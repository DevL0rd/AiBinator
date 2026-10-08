import { randomUUID } from 'node:crypto';
import { roleInstructions } from './manager-guide.js';
import { contextWindow, mainUsage, MessageQueue, progressText } from './claude-stream.js';
import { approvalKind, errorText, type PendingApproval, type Resolution, type SessionState, type TurnState } from './claude-session.js';
import { claudeChoice, type OperatorConfig } from './config.js';
import type { ApprovalDecision, ProviderAdapter, ProviderHooks, ProviderReconciliation, ProviderRole } from './provider-adapter.js';
import {
    loadClaudeQuery,
    loadClaudeMcp,
    type ClaudeMessage,
    type ClaudeMcpFactory,
    type ClaudePermissionContext,
    type ClaudePermissionResult,
    type ClaudeQueryFactory,
    type ClaudeToolFactory,
} from './claude-protocol.js';

export class ClaudeAdapter implements ProviderAdapter {
    private config?: OperatorConfig;
    private hooks?: ProviderHooks;
    private epoch = '';
    private closed = true;
    private approvalSequence = 0;
    private readonly sessions = new Map<string, SessionState>();
    private readonly approvals = new Map<string, PendingApproval>();
    private queryFactory?: ClaudeQueryFactory;
    private mcpFactories?: { createSdkMcpServer: ClaudeMcpFactory; tool: ClaudeToolFactory };

    constructor(
        private readonly getQuery: () => Promise<ClaudeQueryFactory> = loadClaudeQuery,
        private readonly getMcp: () => Promise<{ createSdkMcpServer: ClaudeMcpFactory; tool: ClaudeToolFactory }> = loadClaudeMcp,
    ) {}

    async connect(config: OperatorConfig, hooks: ProviderHooks): Promise<void> {
        if (!this.closed) await this.close();
        this.config = config;
        this.hooks = hooks;
        this.epoch = randomUUID();
        this.closed = false;
        try {
            this.queryFactory = await this.getQuery();
            if (hooks.tools?.length) this.mcpFactories = await this.getMcp();
        } catch (error) {
            this.closed = true;
            this.config = undefined;
            this.hooks = undefined;
            throw error;
        }
        await hooks.onEvent({ type: 'connected', epoch: this.epoch });
    }

    openSession(input: { role: ProviderRole; conversationKey: string; sessionId?: string }): Promise<{ id: string }> {
        return Promise.resolve().then(() => this.open(input));
    }

    private open(input: { role: ProviderRole; conversationKey: string; sessionId?: string }): { id: string } {
        this.assertConnected();
        const id = input.sessionId ?? randomUUID();
        if (this.sessions.has(id)) return { id };
        const queue = new MessageQueue();
        const queryFactory = this.queryFactory!;
        const mcpServers = input.role === 'controller' ? this.controllerServers(id) : undefined;
        const query = queryFactory({
            prompt: queue,
            options: {
                cwd: this.config!.workspace,
                ...(claudeChoice(this.config!, input.role === 'worker') as { model?: string; effort?: OperatorConfig['claudeEffort'] }),
                systemPrompt: {
                    type: 'preset' as const,
                    preset: 'claude_code' as const,
                    append: roleInstructions(input.role, this.config!.instructions),
                    snapshot: true as const,
                },
                ...(input.sessionId ? { resume: input.sessionId } : {}),
                ...(!input.sessionId ? { sessionId: id } : {}),
                ...(mcpServers ? { mcpServers } : {}),
                canUseTool: (toolName, toolInput, context) => this.requestApproval(id, toolName, toolInput, context),
            },
        });
        const session: SessionState = {
            id,
            role: input.role,
            queue,
            query,
            turns: [],
            history: new Map(),
            resumed: Boolean(input.sessionId),
            closed: false,
            stream: Promise.resolve(),
        };
        this.sessions.set(id, session);
        session.stream = this.consume(session, Boolean(input.sessionId));
        return { id };
    }

    private controllerServers(sessionId: string): Record<string, unknown> | undefined {
        const providerTools = this.hooks?.tools;
        if (!providerTools?.length) return undefined;
        const { createSdkMcpServer, tool } = this.mcpFactories!;
        const tools = providerTools.map((definition) =>
            tool(definition.name, definition.description, definition.inputShape, async (args) => {
                const result = await definition.call(args, sessionId);
                return {
                    content: [{ type: 'text', text: result.text }],
                    ...(result.success ? {} : { isError: true }),
                };
            }),
        );
        return { aibinator: createSdkMcpServer({ name: 'aibinator', version: '1.0.0', tools }) };
    }

