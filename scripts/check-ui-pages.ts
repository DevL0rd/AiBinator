import assert from 'node:assert/strict';
import { pageItems } from '../src/operator/ui/pages/index.js';
import { card, setting, settingItem, statusItem } from '../src/operator/ui/items.js';
import { frame } from '../src/operator/ui/frame.js';
import { viewOf, type UiState } from '../src/operator/ui/state.js';
import type { Line } from '../src/operator/ui/canvas.js';
import { pages, type PageId, type View } from '../src/operator/ui/model.js';
import stringWidth from 'string-width';
import type { LiveSetupStatus } from '../src/operator/setup-model.js';
import { actions, reservedActions } from '../src/aibi/capabilities.js';
import { aibiStatus } from './fixtures.js';
import { observed, uiStore } from './ui-fixtures.js';

const text = (lines: Line[]) => lines.map((row) => row.spans.map((item) => item.text).join('')).join('\n');
const pageText = (state: UiState, page: PageId) => {
    const view = viewOf(state);
    return text(pageItems(page, view).flatMap((item) => item.lines(300, false, view)));
};
type Aibi = LiveSetupStatus['aibi'];
type Patch = {
    drafts?: Partial<Record<'operator' | 'policy' | 'environment', Record<string, unknown>>>;
    live?: { operator?: Record<string, unknown>; aibi?: Partial<Aibi> } | null;
};
function state(patch: Patch = {}, extra: Partial<UiState> = {}): UiState {
    const base = uiStore().state;
    const drafts = {
        operator: { ...base.drafts.operator, ...patch.drafts?.operator },
        policy: { ...base.drafts.policy, ...patch.drafts?.policy },
        environment: { ...base.drafts.environment, ...patch.drafts?.environment },
    };
    const live =
        patch.live === null
            ? null
            : {
                  operator: { ...observed.live!.operator, ...patch.live?.operator },
                  aibi: aibiStatus(patch.live?.aibi),
              };
    return { ...base, drafts, observed: { ...base.observed, live }, ...extra };
}
const liveMode = (mode: string, more: Record<string, unknown> = {}) => ({ operator: { mode, appliedConfigAt: null, ...more } });

function checkApps(): void {
    const web = { claude: 'https://bot.example.com/mcp', chatgpt: 'https://old.example.com/mcp' };
    const apps = pageText(state({}, { extras: { apps: {}, web } }), 'apps');
    assert.ok(apps.includes('Reached through bot.example.com'));
    assert.ok(apps.includes(' CONNECTED ') && apps.includes('Added. Open it to see the steps again.'), 'a current connector is connected');
    assert.ok(apps.includes(' ADDRESS CHANGED ') && apps.includes('Your public address changed'), 'an old address is flagged');
    assert.ok(apps.includes('http://127.0.0.1:8789'), 'the default port is shown');
    const fresh = pageText(state({ drafts: { environment: { AIBINATOR_PORT: 9000 } } }), 'apps');
    assert.ok(fresh.includes(' NOT CONNECTED ') && fresh.includes('http://127.0.0.1:9000'), 'a custom port is shown');
    const local = pageText(state({ drafts: { environment: { AIBINATOR_RESOURCE_URL: '' } } }), 'apps');
    assert.ok(local.includes('Set a public domain below to use these') && local.includes(' NEEDS A PUBLIC DOMAIN '));
}

