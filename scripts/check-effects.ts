import assert from 'node:assert/strict';
import {
    commitPassword,
    isPasswordSheet,
    quit,
    refresh,
    refreshLive,
    refreshStatus,
    reloadPanel,
    review,
    run,
} from '../src/operator/ui/effects.js';
import { claudeConnectorLink } from '../src/operator/web-connectors.js';
import { called, fakeServices, observed, press, settle, sheetOf, snapshot, uiStore, type Calls, type TestStore } from './ui-fixtures.js';

const confirmSheet = (ui: TestStore) => sheetOf(ui, 'confirm');
const editSheet = (ui: TestStore) => sheetOf(ui, 'edit');
const withEnvironment = (ui: TestStore, environment: Record<string, unknown>) =>
    (ui.state = { ...ui.state, snapshot: { ...ui.state.snapshot, documents: { ...ui.state.snapshot.documents, environment } } });

async function checkRefreshes(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls), { observed: { ...observed, live: null, runtime: false } });
    await refreshStatus(ui);
    assert.equal(ui.state.observed.live?.aibi.address, '192.168.1.20', 'status refresh reads the live bridge');
    assert.notEqual(ui.state.observed.observedAt, '');
    await refreshLive(ui);
    assert.equal(ui.state.observed.runtime, true, 'a live refresh also reads the runtime lock');
    assert.deepEqual(called(calls, 'readOperatorConfig').length, 1);
    ui.state = { ...ui.state, drafts: { ...ui.state.drafts, operator: { ...ui.state.drafts.operator, mode: 'manual-mcp' } } };
    const next = structuredClone(snapshot);
    next.documents.environment.AIBINATOR_AUTH_MODE = 'oauth';
    const reload = uiStore(fakeServices(calls, { readPanel: () => Promise.resolve(next) }), { drafts: ui.state.drafts });
    await reloadPanel(reload);
    assert.equal(reload.state.snapshot, next, 'reloading replaces the snapshot');
    assert.equal(reload.state.drafts.operator.mode, 'manual-mcp', 'pending edits survive a reload');
    assert.equal(reload.state.drafts.environment.AIBINATOR_AUTH_MODE, 'oauth', 'untouched values follow the files');
    const failing = uiStore(fakeServices(calls, { liveSetupStatus: () => Promise.reject(new Error('bridge gone')) }));
    await refreshStatus(failing);
    assert.deepEqual(failing.state.toast, { text: 'bridge gone', tone: 'bad' }, 'a failed refresh is reported, not thrown');
    const odd = uiStore(fakeServices(calls, { readPanel: () => Promise.reject(new Error('x'.repeat(400))) }));
    await reloadPanel(odd);
    assert.equal(odd.state.toast?.text.length, 240, 'long errors are shortened');
}

async function checkDeepRefresh(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    await refresh(ui);
    assert.deepEqual(called(calls, 'observations')[0], ['observations', observed], 'a light refresh reuses known models');
    assert.equal(called(calls, 'readPanel').length, 0);
    await refresh(ui, true);
    assert.deepEqual(called(calls, 'observations')[1], ['observations', undefined], 'a deep refresh reloads models');
    assert.deepEqual(
        called(calls, 'appState').map(([, id]) => id),
        ['claude-code', 'codex'],
    );
    assert.deepEqual(called(calls, 'portsAllowed'), [['portsAllowed', 53]], 'the lowest AIBI port is checked');
    assert.equal(ui.state.extras.ports, true);
    assert.equal(ui.state.extras.password, true);
    const testing = structuredClone(snapshot);
    testing.documents.policy = { ...testing.documents.policy, aibi: { httpPort: 8080, httpsPort: 8443, dnsPort: 5353 } };
    const blocked = uiStore(fakeServices(calls, { readPanel: () => Promise.resolve(testing), portsAllowed: () => Promise.resolve(false) }));
    await refresh(blocked, true);
    assert.equal(blocked.state.extras.ports, false, 'ports that are not allowed are remembered');
    const custom = uiStore(fakeServices(calls, { readPanel: () => Promise.resolve(testing) }));
    await refresh(custom, true);
    assert.deepEqual(called(calls, 'portsAllowed').at(-1), ['portsAllowed', 5353], 'custom ports are checked from the lowest one');
}

async function checkTasks(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'start');
    assert.equal(ui.state.busy, 'Starting Codex…', 'the busy label names the responder');
    await settle();
    assert.equal(ui.state.busy, undefined);
    assert.deepEqual(called(calls, 'startSaved')[0], ['startSaved', snapshot, true]);
    assert.deepEqual(ui.state.activity[0]?.text, 'Started.');
    run(ui, 'pause');
    assert.equal(ui.state.busy, 'Pausing…');
    await settle();
    assert.deepEqual(called(calls, 'startSaved')[1], ['startSaved', snapshot, false]);
    run(ui, 'refresh');
    await settle();
    assert.deepEqual(ui.state.toast, { text: 'Status refreshed.', tone: 'good' });
    run(ui, 'open-session');
    await settle();
    assert.deepEqual(called(calls, 'openConversation'), [['openConversation', String(snapshot.documents.operator.workspace)]]);
    const broken = uiStore(fakeServices(calls, { startSaved: () => Promise.reject(new Error('blocked')) }));
    run(broken, 'start');
    await settle();
    assert.equal(broken.state.toast?.tone, 'bad');
    assert.equal(broken.state.toast?.text, 'blocked');
    const notAnError: Error = { name: 'Error', message: 'nope' };
    const strange = uiStore(fakeServices(calls, { installService: () => Promise.reject(notAnError) }));
    run(strange, 'install-service');
    await press(strange, 'Install');
    assert.equal(strange.state.toast?.text, 'Something went wrong', 'non-errors get a friendly message');
}

