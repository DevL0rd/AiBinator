import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
    checkRecovery,
    checkFailures,
    MockTransport,
    connected,
    config,
    settle,
    session,
    turn,
    latestApproval,
    reconciliation,
    mockTools,
    workerSession,
    toolResponse,
} from './codex-adapter-fixture.js';
type Harness = Awaited<ReturnType<typeof connected>>;

async function checkDynamicTools(): Promise<void> {
    const { calls, tools } = mockTools();
    const h = await connected(tools);
    try {
        await session(h.adapter, h.transport, 'tool-controller');
        const start = h.transport.sent.find((frame) => frame.method === 'thread/start')!;
        assert.deepEqual(
            start.params?.dynamicTools,
            tools.map(({ name, description, inputSchema }) => ({
                type: 'function',
                name,
                description,
                inputSchema,
            })),
        );
        await turn(h.adapter, h.transport, 'tool-controller', 'tool-turn');
        await workerSession(h);
        const params = {
            threadId: 'tool-controller',
            turnId: 'tool-turn',
            callId: 'call-1',
            tool: 'start_task',
            arguments: { text: 'Task' },
        };
        await toolResponse(h.transport, 70, params, true);
        assert.deepEqual(calls[0], { name: 'start_task', args: { text: 'Task' }, sessionId: 'tool-controller' });
        await toolResponse(h.transport, '70', params, false);
        await toolResponse(h.transport, 71, { ...params, callId: 'call-2', arguments: { text: 3 } }, false);
        await toolResponse(h.transport, 72, { ...params, callId: 'call-3', arguments: { text: 'Task', extra: true } }, false);
        await toolResponse(h.transport, 73, { ...params, callId: 'call-4', tool: 'unknown_tool' }, false);
        await toolResponse(h.transport, 74, { ...params, callId: 'call-5', threadId: 'tool-worker', turnId: 'worker-turn' }, false);
        await toolResponse(h.transport, 75, { ...params, callId: 'call-6', turnId: 'old-turn' }, false);
        assert.equal(calls.length, 1, 'invalid, duplicate, stale, and worker calls never execute');
        await toolResponse(h.transport, 76, { ...params, callId: 'call-7', tool: 'get_task_status' }, false);
        assert.match(JSON.stringify(h.transport.sent.at(-1)?.result), /Mock task unavailable/);
        const before = h.events.length;
        h.transport.receive({
            method: 'item/reasoning/textDelta',
            params: { threadId: 'tool-controller', turnId: 'tool-turn', delta: 'private chain of thought' },
        });
        await settle();
        assert.equal(h.events.length, before, 'reasoning deltas are not relayed as progress');
        await checkStaleTool(h, params, tools);
    } finally {
        await h.adapter.close();
    }
}

async function checkStaleTool(h: Harness, params: Record<string, unknown>, tools: ReturnType<typeof mockTools>['tools']): Promise<void> {
    let finish!: (result: { success: boolean; text: string }) => void;
    tools[2]!.call = () =>
        new Promise((resolve) => {
            finish = resolve;
        });
    h.transport.receive({ id: 'pending-tool', method: 'item/tool/call', params: { ...params, callId: 'call-8', tool: 'steer_task' } });
    await settle();
    h.transport.receive({ method: 'serverRequest/resolved', params: { threadId: 'tool-controller', requestId: 'pending-tool' } });
    finish({ success: true, text: 'Late result' });
    await settle();
    assert.equal(
        h.transport.sent.some((frame) => frame.id === 'pending-tool'),
        false,
        'resolved requests discard late tool results',
    );
}

async function checkSessions(h: Harness): Promise<void> {
    const { adapter, transport, events } = h;
    await assert.rejects(adapter.connect(config, { onEvent: async () => {} }), /already connected/);
    await session(adapter, transport, 'controller');
    assert.deepEqual(
        await reconciliation(adapter, transport, 'controller', undefined, { id: 'controller', status: { type: 'idle' }, turns: [] }),
        { sessionId: 'controller', state: 'idle' },
    );
    assert.deepEqual(await adapter.openSession({ role: 'controller', conversationKey: 'controller' }), { id: 'controller' });
    await assert.rejects(adapter.openSession({ role: 'worker', conversationKey: 'other', sessionId: 'controller' }), /different role/);
    const after = transport.sent.length;
    const workerA = adapter.openSession({ role: 'worker', conversationKey: 'worker-a', sessionId: 'saved-worker' });
    const workerB = adapter.openSession({ role: 'worker', conversationKey: 'worker-b' });
    const resume = await transport.request('thread/resume', after);
    const start = await transport.request('thread/start', after);
    assert.equal(resume.params?.threadId, 'saved-worker');
    assert.notEqual(resume.id, start.id);
    transport.receive({ id: 'unrelated-id', result: { thread: { id: 'incorrect' } } });
    transport.reply(start, { thread: { id: 'fresh-worker', turns: [] } });
    transport.reply(resume, { thread: { id: 'saved-worker', turns: [{ id: 'old-turn', status: 'completed', items: [] }] } });
    assert.deepEqual(await workerB, { id: 'fresh-worker' });
    assert.deepEqual(await workerA, { id: 'saved-worker' });
    await settle();
    assert.equal(
        events.some((event) => event.type === 'final'),
        false,
        'resume never replays historical finals',
    );
}

