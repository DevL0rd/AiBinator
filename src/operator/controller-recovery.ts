import type { ControllerStore } from './controller-state.js';
import type { ProviderAdapter, ProviderEvent, ProviderReconciliation } from './provider-adapter.js';
import { appendReply } from './controller-outbox.js';

const interrupted =
    'AiBinator restarted while this was in progress and the result could not be recovered. Please ask again if it still matters.';

export async function recoverController(
    adapter: ProviderAdapter,
    store: ControllerStore,
    generation: number,
    emit: (event: ProviderEvent) => Promise<void>,
): Promise<void> {
    if (!adapter.reconcile) return;
    const state = store.snapshot();
    const records = [
        ...state.conversations
            .filter((item) => item.state === 'recovering')
            .map((item) => ({ ...item, role: 'controller' as const, conversationKey: item.key })),
        ...state.tasks.filter((item) => item.state === 'recovering').map((item) => ({ ...item, role: 'worker' as const })),
    ];
    for (const record of records) {
        if (!record.sessionId || !record.turnId) {
            await unstarted(store, generation, record);
            continue;
        }
        const resumed = await adapter.openSession({
            role: record.role,
            conversationKey: record.conversationKey,
            sessionId: record.sessionId,
        });
        if (resumed.id !== record.sessionId) throw new Error('Provider recovery changed conversation identity');
        const proof = await adapter.reconcile(record.sessionId, record.turnId);
        if (proof.sessionId !== record.sessionId) continue;
        if (proof.state === 'unknown') {
            await release(store, generation, record.sessionId, record.originEventId);
            continue;
        }
        const terminal = terminalEvent(proof);
        if (terminal) await emit(terminal);
        else await applyProof(store, generation, proof);
    }
}
function terminalEvent(proof: ProviderReconciliation): ProviderEvent | undefined {
    if (!proof.turnId) return;
    if (proof.state === 'completed')
        return { type: 'final', sessionId: proof.sessionId, turnId: proof.turnId, text: proof.text ?? 'Recovered completed work.' };
    if (['failed', 'interrupted'].includes(proof.state))
        return { type: 'turn.failed', sessionId: proof.sessionId, turnId: proof.turnId, reason: proof.reason ?? proof.state };
}
async function applyProof(store: ControllerStore, generation: number, proof: ProviderReconciliation): Promise<void> {
    if (!['idle', 'running', 'waiting-approval'].includes(proof.state)) return;
    const controllerState = { idle: 'idle', running: 'busy', 'waiting-approval': 'approval' } as const;
    const state = controllerState[proof.state as keyof typeof controllerState];
    await store.update((current) => {
        const worker = current.tasks.find((item) => item.sessionId === proof.sessionId);
        const conversation = current.conversations.find((item) => item.sessionId === proof.sessionId);
        if (worker && state !== 'idle') worker.state = state === 'approval' ? 'approval' : 'running';
        if (conversation) conversation.state = state;
    }, generation);
}
async function unstarted(store: ControllerStore, generation: number, record: { role: string; id?: string; key?: string }): Promise<void> {
    await store.update((current) => {
        const conversation = current.conversations.find((item) => record.role === 'controller' && item.key === record.key);
        const worker = current.tasks.find((item) => record.role === 'worker' && item.id === record.id);
        if (conversation) Object.assign(conversation, { state: 'idle' });
        if (worker) {
            worker.state = 'queued';
            delete worker.sessionId;
        }
    }, generation);
}
async function release(store: ControllerStore, generation: number, sessionId: string, originEventId: string): Promise<void> {
    await store.update((current) => {
        const worker = current.tasks.find((item) => item.sessionId === sessionId);
        const conversation = current.conversations.find((item) => item.sessionId === sessionId);
        if (worker) Object.assign(worker, { state: 'failed', result: interrupted });
        if (conversation) {
            conversation.state = 'idle';
            delete conversation.turnId;
        }
        appendReply(current, originEventId, interrupted, `controller-recovery-${sessionId}-${generation}`);
    }, generation);
}
