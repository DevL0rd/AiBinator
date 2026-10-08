import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { deskFixture, pcm, played, result, stream, type FakeSession } from './aibi-fakes.js';

const info = { index: 1, timeZone: 'UTC' };
const chat = { ...info, chat: true };
const told = (session: FakeSession) => session.named('text').map((call) => String(call[1]));

async function checkTaskResult(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'task-')));
    gemini.reply = (session, cause) => {
        if (cause === 'turn') session.events.tool('call-1', 'do_task', { task: 'check whether the build passed' });
        session.speak(cause === 'turn' ? 'On it.' : 'The build passed.');
    };
    const started = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(started).behavior_paras.type, 'connect', 'the acknowledgement keeps AIBI in conversation mode for the result');
    played(host, started);
    const page = host.queue.snapshot(0, 10);
    assert.equal(page.events.length, 1, 'the work is handed to the responder');
    assert.equal(page.events[0]!.text, 'check whether the build passed');
    assert.equal(desk.status().tasks, 1);
    const context = host.queue.context(page.events[0]!.id);
    await context.respond!('Running the tests', true);
    assert.equal(told(gemini.last).length, 0, 'progress is only logged');
    assert.equal(host.activity.recent(10, 'task').at(-1)!.title, 'Progress');
    await context.respond!('The build passed with no failures.', false);
    assert.equal(desk.status().tasks, 0);
    const reply = await desk.listen(stream(pcm(false)), chat);
    assert.equal(result(reply).behavior_paras.txt, 'The build passed.', 'a waiting result is told on the next silent turn');
    assert.ok(told(gemini.last).some((text) => text.includes('[Task update] The build passed with no failures.')));
}

async function checkAcknowledgement(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'ack-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'do_task', { task: 'minimize all windows' });
        session.events.turnComplete();
        setTimeout(() => session.speak('On it!'), 20);
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).behavior_paras.txt, 'On it!', 'a task always gets a spoken acknowledgement');
    const tool = gemini.last.named('tool')[0]!;
    assert.match(String((tool[3] as { status: string }).status), /tell them now/);
}

async function checkKeptResult(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'kept-')));
    gemini.reply = (session) => session.speak('Hello!');
    await desk.listen(stream(pcm(true)), info);
    assert.equal(desk.tell('[Task update] Done.'), 'now');
    await desk.end();
    assert.equal(desk.status().waiting, 1, 'a result the voice never told waits for the next wake');
}

async function checkQuickTask(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'quick-')));
    gemini.reply = (session, cause) => {
        if (cause === 'turn') session.events.tool('call-1', 'do_task', { task: 'open YouTube', quick: 'yes' });
        session.speak(cause === 'turn' ? 'Opening it now.' : 'YouTube is open.');
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).rec_behavior, 'interact_speak', 'a quick task does not start conversation mode');
    const speech = host.speeches.find(String(result(reply).behavior_paras.url).split('/').at(-1)!)!;
    assert.equal(speech.open, true, 'the answer stays open while the task runs');
    const event = host.queue.snapshot(0, 10).events[0]!;
    await host.queue.context(event.id).respond!('YouTube is open.', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(speech.open, false, 'the result is spoken into the same answer, which then ends');
    assert.ok(host.memory.recent(5).some((line) => line.text === 'YouTube is open.'));
}

async function checkEndingWithResult(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'ending-result-')));
    gemini.reply = (session, cause) => {
        if (cause !== 'turn') return session.speak('YouTube is open.');
        desk.tell('[Task update] YouTube is open.');
        session.events.tool('call-1', 'end_conversation', {});
        session.speak('Bye!');
    };
    await desk.listen(stream(pcm(true)), chat);
    const told = await desk.listen(stream(pcm(false)), chat);
    assert.equal(
        result(told).behavior_paras.txt,
        'YouTube is open.',
        'a result that arrives as the conversation ends is told before leaving',
    );
    const left = await desk.listen(stream(pcm(false)), chat);
    assert.deepEqual(result(left).behavior_paras, { type: 'quit' });
}

async function checkPause(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'pause-')));
    gemini.reply = (session) => session.speak('Hello!');
    await desk.listen(stream(pcm(true)), chat);
    const reply = await desk.listen(stream(pcm(false)), chat);
    assert.equal(result(reply).behavior_paras.txt, '', 'a quiet moment keeps AIBI listening');
    assert.equal(gemini.last.named('start').length, 1, 'quiet uploads never reach Gemini');
    assert.equal(desk.active, true);
}

