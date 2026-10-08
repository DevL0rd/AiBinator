import type { Socket } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { policySchema } from '../src/core/config.js';
import { deskFixture, FakeSocket, pcm, played, result, stream } from './aibi-fakes.js';

const info = { index: 7, timeZone: 'Europe/Berlin' };
const chat = { ...info, chat: true };

async function checkSpeech(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'speech-')));
    gemini.reply = (session) => {
        session.events.heard('hello there');
        session.speak('Hi! Nice to hear you.');
    };
    const reply = await desk.listen(stream(pcm(true)), chat);
    const turn = result(reply);
    assert.equal(turn.rec_behavior, 'interact_speak');
    assert.equal(turn.behavior_paras.listen, 0, 'like the cloud, AIBI decides when it listens');
    assert.match(String(turn.behavior_paras.url), /^http:\/\/api\.aibipocket\.com\/tts\/dl\/local-.+\.mp3$/);
    assert.equal(turn.behavior_paras.txt, 'Hi! Nice to hear you.');
    assert.equal(reply.index, 7);
    const session = gemini.last;
    const kinds = session.calls.map(([kind]) => kind);
    assert.equal(kinds.indexOf('start'), 0, 'the turn starts before any audio');
    assert.ok(kinds.lastIndexOf('audio') < kinds.indexOf('end'), 'the turn ends after the last audio');
    const first = session.named('audio')[0]![1] as Int16Array;
    assert.deepEqual([first[0], first[1]], [-6000, 6000], 'big-endian AIBI samples arrive as native samples');
    assert.match(session.options.system, /Europe\/Berlin/, 'the voice knows their time zone');
    assert.match(session.options.system, /battery: 80/, 'the voice knows the robot status');
    const action = session.options.tools.find((tool) => tool.name === 'aibi_action')!;
    assert.match(action.description, /ability_dance: /, 'the action catalog lives in the aibi_action tool');
    assert.doesNotMatch(session.options.system, /ability_dance/, 'and is not repeated in the prompt');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        host.memory.recent(10).map((line) => [line.role, line.text]),
        [
            ['user', 'hello there'],
            ['aibi', 'Hi! Nice to hear you.'],
        ],
    );
    const id = String(turn.behavior_paras.url).split('/').at(-1)!;
    assert.equal(host.speeches.find(id)?.open, false, 'the speech stream is finished at turn end');
    assert.equal(desk.active, true, 'the conversation stays open');
}

async function checkSilentWake(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'silent-')));
    const reply = await desk.listen(stream(pcm(false)), info);
    assert.equal(result(reply).rec_behavior, 'voice_dont_understand', 'a silent wake gets the native puzzled reaction');
    assert.equal(gemini.last.named('start').length, 0, 'silence never reaches Gemini');
    assert.equal(desk.active, true, 'the voice stays ready for the next wake');
    const fresh = deskFixture(await mkdtemp(join(directory, 'silent-chat-')));
    const quit = await fresh.desk.listen(stream(pcm(false)), { ...info, chat: true });
    assert.deepEqual(result(quit).behavior_paras, { type: 'quit' }, 'silence at the start of conversation mode leaves it');
    assert.equal(fresh.desk.active, false);
}

async function checkConversationMode(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'connect-')));
    gemini.reply = (session) => {
        session.events.heard('how was your day');
        session.speak('Pretty good, I danced a lot!');
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).rec_behavior, 'ability_chatgpt', 'answering out loud switches AIBI to conversation mode');
    assert.equal(result(reply).behavior_paras.type, 'connect');
    assert.equal(result(reply).behavior_paras.txt, 'Pretty good, I danced a lot!', 'the switch carries the answer');
    assert.deepEqual(
        host.memory.recent(5).map((line) => line.text),
        ['how was your day', 'Pretty good, I danced a lot!'],
    );
    gemini.reply = (session) => session.speak('Still here!');
    const next = await desk.listen(stream(pcm(true)), chat);
    assert.equal(result(next).rec_behavior, 'interact_speak', 'in conversation mode answers are plain speech');
    const quiet = await desk.listen(stream(pcm(false)), chat);
    assert.equal(result(quiet).behavior_paras.txt, '', 'a quiet upload just keeps it listening');
    assert.ok(!gemini.last.options.tools.some((tool) => tool.name === 'start_conversation'));
}

