import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localCall } from '../src/mcp/local-client.js';
import { guarded } from '../src/mcp/tools.js';
import { AibiService, type Responder } from '../src/aibi/service.js';
import type { Scope } from '../src/core/config.js';
import { fakeConfig, type fixture } from './fixtures.js';
import { key, localServer } from './check-channel.js';
import { inDirectory } from './host-fixture.js';
import { FakeGemini } from './aibi-fakes.js';

type Fixture = ReturnType<typeof fixture>;
type Line = { id: number; role: string; text: string };
const foreignRejection = { then: (_resolve: unknown, reject: (reason: string) => void) => reject('raw') } as unknown as Promise<unknown>;
const responder: Responder = {
    available: () => true,
    answer: () => Promise.resolve('passed on'),
    command: (name) => Promise.resolve(`ran ${name}`),
};

function caller(base: string) {
    return async (name: string, args: Record<string, unknown>) => {
        const result = await localCall({ base, key }, 'tools/call', { name, arguments: args });
        const text = (result.content as { text: string }[])[0]!.text;
        return { failed: result.isError === true, text, value: <T>() => JSON.parse(text) as T };
    };
}
type Call = ReturnType<typeof caller>;

async function refused(call: Call, name: string, args: Record<string, unknown>, message: string): Promise<void> {
    const result = await call(name, args);
    assert.deepEqual([result.failed, result.text], [true, message], `${name} is refused`);
}

async function checkReply(call: Call, f: Fixture): Promise<void> {
    const progress = await call('aibi_reply', { eventId: f.event.id, text: 'Checking the forecast', progress: true });
    assert.equal(progress.failed, false, progress.text);
    for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await call('aibi_reply', { eventId: f.event.id, text: 'Sunny all day.', idempotencyKey: 'mcp-final-answer' });
        assert.equal(answer.failed, false, answer.text);
    }
    assert.deepEqual(
        f.spoken,
        [
            { text: 'Checking the forecast', quiet: true },
            { text: 'Sunny all day.', quiet: false },
        ],
        'Progress is only logged and a retried answer is spoken once',
    );
    await refused(call, 'aibi_reply', { eventId: randomUUID(), text: 'Hello' }, 'Request expired, dropped, or unknown');
}

async function checkPolling(call: Call, f: Fixture): Promise<void> {
    const page = await call('events_poll', { after: 0 });
    assert.deepEqual(
        page.value<{ events: { id: string }[] }>().events.map((event) => event.id),
        [f.event.id],
    );
    for (let index = 0; index < 25; index++)
        f.queue.add(`bulky-${index}`, { kind: 'voice', text: '\u0001'.repeat(4000), conversation: 'bulky' });
    const bulky = await call('events_poll', { after: f.event.cursor });
    assert.equal(bulky.failed, true);
    assert.match(bulky.text, /Result exceeds output limit/);
}

async function checkScopes(call: Call, f: Fixture): Promise<void> {
    const all = [...f.policy.config.scopes];
    const cases: [Scope, string, Record<string, unknown>][] = [
        ['aibi.speak', 'aibi_say', { text: 'Hello' }],
        ['aibi.act', 'aibi_action', { action: 'ability_dance' }],
        ['aibi.read', 'aibi_history', {}],
        ['memory.write', 'aibi_history_clear', {}],
    ];
    for (const [scope, name, args] of cases) {
        f.policy.config.scopes = all.filter((item) => item !== scope);
        await refused(call, name, args, `The ${scope} ability is switched off in AiBinator`);
    }
    f.policy.config.scopes = all;
}

async function checkSpeech(call: Call, aibi: AibiService): Promise<void> {
    assert.deepEqual((await call('aibi_say', { text: 'Dinner is ready' })).value(), { delivered: 'later' });
    const alarm = await call('aibi_action', { action: 'ability_alarm_set', options: { time: '07:30', tag: 1 } });
    assert.deepEqual(
        alarm.value(),
        { delivered: false, reason: 'AIBI is not in a conversation, so it cannot move right now.' },
        'Without a conversation an action is not saved for later',
    );
    await refused(call, 'aibi_action', { action: 'not_an_action' }, 'not_an_action is not an enabled AIBI action');
    await refused(call, 'aibi_action', { action: 'ability_chatgpt' }, 'ability_chatgpt is not an enabled AIBI action');
    await refused(
        call,
        'aibi_action',
        { action: 'ability_alarm_set', options: { time: '25:00' } },
        'time="25:00" is not valid for ability_alarm_set',
    );
    assert.equal(aibi.desk.status().waiting, 1, 'Only valid requests wait for the next conversation');
}

