import assert from 'node:assert/strict';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { policySchema } from '../src/core/config.js';
import type { PanelSnapshot } from '../src/operator/panel-store.js';
import type { Observations } from '../src/operator/ui/model.js';
import type { Key } from '../src/operator/ui/keys.js';
import { initialState, type UiState } from '../src/operator/ui/state.js';
import type { Services, Store } from '../src/operator/ui/effects.js';
import { aibiStatus } from './fixtures.js';
import type { Sheet } from '../src/operator/ui/sheets.js';

const documents = {
    operator: { ...defaultOperatorConfig(), mode: 'codex-local' },
    policy: policySchema.parse({}),
    environment: {
        AIBINATOR_RESOURCE_URL: 'https://bot.example.com/mcp',
        GEMINI_API_KEY: 'secret',
        AIBINATOR_AUTH_MODE: 'bearer',
    },
};
export const snapshot: PanelSnapshot = {
    documents: structuredClone(documents),
    originals: { operator: '', policy: '', environment: '' },
    paths: { operator: '', policy: '', environment: '' },
};
export const models = {
    source: 'fixture',
    observedAt: '',
    note: '',
    defaultModel: { id: '', name: 'Default', efforts: ['high'] },
    models: [],
};
export const observed: Observations = {
    live: { aibi: aibiStatus(), operator: { mode: 'codex-local', appliedConfigAt: null } },
    runtime: true,
    active: { ...defaultOperatorConfig(), mode: 'codex-local', enabled: true },
    codex: models,
    claude: models,
    service: { available: true, installed: false, active: false },
    observedAt: '',
};
export const key = (patch: Partial<Key> = {}): Key => ({
    ctrl: false,
    meta: false,
    escape: false,
    return: false,
    tab: false,
    shift: false,
    backspace: false,
    delete: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    ...patch,
});

export type Calls = [string, ...unknown[]][];

export function fakeServices(calls: Calls, overrides: Partial<Services> = {}): Services {
    const record =
        <T>(name: string, value: T) =>
        (...args: unknown[]) => {
            calls.push([name, ...args]);
            return Promise.resolve(value);
        };
    const fakes: Services = {
        liveSetupStatus: record('liveSetupStatus', observed.live),
        runtimePresent: record('runtimePresent', true),
        readOperatorConfig: record('readOperatorConfig', observed.active),
        readPanel: record('readPanel', snapshot),
        applyDraft: record('applyDraft', { snapshot, message: 'Saved.' }),
        startSaved: record('startSaved', 'Started.'),
        observations: record('observations', observed),
        ownerReady: record('ownerReady', true),
        appState: record('appState', { id: 'codex', cli: true, connected: true, status: 'Connected' }),
        connectApp: record('connectApp', 'Connected.'),
        disconnectApp: record('disconnectApp', 'Disconnected.'),
        webConnectors: record('webConnectors', {}),
        markWebAdded: record('markWebAdded', 'Marked.'),
        portsAllowed: record('portsAllowed', true),
        clearMemory: record('clearMemory', 'Forgotten.'),
        openUrl: record('openUrl', undefined),
        openConversation: record('openConversation', 'Opened.'),
        installService: record('installService', 'Installed.'),
        restartService: record('restartService', 'Restarted.'),
        savePassword: record('savePassword', undefined),
        checkUpdate: record('checkUpdate', undefined),
        applyUpdate: record('applyUpdate', 'Updated.'),
    };
    return { ...fakes, ...overrides };
}

export type TestStore = Store & { state: UiState; exited: boolean };

export function uiStore(services?: Services, state: Partial<UiState> = {}): TestStore {
    const value = { state: { ...initialState(snapshot, observed), ...state }, exited: false } as TestStore;
    value.get = () => value.state;
    value.set = (update) => (value.state = update(value.state));
    value.exit = () => (value.exited = true);
    if (services) value.services = services;
    return value;
}

export const called = (calls: Calls, name: string) => calls.filter(([entry]) => entry === name);

export async function settle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

export const sheetOf = <K extends Sheet['kind']>(ui: TestStore, kind: K) => {
    assert.equal(ui.state.sheet?.kind, kind);
    return ui.state.sheet as Extract<Sheet, { kind: K }>;
};
export async function press(ui: TestStore, label: string): Promise<void> {
    const button = sheetOf(ui, 'confirm').buttons.find((item) => item.label === label);
    assert.ok(button, `button ${label}`);
    await button.run();
    await settle();
}
