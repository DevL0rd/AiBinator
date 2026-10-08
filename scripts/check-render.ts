import assert from 'node:assert/strict';
import { settings, type SettingDefinition } from '../src/operator/settings-registry.js';
import { hits, lineWidth, type Line } from '../src/operator/ui/canvas.js';
import { sheetLines, type Sheet } from '../src/operator/ui/sheets.js';
import { color, glyph, tone } from '../src/operator/ui/theme.js';
import { observations } from '../src/operator/ui/observe.js';
import { aibiSignal, assistantName, assistantSignal, runtimeSignal, type Signal } from '../src/operator/ui/status.js';
import { viewOf } from '../src/operator/ui/state.js';
import type { Observations } from '../src/operator/ui/model.js';
import type { LiveSetupStatus } from '../src/operator/setup-model.js';
import { aibiStatus } from './fixtures.js';
import { models, observed, uiStore } from './ui-fixtures.js';

const text = (lines: Line[]) => lines.map((value) => value.spans.map((item) => item.text).join('')).join('\n');
const find = (predicate: (item: SettingDefinition) => boolean) => {
    const found = settings.find(predicate);
    assert.ok(found);
    return found;
};
function drawn(sheet: Sheet, screen = 120): string {
    const lines = sheetLines(sheet, screen);
    const size = Math.min(78, screen - 8);
    for (const value of lines) assert.equal(lineWidth(value), size, `${sheet.kind} sheet keeps its width`);
    return text(lines);
}

function checkEditSheets(): void {
    const secret = find((item) => Boolean(item.credential));
    const masked = drawn({ kind: 'edit', field: secret, label: 'Token', input: 'hunter2', options: [], labels: {}, error: 'Too short.' });
    assert.ok(masked.includes('•••••••') && !masked.includes('hunter2'), 'credentials are masked');
    assert.ok(masked.includes('Too short.'), 'errors are shown');
    assert.ok(masked.includes(' Token '), 'the label is the title');
    const choice = find((item) => item.kind === 'choice' && (item.choices?.length ?? 0) > 1);
    const options = [...choice.choices!, ''];
    const picked = drawn({ kind: 'edit', field: choice, label: 'Pick', input: options[1]!, options, labels: { [options[0]!]: 'First' } });
    assert.ok(picked.includes(`${glyph.radioOn} ${options[1]}`), 'the current option is marked');
    assert.ok(picked.includes(`${glyph.radioOff} First`), 'option labels replace raw values');
    assert.ok(picked.includes(`${glyph.radioOff} Default`), 'an empty option reads as Default');
    assert.ok(picked.includes(' Done ') && picked.includes(' Cancel '));
}

function checkMultiSheet(): void {
    const choices = Array.from({ length: 12 }, (_, index) => `item-${index}`);
    const field = { ...find((item) => item.kind === 'list'), choices };
    const sheet: Sheet = { kind: 'multi', field, label: 'Many', chosen: ['item-0', 'item-11'], index: 11 };
    const lines = sheetLines(sheet, 120);
    const body = text(lines);
    assert.ok(body.includes('2 of 12 selected'));
    assert.ok(body.includes(`${glyph.boxOn} item-11`), 'the list scrolls to keep the cursor visible');
    assert.ok(!body.includes('item-0 '), 'items scrolled past are hidden');
    assert.ok(body.includes(`${glyph.boxOff} item-10`));
    assert.ok(
        hits(lines).some((item) => item.target === 'sheet:option:11'),
        'options keep their real index for clicks',
    );
}

function checkOtherSheets(): void {
    const reachable = settings.map((item) => item.id);
    assert.ok(drawn({ kind: 'search', input: '', index: 0, reachable: [] }).includes('Type to search every setting.'));
    assert.ok(drawn({ kind: 'search', input: 'zzzzqqq', index: 0, reachable }).includes('No matching settings.'));
    const found = drawn({ kind: 'search', input: 'public domain', index: 0, reachable });
    assert.ok(found.includes('Find a setting') && found.includes(`${glyph.arrow} Public domain`), 'matches are listed');
    const help = drawn({ kind: 'help' });
    assert.ok(help.includes(' Keys ') && help.includes('Review and save changes'));
    const sheet: Sheet = {
        kind: 'confirm',
        title: 'Sure?',
        body: ['A long explanation '.repeat(8)],
        buttons: [
            { label: 'Yes', tone: 'good', run: () => undefined },
            { label: 'No', tone: 'bad', run: () => undefined },
        ],
        index: 1,
    };
    const lines = sheetLines(sheet, 60);
    assert.equal(text(lines).match(/explanation/g)?.length, 8, 'body text wraps instead of being cut');
    const spans = lines.flatMap((value) => value.spans);
    const yes = spans.find((item) => item.text === ' Yes ');
    const no = spans.find((item) => item.text === ' No ');
    assert.equal(no?.bg, tone.bad, 'the selected button is filled');
    assert.equal(no?.fg, color.ink);
    assert.equal(yes?.bg, color.lift);
    assert.equal(yes?.fg, tone.good);
    assert.equal(yes?.target, 'sheet:button:0');
}