async function checkReading(call: Call, f: Fixture): Promise<void> {
    const listed = (await call('aibi_actions', {})).value<{ actions: { id: string; options: object }[]; animations: string[] }>();
    const ids = listed.actions.map((action) => action.id);
    assert.ok(ids.includes('ability_dance'));
    assert.ok(
        ids.includes('interact_mood') && !ids.includes('ability_chatgpt'),
        'every action is on by default; reserved ones are not offered',
    );
    assert.deepEqual(listed.actions.find((action) => action.id === 'ability_alarm_set')?.options, { time: 'HH:mm', tag: '0|1|2|3|4|5|6' });
    assert.equal(listed.animations.length, 533, 'every animation is on by default');
    const status = (await call('aibinator_status', {})).value<{ queueEpoch: string; scopes: string[]; aibi: { mode: string } }>();
    assert.deepEqual([status.queueEpoch, status.scopes, status.aibi.mode], [f.queue.epoch, f.policy.config.scopes, 'local']);
}

async function checkMemory(call: Call, aibi: AibiService): Promise<void> {
    aibi.memory.add('user', 'Remind me to water the plants');
    aibi.memory.add('aibi', 'I will remind you tonight.');
    aibi.memory.add('note', 'AIBI did ability_dance.');
    const latest = (await call('aibi_history', { limit: 2 })).value<Line[]>();
    assert.deepEqual(
        latest.map((line) => [line.id, line.role]),
        [
            [2, 'aibi'],
            [3, 'note'],
        ],
    );
    const older = (await call('aibi_history', { before: 2 })).value<Line[]>();
    assert.deepEqual(
        older.map((line) => line.text),
        ['Remind me to water the plants'],
    );
    aibi.activity.add('heard', 'Remind me to water the plants');
    aibi.activity.add('warning', 'Gemini Live failed', 'offline');
    const warnings = (await call('aibi_activity', { kind: 'warning' })).value<{ title: string; detail: string }[]>();
    assert.deepEqual(
        warnings.map((entry) => [entry.title, entry.detail]),
        [['Gemini Live failed', 'offline']],
    );
    assert.deepEqual((await call('aibi_history_delete', { id: 2 })).value(), { removed: true });
    assert.deepEqual((await call('aibi_history_delete', { id: 2 })).value(), { removed: false });
    assert.deepEqual((await call('aibi_history_clear', {})).value(), { removed: 2 });
    await Promise.all([aibi.memory.flushed(), aibi.activity.flushed()]);
    assert.deepEqual(JSON.parse(await readFile('.data/aibi/memory.json', 'utf8')), [], 'Forgetting is saved');
}

async function checkSettingsTool(call: Call): Promise<void> {
    const token = fakeConfig().AIBINATOR_MCP_TOKEN!;
    await writeFile('.env', `GEMINI_API_KEY=fixture-not-a-real-key\nAIBINATOR_MCP_TOKEN=${token}\n`);
    await writeFile('policy.json', '{}');
    await refused(call, 'aibinator_settings_update', { changes: [{ id: 'not-a-setting', value: true }] }, 'Unknown setting not-a-setting');
    const listed = (await call('aibinator_settings', {})).value<{ id: string; value: unknown; editable: boolean }[]>();
    const shown = (id: string) => listed.find((item) => item.id === id);
    assert.deepEqual(shown('environment.GEMINI_API_KEY'), { ...shown('environment.GEMINI_API_KEY'), value: 'set', editable: false });
    assert.equal(shown('environment.AIBINATOR_MCP_TOKEN')?.value, 'set');
    for (const secret of ['fixture-not-a-real-key', token])
        assert.ok(!JSON.stringify(listed).includes(secret), 'Credential values are never returned');
    await refused(
        call,
        'aibinator_settings_update',
        { changes: [{ id: 'environment.GEMINI_API_KEY', value: 'another-fixture-key' }] },
        'Google Gemini API key can only be changed in the setup app',
    );
    const named = await call('aibinator_settings_update', { changes: [{ id: 'policy.ownerName', value: 'Robin' }] });
    assert.equal(named.failed, false, named.text);
    assert.match(named.value<string>(), /AIBI settings saved and applied\./);
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { ownerName: string }).ownerName, 'Robin');
}

export async function checkMcpTools(directory: string): Promise<void> {
    assert.deepEqual(await guarded(() => foreignRejection), {
        content: [{ type: 'text', text: 'Operation failed' }],
        isError: true,
    });
    const root = resolve(directory, 'mcp-tools');
    const { f, http, base } = await localServer(resolve(directory, 'mcp-tools.json'));
    const call = caller(base);
    try {
        await inDirectory(root, async () => {
            await refused(call, 'aibi_say', { text: 'Hello' }, 'AIBI is not running');
            const aibi = new AibiService(f.policy, f.queue, new FakeGemini(), responder);
            f.bridge.aibi = aibi;
            f.bridge.desk = aibi.desk;
            await checkReply(call, f);
            await checkPolling(call, f);
            await checkScopes(call, f);
            await checkSpeech(call, aibi);
            await checkReading(call, f);
            await checkMemory(call, aibi);
            await checkSettingsTool(call);
        });
    } finally {
        await http.stop();
    }
}
