import { withHistory, type History } from './history.js';
import { progressPost } from './activity-format.js';
import { TaskDesk, workerReport } from './controller-tasks.js';
import type { BotEvent } from '../core/queue.js';
import type { OperatorConfig } from './config.js';
import { ControllerStore, controllerStatus, conversationKey, type ControllerTask } from './controller-state.js';
import type { ApprovalDecision, ProviderAdapter, ProviderApproval, ProviderEvent, ProviderNotice } from './provider-adapter.js';
import { isNotice } from './provider-adapter.js';
import { controllerTools } from './controller-tools.js';
import { recoverController } from './controller-recovery.js';
import { appendReply, ControllerOutbox } from './controller-outbox.js';
import { shortReason, TurnClock } from './controller-turns.js';
import { joinedSession, type Sharing } from './discordinator.js';

export type ControllerDelivery = (eventId: string, content: string, key: string, loose: boolean) => Promise<unknown>;
export type ControllerApprovalDelivery = (request: ProviderApproval, originEventId: string) => Promise<void>;
export type ControllerOptions = {
    activity?: boolean;
    workerCapacity?: number;
    invalidateApproval?: (key?: string) => void;
    processing?: (sessionId: string, eventId: string, processing: boolean) => void;
    changed?: () => void;
    history?: History;
    notice?: (event: ProviderNotice) => void;
    sessionIdleMs?: number;
    describe?: (event: BotEvent) => string;
    brief?: (eventId: string, title: string, prompt: string) => string;
    origin?: (eventId: string) => BotEvent | undefined;
    shared?: () => Promise<Sharing>;
};