    async startTurn(sessionId: string, input: { text: string; originEventId: string; taskId?: string }): Promise<{ turnId: string }> {
        const session = this.session(sessionId);
        const turn: TurnState = { id: randomUUID(), ...input, state: 'running' };
        session.turns.push(turn);
        session.history.set(turn.id, turn);
        await this.emit({ type: 'turn.started', sessionId, turnId: turn.id });
        session.queue.push({
            type: 'user',
            message: { role: 'user', content: input.text },
            parent_tool_use_id: null,
            session_id: sessionId,
        });
        return { turnId: turn.id };
    }

    steer(sessionId: string, turnId: string, text: string): Promise<void> {
        const session = this.session(sessionId);
        if (!this.findTurn(session, turnId)) return Promise.reject(new Error(`Unknown Claude turn: ${turnId}`));
        session.queue.push({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: sessionId,
        });
        return Promise.resolve();
    }

    async interrupt(sessionId: string, turnId: string): Promise<void> {
        const session = this.session(sessionId);
        if (!this.findTurn(session, turnId)) throw new Error(`Unknown Claude turn: ${turnId}`);
        await session.query.interrupt();
        const turn = this.findTurn(session, turnId)!;
        turn.state = 'interrupted';
    }

    async resolveApproval(key: string, decision: ApprovalDecision): Promise<void> {
        const pending = this.approvals.get(key);
        if (!pending || pending.epoch !== this.epoch) throw new Error(`Unknown or expired approval: ${key}`);
        this.approvals.delete(key);
        pending.detach();
        const session = this.sessions.get(pending.sessionId);
        const turn = session && this.findTurn(session, pending.turnId);
        if (turn) turn.state = 'running';
        pending.resolve(permissionResult(pending.input, decision));
        await this.emit({ type: 'approval.resolved', key, epoch: this.epoch });
        if (decision.action !== 'cancel' || !session || !turn) return;
        await session.query.interrupt();
        turn.state = 'interrupted';
    }

    reconcile(sessionId: string, turnId?: string): Promise<ProviderReconciliation> {
        return Promise.resolve(this.reconcileNow(sessionId, turnId));
    }