async function checkTurnControls(h: Harness): Promise<void> {
    const { adapter, transport, transports } = h;
    await turn(adapter, transport, 'controller', 'turn-1');
    assert.equal(transports.length, 1, 'one long-lived process serves all sessions and turns');
    assert.equal(
        (
            await reconciliation(adapter, transport, 'controller', 'turn-1', {
                id: 'controller',
                status: { type: 'active', activeFlags: [] },
                turns: [{ id: 'turn-1', status: 'inProgress' }],
            })
        ).state,
        'running',
    );
    assert.equal(
        (
            await reconciliation(adapter, transport, 'controller', 'turn-1', {
                id: 'controller',
                status: { type: 'active', activeFlags: ['waitingOnApproval'] },
                turns: [{ id: 'turn-1', status: 'inProgress' }],
            })
        ).state,
        'waiting-approval',
    );
    assert.equal(
        (
            await reconciliation(adapter, transport, 'controller', 'missing', {
                id: 'controller',
                status: { type: 'idle' },
                turns: [{ id: 'turn-1', status: 'inProgress' }],
            })
        ).state,
        'unknown',
    );
    await assert.rejects(adapter.startTurn('controller', { text: 'Duplicate', originEventId: 'event-2' }), /busy/);
    await assert.rejects(adapter.steer('controller', 'wrong-turn', 'Change plan'), /active turn/);
    const steering = adapter.steer('controller', 'turn-1', 'Change plan');
    const steerFrame = await transport.request('turn/steer');
    assert.equal(steerFrame.params?.expectedTurnId, 'turn-1');
    transport.reply(steerFrame, { turnId: 'turn-1' });
    await steering;
    transport.receive({
        method: 'item/agentMessage/delta',
        params: { threadId: 'controller', turnId: 'turn-1', itemId: 'answer', delta: 'Partial' },
    });
    transport.receive({
        method: 'item/completed',
        params: {
            threadId: 'controller',
            turnId: 'turn-1',
            item: { id: 'comment', type: 'agentMessage', text: 'Working', phase: 'commentary' },
        },
    });
}

async function checkExecutions(h: Harness): Promise<string> {
    const { adapter, transport, events } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    transport.receive({ id: 7, method: 'item/commandExecution/requestApproval', params: approvalParams });
    const command = await latestApproval(events);
    assert.equal(
        transport.sent.some((frame) => frame.id === 7),
        false,
        'requests never auto-approve',
    );
    transport.receive({ id: '7', method: 'item/fileChange/requestApproval', params: approvalParams });
    const file = await latestApproval(events);
    assert.notEqual(command.key, file.key, 'string and numeric IDs must remain distinct');
    await adapter.resolveApproval(command.key, { action: 'allow-once' });
    assert.deepEqual(transport.sent.at(-1), { id: 7, result: { decision: 'accept' } });
    await adapter.resolveApproval(file.key, { action: 'deny' });
    assert.deepEqual(transport.sent.at(-1), { id: '7', result: { decision: 'decline' } });
    await assert.rejects(adapter.resolveApproval(command.key, { action: 'allow-once' }), /stale/);
    transport.receive({ method: 'serverRequest/resolved', params: { threadId: 'controller', requestId: 7 } });
    await settle();
    assert.ok(events.some((event) => event.type === 'approval.resolved' && event.key === command.key));
    return file.key;
}

