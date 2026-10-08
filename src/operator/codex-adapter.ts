import { randomUUID } from 'node:crypto';
import { codexUsage } from './codex-activity.js';
import { codexChoice, type OperatorConfig } from './config.js';
import type {
    ApprovalDecision,
    ProviderAdapter,
    ProviderEvent,
    ProviderHooks,
    ProviderRole,
    ProviderReconciliation,
    ProviderSession,
    ProviderTurn,
    UsageWindow,
} from './provider-adapter.js';
import {
    object,
    string,
    idValue,
    approvalKey,
    textInput,
    efforts,
    sessionState,
    activeState,
    clearApproval,
    settleResponse,
    deferFrame,
    requestRPC,
    readFrames,
    exactSessionID,
    type Connection,
    type RecordValue,
    type CodexAdapterOptions,
    type ProtocolHooks,
} from './codex-protocol.js';
import { approvalResult, requestApproval, requestTool, controllerParams } from './codex-approvals.js';
import { existingSession, resumedState, started, notification, reconcileThread } from './codex-state.js';
export type { CodexTransport, CodexAdapterOptions } from './codex-protocol.js';

function assertEfforts(config: OperatorConfig): void {
    for (const effort of [config.codexEffort, config.workerCodexEffort])
        if (effort && !efforts.has(effort)) throw new Error('Unsupported Codex reasoning effort');
}

export class CodexAdapter implements ProviderAdapter {
    private connection?: Connection;
    private config?: OperatorConfig;
    private hooks?: ProviderHooks;
    private events: Promise<void> = Promise.resolve();
    private connecting = false;
    private readonly options: Required<CodexAdapterOptions>;

    constructor(options: CodexAdapterOptions) {
        this.options = {
            spawnTransport: options.spawnTransport,
            requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
            maxLineBytes: options.maxLineBytes ?? 16 * 1024 * 1024,
        };
        if (!Number.isFinite(this.options.requestTimeoutMs) || this.options.requestTimeoutMs <= 0)
            throw new Error('RPC acknowledgement timeout must be positive');
        if (!Number.isSafeInteger(this.options.maxLineBytes) || this.options.maxLineBytes <= 0)
            throw new Error('Protocol line limit must be positive');
    }

    async connect(config: OperatorConfig, hooks: ProviderHooks): Promise<void> {
        if (this.connecting || this.connection?.alive) throw new Error('Codex adapter is already connected');
        assertEfforts(config);
        this.connecting = true;
        this.config = { ...config };
        this.hooks = hooks;
        let connection: Connection | undefined;
        try {
            const transport = this.options.spawnTransport(config);
            connection = {
                epoch: randomUUID(),
                transport,
                alive: true,
                ready: false,
                buffer: '',
                pending: new Map(),
                approvals: new Map(),
                sessions: new Map(),
                openings: new Map(),
                deferred: new Map(),
                toolRequests: new Map(),
                toolCalls: new Set(),
            };
            this.connection = connection;
            const current = connection;
            transport.stdout.setEncoding('utf8');
            transport.stdout.on('data', (chunk: string) => this.read(current, chunk));
            transport.stdout.on('error', (error: Error) => this.disconnect(current, error.message));
            transport.stdout.on('end', () => this.disconnect(current, 'Codex app-server stdout ended'));
            transport.stdin.on('error', (error: Error) => this.disconnect(current, error.message));
            transport.stderr?.resume();
            transport.onError((error) => this.disconnect(current, error.message));
            transport.onExit((reason) => this.disconnect(current, reason));
            await this.rpc(current, 'initialize', {
                clientInfo: { name: 'aibinator', title: 'AiBinator local responder', version: '1.0.0' },
                capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
            });
            this.send(current, { method: 'initialized', params: {} });
            current.ready = true;
            this.emit(current, { type: 'connected', epoch: current.epoch });
        } catch (error) {
            if (connection) {
                this.disconnect(connection, error instanceof Error ? error.message : 'Connection failed');
                await connection.transport.stop();
            }
            throw error;
        } finally {
            this.connecting = false;
        }
    }

