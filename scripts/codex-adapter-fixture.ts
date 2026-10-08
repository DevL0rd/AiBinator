import assert from 'node:assert/strict';
import { roleInstructions } from '../src/operator/manager-guide.js';
import { PassThrough, Writable } from 'node:stream';
import { z } from 'zod';
import { CodexAdapter, type CodexTransport } from '../src/operator/codex-adapter.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import type { ProviderEvent, ProviderApproval, ProviderTool } from '../src/operator/provider-adapter.js';

export type Frame = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
export class MockTransport implements CodexTransport {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly sent: Frame[] = [];
    readonly stdin = new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
            this.sent.push(JSON.parse(chunk.toString()) as Frame);
            callback();
        },
    });
    stopped = false;
    private exit?: (reason: string) => void;
    private error?: (error: Error) => void;
    onExit(listener: (reason: string) => void): void {
        this.exit = listener;
    }
    onError(listener: (error: Error) => void): void {
        this.error = listener;
    }
    stop(): Promise<void> {
        this.stopped = true;
        return Promise.resolve();
    }
    receive(frame: Frame): void {
        this.stdout.write(`${JSON.stringify(frame)}\n`);
    }
    reply(frame: Frame, result: unknown): void {
        this.receive({ id: frame.id!, result });
    }
    fail(reason: string): void {
        this.exit?.(reason);
    }
    failSpawn(): void {
        this.error?.(new Error('mock spawn failure'));
    }
    async request(method: string, after = 0): Promise<Frame> {
        for (let attempt = 0; attempt < 20; attempt++) {
            const found = this.sent.slice(after).find((frame) => frame.method === method);
            if (found) return found;
            await settle();
        }
        throw new Error(`No request for ${method}`);
    }
}
export const settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
};
export const config = {
    ...defaultOperatorConfig(),
    mode: 'codex-local' as const,
    codexModel: 'test-model',
    codexEffort: 'high',
    instructions: 'Stay in scope.',
};

export async function connected(tools?: ProviderTool[]): Promise<{
    adapter: CodexAdapter;
    transport: MockTransport;
    events: ProviderEvent[];
    transports: MockTransport[];
}> {
    const transports: MockTransport[] = [];
    const events: ProviderEvent[] = [];
    const adapter = new CodexAdapter({
        spawnTransport: () => {
            const transport = new MockTransport();
            transports.push(transport);
            return transport;
        },
    });
    const connecting = adapter.connect(config, {
        ...(tools ? { tools } : {}),
        onEvent: (event) => {
            events.push(event);
            return Promise.resolve();
        },
    });
    const transport = transports[0]!;
    const initialize = await transport.request('initialize');
    assert.equal(transport.sent.length, 1);
    assert.deepEqual(initialize.params?.capabilities, { experimentalApi: true, mcpServerOpenaiFormElicitation: true });
    transport.reply(initialize, { userAgent: 'mock' });
    await connecting;
    await settle();
    assert.equal(transport.sent[1]?.method, 'initialized');
    assert.equal(events[0]?.type, 'connected');
    return { adapter, transport, events, transports };
}

export async function session(adapter: CodexAdapter, transport: MockTransport, id: string): Promise<void> {
    const after = transport.sent.length;
    const opening = adapter.openSession({ role: 'controller', conversationKey: id });
    const frame = await transport.request('thread/start', after);
    assert.equal(frame.params?.approvalPolicy, 'on-request');
    assert.equal(frame.params?.approvalsReviewer, 'user');
    assert.equal(frame.params?.model, config.codexModel);
    assert.equal(frame.params?.developerInstructions, roleInstructions('controller', config.instructions));
    assert.equal(frame.params?.sandbox, undefined);
    transport.reply(frame, { thread: { id, turns: [] } });
    assert.deepEqual(await opening, { id });
}