function checkAibi(): void {
    const page = (patch: Patch, extra: Partial<UiState> = {}) => pageText(state(patch, extra), 'aibi');
    const connected = page({});
    for (const row of [
        'Last seen 2026-10-08 10:00 UTC from 192.168.1.40',
        'Listening on 80 and 443',
        'Answering on 192.168.1.20',
        'give AIBI (or your whole network) 192.168.1.20 as DNS',
        'Local (AiBinator answers)',
    ])
        assert.ok(connected.includes(row), `the AIBI page shows ${row}`);
    assert.ok(!connected.includes('Allow ports'), 'ports are only offered once they are known to be blocked');
    assert.ok(page({}, { extras: { apps: {}, ports: false } }).includes('Allow ports 53, 80 and 443'), 'blocked ports can be allowed');
    assert.ok(!page({}, { extras: { apps: {}, ports: true } }).includes('Allow ports'));
    const broken = page({
        live: {
            aibi: { proxy: { state: 'failed', error: 'Port 443 is taken' }, dns: { state: 'off' }, address: '', lastContact: null },
        },
    });
    for (const row of ['Port 443 is taken', 'Off', 'Not detected yet', 'Has not called yet', 'make this computer’s address its DNS server'])
        assert.ok(broken.includes(row), `a broken connection shows ${row}`);
    assert.ok(page({ live: { aibi: { proxy: { state: 'starting' } } } }).includes('Starting…'));
    assert.ok(page({ live: { aibi: { proxy: { state: 'failed' } } } }).includes('Did not start'));
    const stopped = page({ live: null });
    assert.ok(
        stopped.includes('AiBinator is not running') && stopped.includes('Has not called yet'),
        'a stopped AiBinator reports nothing',
    );
    assert.ok(page({ drafts: { policy: { aibi: { mode: 'passthrough' } } } }).includes('Pass-through (AIBI cloud)'));
}

function checkAibiPages(): void {
    const usable = actions.filter((action) => !reservedActions.has(action.id)).length;
    assert.ok(pageText(state(), 'abilities').includes(`${usable} of ${usable} actions on`), 'every action is on by default');
    assert.ok(
        pageText(state({ drafts: { policy: { aibi: { actions: [...actions.map((action) => action.id)] } } } }), 'abilities').includes(
            `${usable} of ${usable}`,
        ),
        'conversation and camera are not counted as actions',
    );
    const voice = (patch: Patch) => pageText(state(patch), 'voice');
    assert.ok(voice({}).includes('Ready'));
    assert.ok(voice({ drafts: { environment: { GEMINI_API_KEY: '' } } }).includes('Needs a Google Gemini key'));
    const talking = { conversation: true, waiting: 0, tasks: 0, configured: true };
    assert.ok(voice({ live: { aibi: { voice: talking } } }).includes('Talking with AIBI now'));
    const empty = pageText(state(), 'memory');
    assert.ok(empty.includes('0 lines remembered') && empty.includes('Nothing yet.') && empty.includes('No activity yet.'));
    assert.ok(empty.includes('Forget everything'), 'the conversation can be forgotten');
    const aibi: Partial<Aibi> = {
        memory: 2,
        conversation: [
            { id: 1, at: '2026-10-08T09:15:00.000Z', role: 'user', text: 'Hello there' },
            { id: 2, at: '2026-10-08T09:16:00.000Z', role: 'aibi', text: 'Hi!' },
        ],
        activity: [
            { id: 1, at: '2026-10-08T09:15:00.000Z', kind: 'heard', title: 'Hello there', detail: '' },
            { id: 2, at: '2026-10-08T09:17:00.000Z', kind: 'warning', title: 'Odd request', detail: '/new/path' },
        ],
    };
    const memory = pageText(state({ live: { aibi } }), 'memory');
    for (const row of ['2 lines remembered', '09:15  You    Hello there', '09:16  AIBI   Hi!', 'Odd request · /new/path'])
        assert.ok(memory.includes(row), `memory shows ${row}`);
    assert.ok(memory.indexOf('Odd request') < memory.indexOf('heard'), 'activity is newest first');
    const home = pageText(state({ live: { aibi } }), 'home');
    assert.ok(home.includes('Heard: Hello there') && home.includes('Odd request · /new/path'), 'home shows what AIBI did');
    assert.ok(!home.includes('Nothing yet.'));
}

