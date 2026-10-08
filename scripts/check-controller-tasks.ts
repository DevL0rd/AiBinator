import assert from 'node:assert/strict';
import { join } from 'node:path';
import { claudeChoice, codexChoice, defaultOperatorConfig } from '../src/operator/config.js';
import { ConversationController } from '../src/operator/controller.js';
import { ControllerStore, conversationKey } from '../src/operator/controller-state.js';
import { desktopGuide, roleInstructions, workerBrief } from '../src/operator/manager-guide.js';
import { controllerEvent, FakeProvider, settle } from './check-controller.js';

type Tasks = { tasks: { id: string; title: string; state: string; progress?: string; result?: string }[] };

function checkGuides(): void {
    assert.match(
        roleInstructions('controller', 'Owner note.'),
        /^Requests from AIBI[\s\S]*manager of the work you start[\s\S]*start_task[\s\S]*list_tasks[\s\S]*spoken to them out loud[\s\S]*Owner note\.$/,
    );
    assert.match(
        roleInstructions('worker', 'Owner note.'),
        /^You are a worker[\s\S]*request made through AIBI[\s\S]*Your last message goes back to the responder[\s\S]*Owner note\.$/,
    );
    assert.doesNotMatch(roleInstructions('worker', undefined), /start_task/, 'workers are not told to start more workers');
    assert.match(
        desktopGuide(),
        /never as a background agent[\s\S]*session tools[\s\S]*claude --remote-control[\s\S]*claude agents --json/,
        'Claude Desktop manages chats with its own tools',
    );
    assert.doesNotMatch(desktopGuide(), /assistant_|--model/);
    assert.match(
        desktopGuide({}, 'responder-session'),
        /AIBI eventId[\s\S]*session ID responder-session[\s\S]*aibi_reply/,
        'new chats report back to the responder by its session',
    );
    assert.match(
        desktopGuide({ model: 'opus', effort: 'high' }),
        /start them with --model opus --effort high/,
        'new chats start with the model and effort chosen for them',
    );
    assert.deepEqual(
        claudeChoice({ ...defaultOperatorConfig(), claudeModel: 'sonnet', claudeEffort: 'low' }, true),
        { model: 'sonnet', effort: 'low' },
        'workers default to the responder’s choice',
    );
    assert.deepEqual(
        claudeChoice({ ...defaultOperatorConfig(), claudeModel: 'sonnet', claudeEffort: 'low', workerClaudeModel: 'opus' }, true),
        { model: 'opus' },
        'a different worker model does not inherit an effort it may not offer',
    );
    assert.deepEqual(codexChoice({ ...defaultOperatorConfig(), codexModel: 'gpt', workerCodexEffort: 'high' }, true), {
        model: 'gpt',
        effort: 'high',
    });
    assert.deepEqual(
        codexChoice({ ...defaultOperatorConfig(), codexModel: 'gpt', workerCodexModel: 'mini' }),
        { model: 'gpt' },
        'the responder keeps its own',
    );
    assert.equal(
        workerBrief('Ship it', 'Do the thing', 'event-1', 'AIBI · note'),
        'Task: Ship it\nRequested in: AIBI · note\nAIBI eventId for this work: "event-1"\n\nDo the thing',
    );
}

async function checkReport(
    controller: ConversationController,
    adapter: FakeProvider,
    sent: string[],
    taskId: string,
    worker: string,
): Promise<void> {
    await adapter.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: adapter.turns[0]!.turnId, text: 'On it' });
    await adapter.hooks.onEvent({ type: 'progress', sessionId: worker, turnId: adapter.turns[1]!.turnId, text: 'Halfway there' });
    assert.equal(controller.tasks.get(taskId).progress, 'Halfway there', 'the latest progress is kept for status questions');
    assert.ok(!sent.includes('Halfway there'), 'worker progress goes to the responder, not to AIBI');
    await adapter.hooks.onEvent({ type: 'final', sessionId: worker, turnId: adapter.turns[1]!.turnId, text: 'Built and green' });
    await settle(() => adapter.turns.length === 3);
    assert.equal(controller.tasks.get(taskId).state, 'completed');
    assert.ok(!sent.includes('Built and green'), 'a worker does not tell AIBI its result itself');
    assert.equal(adapter.turns[2]!.sessionId, 'session-1', 'the result is reported to the responder');
    assert.match(adapter.turns[2]!.text, /^\[Report from your worker "Build it" \(task [^)]+\): it finished\]\nBuilt and green\n/);
    await adapter.hooks.onEvent({ type: 'final', sessionId: 'session-1', turnId: adapter.turns[2]!.turnId, text: 'The build passed.' });
    await settle(() => sent.includes('The build passed.'));
}

export async function checkControllerTasks(directory: string): Promise<void> {
    checkGuides();
    const adapter = new FakeProvider();
    const sent: string[] = [];
    const controller = new ConversationController(
        adapter,
        defaultOperatorConfig(),
        new ControllerStore(join(directory, 'controller-tasks.json')),
        (_id, content) => {
            sent.push(content);
            return Promise.resolve();
        },
        () => Promise.resolve(),
        {
            brief: (eventId, title, prompt) => `${title} | ${eventId} | ${prompt}`,
            origin: (eventId) => (eventId === 'first' ? controllerEvent('first') : undefined),
        },
    );
    await controller.start();
    await controller.ingest(controllerEvent('first'));
    await settle(() => adapter.turns.length === 1);
    const tool = (name: string) => adapter.hooks.tools!.find((item) => item.name === name)!;
    const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse((await tool(name).call(args, 'session-1')).text) as unknown;

    const { taskId } = (await call('start_task', { title: 'Build it', prompt: 'Run the build' })) as { taskId: string };
    await settle(() => adapter.turns.length === 2);
    assert.equal(adapter.turns[1]!.text, 'Build it | first | Run the build', 'a worker gets the full brief with who asked');
    const worker = adapter.turns[1]!.sessionId;
    await settle(() => Boolean(controller.tasks.get(taskId).turnId));
    const listed = (await call('list_tasks', {})) as Tasks;
    assert.deepEqual([listed.tasks[0]!.title, listed.tasks[0]!.state], ['Build it', 'running'], 'workers are listed by title');

    await checkReport(controller, adapter, sent, taskId, worker);

    assert.equal(await controller.tasks.message(taskId, 'Now run the tests too', 'first'), 'queued');
    await settle(() => adapter.turns.length === 4);
    assert.deepEqual(
        [adapter.turns[3]!.sessionId, adapter.turns[3]!.text],
        [worker, 'Now run the tests too'],
        'follow-up work resumes the same worker',
    );
    assert.ok(adapter.resumed.includes(worker));

    const other = await controller.tasks.start({
        conversationKey: conversationKey(),
        originEventId: 'first',
        title: 'Research',
        prompt: 'Look into it',
    });
    await settle(() => adapter.turns.length === 5);
    assert.deepEqual(
        adapter.keys.filter((key) => key.startsWith('task:')),
        [`task:${taskId}`, `task:${taskId}`, `task:${other}`],
        'every worker has its own session',
    );
    const visible = (await call('list_tasks', {})) as Tasks;
    assert.ok(
        visible.tasks.some((item) => item.id === other),
        'every worker of the conversation is listed',
    );
    await settle(() => Boolean(controller.tasks.get(other).turnId));
    assert.deepEqual(await call('steer_task', { taskId: other, text: 'Focus on X' }), { sent: 'steered' }, 'a running worker is steered');
    await controller.stop();
}