    async openSession(input: {
        role: ProviderRole;
        conversationKey: string;
        sessionId?: string;
        shared?: boolean;
    }): Promise<ProviderSession> {
        const connection = this.current();
        if (!input.conversationKey || (input.sessionId !== undefined && !input.sessionId))
            throw new Error('Conversation key and exact resume ID must be nonempty');
        const binding = JSON.stringify([input.role, input.conversationKey]);
        const existing = existingSession(connection, input);
        if (existing) return existing;
        const opening = connection.openings.get(binding);
        if (opening) {
            const session = await opening;
            if (input.sessionId && input.sessionId !== session.id) throw new Error('Conflicting resume ID');
            return session;
        }
        const promise = this.createSession(connection, input);
        connection.openings.set(binding, promise);
        try {
            return await promise;
        } finally {
            connection.openings.delete(binding);
            this.flushDeferred(connection);
        }
    }

    private flushDeferred(connection: Connection): void {
        if (connection.openings.size) return;
        const deferred = [...connection.deferred.values()].flat();
        connection.deferred.clear();
        for (const message of deferred) if (connection.alive) this.message(connection, message);
    }

    private async createSession(
        connection: Connection,
        input: {
            role: ProviderRole;
            conversationKey: string;
            sessionId?: string;
            shared?: boolean;
        },
    ): Promise<ProviderSession> {
        const params = controllerParams(this.config!, input, this.hooks?.tools ?? []);
        const response = object(await this.rpc(connection, input.sessionId ? 'thread/resume' : 'thread/start', params));
        const thread = object(response.thread);
        const id = exactSessionID(connection, thread, input.sessionId);
        const session = resumedState(thread, input);
        connection.sessions.set(id, session);
        this.emit(connection, { type: 'session', sessionId: id, resumed: !!input.sessionId });
        if (session.turnId) this.emit(connection, { type: 'turn.started', sessionId: id, turnId: session.turnId });
        const deferred = connection.deferred.get(id) ?? [];
        connection.deferred.delete(id);
        for (const message of deferred) this.message(connection, message);
        return { id };
    }

    async startTurn(sessionId: string, input: { text: string; originEventId: string; taskId?: string }): Promise<ProviderTurn> {
        const connection = this.current();
        const session = sessionState(connection, sessionId);
        if (session.starting || session.turnId) throw new Error('Session is busy; steer or interrupt the active turn');
        if (!input.text || !input.originEventId) throw new Error('Turn input and origin event ID must be nonempty');
        session.starting = true;
        session.submitted = true;
        session.messages.clear();
        try {
            const effort = this.config && codexChoice(this.config, session.role === 'worker').effort;
            const response = object(
                await this.rpc(connection, 'turn/start', {
                    threadId: sessionId,
                    input: textInput(input.text),
                    clientUserMessageId: input.originEventId,
                    ...(effort ? { effort } : {}),
                    ...(input.taskId ? { responsesapiClientMetadata: { aibinator_task_id: input.taskId } } : {}),
                }),
            );
            const turn = object(response.turn);
            const turnId = string(turn.id);
            if (!turnId) throw new Error('App-server did not return a turn ID');
            if (turn.status === 'inProgress') started(connection, sessionId, turnId, this.protocol(connection));
            return { turnId };
        } finally {
            session.starting = false;
        }
    }

    async steer(sessionId: string, turnId: string, text: string): Promise<void> {
        const connection = this.current();
        activeState(connection, sessionId, turnId);
        if (!text) throw new Error('Steering input must be nonempty');
        await this.rpc(connection, 'turn/steer', { threadId: sessionId, expectedTurnId: turnId, input: textInput(text) });
    }

    async interrupt(sessionId: string, turnId: string): Promise<void> {
        const connection = this.current();
        activeState(connection, sessionId, turnId);
        await this.rpc(connection, 'turn/interrupt', { threadId: sessionId, turnId });
    }

    async compact(sessionId: string): Promise<void> {
        await this.rpc(this.current(), 'thread/compact/start', { threadId: sessionId });
    }

    async usage(): Promise<UsageWindow[]> {
        return codexUsage(object(await this.rpc(this.current(), 'account/rateLimits/read', {})));
    }

    async resolveApproval(key: string, decision: ApprovalDecision): Promise<void> {
        const connection = this.current();
        const pending = connection.approvals.get(key);
        if (!pending || pending.answered || pending.request.epoch !== connection.epoch)
            throw new Error('Approval is stale, resolved, or belongs to another connection');
        this.send(connection, { id: pending.id, result: approvalResult(pending, decision) });
        pending.answered = true;
        if (decision.action !== 'cancel' || !['question', 'permissions'].includes(pending.request.kind)) return;
        const { sessionId, turnId } = pending.request;
        if (connection.sessions.get(sessionId)?.turnId !== turnId) return;
        await this.interrupt(sessionId, turnId).catch((error: unknown) => {
            if (connection.sessions.get(sessionId)?.turnId === turnId) throw error;
        });
    }