async function checkQuestionsPermissions(h: Harness): Promise<void> {
    const { adapter, transport, events } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    transport.receive({
        id: 8,
        method: 'item/tool/requestUserInput',
        params: {
            ...approvalParams,
            isBlocking: false,
            questions: [
                { id: 'q', header: 'Plan', question: 'Which plan?', isSecret: true, options: [{ label: 'A', description: 'A plan' }] },
            ],
        },
    });
    const question = await latestApproval(events);
    assert.equal(question.secret, true);
    assert.equal((question.payload as Record<string, unknown>).isBlocking, false);
    await assert.rejects(adapter.resolveApproval(question.key, { action: 'allow-once' }), /explicit answers/);
    await assert.rejects(adapter.resolveApproval(question.key, { action: 'allow-once', answers: { q: ['B'] } }), /offered choice/);
    await adapter.resolveApproval(question.key, { action: 'allow-once', answers: { q: ['A'] } });
    assert.deepEqual(transport.sent.at(-1), { id: 8, result: { answers: { q: { answers: ['A'] } } } });
    transport.receive({
        id: 9,
        method: 'item/permissions/requestApproval',
        params: { ...approvalParams, permissions: { fileSystem: { write: ['/safe/file'] }, network: { enabled: true } } },
    });
    const permissions = await latestApproval(events);
    await assert.rejects(
        adapter.resolveApproval(permissions.key, { action: 'allow-once', permissions: { fileSystem: { write: ['/arbitrary/file'] } } }),
        /exceeds/,
    );
    await adapter.resolveApproval(permissions.key, { action: 'allow-once', permissions: { network: { enabled: true } } });
    assert.deepEqual(transport.sent.at(-1), { id: 9, result: { permissions: { network: { enabled: true } }, scope: 'turn' } });
}

async function checkElicitAndFinal(h: Harness, fileKey: string): Promise<void> {
    const { adapter, transport, events } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    transport.receive({
        id: 10,
        method: 'mcpServer/elicitation/request',
        params: { ...approvalParams, mode: 'form', message: 'Enter data', requestedSchema: { type: 'object' } },
    });
    const elicitation = await latestApproval(events);
    await adapter.resolveApproval(elicitation.key, { action: 'allow-once', content: { selection: 'chosen' } });
    assert.deepEqual(transport.sent.at(-1), { id: 10, result: { action: 'accept', content: { selection: 'chosen' } } });
    transport.receive({ id: 11, method: 'unknown/request', params: approvalParams });
    assert.deepEqual(transport.sent.at(-1), { id: 11, error: { code: -32601, message: 'Unsupported request or unowned thread' } });
    transport.receive({
        method: 'turn/completed',
        params: {
            threadId: 'controller',
            turn: {
                id: 'turn-1',
                status: 'completed',
                items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Finished.' }],
            },
        },
    });
    await settle();
    assert.deepEqual(events.filter((event) => event.type === 'final').at(-1), {
        type: 'final',
        sessionId: 'controller',
        turnId: 'turn-1',
        text: 'Finished.',
    });
    await assert.rejects(adapter.resolveApproval(fileKey, { action: 'cancel' }), /stale/);
}

async function checkInterruptions(h: Harness): Promise<void> {
    const { adapter, transport, events } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    await turn(adapter, transport, 'controller', 'turn-2');
    transport.receive({ id: 12, method: 'item/fileChange/requestApproval', params: { ...approvalParams, turnId: 'turn-2' } });
    const cancelledFile = await latestApproval(events);
    await adapter.resolveApproval(cancelledFile.key, { action: 'cancel' });
    assert.deepEqual(transport.sent.at(-1), { id: 12, result: { decision: 'cancel' } });
    const interruption = adapter.interrupt('controller', 'turn-2');
    const interrupt = await transport.request('turn/interrupt');
    assert.equal(interrupt.params?.turnId, 'turn-2');
    transport.reply(interrupt, {});
    await interruption;
    transport.receive({
        method: 'turn/completed',
        params: { threadId: 'controller', turn: { id: 'turn-2', status: 'interrupted', items: [] } },
    });
    await settle();
    assert.ok(events.some((event) => event.type === 'turn.failed' && event.turnId === 'turn-2'));
}

async function checkFastFinish(h: Harness): Promise<string | number> {
    const { adapter, transport } = h;
    const fastAfter = transport.sent.length;
    const fast = adapter.startTurn('controller', { text: 'Fast', originEventId: 'fast' });
    const fastFrame = await transport.request('turn/start', fastAfter);
    transport.receive({ method: 'turn/started', params: { threadId: 'controller', turn: { id: 'fast-turn' } } });
    transport.receive({
        method: 'turn/completed',
        params: { threadId: 'controller', turn: { id: 'fast-turn', status: 'completed', items: [] } },
    });
    transport.reply(fastFrame, { turn: { id: 'fast-turn', status: 'inProgress', items: [] } });
    await fast;
    await turn(adapter, transport, 'controller', 'turn-3');
    return fastFrame.id!;
}

