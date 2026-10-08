import { applyDraft, readPanel, rebaseDrafts, startSaved } from '../panel-store.js';
import { affectsConnections } from '../reconnect.js';
import { readOperatorConfig } from '../config.js';
import { ownerReady } from '../../oauth/provision.js';
import { oauthDirectory } from '../../oauth/registration.js';
import { restartService } from '../install.js';
import { applyUpdate, checkForUpdate, installApp, localShell, updateBlocker } from '../self-install.js';
import { installRecord } from '../app-home.js';
import type { AppUpdate } from './model.js';
import { openConversation } from '../session-router.js';
import { appNames, appState, connectApp, disconnectApp, statusHint, type AppId } from '../connections.js';
import { observations } from './observe.js';
import { localCall, localEndpoint } from '../../mcp/local-client.js';
import { portsAllowed } from '../../aibi/ports.js';
import { publicDomain } from '../connection-domain.js';
import { claudeConnectorLink, markWebAdded, webConnectors, type WebId } from '../web-connectors.js';
import { openUrl } from '../open-url.js';
import { liveSetupStatus } from '../setup-model.js';
import { runtimePresent } from '../status.js';
import type { ActionId } from './model.js';
import { assistantName } from './status.js';
import { logged, viewOf, type UiState } from './state.js';
import type { Button, Sheet } from './sheets.js';
import type { Tone } from './theme.js';
import type { SettingDefinition } from '../settings-registry.js';
import { passwordError } from '../../oauth/provision.js';
import { savePassword } from '../onboarding-store.js';

const services = {
    liveSetupStatus,
    runtimePresent,
    readOperatorConfig,
    readPanel,
    applyDraft,
    startSaved,
    observations,
    ownerReady,
    appState,
    connectApp,
    disconnectApp,
    webConnectors,
    markWebAdded,
    portsAllowed,
    clearMemory,
    openUrl,
    openConversation,
    installService: async () => (await installApp(localShell(false))).join(' '),
    restartService,
    savePassword,
    checkUpdate,
    applyUpdate: async () => `${await applyUpdate(localShell(false))} Reopen aibinator to use the new version of this app.`,
};

async function clearMemory(): Promise<string> {
    const result = await localCall(await localEndpoint(), 'tools/call', { name: 'aibi_history_clear', arguments: {} }, 10_000);
    const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? '';
    if (result.isError) throw new Error(text || 'AiBinator could not forget the conversation');
    return 'AIBI’s conversation memory was erased.';
}

async function checkUpdate(): Promise<AppUpdate | undefined> {
    if (!(await installRecord())) return undefined;
    try {
        const state = await checkForUpdate(localShell(false));
        const blocker = updateBlocker(state);
        return { behind: state.behind, current: state.current, latest: state.latest, ...(blocker ? { blocker } : {}) };
    } catch (error) {
        return { behind: 0, current: '', latest: '', error: error instanceof Error ? error.message.slice(0, 160) : 'unknown error' };
    }
}
export type Services = typeof services;

export interface Store {
    get(): UiState;
    set(update: (state: UiState) => UiState): void;
    exit(): void;
    services?: Services;
}

export const io = (store: Store): Services => store.services ?? services;

const friendly = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong').slice(0, 240);
const close = (store: Store) => store.set((state) => ({ ...state, sheet: undefined }));

type Outcome = string | { message: string; warning?: boolean };
async function task(store: Store, label: string, work: () => Promise<Outcome>): Promise<boolean> {
    store.set((state) => ({ ...state, busy: label, sheet: undefined }));
    try {
        const outcome = await work();
        const [message, tone]: [string, Tone] =
            typeof outcome === 'string' ? [outcome, 'good'] : [outcome.message, outcome.warning ? 'warn' : 'good'];
        store.set((state) => logged({ ...state, busy: undefined }, message, tone));
        return true;
    } catch (error) {
        store.set((state) => logged({ ...state, busy: undefined }, friendly(error), 'bad'));
        return false;
    }
}