async function checkApps(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'app-codex');
    assert.equal(confirmSheet(ui).title, 'Codex');
    assert.match(confirmSheet(ui).body[0]!, /Status: Checking…/);
    assert.deepEqual(
        confirmSheet(ui).buttons.map((item) => item.label),
        ['Connect', 'Cancel'],
    );
    await press(ui, 'Connect');
    assert.deepEqual(called(calls, 'connectApp'), [['connectApp', 'codex']]);
    assert.equal(ui.state.extras.apps.codex?.connected, true, 'connecting refreshes the app state');
    run(ui, 'app-claude-code');
    assert.match(confirmSheet(ui).body[0]!, /^Status: Connected\./);
    assert.deepEqual(
        confirmSheet(ui).buttons.map((item) => item.label),
        ['Repair', 'Disconnect', 'Cancel'],
    );
    await press(ui, 'Disconnect');
    assert.deepEqual(called(calls, 'disconnectApp'), [['disconnectApp', 'claude-code']]);
    run(ui, 'app-codex');
    await press(ui, 'Cancel');
    assert.equal(ui.state.sheet, undefined);
}

async function checkWeb(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'web-claude');
    const url = 'https://bot.example.com/mcp';
    assert.equal(confirmSheet(ui).title, 'Claude on the web and phone');
    assert.ok(confirmSheet(ui).body[0]!.includes(url));
    await press(ui, 'Open claude.ai');
    assert.deepEqual(called(calls, 'openUrl'), [['openUrl', claudeConnectorLink(url)]]);
    assert.equal(ui.state.toast?.text, 'Opened claude.ai with AiBinator filled in.');
    run(ui, 'web-chatgpt');
    assert.deepEqual(
        confirmSheet(ui).buttons.map((item) => item.label),
        ['I added it', 'Cancel'],
    );
    assert.equal(confirmSheet(ui).body.length, 1);
    await press(ui, 'I added it');
    assert.deepEqual(called(calls, 'markWebAdded'), [['markWebAdded', 'chatgpt', url]]);
    withEnvironment(ui, {});
    run(ui, 'web-claude');
    assert.equal(ui.state.sheet, undefined);
    assert.deepEqual(ui.state.toast, { text: 'Set your public domain on the Apps page first.', tone: 'warn' });
}

async function checkAibiActions(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'allow-ports');
    assert.equal(confirmSheet(ui).title, 'Allow ports 53, 80 and 443');
    assert.match(confirmSheet(ui).body.at(-1)!, /aibinator ports/, 'the ports guide names the command to run');
    await press(ui, 'OK');
    assert.equal(ui.state.sheet, undefined);
    run(ui, 'clear-memory');
    assert.equal(confirmSheet(ui).title, 'Forget everything?');
    await press(ui, 'Cancel');
    assert.equal(called(calls, 'clearMemory').length, 0, 'cancelling forgets nothing');
    run(ui, 'clear-memory');
    await press(ui, 'Forget');
    assert.equal(called(calls, 'clearMemory').length, 1);
    assert.equal(ui.state.activity.at(-1)?.text, 'Forgotten.');
    const failing = uiStore(fakeServices(calls, { clearMemory: () => Promise.reject(new Error('AiBinator is not running')) }));
    run(failing, 'clear-memory');
    await press(failing, 'Forget');
    assert.deepEqual(failing.state.toast, { text: 'AiBinator is not running', tone: 'bad' });
}

async function checkPassword(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'sign-in-password');
    const first = editSheet(ui);
    assert.equal(first.label, 'Sign-in password');
    assert.equal(isPasswordSheet(first), true);
    commitPassword(ui, { ...first, input: 'short' });
    assert.equal(editSheet(ui).error, 'Use at least 12 characters.');
    const chosen = 'fixture-password-value';
    commitPassword(ui, { ...first, input: chosen });
    const second = editSheet(ui);
    assert.equal(second.label, 'Confirm password', 'a valid password asks for confirmation');
    commitPassword(ui, { ...second, input: `${chosen}!` });
    assert.equal(editSheet(ui).error, 'The passwords do not match.');
    commitPassword(ui, { ...second, input: chosen });
    await settle();
    assert.deepEqual(called(calls, 'savePassword'), [['savePassword', chosen]]);
    assert.equal(ui.state.activity.at(-1)?.text, 'Sign-in password saved. It works on the next sign-in.');
    assert.equal(isPasswordSheet({ ...second, field: { ...second.field } }), false);
}

async function checkService(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    run(ui, 'install-service');
    assert.equal(confirmSheet(ui).title, 'Install the background service?');
    await press(ui, 'Install');
    assert.equal(called(calls, 'installService').length, 1);
    assert.equal(ui.state.activity.at(-1)?.text, 'Installed.');
    run(ui, 'restart-service');
    assert.equal(confirmSheet(ui).title, 'Restart AiBinator?');
    await press(ui, 'Restart');
    assert.equal(called(calls, 'restartService').length, 1);
    run(ui, 'restart-service');
    await press(ui, 'Cancel');
    assert.equal(ui.state.sheet, undefined);
    assert.equal(called(calls, 'restartService').length, 1);
}

export async function checkEffects(): Promise<void> {
    await checkRefreshes();
    await checkDeepRefresh();
    await checkTasks();
    await checkApps();
    await checkWeb();
    await checkAibiActions();
    await checkPassword();
    await checkService();
    const ui = uiStore(fakeServices([]));
    review(ui);
    assert.deepEqual(ui.state.toast, { text: 'Nothing to save.', tone: 'idle' });
    quit(ui);
    assert.equal(ui.exited, true, 'quitting with nothing pending leaves at once');
}
