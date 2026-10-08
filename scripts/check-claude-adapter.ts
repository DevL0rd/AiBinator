import assert from 'node:assert/strict';
import { roleInstructions } from '../src/operator/manager-guide.js';
import { z } from 'zod';
import { ClaudeAdapter } from '../src/operator/claude-adapter.js';
import type {
    ClaudeMessage,
    ClaudeMcpFactory,
    ClaudePermissionResult,
    ClaudeQuery,
    ClaudeQueryFactory,
    ClaudeQueryOptions,
    ClaudeToolFactory,
    ClaudeUserMessage,
} from '../src/operator/claude-protocol.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import type { ProviderEvent } from '../src/operator/provider-adapter.js';

class OutputQueue implements AsyncIterable<ClaudeMessage> {
    private readonly values: ClaudeMessage[] = [];
    private readonly waiters: Array<(value: IteratorResult<ClaudeMessage>) => void> = [];
    private ended = false;

    push(value: ClaudeMessage): void {
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.values.push(value);
    }

    close(): void {
        this.ended = true;
        this.waiters.splice(0).forEach((resolve) => resolve({ value: undefined, done: true }));
    }

    async *[Symbol.asyncIterator](): AsyncIterator<ClaudeMessage> {
        while (true) {
            const item = await this.nextOutput();
            if (item.done) return;
            yield item.value;
        }
    }
    private nextOutput(): Promise<IteratorResult<ClaudeMessage>> {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
    }
}

export type FakeCall = {
    options: ClaudeQueryOptions;
    inputs: ClaudeUserMessage[];
    query: FakeQuery;
};

export class FakeQuery extends OutputQueue implements ClaudeQuery {
    readonly controller = new AbortController();
    interrupted = 0;
    closed = 0;
    releaseBusy?: () => void;

    constructor(
        prompt: AsyncIterable<ClaudeUserMessage>,
        readonly options: ClaudeQueryOptions,
        readonly inputs: ClaudeUserMessage[],
    ) {
        super();
        void this.consume(prompt);
    }

    interrupt(): Promise<void> {
        this.interrupted += 1;
        return Promise.resolve();
    }

    override close(): void {
        this.closed += 1;
        this.controller.abort();
        super.close();
    }

    private async consume(prompt: AsyncIterable<ClaudeUserMessage>): Promise<void> {
        this.push({
            type: 'system',
            subtype: 'init',
            session_id: this.options.resume ?? this.options.sessionId,
        });
        for await (const input of prompt) {
            this.inputs.push(input);
            const text = input.message.content;
            if (text === 'busy') await new Promise<void>((resolve) => (this.releaseBusy = resolve));
            if (text === 'approve' || text === 'deny' || text === 'cancel' || text === 'abort') {
                const result = await this.options.canUseTool('Bash', { command: 'echo redacted' }, { signal: this.controller.signal });
                this.finishPermission(text, result);
                continue;
            }
            if (text === 'question') {
                const result = await this.options.canUseTool(
                    'AskUserQuestion',
                    {
                        questions: [
                            {
                                question: 'Pick one',
                                options: [{ label: 'A' }, { label: 'B' }],
                                multiSelect: false,
                            },
                        ],
                    },
                    { signal: this.controller.signal },
                );
                const answer = asAllow(result).updatedInput.answers as Record<string, string[]>;
                assert.deepEqual(answer, { 'Pick one': ['B'] });
                this.push({ type: 'result', subtype: 'success', result: 'answered' });
                continue;
            }
            this.push({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'thinking', thinking: 'private' },
                        { type: 'tool_use', name: 'Read', input: { secret: 'not forwarded' } },
                        { type: 'text', text },
                    ],
                },
            });
            this.push({ type: 'result', subtype: 'success', result: `done:${text}` });
        }
    }

    private finishPermission(text: string, result: ClaudePermissionResult): void {
        if (text === 'approve') assert.equal(result.behavior, 'allow');
        else
            assert.deepEqual(result, {
                behavior: 'deny',
                message:
                    text === 'cancel'
                        ? 'User canceled this request'
                        : text === 'abort'
                          ? 'Approval request expired'
                          : 'User denied this request',
            });
        this.push({ type: 'result', subtype: 'success', result: text });
    }
}

const asAllow = (result: ClaudePermissionResult): Extract<ClaudePermissionResult, { behavior: 'allow' }> => {
    assert.equal(result.behavior, 'allow');
    return result;
};

const tick = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
export const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await tick();
    }
    throw new Error('Timed out waiting for fake Claude event');
};