export class ConversationController {
    private generation = 0;
    private connected = false;
    private epoch?: string;
    private stopped = false;
    private pumping = false;
    private pumpAgain = false;
    private readonly outbox: ControllerOutbox;
    private approvals = new Map<string, { request: ProviderApproval; originEventId: string }>();
    private progressAt = new Map<string, number>();
    private approvalDeliveryError: string | null = null;
    private failed = false;
    private readonly turns: TurnClock;
    readonly tasks: TaskDesk;
    constructor(
        readonly adapter: ProviderAdapter,
        readonly config: OperatorConfig,
        readonly store: ControllerStore,
        readonly deliver: ControllerDelivery,
        readonly requestApproval: ControllerApprovalDelivery,
        readonly options: ControllerOptions = {},
    ) {
        this.outbox = new ControllerOutbox(store, deliver, () => this.generation);
        this.turns = new TurnClock(adapter, config, () => this.fail(), options.sessionIdleMs ?? 10 * 60_000);
        this.tasks = new TaskDesk(
            store,
            () => this.generation,
            () => this.schedulePump(),
            (sessionId, turnId, text) => this.adapter.steer(sessionId, turnId, text),
            (sessionId, turnId) => this.turns.interrupt(sessionId, turnId, 'cancel'),
        );
    }
    async start(): Promise<void> {
        await this.store.load();
        this.generation = await this.store.acquire();
        await this.adapter.connect(this.config, {
            onEvent: (event) => (isNotice(event) ? Promise.resolve(this.options.notice?.(event)) : this.handleProviderEvent(event)),
            tools: controllerTools(this, this.store),
        });
        await recoverController(this.adapter, this.store, this.generation, (event) => this.onEvent(event));
        await this.outbox.flush();
        await this.pump();
    }
    async stop(): Promise<void> {
        this.stopped = true;
        this.connected = false;
        this.approvals.clear();
        this.options.invalidateApproval?.();
        this.turns.clear();
        this.stopProcessing();
        this.outbox.stop();
        await this.adapter.close();
    }
    status() {
        const live = { connected: this.connected, failed: this.failed, deliveryError: this.outbox.error, generation: this.generation };
        return controllerStatus(this.store.snapshot(), {
            ...live,
            approvals: this.approvals.size,
            approvalDeliveryError: this.approvalDeliveryError,
        });
    }
    conversation() {
        return this.store.snapshot().conversations.find((item) => item.key === conversationKey());
    }
    async reset(): Promise<void> {
        const sessions: string[] = [];
        await this.store.update((state) => {
            if (state.conversations.some((item) => item.state !== 'idle'))
                throw new Error('The assistant is still working. Use /stop first, then /new.');
            for (const item of state.conversations) {
                if (item.sessionId) sessions.push(item.sessionId);
                Object.assign(item, { sessionId: undefined, seen: {} });
            }
        }, this.generation);
        for (const sessionId of sessions) this.closeIdle(sessionId);
    }
    async stopAll(): Promise<number> {
        const running = this.store.snapshot().conversations.filter((item) => item.sessionId && item.turnId && item.state !== 'idle');
        for (const item of running) await this.turns.interrupt(item.sessionId!, item.turnId!, 'stop');
        return running.length;
    }
    async ingest(event: BotEvent): Promise<boolean> {
        if (this.stopped) throw new Error('Controller stopped');
        const added = await this.store.enqueue(event);
        this.schedulePump();
        return added;
    }
    async startTask(conversation: string, prompt: string, title = 'Task'): Promise<string> {
        const owner = this.store.snapshot().conversations.find((item) => item.key === conversation);
        if (!owner) throw new Error('Task has no verified owning conversation');
        const brief = this.options.brief?.(owner.originEventId, title, prompt) ?? prompt;
        return this.tasks.start({ conversationKey: conversation, originEventId: owner.originEventId, title, prompt: brief });
    }
    getTaskStatus(id: string): ControllerTask {
        return this.tasks.get(id);
    }
    cancelTask(id: string): Promise<void> {
        return this.tasks.cancel(id);
    }
    async resolveApproval(key: string, decision: ApprovalDecision, originEventId: string): Promise<void> {
        const pending = this.approvals.get(key);
        if (!pending || pending.originEventId !== originEventId) throw new Error('Approval is not pending for this origin');
        this.approvals.delete(key);
        if (decision.action === 'cancel') this.turns.expect(pending.request.sessionId, pending.request.turnId, 'cancel');
        try {
            await this.adapter.resolveApproval(key, decision);
        } catch (error) {
            this.approvals.set(key, pending);
            throw error;
        }
    }
    private async handleProviderEvent(event: ProviderEvent): Promise<void> {
        if (this.stopped) return;
        try {
            await this.onEvent(event);
        } catch {
            this.fail();
        }
    }
    private fail(): void {
        this.connected = false;
        this.failed = true;
        this.options.changed?.();
    }
    private schedulePump(): void {
        void this.pump().catch(() => this.fail());
    }
    private async pump(): Promise<void> {
        if (this.pumping) {
            this.pumpAgain = true;
            return;
        }
        if (!this.available()) return;
        this.pumping = true;
        try {
            for (const event of this.store.snapshot().inbox) await this.dispatch(event);
            await this.startWorkers();
        } finally {
            this.pumping = false;
            if (this.pumpAgain) {
                this.pumpAgain = false;
                this.schedulePump();
            }
        }
    }
    private async dispatch(event: BotEvent & { replyTo?: string }): Promise<void> {
        const replyTo = event.replyTo ?? event.id;
        const key = conversationKey();
        const existing = this.store.snapshot().conversations.find((item) => item.key === key);
        if (existing && existing.state !== 'idle') return;
        let sessionId = existing?.sessionId;
        if (sessionId) this.turns.wake(sessionId);
        await this.store.update((state) => {
            const item = state.conversations.find((item) => item.key === key);
            if (item) Object.assign(item, { state: 'busy', originEventId: replyTo });
            else
                state.conversations.push({
                    key,
                    seen: {},
                    originEventId: replyTo,
                    state: 'busy',
                });
        }, this.generation);
        let submitted = false;
        try {
            sessionId = await this.openConversation(key, sessionId);
            submitted = true;
            const describe = event.replyTo ? () => event.text : this.options.describe;
            const text = await withHistory(this.store, this.generation, key, event, this.options.history, describe);
            const turn = await this.adapter.startTurn(sessionId, { text, originEventId: replyTo });
            this.turns.arm(sessionId, turn.turnId);
            this.progressAt.set(sessionId, Date.now());
            await this.store.update((state) => {
                const item = state.conversations.find((item) => item.key === key)!;
                if (item.state === 'busy') item.turnId = turn.turnId;
                state.inbox = state.inbox.filter((item) => item.id !== event.id);
            }, this.generation);
            await this.drainFinals(sessionId, turn.turnId);
        } catch (error) {
            await this.store.update((state) => {
                const item = state.conversations.find((item) => item.key === key)!;
                item.state = submitted ? 'recovering' : 'idle';
            }, this.generation);
            throw error;
        }
    }
    private async openConversation(key: string, saved?: string): Promise<string> {
        const shared = await joinedSession(this.options.shared);
        const sessionId = shared ?? saved;
        const resume = { ...(sessionId ? { sessionId } : {}), ...(shared ? { shared: true } : {}) };
        const opened = await this.adapter.openSession({ role: 'controller', conversationKey: key, ...resume });
        if (opened.id !== saved)
            await this.store.update((state) => {
                Object.assign(
                    state.conversations.find((item) => item.key === key)!,
                    { sessionId: opened.id, seen: {} },
                );
            }, this.generation);
        return opened.id;
    }
    private async startWorkers(): Promise<void> {
        const state = this.store.snapshot();
        const active = state.tasks.filter((item) => ['running', 'approval', 'recovering'].includes(item.state)).length;
        for (const task of state.tasks
            .filter((item) => item.state === 'queued')
            .slice(0, Math.max(0, (this.options.workerCapacity ?? 2) - active))) {
            const session = await this.adapter.openSession({
                role: 'worker',
                conversationKey: `task:${task.id}`,
                ...(task.sessionId ? { sessionId: task.sessionId } : {}),
            });
            await this.store.update((state) => {
                Object.assign(
                    state.tasks.find((item) => item.id === task.id)!,
                    { sessionId: session.id, state: 'running' },
                );
            }, this.generation);
            const turn = await this.adapter.startTurn(session.id, {
                text: task.prompt,
                originEventId: task.originEventId,
                taskId: task.id,
            });
            this.turns.arm(session.id, turn.turnId);
            await this.store.update((state) => {
                state.tasks.find((item) => item.id === task.id)!.turnId = turn.turnId;
            }, this.generation);
            await this.drainFinals(session.id, turn.turnId);
        }
    }
    private async onEvent(event: ProviderEvent): Promise<void> {
        if (event.type === 'connected') {
            this.connected = true;
            this.epoch = event.epoch;
        } else if (event.type === 'disconnected') this.disconnected();
        else if (event.type === 'approval.resolved') await this.resolved(event);
        else if (event.type === 'approval.requested') await this.approval(event.request);
        else if (event.type === 'turn.started') await this.started(event.sessionId, event.turnId);
        else if (event.type === 'final' || event.type === 'turn.failed') await this.finished(event);
        else if (event.type === 'progress') await this.progress(event);
    }
    private disconnected(): void {
        this.stopProcessing();
        this.approvals.clear();
        this.options.invalidateApproval?.();
        if (!this.stopped) this.fail();
    }
    private available(): boolean {
        return !this.stopped && this.connected;
    }
    private stopProcessing(): void {
        const state = this.store.snapshot();
        for (const owner of [...state.conversations, ...state.tasks])
            if (owner.sessionId) this.options.processing?.(owner.sessionId, owner.originEventId, false);
    }
    private owner(sessionId: string) {
        const state = this.store.snapshot();
        return state.tasks.find((item) => item.sessionId === sessionId) ?? state.conversations.find((item) => item.sessionId === sessionId);
    }
    private async resolved(event: Extract<ProviderEvent, { type: 'approval.resolved' }>): Promise<void> {
        if (event.epoch !== this.epoch) return;
        const pending = this.approvals.get(event.key);
        this.approvals.delete(event.key);
        this.options.invalidateApproval?.(event.key);
        if (pending) await this.markSession(pending.request.sessionId, 'busy');
    }
    private async started(sessionId: string, turnId: string): Promise<void> {
        const owner = this.owner(sessionId);
        if (owner?.turnId && owner.turnId !== turnId) return;
        if (owner) this.options.processing?.(sessionId, owner.originEventId, true);
        await this.store.update((current) => {
            const worker = current.tasks.find((item) => item.sessionId === sessionId);
            const controller = current.conversations.find((item) => item.sessionId === sessionId);
            if (worker) worker.turnId = turnId;
            if (controller) controller.turnId = turnId;
        }, this.generation);
        await this.drainFinals(sessionId, turnId);
    }
    private async approval(request: ProviderApproval): Promise<void> {
        const owner = this.owner(request.sessionId);
        if (!owner || request.epoch !== this.epoch) return;
        if (owner.turnId && owner.turnId !== request.turnId) return;
        this.options.processing?.(request.sessionId, owner.originEventId, false);
        this.approvals.set(request.key, { request, originEventId: owner.originEventId });
        await this.markSession(request.sessionId, 'approval');
        try {
            await this.requestApproval(request, owner.originEventId);
        } catch (error) {
            await this.approvalUnavailable(request, owner.originEventId, error);
        }
    }
    private async approvalUnavailable(request: ProviderApproval, originEventId: string, error: unknown): Promise<void> {
        this.approvalDeliveryError = 'An approval request could not be asked through AIBI, so it was denied.';
        this.approvals.delete(request.key);
        await this.adapter.resolveApproval(request.key, { action: 'deny' });
        await this.outbox.queue(
            originEventId,
            `${request.title} needed your approval, but the request could not be shown here (${shortReason(error)}), so it was denied.`,
            `controller-approval-unavailable-${request.key}`,
        );
    }
    private async finished(event: Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>): Promise<void> {
        const owner = this.owner(event.sessionId);
        if (!owner) return;
        if ('state' in owner && owner.state === 'cancelled') return this.release(event.sessionId, event.turnId, owner.originEventId);
        if (!owner.turnId) return this.turns.defer(event, owner.state);
        if (owner.turnId !== event.turnId) return;
        const text = this.turns.outcome(event);
        this.release(event.sessionId, event.turnId, owner.originEventId);
        const report = 'prompt' in owner ? this.report(owner, text, event) : undefined;
        await this.store.update((current) => {
            if (report) current.inbox.push(report);
            else appendReply(current, owner.originEventId, text, `controller-final-${event.sessionId}-${event.turnId}`);
            const worker = current.tasks.find((item) => item.sessionId === event.sessionId);
            if (worker && worker.state !== 'cancelled') {
                worker.state = event.type === 'final' ? 'completed' : 'failed';
                worker.result = text;
                worker.updatedAt = new Date().toISOString();
            }
            const controller = current.conversations.find((item) => item.sessionId === event.sessionId);
            if (controller) {
                controller.state = 'idle';
                delete controller.turnId;
            }
        }, this.generation);
        if ('prompt' in owner) await this.adapter.closeSession?.(event.sessionId);
        else this.turns.rest(event.sessionId, () => this.closeIdle(event.sessionId));
        await this.outbox.flush();
        this.schedulePump();
        this.options.changed?.();
    }
    private report(task: ControllerTask, text: string, event: Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>) {
        const origin = this.options.origin?.(task.originEventId);
        return origin && workerReport(task, text, event.type === 'final', origin, event.turnId);
    }
    private closeIdle(sessionId: string): void {
        this.turns.wake(sessionId);
        const owner = this.owner(sessionId);
        if (owner && owner.state !== 'idle') return;
        void this.adapter.closeSession?.(sessionId).catch(() => this.fail());
    }
    private release(sessionId: string, turnId: string, originEventId: string): void {
        this.options.processing?.(sessionId, originEventId, false);
        this.turns.release(sessionId, turnId);
    }
    private async progress(event: Extract<ProviderEvent, { type: 'progress' }>): Promise<void> {
        const owner = this.owner(event.sessionId);
        if (!owner || owner.turnId !== event.turnId) return;
        if ('prompt' in owner) return this.tasks.progress(event.sessionId, event.text);
        if (event.activity && !this.options.activity) return;
        const quiet = this.progressAt.get(event.sessionId) ?? Date.now();
        const text = progressPost(Boolean(event.activity), event.text, quiet, this.config.progressSeconds ?? 60);
        if (!text) return;
        this.progressAt.set(event.sessionId, Date.now());
        await this.outbox.queue(owner.originEventId, text, `controller-progress-${event.sessionId}-${Date.now()}`, true);
    }
    private async drainFinals(sessionId: string, turnId: string): Promise<void> {
        for (const event of this.turns.deferred(sessionId, turnId)) await this.finished(event);
    }
    private async markSession(sessionId: string, state: 'busy' | 'approval'): Promise<void> {
        const owner = this.owner(sessionId);
        if (owner) this.options.processing?.(sessionId, owner.originEventId, state === 'busy');
        await this.store.update((current) => {
            const task = current.tasks.find((item) => item.sessionId === sessionId);
            const conversation = current.conversations.find((item) => item.sessionId === sessionId);
            if (task && task.state !== 'cancelled') task.state = state === 'busy' ? 'running' : 'approval';
            if (conversation) conversation.state = state;
        }, this.generation);
    }
}