async function checkCancellation(h: Harness): Promise<void> {
    const { adapter, transport, events } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    transport.receive({
        id: 'permission-deny',
        method: 'item/permissions/requestApproval',
        params: { ...approvalParams, turnId: 'turn-3', permissions: { network: { enabled: true } } },
    });
    const deniedPermission = await latestApproval(events);
    await adapter.resolveApproval(deniedPermission.key, { action: 'deny' });
    assert.deepEqual(transport.sent.at(-1), { id: 'permission-deny', result: { permissions: {}, scope: 'turn' } });
    transport.receive({
        id: 'question-cancel',
        method: 'item/tool/requestUserInput',
        params: { ...approvalParams, turnId: 'turn-3', isBlocking: true, questions: [{ id: 'q', header: 'Q', question: 'Question?' }] },
    });
    const cancelledQuestion = await latestApproval(events);
    const cancelAfter = transport.sent.length;
    const cancelling = adapter.resolveApproval(cancelledQuestion.key, { action: 'cancel' });
    const cancelInterrupt = await transport.request('turn/interrupt', cancelAfter);
    assert.deepEqual(transport.sent[cancelAfter], { id: 'question-cancel', result: { answers: {} } });
    transport.reply(cancelInterrupt, {});
    await cancelling;
    transport.receive({
        id: 'elicit-deny',
        method: 'mcpServer/elicitation/request',
        params: {
            threadId: 'controller',
            serverName: 'mock',
            mode: 'url',
            message: 'Approve?',
            url: 'https://example.com',
            elicitationId: 'e',
        },
    });
    const deniedElicitation = await latestApproval(events);
    assert.equal(deniedElicitation.turnId, '', 'standalone elicitation must not invent a turn');
    await adapter.resolveApproval(deniedElicitation.key, { action: 'deny' });
    assert.deepEqual(transport.sent.at(-1), { id: 'elicit-deny', result: { action: 'decline', content: null } });
}

async function checkReconnect(h: Harness, oldRequestId: string | number): Promise<MockTransport> {
    const { adapter, transport, events, transports } = h;
    const approvalParams = { threadId: 'controller', turnId: 'turn-1', itemId: 'cmd', command: 'echo test' };
    transport.receive({ id: 13, method: 'item/commandExecution/requestApproval', params: { ...approvalParams, turnId: 'turn-3' } });
    const stale = await latestApproval(events);
    const uncertain = adapter.steer('controller', 'turn-3', 'Pending');
    transport.fail('connection lost');
    await assert.rejects(uncertain, /connection lost/);
    await assert.rejects(adapter.resolveApproval(stale.key, { action: 'allow-once' }), /not connected/);
    assert.equal(transport.stopped, true);
    const reconnecting = adapter.connect(config, {
        onEvent: (event) => {
            events.push(event);
            return Promise.resolve();
        },
    });
    const restarted = transports[1]!;
    const init2 = await restarted.request('initialize');
    restarted.receive({ id: oldRequestId, result: { turn: { id: 'wrong' } } });
    restarted.reply(init2, {});
    await reconnecting;
    await assert.rejects(adapter.resolveApproval(stale.key, { action: 'allow-once' }), /stale/);
    await assert.rejects(adapter.startTurn('controller', { text: 'Old connection', originEventId: 'old' }), /not owned/);
    const recovered = adapter.openSession({ role: 'controller', conversationKey: 'controller', sessionId: 'controller' });
    const recoveredFrame = await restarted.request('thread/resume');
    restarted.reply(recoveredFrame, { thread: { id: 'controller', turns: [{ id: 'live', status: 'inProgress', items: [] }] } });
    await recovered;
    return restarted;
}

export async function checkCodexAdapter(): Promise<void> {
    const harness = await connected();
    try {
        await checkSessions(harness);
        await checkTurnControls(harness);
        const fileKey = await checkExecutions(harness);
        await checkQuestionsPermissions(harness);
        await checkElicitAndFinal(harness, fileKey);
        await checkInterruptions(harness);
        const oldId = await checkFastFinish(harness);
        await checkCancellation(harness);
        const restarted = await checkReconnect(harness, oldId);
        await checkRecovery(harness, restarted);
    } finally {
        await harness.adapter.close();
    }
    await checkFailures();
    await checkDynamicTools();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await checkCodexAdapter();
    console.log('Codex adapter mock checks passed');
}