async function reported(store: Store, work: () => Promise<void>): Promise<void> {
    try {
        await work();
    } catch (error) {
        store.set((state) => logged(state, friendly(error), 'bad'));
    }
}

export const refreshStatus = (store: Store): Promise<void> =>
    reported(store, async () => {
        const live = await io(store).liveSetupStatus();
        store.set((state) => ({ ...state, observed: { ...state.observed, live, observedAt: new Date().toISOString() } }));
    });

export const refreshLive = (store: Store): Promise<void> =>
    reported(store, async () => {
        const use = io(store);
        const [live, runtime, active] = await Promise.all([use.liveSetupStatus(), use.runtimePresent(), use.readOperatorConfig()]);
        store.set((state) => ({ ...state, observed: { ...state.observed, live, runtime, active, observedAt: new Date().toISOString() } }));
    });

export const reloadPanel = (store: Store): Promise<void> =>
    reported(store, async () => {
        const next = await io(store).readPanel();
        store.set((state) => ({ ...state, snapshot: next, drafts: rebaseDrafts(state.snapshot, state.drafts, next) }));
    });

async function extras(store: Store): Promise<void> {
    const { environment, policy } = store.get().snapshot.documents;
    const aibi = (policy.aibi ?? {}) as { httpPort?: number; httpsPort?: number; dnsPort?: number };
    const lowest = Math.min(aibi.httpPort ?? 80, aibi.httpsPort ?? 443, aibi.dnsPort ?? 53);
    const use = io(store);
    const [claude, codex, web, password, ports, update] = await Promise.all([
        use.appState('claude-code'),
        use.appState('codex'),
        use.webConnectors(),
        use.ownerReady(oauthDirectory.parse(environment.AIBINATOR_OAUTH_DATA_DIR)),
        use.portsAllowed(lowest),
        use.checkUpdate(),
    ]);
    store.set((state) => ({
        ...state,
        extras: { apps: { 'claude-code': claude, codex }, web, password, ports, ...(update ? { update } : {}) },
    }));
}

export const refresh = (store: Store, deep = false): Promise<void> =>
    reported(store, async () => {
        if (deep) await reloadPanel(store);
        const observed = await io(store).observations(deep ? undefined : store.get().observed);
        store.set((state) => ({ ...state, observed }));
        if (deep) await extras(store);
    });

export function confirm(store: Store, title: string, body: string[], buttons: Button[]): void {
    store.set((state) => ({ ...state, sheet: { kind: 'confirm', title, body, buttons, index: 0 } }));
}

async function activate(store: Store, enabled: boolean): Promise<void> {
    const label = assistantName(store.get().snapshot.documents.operator.mode);
    await task(store, enabled ? `Starting ${label}…` : 'Pausing…', () => io(store).startSaved(store.get().snapshot, enabled));
    await refresh(store);
}

const appNotes: Record<AppId, string> = {
    'claude-code':
        'Installs a local plugin that gives every Claude Code session, including Claude Desktop, the AIBI tools with no sign-in.',
    codex: 'Points Codex at AiBinator on this computer with its private local key, so there is nothing to sign in to.',
};

function appSheet(store: Store, id: AppId): void {
    const state = store.get().extras.apps[id];
    const connected = Boolean(state?.connected);
    const connect = () => void task(store, `Connecting ${appNames[id]}…`, () => io(store).connectApp(id)).then(() => refresh(store, true));
    const disconnect = () =>
        void task(store, `Disconnecting ${appNames[id]}…`, () => io(store).disconnectApp(id)).then(() => refresh(store, true));
    confirm(
        store,
        appNames[id],
        [`Status: ${state?.status ?? 'Checking…'}. ${statusHint[state?.status ?? ''] ?? ''}`.trim(), appNotes[id]],
        [
            { label: connected ? 'Repair' : 'Connect', tone: 'good', run: connect },
            ...(connected ? [{ label: 'Disconnect', tone: 'bad' as const, run: disconnect }] : []),
            { label: 'Cancel', tone: 'idle', run: () => close(store) },
        ],
    );
}