    private reconcileNow(sessionId: string, turnId?: string): ProviderReconciliation {
        const session = this.sessions.get(sessionId);
        if (!session)
            return {
                sessionId,
                state: 'unknown',
                ...(turnId ? { turnId } : {}),
                reason: 'No live SDK stream evidence',
            };
        const turn = turnId ? session.history.get(turnId) : (session.current ?? session.turns[0]);
        if (!turn) {
            if (session.resumed)
                return {
                    sessionId,
                    state: 'unknown',
                    reason: 'Session resume does not prove prior turn state',
                };
            return { sessionId, state: 'idle' };
        }
        return {
            sessionId,
            state: turn.state,
            turnId: turn.id,
            ...(turn.resultText !== undefined ? { text: turn.resultText } : {}),
            ...(turn.reason !== undefined ? { reason: turn.reason } : {}),
        };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const [key, pending] of this.approvals) {
            pending.detach();
            pending.resolve({ behavior: 'deny', message: 'Provider disconnected' });
            await this.emit({ type: 'approval.resolved', key, epoch: pending.epoch });
        }
        this.approvals.clear();
        const streams: Promise<void>[] = [];
        for (const session of this.sessions.values()) {
            session.closed = true;
            session.queue.close();
            session.query.close();
            streams.push(session.stream);
        }
        await Promise.allSettled(streams);
        this.sessions.clear();
        this.queryFactory = undefined;
        this.mcpFactories = undefined;
        await this.emit({
            type: 'disconnected',
            epoch: this.epoch,
            reason: 'closed',
        });
    }

    private async requestApproval(
        sessionId: string,
        toolName: string,
        input: Record<string, unknown>,
        context: ClaudePermissionContext,
    ): Promise<ClaudePermissionResult> {
        const session = this.session(sessionId);
        const turn = session.current ?? session.turns[0];
        if (!turn) return { behavior: 'deny', message: 'No active turn for approval' };
        const key = `${this.epoch}:${sessionId}:${turn.id}:${++this.approvalSequence}`;
        return new Promise<ClaudePermissionResult>((resolve) => {
            let settled = false;
            const finish: Resolution = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            const abort = () => {
                if (!this.approvals.delete(key)) return;
                turn.state = 'running';
                finish({ behavior: 'deny', message: 'Approval request expired' });
                void this.emit({ type: 'approval.resolved', key, epoch: this.epoch });
            };
            context.signal.addEventListener('abort', abort, { once: true });
            const detach = () => context.signal.removeEventListener('abort', abort);
            this.approvals.set(key, {
                epoch: this.epoch,
                sessionId,
                turnId: turn.id,
                input,
                resolve: finish,
                detach,
            });
            turn.state = 'waiting-approval';
            void this.emit({
                type: 'approval.requested',
                request: {
                    key,
                    epoch: this.epoch,
                    sessionId,
                    turnId: turn.id,
                    kind: approvalKind(toolName),
                    title: toolName === 'AskUserQuestion' ? 'Claude has a question' : `Claude wants to use ${toolName}`,
                    payload: { toolName, input },
                    ...(toolName === 'AskUserQuestion' ? { schema: { questions: input.questions } } : {}),
                },
            }).catch(() => abort());
        });
    }

    private async consume(session: SessionState, resumed: boolean): Promise<void> {
        let failure: unknown = new Error('Claude session ended unexpectedly');
        try {
            for await (const message of session.query) {
                if (session.closed) break;
                await this.handleMessage(session, message, resumed);
            }
        } catch (error) {
            failure = error;
        }
        await this.handleStreamFailure(session, failure);
        this.retire(session);
    }

    closeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return Promise.resolve();
        this.retire(session);
        session.queue.close();
        session.query.close();
        return Promise.resolve();
    }

    private retire(session: SessionState): void {
        session.closed = true;
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    }

    private async handleMessage(session: SessionState, message: ClaudeMessage, resumed: boolean): Promise<void> {
        if (message.type === 'system' && message.subtype === 'init') {
            const actualId = typeof message.session_id === 'string' ? message.session_id : session.id;
            if (actualId !== session.id) throw new Error('Claude initialized an unexpected session identity');
            await this.emit({ type: 'session', sessionId: actualId, resumed });
            return;
        }
        session.current ??= session.turns[0];
        if (!session.current) return;
        for (const progress of progressText(message))
            await this.emit({
                type: 'progress',
                sessionId: session.id,
                turnId: session.current.id,
                text: progress.text,
                activity: progress.activity,
            });
        await this.trackContext(session, message);
        if (message.type === 'result') await this.finishTurn(session, session.current, message);
    }

    private async trackContext(session: SessionState, message: ClaudeMessage): Promise<void> {
        session.usage = mainUsage(message) ?? session.usage;
        const window = message.type === 'result' ? contextWindow(message, session.usage?.model) : undefined;
        if (window && session.usage)
            await this.emit({ type: 'context', sessionId: session.id, percent: Math.round((session.usage.tokens / window) * 100) });
    }

    private async finishTurn(session: SessionState, turn: TurnState, message: ClaudeMessage): Promise<void> {
        const text = typeof message.result === 'string' ? message.result : '';
        if (message.subtype === 'success') {
            turn.state = 'completed';
            turn.resultText = text;
            await this.emit({ type: 'final', sessionId: session.id, turnId: turn.id, text });
        } else {
            turn.state = 'failed';
            turn.reason = text || String(message.subtype ?? 'Claude turn failed');
            await this.emit({ type: 'turn.failed', sessionId: session.id, turnId: turn.id, reason: turn.reason });
        }
        session.turns.shift();
        session.current = undefined;
    }

    private async handleStreamFailure(session: SessionState, error: unknown): Promise<void> {
        if (session.closed) return;
        const turn = session.current ?? session.turns[0];
        if (!turn) return;
        turn.state = 'failed';
        turn.reason = errorText(error);
        await this.emit({ type: 'turn.failed', sessionId: session.id, turnId: turn.id, reason: turn.reason });
    }

    private findTurn(session: SessionState, turnId: string): TurnState | undefined {
        return session.current?.id === turnId ? session.current : session.turns.find((turn) => turn.id === turnId);
    }

    private session(id: string): SessionState {
        this.assertConnected();
        const session = this.sessions.get(id);
        if (!session || session.closed) throw new Error(`Unknown Claude session: ${id}`);
        return session;
    }

    private assertConnected(): void {
        if (this.closed || !this.config || !this.hooks) throw new Error('Claude adapter is not connected');
    }

    private async emit(event: Parameters<ProviderHooks['onEvent']>[0]): Promise<void> {
        await this.hooks?.onEvent(event);
    }
}

function permissionResult(input: Record<string, unknown>, decision: ApprovalDecision): ClaudePermissionResult {
    if (decision.action !== 'allow-once')
        return { behavior: 'deny', message: decision.action === 'cancel' ? 'User canceled this request' : 'User denied this request' };
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return { behavior: 'allow', updatedInput: decision.answers ? { ...input, questions, answers: decision.answers } : input };
}