async function checkIdle(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'idle-')));
    gemini.reply = (session) => session.speak('Hello!');
    await desk.listen(stream(pcm(true)), chat);
    await desk.end();
    const reply = await desk.listen(stream(pcm(false)), chat);
    assert.deepEqual(result(reply).behavior_paras, { type: 'quit' }, 'after the voice ended, the next quiet turn leaves conversation mode');
    assert.equal(desk.active, false);
}

async function checkOutbox(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'outbox-')));
    gemini.reply = (session) => session.speak('Dinner is ready!');
    assert.equal((await desk.chatStart('UTC')).errcode, 500, 'with nothing waiting, AIBI does not start a chat by itself');
    assert.equal(desk.active, false);
    assert.equal(desk.say('Dinner is ready'), 'later', 'with no conversation it waits for AIBI');
    assert.equal(desk.status().waiting, 1);
    const reply = await desk.chatStart('UTC');
    assert.equal(reply.responsetag, 'chatstart');
    assert.match(String(reply.url), /\/tts\/dl\//);
    assert.ok(
        told(gemini.last).some((text) => text.includes('Dinner is ready')),
        'the reach-out says the waiting message',
    );
    assert.equal(desk.status().waiting, 0);
    assert.equal(desk.say('And dessert'), 'now', 'during a conversation it is told right away');
    await desk.end();
    assert.equal(desk.playAction('ability_dance', {}), false, 'an action outside a conversation is not saved for later');
    assert.equal(desk.status().waiting, 1, 'only the untold message waits');
    desk.say('The build passed');
    desk.say('Mom called');
    await desk.chatStart('UTC');
    assert.match(
        told(gemini.last).at(-1)!,
        /one short message that keeps every important detail/,
        'several waiting messages are told together',
    );
    assert.equal(desk.status().waiting, 0);
}

async function checkOneShots(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'oneshot-')));
    gemini.reply = (session) => session.speak('Hi.');
    const boot = await desk.powerOn('UTC');
    assert.equal(boot.responsetag, 'poweronvoice');
    assert.match(String(boot.url), /\/poweron\/dl\//, 'power-on speech uses its own download path');
    assert.deepEqual(gemini.last.options.tools, [], 'one-shot speech has no tools');
    const tts = await desk.readAloud('Ten minutes left');
    assert.equal(tts.responsetag, 'tts');
    assert.ok(told(gemini.last).some((text) => text.includes('Ten minutes left')));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gemini.last.named('close').length, 1, 'one-shot sessions close after speaking');
    assert.equal(desk.active, false);
}

async function checkSpokenToolResult(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'tool-result-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'assistant', { command: 'status' });
        session.events.turnComplete();
        setTimeout(() => session.speak('Nothing is running right now.'), 30);
    };
    const reply = await desk.listen(stream(pcm(true)), chat);
    assert.equal(result(reply).behavior_paras.txt, 'Nothing is running right now.', 'the answer waits for a tool result it has to speak');
    assert.equal((gemini.last.named('tool')[0]![4] as { scheduling: string }).scheduling, 'idle', 'and the voice is asked to speak it');
}

async function checkDuplicateTask(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'duplicate-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'do_task', { task: 'Check the CPU usage' });
        session.events.tool('call-2', 'do_task', { task: 'check the CPU usage' });
        session.speak('Checking now.');
    };
    await desk.listen(stream(pcm(true)), chat);
    assert.equal(host.queue.snapshot(0, 10).events.length, 1, 'the same task asked twice is only started once');
    assert.match(String((gemini.last.named('tool')[1]![3] as { status: string }).status), /already running/);
}

async function checkQuestions(directory: string): Promise<void> {
    const answers: [string, string][] = [];
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'questions-')), {
        answer: (request, answer) => {
            answers.push([request, answer]);
            return Promise.resolve('passed on; the work continues');
        },
    });
    gemini.reply = (session) => {
        session.events.tool('call-1', 'answer_request', { request: 'ab12cd', answer: 'allow' });
        session.events.tool('call-2', 'assistant', { command: 'usage' });
        session.speak('Done.');
    };
    await desk.listen(stream(pcm(true)), info);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(answers, [['ab12cd', 'allow']]);
    const results = gemini.last.named('tool').map((call) => call[3]);
    assert.deepEqual(results, [{ status: 'passed on; the work continues' }, { status: 'ran usage' }]);
}

export async function checkAibiTasks(directory: string): Promise<void> {
    await checkTaskResult(directory);
    await checkAcknowledgement(directory);
    await checkKeptResult(directory);
    await checkQuickTask(directory);
    await checkEndingWithResult(directory);
    await checkPause(directory);
    await checkIdle(directory);
    await checkOutbox(directory);
    await checkOneShots(directory);
    await checkQuestions(directory);
    await checkSpokenToolResult(directory);
    await checkDuplicateTask(directory);
}