type FakeTool = { name: string; handler(args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> };
type Harness = { adapter: ClaudeAdapter; calls: FakeCall[]; events: ProviderEvent[]; tools: FakeTool[]; toolSessions: string[] };

async function makeHarness(): Promise<Harness> {
    const calls: FakeCall[] = [];
    const factory: ClaudeQueryFactory = ({ prompt, options }) => {
        const inputs: ClaudeUserMessage[] = [];
        const query = new FakeQuery(prompt, options, inputs);
        calls.push({ options, inputs, query });
        return query;
    };
    const events: ProviderEvent[] = [];
    const tools: FakeTool[] = [];
    const toolFactory: ClaudeToolFactory = (name, _description, _shape, handler) => ({ name, handler });
    const mcpFactory: ClaudeMcpFactory = ({ tools: definitions }) => ({ definitions });
    const adapter = new ClaudeAdapter(
        () => Promise.resolve(factory),
        () => Promise.resolve({ createSdkMcpServer: mcpFactory, tool: toolFactory }),
    );
    const toolSessions: string[] = [];
    await adapter.connect(
        {
            ...defaultOperatorConfig(),
            mode: 'claude-session',
            workspace: '/workspace',
            claudeModel: 'test-model',
            claudeEffort: 'high',
            instructions: 'Keep the controller responsive.',
        },
        {
            onEvent: (event) => {
                events.push(event);
                return Promise.resolve();
            },
            tools: [
                {
                    name: 'get_task_status',
                    description: 'Get task status',
                    inputSchema: { type: 'object' },
                    inputShape: { taskId: z.string() },
                    call: (_args, sessionId) => {
                        toolSessions.push(sessionId);
                        return Promise.resolve({ success: true, text: 'ready' });
                    },
                },
            ],
        },
    );
    return { adapter, calls, events, tools, toolSessions };
}

async function checkReuse(harness: Harness): Promise<string> {
    const { adapter, calls, events } = harness;
    const controller = await adapter.openSession({
        role: 'controller',
        conversationKey: 'control',
    });
    const controllerServer = calls[0]!.options.mcpServers?.aibinator as { definitions: FakeTool[] };
    assert.equal(calls[0]!.options.sessionId, controller.id, 'new SDK session uses the returned exact UUID');
    harness.tools.push(...controllerServer.definitions);
    assert.equal(harness.tools[0]!.name, 'get_task_status');
    assert.deepEqual(await harness.tools[0]!.handler({ taskId: 'task' }), { content: [{ type: 'text', text: 'ready' }] });
    assert.deepEqual(harness.toolSessions, [controller.id]);
    const first = await adapter.startTurn(controller.id, {
        text: 'hello',
        originEventId: 'one',
    });
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === first.turnId));
    assert.deepEqual(await adapter.reconcile(controller.id, first.turnId), {
        sessionId: controller.id,
        state: 'completed',
        turnId: first.turnId,
        text: 'done:hello',
    });
    const second = await adapter.startTurn(controller.id, {
        text: 'again',
        originEventId: 'two',
    });
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === second.turnId));
    assert.equal(calls.length, 1, 'a session keeps one persistent query process');
    assert.deepEqual(
        calls[0]!.inputs.map((input) => input.message.content),
        ['hello', 'again'],
    );
    assert.equal(calls[0]!.options.model, 'test-model');
    assert.equal(calls[0]!.options.effort, 'high');
    assert.deepEqual(calls[0]!.options.systemPrompt, {
        type: 'preset',
        preset: 'claude_code',
        append: roleInstructions('controller', 'Keep the controller responsive.'),
        snapshot: true,
    });
    assert.ok(events.every((event) => event.type !== 'progress' || !event.text.includes('private')));
    assert.ok(events.some((event) => event.type === 'progress' && event.text.startsWith('Reading') && event.activity));
    assert.ok(events.some((event) => event.type === 'progress' && event.text === 'hello' && !event.activity));
    return controller.id;
}

async function checkIndependence(harness: Harness, controllerId: string): Promise<string> {
    const { adapter, calls, events } = harness;
    const resumed = await adapter.openSession({
        role: 'worker',
        conversationKey: 'saved',
        sessionId: 'saved-session',
    });
    assert.equal(calls[1]!.options.mcpServers, undefined, 'workers receive no controller MCP server');
    assert.equal(calls[1]!.options.resume, 'saved-session', 'resume uses the exact saved session id');
    assert.equal(calls[1]!.options.sessionId, undefined, 'resume is not combined with a new session ID');
    const worker = await adapter.openSession({
        role: 'worker',
        conversationKey: 'worker-two',
    });
    const busy = await adapter.startTurn(resumed.id, {
        text: 'busy',
        originEventId: 'busy',
    });
    assert.equal((await adapter.reconcile(resumed.id, busy.turnId)).state, 'running');
    const responsive = await adapter.startTurn(controllerId, {
        text: 'responsive',
        originEventId: 'responsive',
    });
    const independent = await adapter.startTurn(worker.id, {
        text: 'independent',
        originEventId: 'independent',
    });
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === responsive.turnId));
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === independent.turnId));
    assert.ok(!events.some((event) => event.type === 'final' && event.turnId === busy.turnId));
    calls[1]!.query.releaseBusy!();
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === busy.turnId));
    return worker.id;
}

