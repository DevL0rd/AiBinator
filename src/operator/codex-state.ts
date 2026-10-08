import type { ProviderRole, ProviderSession, ProviderReconciliation } from './provider-adapter.js';
import { activityLine } from './activity-format.js';
import { codexActivity, codexUsage, contextPercent } from './codex-activity.js';
import {
    object,
    string,
    finalText,
    clearApproval,
    sessionState,
    type Connection,
    type SessionState,
    type RecordValue,
    type ProtocolHooks,
} from './codex-protocol.js';
export type SessionInput = { role: ProviderRole; conversationKey: string; sessionId?: string };
export function existingSession(connection: Connection, input: SessionInput): ProviderSession | undefined {
    for (const [id, session] of connection.sessions) {
        if (session.role === input.role && session.conversationKey === input.conversationKey) {
            if (input.sessionId && input.sessionId !== id) throw new Error('Conversation already bound to another session');
            return { id };
        }
        if (input.sessionId === id) throw new Error('Session is owned by a different role or conversation');
    }
    return undefined;
}
export function resumedState(thread: RecordValue, input: SessionInput): SessionState {
    const active = Array.isArray(thread.turns) ? thread.turns.map(object).filter((turn) => turn.status === 'inProgress') : [];
    if (active.length > 1) throw new Error('Session has multiple active turns');
    if (active[0] && !string(active[0].id)) throw new Error('Resumed active turn has no ID');
    return {
        role: input.role,
        conversationKey: input.conversationKey,
        starting: false,
        messages: new Map(),
        completed: new Set(),
        resumed: !!input.sessionId,
        submitted: false,
        ...(active[0] ? { turnId: string(active[0].id) } : {}),
    };
}
export function started(connection: Connection, sessionId: string, turnId: string, hooks: ProtocolHooks): void {
    const session = sessionState(connection, sessionId);
    if (!turnId) throw new Error('Turn notification has no ID');
    if (session.completed.has(turnId) || session.turnId === turnId) return;
    if (session.turnId) throw new Error('App-server started a second active turn');
    session.turnId = turnId;
    hooks.emit({ type: 'turn.started', sessionId, turnId });
}
function recordCompleted(session: SessionState, turnId: string): void {
    session.completed.add(turnId);
    if (session.completed.size > 32) session.completed.delete(session.completed.values().next().value!);
}
function clearTurn(connection: Connection, sessionId: string, turnId: string, hooks: ProtocolHooks): void {
    const session = sessionState(connection, sessionId);
    session.turnId = undefined;
    recordCompleted(session, turnId);
    for (const [key, pending] of connection.approvals)
        if (pending.request.sessionId === sessionId && pending.request.turnId === turnId) clearApproval(connection, key, hooks);
    for (const [id, request] of connection.toolRequests)
        if (request.sessionId === sessionId && request.turnId === turnId) connection.toolRequests.delete(id);
    for (const key of connection.toolCalls) {
        const [callSession, callTurn] = JSON.parse(key) as [string, string];
        if (callSession === sessionId && callTurn === turnId) connection.toolCalls.delete(key);
    }
}
function agentDelta(session: SessionState, params: RecordValue, hooks: ProtocolHooks): void {
    const itemId = string(params.itemId);
    const delta = string(params.delta);
    if (!itemId || !delta) return;
    const item = session.messages.get(itemId) ?? { text: '' };
    item.text += delta;
    session.messages.set(itemId, item);
    hooks.emit({ type: 'progress', sessionId: string(params.threadId), turnId: string(params.turnId), text: delta });
}
function completedItem(session: SessionState, item: RecordValue): void {
    const itemId = string(item.id);
    if (item.type === 'agentMessage' && itemId) session.messages.set(itemId, { text: string(item.text), phase: string(item.phase) });
}
function itemNotice(session: SessionState, method: string, params: RecordValue, hooks: ProtocolHooks): void {
    const item = object(params.item);
    if (method === 'item/completed') {
        completedItem(session, item);
        if (item.type === 'imageGeneration' && (item.savedPath || item.result))
            hooks.emit({
                type: 'image',
                sessionId: string(params.threadId),
                ...(item.savedPath ? { path: string(item.savedPath) } : { data: string(item.result) }),
            });
        return;
    }
    const activity = codexActivity(item);
    if (activity)
        hooks.emit({ type: 'progress', sessionId: string(params.threadId), turnId: string(params.turnId), text: activity, activity: true });
}
function completedTurn(connection: Connection, sessionId: string, turn: RecordValue, hooks: ProtocolHooks): void {
    const turnId = string(turn.id);
    const session = sessionState(connection, sessionId);
    if (Array.isArray(turn.items)) for (const item of turn.items.map(object)) completedItem(session, item);
    clearTurn(connection, sessionId, turnId, hooks);
    if (turn.status === 'completed') {
        const items = [...session.messages.values()].map((item) => ({ ...item, type: 'agentMessage' }));
        hooks.emit({ type: 'final', sessionId, turnId, text: finalText(items) });
    } else
        hooks.emit({
            type: 'turn.failed',
            sessionId,
            turnId,
            reason: string(object(turn.error).message) || `Codex turn ${string(turn.status) || 'failed'}`,
        });
    session.messages.clear();
}
function activeNotice(connection: Connection, method: string, params: RecordValue, hooks: ProtocolHooks): void {
    const sessionId = string(params.threadId);
    const session = sessionState(connection, sessionId);
    switch (method) {
        case 'item/agentMessage/delta':
            agentDelta(session, params, hooks);
            return;
        case 'item/started':
        case 'item/completed':
            itemNotice(session, method, params, hooks);
            return;
        case 'turn/completed':
            completedTurn(connection, sessionId, object(params.turn), hooks);
            return;
        default:
            if (method === 'item/mcpToolCall/progress' && string(params.message))
                hooks.emit({
                    type: 'progress',
                    sessionId,
                    turnId: string(params.turnId),
                    text: activityLine(string(params.message)),
                    activity: true,
                });
    }
}
export function notification(connection: Connection, method: string, params: RecordValue, hooks: ProtocolHooks): void {
    if (method === 'account/rateLimits/updated') {
        hooks.emit({ type: 'usage', windows: codexUsage(params) });
        return;
    }
    const sessionId = string(params.threadId);
    const session = connection.sessions.get(sessionId);
    if (!session) return;
    if (method === 'thread/tokenUsage/updated') {
        const percent = contextPercent(object(params.tokenUsage));
        if (percent !== undefined) hooks.emit({ type: 'context', sessionId, percent });
        return;
    }
    if (method === 'turn/started') {
        started(connection, sessionId, string(object(params.turn).id), hooks);
        return;
    }
    const turnId = string(params.turnId) || string(object(params.turn).id);
    if (!turnId || session.turnId !== turnId) return;
    activeNotice(connection, method, params, hooks);
}
function unknownProof(sessionId: string, turnId: string | undefined, reason: string): ProviderReconciliation {
    return { sessionId, state: 'unknown', ...(turnId ? { turnId } : {}), reason };
}
function terminalProof(connection: Connection, sessionId: string, turn: RecordValue, hooks: ProtocolHooks): ProviderReconciliation {
    const id = string(turn.id);
    const session = sessionState(connection, sessionId);
    if (session.turnId === id) {
        clearTurn(connection, sessionId, id, hooks);
        session.messages.clear();
    }
    if (turn.status === 'completed') return { sessionId, turnId: id, state: 'completed', text: finalText(turn.items) };
    return {
        sessionId,
        turnId: id,
        state: turn.status === 'failed' ? 'failed' : 'interrupted',
        reason: string(object(turn.error).message) || `Codex turn ${string(turn.status)}`,
    };
}
function runningProof(
    connection: Connection,
    sessionId: string,
    turn: RecordValue,
    status: RecordValue,
    hooks: ProtocolHooks,
): ProviderReconciliation {
    const id = string(turn.id);
    const session = sessionState(connection, sessionId);
    if (turn.status !== 'inProgress' || status.type !== 'active')
        return unknownProof(sessionId, id, 'Historical turn state is not corroborated by a live active thread');
    if (session.turnId && session.turnId !== id) return unknownProof(sessionId, id, 'Live turn conflicts with returned history');
    if (session.completed.has(id)) return unknownProof(sessionId, id, 'Read snapshot conflicts with completion notification');
    if (!session.turnId) started(connection, sessionId, id, hooks);
    const waiting = waitingProof(connection, sessionId, id, status);
    return { sessionId, turnId: id, state: waiting ? 'waiting-approval' : 'running' };
}
function waitingProof(connection: Connection, sessionId: string, id: string, status: RecordValue): boolean {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const pending = [...connection.approvals.values()].some(
        (approval) => approval.request.sessionId === sessionId && approval.request.turnId === id && !approval.answered,
    );
    return pending || flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput');
}
function noTurnProof(connection: Connection, sessionId: string, turnId: string | undefined, status: RecordValue): ProviderReconciliation {
    const session = sessionState(connection, sessionId);
    const untouched = !session.resumed && !session.submitted && !session.starting && !session.turnId;
    if (!turnId && untouched && status.type === 'idle') return { sessionId, state: 'idle' };
    return unknownProof(sessionId, turnId, 'No exact turn proof; idle does not prove an uncertain submission was never accepted');
}
export function reconcileThread(
    connection: Connection,
    sessionId: string,
    turnId: string | undefined,
    thread: RecordValue,
    hooks: ProtocolHooks,
): ProviderReconciliation {
    if (thread.id !== sessionId || !Array.isArray(thread.turns))
        return unknownProof(sessionId, turnId, 'Thread identity or turn history is unavailable');
    const turns = thread.turns.map(object);
    const active = turns.filter((turn) => turn.status === 'inProgress');
    if (active.length > 1) return unknownProof(sessionId, turnId, 'History reports multiple active turns');
    const turn = turnId ? turns.find((candidate) => candidate.id === turnId) : active[0];
    const status = object(thread.status);
    if (!turn) return noTurnProof(connection, sessionId, turnId, status);
    if (!string(turn.id)) return unknownProof(sessionId, turnId, 'Turn has no valid identity');
    if (['completed', 'failed', 'interrupted'].includes(string(turn.status))) return terminalProof(connection, sessionId, turn, hooks);
    return runningProof(connection, sessionId, turn, status, hooks);
}