async function checkLeaving(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'leaving-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'end_conversation', {});
        session.speak('Bye for now!');
    };
    await desk.listen(stream(pcm(true)), chat);
    gemini.reply = (session) => session.speak('Still here?');
    const reply = await desk.listen(stream(pcm(true)), chat);
    assert.deepEqual(result(reply).behavior_paras, { type: 'quit' });
    const goodbye = deskFixture(await mkdtemp(join(directory, 'leaving-goodbye-')));
    goodbye.gemini.reply = (session) => {
        session.events.tool('call-1', 'end_conversation', {});
        session.speak('Bye for now!');
    };
    const said = await goodbye.desk.listen(stream(pcm(true)), chat);
    assert.equal(result(said).behavior_paras.type, 'quit', 'the goodbye itself takes AIBI out of conversation mode');
    assert.equal(result(said).behavior_paras.txt, 'Bye for now!', 'and carries the goodbye');
    for (let index = 0; index < 2; index++) {
        const again = await goodbye.desk.listen(stream(pcm(true)), chat);
        assert.deepEqual(result(again).behavior_paras, { type: 'quit' }, 'conversation uploads after it keep being told to leave');
    }
}

async function checkLeftover(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'leftover-')));
    gemini.reply = (session) => {
        session.speak('Once upon a time.');
        session.speak('And then more story.');
    };
    played(host, await desk.listen(stream(pcm(true)), chat));
    const quiet = await desk.listen(stream(pcm(false)), chat);
    assert.equal(result(quiet).behavior_paras.txt, '', 'speech Gemini produced after its turn is never played later on a quiet upload');
}

async function checkFarewell(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'farewell-')));
    gemini.reply = (session) => session.speak('Goodbye! Talk soon.');
    await desk.listen(stream(pcm(true)), chat);
    gemini.reply = (session) => session.speak('Still here!');
    const next = await desk.listen(stream(pcm(true)), chat);
    assert.deepEqual(result(next).behavior_paras, { type: 'quit' }, 'a spoken goodbye ends conversation mode even without the tool');
    assert.equal(gemini.last.named('start').length, 1, 'noise after the goodbye never starts a turn');
}

async function checkFalseWake(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'false-wake-')));
    gemini.reply = (session) => session.speak('Goodbye.');
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).rec_behavior, 'interact_speak');
    assert.equal(result(reply).behavior_paras.txt, '', 'a wake the voice dismisses stays silent');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(desk.active, false, 'and does not start conversation mode');
}

async function checkWordless(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'wordless-')));
    gemini.reply = (session) => session.speak('---');
    const reply = await desk.listen(stream(pcm(true)), chat);
    assert.equal(result(reply).behavior_paras.txt, '', 'speech without words is treated as silence');
}

async function checkAction(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'action-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'aibi_action', { action: 'ability_light_control', options: '{"control":"on","mode":"rainbow"}' });
        session.events.turnComplete();
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).rec_behavior, 'ability_light_control');
    assert.deepEqual(result(reply).behavior_paras, { control: 'on', mode: 'rainbow' });
    const tool = gemini.last.named('tool')[0]!;
    assert.deepEqual(tool[3], { status: 'doing it now' });
    assert.match(host.memory.recent(5).at(-1)!.text, /AIBI did ability_light_control/);
}

async function checkDisabledAction(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'disabled-')));
    host.policy.update(policySchema.parse({ aibi: { actions: ['ability_dance'] } }));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'aibi_action', { action: 'interact_mood', options: '{"mood":"mood_happy"}' });
        session.speak('I cannot do that one.');
    };
    const reply = await desk.listen(stream(pcm(true)), chat);
    assert.equal(result(reply).rec_behavior, 'interact_speak', 'a refused action leaves the voice free to talk');
    assert.match(String((gemini.last.named('tool')[0]![3] as { error: string }).error), /not an enabled AIBI action/);
}