const live = (
    operator: Partial<LiveSetupStatus['operator']> & Record<string, unknown>,
    aibi: Partial<LiveSetupStatus['aibi']> = {},
): Observations => ({
    ...observed,
    live: { aibi: aibiStatus(aibi), operator: { mode: 'codex-local', appliedConfigAt: null, ...operator } },
});
const signal = (observation: Observations, read: (view: ReturnType<typeof viewOf>) => Signal = assistantSignal) =>
    read(viewOf(uiStore(undefined, { observed: observation }).state));
const label = (observation: Observations, read: (view: ReturnType<typeof viewOf>) => Signal = assistantSignal) => {
    const value = signal(observation, read);
    return `${value.label}|${value.detail}|${value.tone}`;
};

function checkAibiSignal(): void {
    const aibi = (patch: Partial<LiveSetupStatus['aibi']>) => label(live({}, patch), aibiSignal);
    assert.equal(label({ ...observed, live: null }, aibiSignal), 'Unknown|Not reporting|idle');
    assert.equal(aibi({}), 'Connected|Last seen 10:00 UTC|good', 'the last call is shown in UTC');
    assert.equal(aibi({ lastContact: null }), 'Waiting|AIBI has not called yet|warn');
    assert.equal(aibi({ voice: { conversation: true, waiting: 0, tasks: 0, configured: true } }), 'Talking|Conversation open|good');
    assert.equal(aibi({ proxy: { state: 'failed', error: 'Port 443 is taken' } }), 'Server down|Port 443 is taken|bad');
    assert.equal(aibi({ proxy: { state: 'failed' } }), 'Server down|Did not start|bad');
    assert.equal(aibi({ dns: { state: 'failed', error: 'Port 53 is taken' } }), 'DNS down|Port 53 is taken|warn');
    assert.equal(
        aibi({ proxy: { state: 'failed' }, dns: { state: 'failed' } }),
        'Server down|Did not start|bad',
        'a broken server matters more than DNS',
    );
    assert.equal(aibi({ dns: { state: 'failed' }, lastContact: null }), 'DNS down|Did not start|warn');
}

function checkSignals(): void {
    assert.equal(signal({ ...observed, live: null }, runtimeSignal).label, 'Outdated', 'a lock without a live bridge needs a restart');
    assert.equal(signal({ ...observed, live: null, runtime: false }, runtimeSignal).tone, 'bad');
    assert.equal(signal(observed, runtimeSignal).label, 'Running');
    assert.equal(label({ ...observed, live: null }), 'Offline|Nothing running|idle');
    assert.equal(label(live({ mode: 'disabled' })), 'Paused|Not taking work|idle');
    assert.equal(label(live({ blockedReason: 'Busy elsewhere' })), 'Blocked|Busy elsewhere|warn');
    assert.equal(label(live({})), 'Starting|Connecting|warn');
    assert.equal(label(live({ controller: { failed: true } })), 'Reconnecting|Restarting|warn');
    assert.equal(label(live({ controller: { deliveryError: 'x' } })), 'Listening|Retrying a reply|warn');
    assert.equal(label(live({ controller: { busy: 2 } })), 'Working|2 in progress|good');
    assert.equal(label(live({ controller: { connected: true } })), 'Listening|Ready for work|good');
    assert.equal(label(live({ mode: 'claude-session', session: { live: true } })), 'Listening|Live in Desktop|good');
    assert.equal(label(live({ mode: 'claude-session', session: { live: false } })), 'Ready|Opens Desktop on demand|good');
    assert.equal(label(live({ mode: 'claude-session', session: null, controller: { busy: 1 } })), 'Working|1 in progress|good');
    assert.equal(label(live({ mode: 'manual-mcp' })), 'External|Managed by your app|info');
    assert.equal(label(live({ mode: 'retired-mode' })), 'External|Managed by your app|info', 'an unknown mode is shown generically');
    assert.equal(assistantName('manual-mcp'), 'Another MCP app');
    assert.equal(assistantName('chatgpt-poll'), 'Paused', 'a removed responder reads as paused');
}

async function checkObservations(): Promise<void> {
    const asked: string[] = [];
    const answer =
        <T>(name: string, value: T) =>
        () => (asked.push(name), Promise.resolve(value));
    const other = { ...models, source: 'fresh' };
    const read = {
        liveSetupStatus: answer('live', observed.live),
        runtimePresent: answer('runtime', false),
        readOperatorConfig: answer('config', observed.active),
        codexModels: answer('codex', other),
        claudeModels: answer('claude', other),
        managedServiceStatus: answer('service', { available: false, installed: false, active: false }),
    };
    const fresh = await observations(undefined, read);
    assert.equal(fresh.codex.source, 'fresh');
    assert.equal(fresh.runtime, false);
    assert.equal(fresh.service.available, false);
    assert.ok(!Number.isNaN(Date.parse(fresh.observedAt)), 'observations are timestamped');
    asked.length = 0;
    const cached = await observations(observed, read);
    assert.equal(cached.claude, observed.claude, 'known models are reused');
    assert.deepEqual(asked.sort(), ['config', 'live', 'runtime', 'service'], 'providers are not asked again');
}

export async function checkRender(): Promise<void> {
    checkEditSheets();
    checkMultiSheet();
    checkOtherSheets();
    checkSignals();
    checkAibiSignal();
    await checkObservations();
}