export async function turn(adapter: CodexAdapter, transport: MockTransport, sessionId: string, turnId: string): Promise<void> {
    const after = transport.sent.length;
    const starting = adapter.startTurn(sessionId, { text: 'Do the work.', originEventId: 'event-1', taskId: 'task-1' });
    const frame = await transport.request('turn/start', after);
    assert.equal(frame.params?.effort, 'high');
    assert.equal(frame.params?.clientUserMessageId, 'event-1');
    assert.deepEqual(frame.params?.responsesapiClientMetadata, { aibinator_task_id: 'task-1' });
    transport.reply(frame, { turn: { id: turnId, status: 'inProgress', items: [] } });
    assert.deepEqual(await starting, { turnId });
}

export async function latestApproval(events: ProviderEvent[]): Promise<ProviderApproval> {
    await settle();
    const event = events.filter((event) => event.type === 'approval.requested').at(-1);
    assert.ok(event?.type === 'approval.requested');
    return event.request;
}

export async function reconciliation(
    adapter: CodexAdapter,
    transport: MockTransport,
    sessionId: string,
    turnId: string | undefined,
    thread: unknown,
) {
    const after = transport.sent.length;
    const reading = adapter.reconcile(sessionId, turnId);
    const frame = await transport.request('thread/read', after);
    assert.deepEqual(frame.params, { threadId: sessionId, includeTurns: true });
    transport.reply(frame, { thread });
    return reading;
}

type Harness = Awaited<ReturnType<typeof connected>>;

export function mockTools() {
    const calls: { name: string; args: unknown; sessionId: string }[] = [];
    const tools: ProviderTool[] = ['start_task', 'get_task_status', 'steer_task', 'cancel_task'].map((name) => ({
        name,
        description: `Mock ${name}`,
        inputShape: { text: z.string() },
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        call: (args, sessionId) => {
            calls.push({ name, args, sessionId });
            if (name === 'get_task_status') return Promise.reject(new Error('Mock task unavailable'));
            return Promise.resolve({ success: true, text: 'Accepted by host' });
        },
    }));
    return { calls, tools };
}

export async function workerSession(h: Harness): Promise<void> {
    const after = h.transport.sent.length;
    const opening = h.adapter.openSession({ role: 'worker', conversationKey: 'tool-worker' });
    const frame = await h.transport.request('thread/start', after);
    assert.equal(frame.params?.dynamicTools, undefined);
    h.transport.reply(frame, { thread: { id: 'tool-worker', turns: [] } });
    await opening;
    await turn(h.adapter, h.transport, 'tool-worker', 'worker-turn');
}

export async function toolResponse(
    transport: MockTransport,
    id: string | number,
    params: Record<string, unknown>,
    success: boolean,
): Promise<void> {
    transport.receive({ id, method: 'item/tool/call', params });
    await settle();
    const response = transport.sent.findLast((frame) => frame.id === id);
    assert.equal((response?.result as { success?: boolean } | undefined)?.success, success);
    assert.equal(response?.error, undefined, 'tool failures are protocol tool-result failures');
}
export async function checkRecovery(h: Harness, restarted: MockTransport): Promise<void> {
    const { adapter, events } = h;
    assert.equal(
        (
            await reconciliation(adapter, restarted, 'controller', 'live', {
                id: 'controller',
                status: { type: 'notLoaded' },
                turns: [{ id: 'live', status: 'inProgress' }],
            })
        ).state,
        'unknown',
        'historical incomplete turns are not live-running proof',
    );
    assert.equal(
        (
            await reconciliation(adapter, restarted, 'controller', 'live', {
                id: 'controller',
                status: { type: 'idle' },
                turns: [{ id: 'different', status: 'completed' }],
            })
        ).state,
        'unknown',
        'missing exact turn cannot be inferred completed',
    );
    await assert.rejects(adapter.startTurn('controller', { text: 'Do not duplicate', originEventId: 'duplicate' }), /busy/);
    assert.deepEqual(
        await reconciliation(adapter, restarted, 'controller', 'live', {
            id: 'controller',
            status: { type: 'idle' },
            turns: [
                {
                    id: 'live',
                    status: 'completed',
                    items: [{ id: 'f', type: 'agentMessage', phase: 'final_answer', text: 'Recovered final' }],
                },
            ],
        }),
        { sessionId: 'controller', turnId: 'live', state: 'completed', text: 'Recovered final' },
    );
    assert.equal(
        (await reconciliation(adapter, restarted, 'controller', undefined, { id: 'controller', status: { type: 'idle' }, turns: [] }))
            .state,
        'unknown',
        'resumed idle alone never proves an uncertain submission absent',
    );
    const readAfter = restarted.sent.length;
    const readError = adapter.reconcile('controller', 'missing');
    const readFrame = await restarted.request('thread/read', readAfter);
    restarted.receive({ id: readFrame.id!, error: { code: -1, message: 'history unavailable' } });
    assert.equal((await readError).state, 'unknown');
    await settle();
    assert.equal(events.filter((event) => event.type === 'connected').length, 2);
    const epochs = events.filter((event) => event.type === 'connected').map((event) => event.epoch);
    assert.notEqual(epochs[0], epochs[1]);
}