async function checkDecisions(harness: Harness, controllerId: string): Promise<void> {
    const { adapter, events } = harness;
    for (const action of ['approve', 'deny', 'cancel'] as const) {
        const turn = await adapter.startTurn(controllerId, {
            text: action,
            originEventId: action,
        });
        await waitFor(() => events.some((event) => event.type === 'approval.requested' && event.request.turnId === turn.turnId));
        const request = events.find(
            (event): event is Extract<ProviderEvent, { type: 'approval.requested' }> =>
                event.type === 'approval.requested' && event.request.turnId === turn.turnId,
        )!.request;
        assert.equal((await adapter.reconcile(controllerId, turn.turnId)).state, 'waiting-approval');
        await adapter.resolveApproval(request.key, {
            action: action === 'approve' ? 'allow-once' : action,
        });
        await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === turn.turnId));
        await assert.rejects(() => adapter.resolveApproval(request.key, { action: 'deny' }), /expired/);
    }
    assert.equal(harness.calls[0]!.query.interrupted, 1, 'cancelling an approval interrupts the turn once, inside the adapter');

    const question = await adapter.startTurn(controllerId, {
        text: 'question',
        originEventId: 'question',
    });
    await waitFor(() => events.some((event) => event.type === 'approval.requested' && event.request.turnId === question.turnId));
    const questionRequest = events.find(
        (event): event is Extract<ProviderEvent, { type: 'approval.requested' }> =>
            event.type === 'approval.requested' && event.request.turnId === question.turnId,
    )!.request;
    assert.equal(questionRequest.kind, 'question');
    await adapter.resolveApproval(questionRequest.key, {
        action: 'allow-once',
        answers: { 'Pick one': ['B'] },
    });
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === question.turnId));
}

async function checkLifecycle(harness: Harness, controllerId: string, workerId: string): Promise<void> {
    const { adapter, calls, events } = harness;
    const aborted = await adapter.startTurn(workerId, {
        text: 'abort',
        originEventId: 'abort',
    });
    await waitFor(() => events.some((event) => event.type === 'approval.requested' && event.request.turnId === aborted.turnId));
    calls[2]!.query.controller.abort();
    await waitFor(() => events.some((event) => event.type === 'approval.resolved' && event.key.includes(aborted.turnId)));

    const interruptible = await adapter.startTurn(controllerId, {
        text: 'busy',
        originEventId: 'interruptible',
    });
    await waitFor(() => calls[0]!.inputs.some((input) => input.message.content === 'busy'));
    await adapter.interrupt(controllerId, interruptible.turnId);
    assert.equal(calls[0]!.query.interrupted, 2, 'interrupt delegates to the live provider query');
    calls[0]!.query.releaseBusy!();
    await waitFor(() => events.some((event) => event.type === 'final' && event.turnId === interruptible.turnId));
    await adapter.close();
    await adapter.close();
    assert.ok(
        calls.every((call) => call.query.closed === 1),
        'close is idempotent',
    );
    await assert.rejects(() => adapter.startTurn(controllerId, { text: 'late', originEventId: 'late' }), /not connected/);
    assert.equal((await adapter.reconcile('missing', 'missing-turn')).state, 'unknown');
}

export async function checkClaudeAdapter(): Promise<void> {
    const unavailableEvents: ProviderEvent[] = [];
    const unavailable = new ClaudeAdapter(() => Promise.reject(new Error('SDK unavailable')));
    await assert.rejects(
        unavailable.connect(defaultOperatorConfig(), {
            onEvent: (event) => {
                unavailableEvents.push(event);
                return Promise.resolve();
            },
        }),
        /SDK unavailable/,
    );
    assert.equal(unavailableEvents.length, 0, 'connect is not emitted before SDK transport availability');
    const harness = await makeHarness();
    const controllerId = await checkReuse(harness);
    const workerId = await checkIndependence(harness, controllerId);
    await checkDecisions(harness, controllerId);
    await checkLifecycle(harness, controllerId, workerId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    void checkClaudeAdapter().then(() => console.log('claude adapter checks passed'));
}