const webGuides: Record<WebId, { title: string; steps: (url: string) => string[] }> = {
    claude: {
        title: 'Claude on the web and phone',
        steps: (url) => [
            `Open claude.ai, add a custom connector named AiBinator with ${url}, and sign in with your AiBinator password.`,
            'Claude on the web, the phone app and Desktop chats can then use the AIBI tools when you ask.',
        ],
    },
    chatgpt: {
        title: 'ChatGPT on the web and phone',
        steps: (url) => [
            `In ChatGPT open Settings, Apps & Connectors, turn on Developer mode, and create a connector named AiBinator with ${url}. Sign in once with your AiBinator password.`,
        ],
    },
};

function webSheet(store: Store, id: WebId): void {
    const domain = publicDomain(store.get().snapshot.documents.environment.AIBINATOR_RESOURCE_URL);
    if (!domain) return store.set((state) => logged(state, 'Set your public domain on the Apps page first.', 'warn'));
    const url = `https://${domain}/mcp`;
    const save = () => void task(store, 'Saving…', () => io(store).markWebAdded(id, url)).then(() => refresh(store, true));
    confirm(store, webGuides[id].title, webGuides[id].steps(url), [
        ...(id === 'claude'
            ? [
                  {
                      label: 'Open claude.ai',
                      tone: 'info' as const,
                      run: () =>
                          void task(
                              store,
                              'Opening claude.ai…',
                              async () => (await io(store).openUrl(claudeConnectorLink(url)), 'Opened claude.ai with AiBinator filled in.'),
                          ),
                  },
              ]
            : []),
        { label: 'I added it', tone: 'good', run: save },
        { label: 'Cancel', tone: 'idle', run: () => close(store) },
    ]);
}

function service(store: Store, install: boolean): void {
    confirm(
        store,
        install ? 'Install the background service?' : 'Restart AiBinator?',
        install
            ? [
                  'AiBinator is built, checked, and installed as a user service that starts when you log in.',
                  'A AiBinator you started by hand keeps running and is never stopped.',
              ]
            : [
                  'Settings already apply without a restart; use this only if something seems stuck. Work in progress is paused and resumes after the restart.',
              ],
        [
            {
                label: install ? 'Install' : 'Restart',
                tone: install ? 'info' : 'warn',
                run: () =>
                    void task(
                        store,
                        install ? 'Installing service…' : 'Restarting…',
                        install ? io(store).installService : io(store).restartService,
                    ).then(() => refresh(store)),
            },
            { label: 'Cancel', tone: 'idle', run: () => close(store) },
        ],
    );
}

const passwordField = (id: string, label: string): SettingDefinition => ({
    id,
    source: 'environment',
    path: id,
    page: 'connections',
    label,
    description: 'Apps that reach AiBinator through your public domain sign in with this password. At least 12 characters.',
    kind: 'text',
    credential: true,
    apply: 'live',
});
const passwordFields = [passwordField('action.password', 'Sign-in password'), passwordField('action.password-confirm', 'Confirm password')];
let chosenPassword = '';

function passwordSheet(store: Store, index: 0 | 1): void {
    const field = passwordFields[index]!;
    store.set((state) => ({ ...state, sheet: { kind: 'edit', field, label: field.label, input: '', options: [], labels: {} } }));
}

export const isPasswordSheet = (sheet: Extract<Sheet, { kind: 'edit' }>) => passwordFields.includes(sheet.field);

export function commitPassword(store: Store, sheet: Extract<Sheet, { kind: 'edit' }>): void {
    const error =
        sheet.field === passwordFields[0]
            ? passwordError(sheet.input)
            : sheet.input === chosenPassword
              ? undefined
              : 'The passwords do not match.';
    if (error) return store.set((state) => ({ ...state, sheet: { ...sheet, error } }));
    if (sheet.field === passwordFields[0]) {
        chosenPassword = sheet.input;
        return passwordSheet(store, 1);
    }
    chosenPassword = '';
    void task(
        store,
        'Saving sign-in password…',
        async () => (await io(store).savePassword(sheet.input), 'Sign-in password saved. It works on the next sign-in.'),
    ).then(() => refresh(store, true));
}