export async function checkFailures(): Promise<void> {
    const spawnFailure = new MockTransport();
    const failing = new CodexAdapter({ spawnTransport: () => spawnFailure });
    const failure = failing.connect(config, { onEvent: async () => {} });
    spawnFailure.failSpawn();
    await assert.rejects(failure, /spawn failure/);
    assert.equal(spawnFailure.stopped, true);
    const timedOut = new CodexAdapter({ spawnTransport: () => new MockTransport(), requestTimeoutMs: 5 });
    await assert.rejects(timedOut.connect(config, { onEvent: async () => {} }), /acknowledgement timed out/);
    await checkSlowCall();
    await checkEarlyFrames();
}

async function checkSlowCall(): Promise<void> {
    const slowTransport = new MockTransport();
    const slow = new CodexAdapter({ spawnTransport: () => slowTransport, requestTimeoutMs: 50 });
    const slowConnect = slow.connect(config, { onEvent: async () => {} });
    slowTransport.reply(await slowTransport.request('initialize'), {});
    await slowConnect;
    await assert.rejects(slow.usage(), /acknowledgement timed out: account\/rateLimits\/read/);
    const after = slowTransport.sent.length;
    const usage = slow.usage();
    slowTransport.reply(await slowTransport.request('account/rateLimits/read', after), { rateLimits: {} });
    assert.deepEqual(await usage, [], 'one slow call fails alone; the connection stays up');
    await slow.close();
}

async function checkEarlyFrames(): Promise<void> {
    const early = await connected();
    try {
        const opening = early.adapter.openSession({ role: 'worker', conversationKey: 'early', sessionId: 'early-thread' });
        const frame = await early.transport.request('thread/resume');
        early.transport.receive({ method: 'turn/started', params: { threadId: 'early-thread', turn: { id: 'early-turn' } } });
        early.transport.receive({
            id: 1,
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'early-thread', turnId: 'early-turn', itemId: 'file' },
        });
        early.transport.reply(frame, { thread: { id: 'early-thread', turns: [] } });
        await opening;
        const earlyRequest = await latestApproval(early.events);
        assert.equal(earlyRequest.sessionId, 'early-thread', 'notifications preceding resume acknowledgement are retained');
        await early.adapter.resolveApproval(earlyRequest.key, { action: 'deny' });
        assert.deepEqual(early.transport.sent.at(-1), { id: 1, result: { decision: 'decline' } });
        early.transport.stdout.write('not-json\n');
        await settle();
        assert.equal(early.transport.stopped, true);
        await assert.rejects(early.adapter.steer('early-thread', 'early-turn', 'No'), /not connected/);
    } finally {
        await early.adapter.close();
    }
}