function checkHome(): void {
    const activity = [{ at: '10:00', text: 'Saved.', tone: 'good' as const }];
    const busy = pageText(state({ live: liveMode('codex-local', { appliedConfigAt: observed.active.updatedAt }) }, { activity }), 'home');
    assert.ok(busy.includes('10:00') && busy.includes('Saved.'), 'recent activity is listed');
    assert.ok(!busy.includes('Nothing yet.'));
    assert.ok(busy.includes('Pause') && !busy.includes('Needs attention'), 'a running assistant can be paused');
    const outdated = pageText(state({ live: null }, { observed: { ...observed, live: null, runtime: true } }), 'home');
    assert.ok(outdated.includes('older build'), 'a running bridge without status needs a restart');
    assert.ok(outdated.includes('Start Codex') && outdated.includes('Let AIBI hand work to it'));
    const pending = pageText(state({ live: liveMode('codex-local') }), 'home');
    assert.ok(pending.includes('You saved Codex, but it is not active yet.') && pending.includes('Waiting for AiBinator to switch'));
    const paused = pageText(state({ live: liveMode('disabled') }), 'home');
    assert.ok(paused.includes('CODEX'), 'a paused bridge shows the saved responder');
    const unknown = pageText(state({ live: liveMode('mystery') }), 'home');
    assert.ok(unknown.includes('ASSISTANT') && unknown.includes('External'), 'an unknown responder is shown generically');
    const changed = state({ drafts: { operator: { instructions: 'Hi' } } });
    assert.ok(pageText(changed, 'home').includes('1 unsaved change. Press S to review.'));
    const twice = state({ drafts: { operator: { instructions: 'Hi', progressSeconds: 30 } } });
    assert.ok(pageText(twice, 'home').includes('2 unsaved changes.'));
}

function checkSystem(): void {
    const service = (active: boolean, installed: boolean) =>
        pageText(state({}, { observed: { ...observed, service: { available: true, installed, active } } }), 'system');
    const running = service(true, true);
    assert.ok(running.includes('Reinstall AiBinator') && running.includes('Restart AiBinator'), 'a running service can be restarted');
    const stopped = service(false, true);
    assert.ok(stopped.includes('Reinstall AiBinator') && !stopped.includes('Restart AiBinator'));
    assert.ok(service(false, false).includes('Install AiBinator'));
    assert.ok(running.includes('.data/setup-backups'));
}

function checkAssistant(): void {
    const page = (patch: Patch, extra: Partial<UiState> = {}) => pageText(state(patch, extra), 'assistant');
    assert.ok(page({}).includes(' ACTIVE '), 'the running responder is marked active');
    assert.ok(page({ live: liveMode('claude-session') }).includes(' SAVED '), 'the saved responder is marked saved');
    assert.ok(page({ drafts: { operator: { mode: 'manual-mcp' } } }).includes(' SELECTED · UNSAVED '));
    assert.ok(page({}).includes(' RECOMMENDED '), 'Claude Code is recommended');
    const desktop = page({
        drafts: { operator: { mode: 'claude-session' } },
        live: liveMode('claude-session', { session: { live: true } }),
    });
    assert.ok(desktop.includes('Live in Claude Desktop'));
    const codex = (connected: boolean) =>
        page({}, { extras: { apps: { codex: { id: 'codex', cli: true, connected, status: connected ? 'Connected' : 'Not connected' } } } });
    assert.ok(codex(true).includes('✓ AIBI tools connected'), 'connected tools are checked off');
    assert.ok(codex(false).includes('○ AIBI tools connected'));
    const manual = page({ drafts: { operator: { mode: 'manual-mcp' } } });
    assert.ok(manual.includes('polls for requests and answers them itself') && manual.includes('http://127.0.0.1:8789/mcp'));
}