export function run(store: Store, action: ActionId): void {
    const handlers: Record<ActionId, () => unknown> = {
        start: () => activate(store, true),
        pause: () => activate(store, false),
        refresh: () => task(store, 'Checking everything…', async () => (await refresh(store, true), 'Status refreshed.')),
        'open-session': () =>
            task(store, 'Opening Claude Desktop…', () =>
                io(store).openConversation(String(store.get().snapshot.documents.operator.workspace)),
            ),
        'app-claude-code': () => appSheet(store, 'claude-code'),
        'app-codex': () => appSheet(store, 'codex'),
        'web-claude': () => webSheet(store, 'claude'),
        'web-chatgpt': () => webSheet(store, 'chatgpt'),
        'sign-in-password': () => passwordSheet(store, 0),
        'install-service': () => service(store, true),
        'restart-service': () => service(store, false),
        update: () => task(store, 'Updating AiBinator…', () => io(store).applyUpdate()).then(() => refresh(store, true)),
        'clear-memory': () => forget(store),
        'allow-ports': () =>
            confirm(
                store,
                'Allow ports 53, 80 and 443',
                [
                    'AIBI only talks to ports 53 (DNS), 80 and 443. On Linux, normal programs may not use ports below 1024 until you allow it once, and a ufw firewall must let your network reach them.',
                    'Run this in a terminal; it asks for your password: aibinator ports',
                ],
                [{ label: 'OK', tone: 'good', run: () => close(store) }],
            ),
    };
    void handlers[action]();
}

function forget(store: Store): void {
    confirm(
        store,
        'Forget everything?',
        ['AIBI’s voice and your responder lose the conversation so far, and its photos are deleted.'],
        [
            {
                label: 'Forget',
                tone: 'bad',
                run: () => void task(store, 'Forgetting…', () => io(store).clearMemory()).then(() => refresh(store)),
            },
            { label: 'Cancel', tone: 'idle', run: () => close(store) },
        ],
    );
}

async function commit(store: Store): Promise<boolean> {
    const before = store.get().snapshot.documents.operator.mode;
    const connections = affectsConnections(viewOf(store.get()).changes);
    const saved = await task(store, 'Saving…', async () => {
        const result = await io(store).applyDraft(store.get().snapshot, store.get().drafts);
        store.set((state) => ({ ...state, snapshot: result.snapshot, drafts: structuredClone(result.snapshot.documents) }));
        return result;
    });
    if (!saved) return false;
    const mode = store.get().snapshot.documents.operator.mode;
    await refresh(store, connections || mode !== before);
    return true;
}

export function review(store: Store): void {
    const changes = viewOf(store.get()).changes;
    if (!changes.length) return store.set((state) => ({ ...state, toast: { text: 'Nothing to save.', tone: 'idle' } }));
    confirm(
        store,
        `Save ${changes.length} change${changes.length === 1 ? '' : 's'}?`,
        [...changes.map((change) => `${change.label}: ${change.before} → ${change.after}`)],
        [
            { label: 'Save', tone: 'good', run: () => void commit(store) },
            { label: 'Keep editing', tone: 'idle', run: () => close(store) },
            {
                label: 'Discard all',
                tone: 'bad',
                run: () =>
                    store.set((state) =>
                        logged(
                            { ...state, sheet: undefined, drafts: structuredClone(state.snapshot.documents) },
                            'Changes discarded.',
                            'idle',
                        ),
                    ),
            },
        ],
    );
}

export function quit(store: Store): void {
    if (!viewOf(store.get()).changes.length) return store.exit();
    confirm(
        store,
        'Save before leaving?',
        ['AiBinator keeps running after you close this screen.'],
        [
            { label: 'Save and quit', tone: 'good', run: () => void commit(store).then((saved) => saved && store.exit()) },
            { label: 'Quit without saving', tone: 'bad', run: () => store.exit() },
            { label: 'Stay', tone: 'idle', run: () => close(store) },
        ],
    );
}