async function checkGoodbye(directory: string): Promise<void> {
    const { desk, gemini } = deskFixture(await mkdtemp(join(directory, 'goodbye-')));
    gemini.reply = (session) => {
        session.events.tool('call-1', 'end_conversation', {});
        session.speak('Bye for now!');
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).behavior_paras.listen, 0, 'the goodbye does not keep AIBI listening');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(desk.active, false, 'the conversation ends after the goodbye');
    assert.equal(gemini.last.named('close').length, 1);
}

async function checkLook(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'look-')));
    gemini.reply = (session, cause) => {
        if (cause === 'turn') {
            session.events.tool('call-1', 'look', {});
            session.events.turnComplete();
        } else session.speak('That is a red mug.');
    };
    const reply = await desk.listen(stream(pcm(true)), info);
    assert.equal(result(reply).rec_behavior, 'interact_recognize');
    const photo = await desk.look(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg');
    assert.deepEqual(result(photo).intent, { name: 'chatgpt_speak', confidence: 1 });
    assert.equal(photo.index, undefined, 'photo answers match the cloud format');
    const shown = gemini.last.named('text').at(-1)!;
    assert.equal((shown[3] as { mimeType: string } | undefined)?.mimeType, 'image/jpeg', 'the photo is shown together with the question');
    assert.ok(
        host.memory.recent(10).some((line) => line.image),
        'the photo is remembered',
    );
}

async function checkDownload(directory: string): Promise<void> {
    const { desk, gemini, host } = deskFixture(await mkdtemp(join(directory, 'download-')));
    gemini.reply = (session) => session.speak('Hello!');
    const reply = await desk.listen(stream(pcm(true)), chat);
    const socket = new FakeSocket();
    const sent: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => sent.push(chunk));
    played(host, reply, socket);
    await new Promise((resolve) => setImmediate(resolve));
    const text = Buffer.concat(sent).toString('latin1');
    assert.doesNotMatch(text, /Transfer-Encoding|Content-Length/, 'the audio streams as plain bytes, without chunking');
    assert.match(text, /Connection: close/);
    assert.equal(socket.writableEnded, true, 'the end of the speech closes the download');
    socket.destroy();
}

async function checkPacing(directory: string): Promise<void> {
    const { host } = deskFixture(await mkdtemp(join(directory, 'pacing-')));
    const speech = host.speeches.create();
    speech.write(new Int16Array(24_000 * 10));
    const socket = new FakeSocket();
    let bytes = 0;
    socket.on('data', (chunk: Buffer) => (bytes += chunk.length));
    speech.serve(socket as unknown as Socket);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(bytes < 20_000, 'ten seconds of audio is not sent at once, only about 1.5 seconds ahead');
    const quiet = host.speeches.create();
    const waiting = new FakeSocket();
    let filled = 0;
    waiting.on('data', (chunk: Buffer) => (filled += chunk.length));
    quiet.serve(waiting as unknown as Socket);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(filled > 1000, 'while Gemini has nothing yet, silence keeps the download going');
    assert.equal(waiting.writableEnded, false, 'and it does not end until the speech does');
    quiet.end();
    speech.fail();
    socket.destroy();
    waiting.destroy();
}

export async function checkAibiVoice(directory: string): Promise<void> {
    await checkSpeech(directory);
    await checkSilentWake(directory);
    await checkConversationMode(directory);
    await checkLeaving(directory);
    await checkLeftover(directory);
    await checkFarewell(directory);
    await checkWordless(directory);
    await checkFalseWake(directory);
    await checkAction(directory);
    await checkDisabledAction(directory);
    await checkGoodbye(directory);
    await checkLook(directory);
    await checkDownload(directory);
    await checkPacing(directory);
}