    async close(): Promise<void> {
        const connection = this.connection;
        if (!connection) return;
        this.disconnect(connection, 'Codex adapter closed');
        await connection.transport.stop();
    }

    async reconcile(sessionId: string, turnId?: string): Promise<ProviderReconciliation> {
        const connection = this.current();
        sessionState(connection, sessionId);
        try {
            const response = object(await this.rpc(connection, 'thread/read', { threadId: sessionId, includeTurns: true }));
            return reconcileThread(connection, sessionId, turnId, object(response.thread), this.protocol(connection));
        } catch (error) {
            return {
                sessionId,
                state: 'unknown',
                ...(turnId ? { turnId } : {}),
                reason: error instanceof Error ? error.message : 'Could not read exact thread',
            };
        }
    }

    private current(): Connection {
        const connection = this.connection;
        if (!connection?.alive || !connection.ready) throw new Error('Codex adapter is not connected');
        return connection;
    }

    private protocol(connection: Connection): ProtocolHooks {
        return { send: (message) => this.send(connection, message), emit: (event) => this.emit(connection, event) };
    }

    private send(connection: Connection, message: RecordValue): void {
        if (!connection.alive || connection !== this.connection) throw new Error('Codex connection is no longer active');
        connection.transport.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error) this.disconnect(connection, error.message);
        });
    }

    private rpc(connection: Connection, method: string, params: RecordValue): Promise<unknown> {
        return requestRPC(connection, method, params, this.options.requestTimeoutMs, this.protocol(connection), (reason) =>
            this.disconnect(connection, reason),
        );
    }

    private read(connection: Connection, chunk: string): void {
        if (!connection.alive || this.connection !== connection) return;
        readFrames(connection, chunk, this.options.maxLineBytes, {
            message: (frame) => this.message(connection, frame),
            disconnect: (reason) => this.disconnect(connection, reason),
        });
    }

    private message(connection: Connection, message: RecordValue): void {
        const method = string(message.method);
        if (!method) {
            settleResponse(connection, message);
            return;
        }
        const params = object(message.params);
        if (deferFrame(connection, message, string(params.threadId))) return;
        const hooks = this.protocol(connection);
        if (Object.hasOwn(message, 'id')) {
            if (!idValue(message.id)) throw new Error('Server request has no valid ID');
            if (method === 'item/tool/call') requestTool(connection, message.id, params, this.hooks?.tools ?? [], hooks);
            else requestApproval(connection, message.id, method, params, hooks);
            return;
        }
        if (method === 'serverRequest/resolved') {
            this.resolved(connection, params);
            return;
        }
        notification(connection, method, params, hooks);
    }

    private resolved(connection: Connection, params: RecordValue): void {
        if (!idValue(params.requestId)) return;
        const key = approvalKey(connection.epoch, params.requestId);
        const toolRequest = connection.toolRequests.get(params.requestId);
        if (toolRequest?.sessionId === params.threadId) connection.toolRequests.delete(params.requestId);
        const pending = connection.approvals.get(key);
        if (pending && pending.request.sessionId === params.threadId) clearApproval(connection, key, this.protocol(connection));
    }

    private disconnect(connection: Connection, reason: string): void {
        if (!connection.alive) return;
        connection.alive = false;
        connection.ready = false;
        for (const pending of connection.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        connection.pending.clear();
        for (const key of connection.approvals.keys()) clearApproval(connection, key, this.protocol(connection));
        for (const [sessionId, session] of connection.sessions) {
            if (session.turnId) this.emit(connection, { type: 'turn.failed', sessionId, turnId: session.turnId, reason });
        }
        connection.sessions.clear();
        connection.toolRequests.clear();
        connection.toolCalls.clear();
        connection.deferred.clear();
        this.emit(connection, { type: 'disconnected', epoch: connection.epoch, reason });
        void connection.transport.stop().catch(() => {});
    }

    private emit(connection: Connection, event: ProviderEvent): void {
        const hooks = this.hooks;
        this.events = this.events
            .then(async () => {
                await hooks?.onEvent(event);
            })
            .catch(() => {
                this.disconnect(connection, 'Provider event handler failed');
                void connection.transport.stop();
            });
    }
}