function checkSignals(): void {
    const header = (patch: Patch, extra: Partial<UiState> = {}) => {
        const current = state(patch, extra);
        const view = viewOf(current);
        return frame({
            view,
            page: 'home',
            focus: 'content',
            items: pageItems('home', view),
            selected: 3,
            scroll: 0,
            width: 120,
            height: 30,
        });
    };
    const top = text(header({}).lines.slice(0, 1));
    assert.ok(top.includes('Starting') && top.includes('Codex') && top.includes('bot.example.com'), 'the header names the responder');
    const nav = (patch: Patch) => text(header(patch).lines);
    assert.ok(nav({}).includes('AIBI      Connected'), 'the menu shows whether AIBI is connected');
    assert.ok(nav({ live: { aibi: { lastContact: null } } }).includes('AIBI      Waiting'));
    assert.ok(nav({ live: null }).includes('AIBI      Unknown'));
    const off = header({ live: liveMode('disabled'), drafts: { environment: { AIBINATOR_RESOURCE_URL: '' } } });
    assert.ok(text(off.lines.slice(0, 1)).includes('No assistant active'), 'a paused bridge names no assistant');
    assert.ok(!text(off.lines.slice(0, 1)).includes('bot.example.com'), 'no domain is shown without one');
    const busy = header({}, { busy: 'Saving…', tick: 3 });
    assert.ok(text(busy.lines.slice(-2)).includes('Saving…'), 'the footer shows the busy task');
    const view = viewOf(state());
    const items = pageItems('aibi', view);
    const scrolled = frame({ view, page: 'aibi', focus: 'content', items, selected: 1, scroll: 40, width: 120, height: 24 });
    assert.ok(scrolled.scroll < 5, 'scrolling back up keeps the selection visible');
    const last = items.findLastIndex((item) => item.intent);
    const down = frame({ view, page: 'aibi', focus: 'content', items, selected: last, scroll: 0, width: 120, height: 24 });
    assert.ok(down.scroll > 0, 'scrolling down keeps the selection visible');
}

function checkItems(): void {
    const view: View = viewOf(state({ drafts: { policy: { aibi: { actions: [actions[0]!.id], animations: [] } } } }));
    const shown = (id: string) => text(settingItem(id).lines(100, true, view));
    assert.match(
        shown('policy.aibi.actions'),
        new RegExp(`1 of ${setting('policy.aibi.actions').choices!.length}`),
        'checklists show how many are chosen',
    );
    assert.match(shown('policy.aibi.animations'), /None/);
    assert.match(shown('policy.aibi.dns'), /On/, 'a missing switch reads as its default');
    assert.match(shown('environment.GEMINI_API_KEY'), /••••••••/, 'a saved key is never shown');
    assert.match(shown('policy.scopes'), /All \d+/, 'every ability is on by default');
    const scopes = (chosen: readonly string[]) =>
        text(settingItem('policy.scopes').lines(100, false, viewOf(state({ drafts: { policy: { scopes: [...chosen] } } }))));
    assert.match(scopes([]), /None/);
    assert.match(scopes(['aibi.read']), /1 of \d+/, 'checklists show how many are chosen');
    assert.match(scopes(setting('policy.scopes').choices!), /All \d+/);
    const restart = viewOf(state({ drafts: { environment: { AIBINATOR_PORT: 9000 } } }));
    assert.doesNotMatch(
        text(settingItem('environment.AIBINATOR_PORT').lines(100, false, restart)),
        /restart/,
        'Changed settings never say they wait for a restart',
    );
    assert.throws(() => settingItem('policy.nothing'), /Unknown setting policy.nothing/);
    const status = statusItem('s', 'Label', 'Value', 'good', { type: 'save' });
    assert.deepEqual(status.intent, { type: 'save' }, 'a status row can be actionable');
    const plain = card({ id: 'c', title: 'Plain card', body: [] });
    assert.equal(plain.intent, undefined);
    assert.ok(text(plain.lines(60, false, view)).includes('Plain card'), 'a card needs no badge');
}

function checkIconWidths(): void {
    for (const page of pages)
        assert.equal(
            stringWidth(page.icon, { ambiguousIsNarrow: false }),
            1,
            `The ${page.label} menu icon is one column wide in every terminal, so rows never wrap and clicks stay aligned`,
        );
}

export function checkUiPages(): void {
    checkIconWidths();
    checkApps();
    checkAibi();
    checkAibiPages();
    checkHome();
    checkSystem();
    checkAssistant();
    checkSignals();
    checkItems();
}
