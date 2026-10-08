import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BotEvent } from '../src/core/queue.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { ConversationController } from '../src/operator/controller.js';
import { ControllerStore, conversationKey } from '../src/operator/controller-state.js';
import { posixOnly } from './fixtures.js';
import type { ApprovalDecision, ProviderAdapter, ProviderHooks } from '../src/operator/provider-adapter.js';
import type { Sharing } from '../src/operator/discordinator.js';

export class FakeProvider implements ProviderAdapter {
    hooks!: ProviderHooks;
    sessions: string[] = [];
    keys: string[] = [];
    resumed: string[] = [];
    turns: { sessionId: string; text: string; turnId: string }[] = [];
    decisions: { key: string; decision: ApprovalDecision }[] = [];
    interrupted: string[] = [];
    failStarts = 0;
    async connect(_config: unknown, hooks: ProviderHooks) {
        this.hooks = hooks;
        await hooks.onEvent({ type: 'connected', epoch: 'test-epoch' });
    }
    openSession(input: { sessionId?: string; conversationKey?: string }) {
        if (input.conversationKey) this.keys.push(input.conversationKey);
        if (input.sessionId) {
            this.resumed.push(input.sessionId);
            return Promise.resolve({ id: input.sessionId });
        }
        const id = `session-${this.sessions.length + 1}`;
        this.sessions.push(id);
        return Promise.resolve({ id });
    }
    startTurn(sessionId: string, input: { text: string }) {
        if (this.failStarts-- > 0) return Promise.reject(new Error('provider refused the turn'));
        const turnId = `turn-${this.turns.length + 1}`;
        this.turns.push({ sessionId, text: input.text, turnId });
        return Promise.resolve({ turnId });
    }
    async steer() {}
    interrupt(_sessionId: string, turnId: string) {
        this.interrupted.push(turnId);
        return Promise.resolve();
    }
    resolveApproval(key: string, decision: ApprovalDecision) {
        this.decisions.push({ key, decision });
        return Promise.resolve();
    }
    reconcile(sessionId: string) {
        return Promise.resolve({ sessionId, state: 'unknown' as const });
    }
    async close() {}
}
export const controllerEvent = (id: string, text = 'request'): BotEvent => ({
    id,
    text,
    kind: 'voice',
    conversation: 'aibinator',
    cursor: 1,
    receivedAt: new Date().toISOString(),
});
export async function settle(predicate: () => boolean) {
    for (let index = 0; index < 100; index++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(predicate(), 'Controller did not settle');
}
async function checkLifecycle(directory: string): Promise<void> {
    const event = controllerEvent;
    const store = new ControllerStore(join(directory, 'controller.json'));
    const adapter = new FakeProvider();
    const deliveries: { id: string; key: string; content: string }[] = [];
    const prompts: string[] = [];
    const controller = new ConversationController(
        adapter,
        defaultOperatorConfig(),
        store,
        (id, content, key) => {
            deliveries.push({ id, key, content });
            return Promise.resolve();
        },
        (_request, origin) => {
            prompts.push(origin);
            return Promise.resolve();
        },
    );
    await controller.start();
    assert.equal(await controller.ingest(event('first')), true);
    assert.equal(await controller.ingest(event('first')), false);
    await settle(() => adapter.turns.length === 1);
    const tools = adapter.hooks.tools!;
    const tool = (name: string) => tools.find((item) => item.name === name)!;
    assert.deepEqual(
        tools.map((item) => item.name),
        ['start_task', 'list_tasks', 'get_task_status', 'steer_task', 'cancel_task'],
    );
    assert.equal((await tool('start_task').call({ title: 'Nope', prompt: 'Denied recursive worker' }, 'worker-session')).success, false);
    await controller.ingest(event('second', 'follow-up while busy'));
    assert.equal(adapter.turns.length, 1);
    assert.equal(controller.status().queued, 1);
    const taskId = await controller.startTask(conversationKey(), 'independent worker');
    await settle(() => adapter.turns.length === 2);
    await settle(() => Boolean(controller.getTaskStatus(taskId).turnId));
    assert.equal(adapter.sessions.length, 2);
    assert.equal((await tool('get_task_status').call({ taskId }, 'session-1')).success, true);
    assert.equal((await tool('get_task_status').call({ taskId }, 'unrelated-session')).success, false);
    assert.equal(controller.getTaskStatus(taskId).state, 'running');
    await checkApproval(controller, adapter, prompts);
    await adapter.hooks.onEvent({ type: 'progress', sessionId: 'session-1', turnId: 'turn-1', text: 'optional activity', activity: true });
    assert.ok(!deliveries.some((item) => item.content === 'optional activity'));
    await controller.cancelTask(taskId);
    assert.equal(adapter.interrupted.length, 1);
    assert.equal(controller.getTaskStatus(taskId).state, 'cancelled');
    await adapter.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-1', text: 'complete' });
    await settle(() => adapter.turns.length === 3);
    assert.equal(adapter.turns[2]!.sessionId, 'session-1');
    assert.equal(adapter.sessions.length, 2);
    await checkRecovery(controller, store);
}
async function checkApproval(controller: ConversationController, adapter: FakeProvider, prompts: string[]): Promise<void> {
    await adapter.hooks.onEvent({
        type: 'approval.requested',
        request: {
            key: 'approval-1',
            epoch: 'test-epoch',
            sessionId: 'session-1',
            turnId: 'turn-1',
            kind: 'command',
            title: 'Run command',
            payload: {},
        },
    });
    assert.deepEqual(prompts, ['first']);
    await assert.rejects(controller.resolveApproval('approval-1', { action: 'allow-once' }, 'second'));
    await controller.resolveApproval('approval-1', { action: 'deny' }, 'first');
    assert.equal(adapter.decisions[0]!.decision.action, 'deny');
    await assert.rejects(controller.resolveApproval('approval-1', { action: 'allow-once' }, 'first'));
    const request = { key: 'approval-2', epoch: 'test-epoch', sessionId: 'session-1', turnId: 'turn-1', kind: 'command' as const };
    await adapter.hooks.onEvent({ type: 'approval.requested', request: { ...request, title: 'Run command', payload: {} } });
    await controller.resolveApproval('approval-2', { action: 'cancel' }, 'first');
    assert.deepEqual(adapter.interrupted, [], 'cancel is interrupted once, by the provider adapter only');
}
async function checkResumeAfterRestart(directory: string): Promise<void> {
    const file = join(directory, 'resume.json');
    const first = new FakeProvider();
    const sent: string[] = [];
    const deliver = (_id: string, content: string) => {
        sent.push(content);
        return Promise.resolve();
    };
    const before = new ConversationController(first, defaultOperatorConfig(), new ControllerStore(file), deliver, async () => {});
    await before.start();
    await before.ingest(controllerEvent('resume-1'));
    await settle(() => first.turns.length === 1 && before.status().busy === 1);
    await first.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-1', text: 'done' });
    await settle(() => before.status().busy === 0 && sent.length === 1);
    await before.stop();
    const second = new FakeProvider();
    const after = new ConversationController(second, defaultOperatorConfig(), new ControllerStore(file), deliver, async () => {});
    await after.start();
    await after.ingest(controllerEvent('resume-2'));
    await settle(() => second.turns.length === 1);
    assert.deepEqual(second.resumed, ['session-1'], 'persisted session is resumed on the new provider connection');
    assert.equal(second.turns[0]!.sessionId, 'session-1');
    await after.stop();
}
async function checkOutboxIsolation(directory: string): Promise<void> {
    const provider = new FakeProvider();
    const sent: string[] = [];
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'outbox.json')),
        (id, content) => {
            if (id === 'gone') return Promise.reject(new Error('AIBI is unreachable'));
            sent.push(`${id}:${content}`);
            return Promise.resolve();
        },
        async () => {},
    );
    await controller.start();
    await controller.ingest(controllerEvent('gone'));
    await controller.ingest(controllerEvent('alive'));
    await settle(() => provider.turns.length === 1);
    await provider.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-1', text: 'done' });
    await settle(() => provider.turns.length === 2);
    assert.equal(provider.turns[1]!.sessionId, 'session-1', 'every request shares the one AIBI conversation');
    await provider.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: 'turn-2', text: 'done' });
    await settle(() => sent.some((item) => item.startsWith('alive:')) && controller.status().pendingDelivery === 1);
    assert.deepEqual(sent, ['alive:done'], 'a failing reply does not block replies to later requests');
    await controller.stop();
}
async function checkRecovery(controller: ConversationController, store: ControllerStore): Promise<void> {
    const generation = store.snapshot().generation;
    await controller.stop();
    const recovered = new ControllerStore(store.file);
    await recovered.load();
    await recovered.acquire();
    assert.equal(recovered.snapshot().conversations[0]!.state, 'recovering');
    await assert.rejects(
        recovered.update(() => {}, generation),
        /generation/,
    );
    if (posixOnly) assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.ok((JSON.parse(await readFile(store.file, 'utf8')) as { seen: string[] }).seen.includes('first'));
}
async function checkHistory(directory: string): Promise<void> {
    const provider = new FakeProvider();
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'history.json')),
        () => Promise.resolve(),
        async () => {},
        {
            history: (_event, seen) =>
                Promise.resolve({ text: seen.aibi ? 'NEW\n' : 'HISTORY\n', key: 'aibi', latest: '2026-10-07T00:00:00.000Z' }),
        },
    );
    await controller.start();
    await controller.ingest(controllerEvent('history-1'));
    await settle(() => provider.turns.length === 1);
    assert.match(provider.turns[0]!.text, /^HISTORY\n/, 'a new conversation receives the recent AIBI conversation');
    await provider.hooks.onEvent({
        type: 'final',
        sessionId: provider.turns[0]!.sessionId,
        turnId: provider.turns[0]!.turnId,
        text: 'done',
    });
    await settle(() => controller.status().busy === 0);
    await controller.ingest(controllerEvent('history-2'));
    await settle(() => provider.turns.length === 2);
    assert.match(provider.turns[1]!.text, /^NEW\n/, 'later messages receive only what is new since the last update');
    await controller.stop();
}
function harness(directory: string, name: string, provider: FakeProvider, approval = () => Promise.resolve()) {
    const sent: string[] = [];
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, name)),
        (_id, content) => {
            sent.push(content);
            return Promise.resolve();
        },
        approval,
    );
    return { controller, sent };
}
const lastTurn = (provider: FakeProvider) => provider.turns.at(-1)!;
async function checkStopAndReset(directory: string): Promise<void> {
    const provider = new FakeProvider();
    const { controller, sent } = harness(directory, 'stop.json', provider, () => Promise.reject(new Error('prompt rejected')));
    await controller.start();
    await controller.ingest(controllerEvent('stop-1'));
    await settle(() => provider.turns.length === 1);
    await assert.rejects(controller.reset(), /still working/, '/new refuses while a turn runs instead of orphaning it');
    assert.equal(await controller.stopAll(), 1);
    assert.deepEqual(provider.interrupted, ['turn-1']);
    await provider.hooks.onEvent({ type: 'turn.failed', sessionId: 'session-1', turnId: 'turn-1', reason: 'aborted' });
    await settle(() => sent.includes('Stopped.'));
    await controller.reset();
    await controller.ingest(controllerEvent('stop-2'));
    await settle(() => provider.turns.length === 2);
    assert.equal(lastTurn(provider).sessionId, 'session-2', 'the next message after /new starts a new conversation');
    await provider.hooks.onEvent({
        type: 'approval.requested',
        request: {
            key: 'hidden',
            epoch: 'test-epoch',
            sessionId: 'session-2',
            turnId: 'turn-2',
            kind: 'command',
            title: 'Run ls',
            payload: {},
        },
    });
    await settle(() => sent.some((text) => text.includes('could not be shown here (prompt rejected)')));
    assert.deepEqual(provider.decisions, [{ key: 'hidden', decision: { action: 'deny' } }], 'an approval that cannot be shown is denied');
    await provider.hooks.onEvent({
        type: 'turn.failed',
        sessionId: 'session-2',
        turnId: 'turn-2',
        reason: 'Rate limit in /home/someone/x',
    });
    await settle(() => sent.some((text) => text.includes('(Rate limit in ~/x)')));
    await controller.ingest(controllerEvent('stop-3'));
    await settle(() => provider.turns.length === 3);
    const long = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} ${'word '.repeat(15)}`).join('\n\n');
    await provider.hooks.onEvent({ type: 'final', sessionId: 'session-2', turnId: 'turn-3', text: long });
    await settle(() => sent.some((text) => text.includes('Paragraph 59')));
    const chunks = sent.slice(sent.findIndex((text) => text.startsWith('Paragraph 0 ')));
    assert.ok(
        chunks.length > 1 && chunks.every((chunk) => chunk.length <= 2000 && chunk.startsWith('Paragraph')),
        'replies split on paragraphs',
    );
    await controller.stop();
}
async function checkUnstartedRecovery(directory: string): Promise<void> {
    const failing = new FakeProvider();
    failing.failStarts = 1;
    const before = harness(directory, 'unstarted.json', failing);
    await before.controller.start();
    await before.controller.ingest(controllerEvent('unstarted-1'));
    await settle(() => before.controller.status().failed);
    await before.controller.stop();
    const store = new ControllerStore(join(directory, 'unstarted.json'));
    await store.load();
    await store.update((state) => {
        state.conversations.push({ key: 'orphan', originEventId: 'orphan', seen: {}, state: 'recovering' });
    });
    const healthy = new FakeProvider();
    const after = harness(directory, 'unstarted.json', healthy);
    await after.controller.start();
    await settle(() => healthy.turns.length === 1);
    assert.ok(!after.sent.some((text) => text.includes('restarted')), 'a turn that never started gets no restart notice');
    assert.equal(after.controller.store.snapshot().conversations.find((item) => item.key === 'orphan')!.state, 'idle');
    await after.controller.stop();
}
async function checkShared(directory: string): Promise<void> {
    const provider = new FakeProvider();
    let sharing: Sharing = { state: 'unavailable', reason: 'Discordinator is not set up' };
    const controller = new ConversationController(
        provider,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'shared.json')),
        () => Promise.resolve(),
        async () => {},
        { shared: () => Promise.resolve(sharing) },
    );
    await controller.start();
    await controller.ingest(controllerEvent('shared-1'));
    await settle(() => controller.status().failed);
    assert.equal(provider.turns.length, 0, 'no private conversation is started when the Coordinator cannot be shared');
    assert.equal(controller.conversation()?.state, 'idle');
    assert.equal(controller.status().queued, 1, 'the request waits instead of being dropped');
    await controller.stop();
    sharing = { state: 'shared', shared: { sessionId: 'coordinator' } };
    const joined = new FakeProvider();
    const after = new ConversationController(
        joined,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'shared.json')),
        () => Promise.resolve(),
        async () => {},
        { shared: () => Promise.resolve(sharing) },
    );
    await after.start();
    await settle(() => joined.turns.length === 1);
    assert.deepEqual(joined.resumed, ['coordinator'], 'the Discordinator Coordinator conversation is joined');
    assert.equal(joined.turns[0]!.sessionId, 'coordinator');
    assert.equal(after.conversation()?.sessionId, 'coordinator', 'the joined Coordinator is remembered');
    await joined.hooks.onEvent({ type: 'turn.started', sessionId: 'coordinator', turnId: 'turn-1' });
    await joined.hooks.onEvent({ type: 'final', sessionId: 'coordinator', turnId: 'turn-1', text: 'done' });
    await settle(() => after.status().busy === 0);
    assert.equal(after.status().busy, 0, 'the reply in the shared Coordinator finishes the request');
    await after.stop();
}
export async function checkController(directory: string): Promise<void> {
    await checkShared(directory);
    await checkStopAndReset(directory);
    await checkUnstartedRecovery(directory);
    await checkHistory(directory);
    await checkLifecycle(directory);
    await checkResumeAfterRestart(directory);
    await checkOutboxIsolation(directory);
}
if (process.argv[1]?.endsWith('check-controller.ts')) {
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-controller-test-'));
    try {
        await checkController(directory);
        console.log('Controller lifecycle mock regressions passed');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
