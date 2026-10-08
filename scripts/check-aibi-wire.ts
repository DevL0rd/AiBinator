import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { collector, decodedBody, HttpReader, rebuild, requestLine, type Message } from '../src/aibi/http.js';
import { BigEndianPcm, Mp3Stream, Resampler, rms, silence, SpeechGate } from '../src/aibi/audio.js';
import { act, chatMode, chatStart, encode, photoAnswer, recognize, speak, summarize, tagged } from '../src/aibi/protocol.js';
import { checkAction, describeRule, enabledActions, enabledAnimations, usableActions } from '../src/aibi/capabilities.js';

function feed(reader: HttpReader, data: Buffer, step: number): void {
    for (let offset = 0; offset < data.length; offset += step) reader.push(data.subarray(offset, offset + step));
}

function checkParser(): void {
    const request = Buffer.from(
        'POST /aibi/voice/detectintent?index=3&role=chatgpt HTTP/1.1\r\nHost: api.aibipocket.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
            '4\r\nabcd\r\n3;x=1\r\nefg\r\n0\r\n\r\n' +
            'GET /aibi/permission HTTP/1.1\r\nHost: api.aibipocket.com\r\n\r\n' +
            'POST /aibi/report/status HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello',
    );
    for (const step of [1, 7, request.length]) {
        const messages: Message[] = [];
        const bodies: string[] = [];
        let current = '';
        const collect = collector((message) => messages.push(message));
        const reader = new HttpReader({
            head: (head) => (collect.head(head), (current = '')),
            body: (chunk) => (collect.body(chunk), (current += chunk.toString())),
            end: () => (collect.end(), bodies.push(current)),
        });
        feed(reader, request, step);
        assert.deepEqual(bodies, ['abcdefg', '', 'hello'], `bodies stream correctly in ${step}-byte pieces`);
        assert.equal(messages.length, 3);
    }
    const { method, path, query } = requestLine('GET /aibi/chat/start?lang=en&tz=UTC HTTP/1.1');
    assert.deepEqual([method, path, query.get('tz')], ['GET', '/aibi/chat/start', 'UTC']);
    const response: Message[] = [];
    const untilClose = new HttpReader(
        collector((message) => response.push(message)),
        true,
    );
    untilClose.push(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n\r\npartial'));
    untilClose.push(Buffer.from('-rest'));
    untilClose.close();
    assert.equal(response[0]!.body.toString(), 'partial-rest', 'a response without a length lasts until the connection closes');
    const packed = { startLine: 'HTTP/1.1 200 OK', headers: { 'content-encoding': 'gzip' }, body: gzipSync('{"a":1}') };
    assert.equal(decodedBody(packed).toString(), '{"a":1}');
    assert.match(rebuild({ ...packed, headers: { 'transfer-encoding': 'chunked' } }).toString('latin1'), /content-length: \d+/);
    assert.throws(() => new HttpReader(collector(() => undefined)).push(Buffer.alloc(70_000, 65)), /too large/);
}

function checkAudio(): void {
    const pcm = new BigEndianPcm();
    const bytes = Buffer.alloc(4);
    bytes.writeInt16BE(-1234, 0);
    bytes.writeInt16BE(321, 2);
    assert.deepEqual([...pcm.push(bytes.subarray(0, 1)), ...pcm.push(bytes.subarray(1))], [-1234, 321], 'odd byte splits are carried');
    const resampler = new Resampler(24_000, 32_000);
    let total = 0;
    for (let index = 0; index < 10; index++) total += resampler.push(new Int16Array(2400)).length;
    assert.equal(total, 32_000);
    const stream = new Mp3Stream();
    const mp3 = Buffer.concat([
        stream.encode(Int16Array.from({ length: 24_000 }, (_, i) => Math.round(9000 * Math.sin(i / 9)))),
        stream.finish(),
    ]);
    assert.equal(mp3[0], 0xff);
    assert.equal(mp3[1]! & 0xe0, 0xe0, 'output is MPEG audio');
    assert.equal((mp3[2]! >> 2) & 0x03, 2, 'at 32 kHz, the rate AIBI already plays');
    assert.ok(silence(250).length > 0);
    const gate = new SpeechGate(1000);
    assert.deepEqual(gate.push(new Int16Array(3200)), [], 'quiet audio is held back');
    const loud = Int16Array.from({ length: 1600 }, (_, i) => (i % 2 ? 3000 : -3000));
    assert.equal(rms(loud), 3000);
    assert.equal(gate.push(loud).length, 2, 'speech releases the pre-roll with it');
    assert.equal(gate.heard, true);
    assert.equal(gate.push(new Int16Array(10)).length, 1, 'after speech everything passes');
}

function checkProtocol(): void {
    const reply = speak({ text: 'Hi', url: 'http://api.aibipocket.com/tts/dl/x.mp3', index: 4, queryText: 'hello' });
    assert.deepEqual(summarize(reply), {
        queryText: 'hello',
        text: 'Hi',
        behavior: 'interact_speak',
        params: summarize(reply).params,
        url: 'http://api.aibipocket.com/tts/dl/x.mp3',
    });
    assert.equal(
        (reply.queryResult as { behavior_paras: { listen: number } }).behavior_paras.listen,
        0,
        'like the cloud, AIBI decides when it listens',
    );
    assert.deepEqual(
        (act({}, 'ability_dance', {}).queryResult as { behavior_paras: unknown }).behavior_paras,
        [],
        'actions without options send an empty list like the cloud',
    );
    assert.deepEqual((chatMode({}, 'quit').queryResult as { behavior_paras: unknown }).behavior_paras, { type: 'quit' });
    assert.equal((recognize({}).queryResult as { rec_behavior: string }).rec_behavior, 'interact_recognize');
    assert.equal(photoAnswer({ text: 'A cup', url: 'u' }).index, undefined);
    assert.deepEqual(chatStart('u'), { errcode: 0, url: 'u', errmsg: 'OK', responsetag: 'chatstart' });
    assert.deepEqual(tagged('permission', { permission: true }), { errcode: 0, errmsg: 'OK', responsetag: 'permission', permission: true });
    const wire = encode('HTTP/1.1 200 OK', { a: 1 }).toString();
    assert.match(wire, /^HTTP\/1\.1 200 OK\r\nContent-Type: application\/json; charset=utf-8\r\nContent-Length: 7\r\n/);
}

function checkCapabilities(): void {
    const abilities = { actions: usableActions.filter((id) => id !== 'interact_mood'), animations: ['Daily_babybottle_end'] };
    const ids = enabledActions(abilities).map((action) => action.id);
    assert.ok(ids.includes('ability_dance'));
    assert.ok(!ids.includes('interact_mood'), 'switched-off actions are hidden');
    assert.ok(
        !ids.includes('ability_chatgpt') && !ids.includes('interact_recognize'),
        'conversation and camera are driven by the voice itself',
    );
    assert.deepEqual(enabledAnimations(abilities), ['Daily_babybottle_end']);
    assert.deepEqual(checkAction(abilities, 'ability_light_control', { control: 'on', mode: 'rainbow', extra: 1 }).params, {
        control: 'on',
        mode: 'rainbow',
    });
    assert.deepEqual(checkAction(abilities, 'ability_alarm_set', { time: '07:30', tag: '4' }).params, { time: '07:30', tag: 4 });
    assert.deepEqual(checkAction(abilities, 'ability_timer', { timerdura: '90' }).params, { timerdura: 90 });
    assert.throws(() => checkAction(abilities, 'ability_alarm_set', { time: '25:00' }), /not valid/);
    assert.throws(() => checkAction(abilities, 'interact_mood', {}), /not an enabled AIBI action/);
    const animated = { actions: usableActions, animations: ['Daily_babybottle_end'] };
    assert.deepEqual(checkAction(animated, 'interact_answer_with_animation', { animation_name: 'Daily_babybottle_end' }).params, {
        animation_name: 'Daily_babybottle_end',
    });
    assert.throws(() => checkAction(animated, 'interact_answer_with_animation', { animation_name: 'Not_allowed' }), /not valid/);
    assert.equal(describeRule(['a', 'b']), 'a|b');
}

export function checkAibiWire(): void {
    checkParser();
    checkAudio();
    checkProtocol();
    checkCapabilities();
}
