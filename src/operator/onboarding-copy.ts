import { verifyLines, type Check } from './onboarding-verify.js';
import { appNames, responderApps } from './connections.js';
import type { AiChoice, NetworkReadiness } from './onboarding-store.js';
import type { StepView } from './onboarding-view.js';
import { assistants } from './ui/status.js';

export type Step =
    | 'loading'
    | 'welcome'
    | 'name'
    | 'gemini'
    | 'ai'
    | 'password'
    | 'password-confirm'
    | 'ai-review'
    | 'connect'
    | 'service'
    | 'ports'
    | 'aibi'
    | 'verify';
export interface State {
    step: Step;
    input: string;
    selected: number;
    name: string;
    choice?: AiChoice;
    password?: string;
    network?: NetworkReadiness;
    contacted?: boolean;
    checks?: Check[];
    evidence?: string;
    busy?: string;
    error?: string;
    notice?: string;
}
export const choices: AiChoice[] = ['claude-session', 'codex-local', 'manual-mcp'];
const stageOf: Record<Step, number> = {
    loading: 0,
    welcome: 0,
    name: 0,
    gemini: 0,
    ai: 1,
    password: 1,
    'password-confirm': 1,
    'ai-review': 1,
    connect: 1,
    service: 2,
    ports: 3,
    aibi: 3,
    verify: 3,
};
export const textSteps: Step[] = ['name', 'gemini', 'password', 'password-confirm'];
const maskedSteps: Step[] = ['gemini', 'password', 'password-confirm'];
export const startable = (checks: Check[] | undefined): boolean =>
    Boolean(checks?.every((check) => check.ok || check.start || check.optional));

export function buttonsFor(state: State): string[] {
    const sets: Partial<Record<Step, string[]>> = {
        welcome: ['Begin'],
        'ai-review': ['Save', 'Back'],
        connect: state.error ? ['Retry', 'Skip'] : ['Continue'],
        service: ['Skip', 'Install', 'Back'],
        ports: state.network?.ports ? ['Continue'] : ['Check again', 'Skip'],
        aibi: state.contacted ? ['Continue'] : ['Check again', 'Skip for now'],
        verify: startable(state.checks) ? ['Finish'] : ['Check again'],
    };
    return sets[state.step] ?? [];
}

function optionsFor(state: State): string[] | undefined {
    if (state.step === 'ai') return choices.map((choice) => assistants[choice].name);
}

export const count = (state: State): number => optionsFor(state)?.length ?? buttonsFor(state).length;

const passwordCopy = {
    password: {
        title: 'Choose a sign-in password',
        body: [
            'Apps that reach AiBinator through your public domain, like ChatGPT and Claude on the web, sign in with this password. There is no username.',
            'At least 12 characters. You can change it later on the Apps page.',
        ],
    },
    confirm: { title: 'Confirm the password', body: ['Type the same password once more.'] },
};

const reviewNote = (choice?: AiChoice) =>
    choice === 'manual-mcp' ? 'Your MCP app connects to AiBinator and answers by itself.' : 'It starts when you finish setup.';

function aibiCopy(state: State): { title: string; body: string[] } {
    const address = state.network?.address || 'this computer’s address';
    return {
        title: state.contacted ? 'AIBI is connected' : 'Point AIBI at this computer',
        body: state.contacted
            ? ['AIBI just called AiBinator. From now on, wake it as usual and AiBinator answers.']
            : [
                  `In your router’s DHCP or DNS settings, give AIBI (or your whole network) ${address} as its DNS server, then turn AIBI off and on again.`,
                  `Give this computer a fixed address (a DHCP reservation for ${address}) so AIBI keeps finding it. AiBinator answers only api.aibipocket.com and forwards every other name, so the rest of your network keeps working.`,
                  'This screen continues by itself as soon as AIBI calls.',
              ],
    };
}

function portsCopy(state: State): { title: string; body: string[] } {
    if (state.network?.ports) return { title: 'Ports are ready', body: ['AiBinator can use ports 53, 80 and 443, where AIBI talks.'] };
    return {
        title: 'Allow AIBI’s ports',
        body: [
            'AIBI only talks to ports 53 (DNS), 80 and 443. On Linux, normal programs may not use ports below 1024 until you allow it once, and a ufw firewall must let your network reach them.',
            'Run this in another terminal (it asks for your password), then choose Check again:',
            '    aibinator ports        (or, from this folder: npm run aibinator -- ports)',
        ],
    };
}

function copy(state: State): { title: string; body: string[] } {
    const copies: Record<Step, () => { title: string; body: string[] }> = {
        loading: () => ({ title: 'Welcome', body: ['Reading your setup progress…'] }),
        welcome: () => ({
            title: 'Welcome to AiBinator',
            body: [
                'AiBinator becomes your AIBI’s brain. Gemini Live is its voice, quick and playful, and your own AI does the real work it hands over.',
                'First its voice, then who does the work, then we connect your AIBI. Nothing is written until you review it.',
            ],
        }),
        name: () => ({ title: 'What should AIBI call you?', body: ['Your first name or a nickname. Leave it empty to skip.'] }),
        gemini: () => ({
            title: 'AIBI’s voice',
            body: [
                'Paste a Google Gemini API key from aistudio.google.com/apikey. It stays hidden and is checked with Google before saving.',
            ],
        }),
        ai: () => ({ title: 'Who does the real work?', body: [assistants[choices[state.selected] ?? 'claude-session'].blurb] }),
        password: () => passwordCopy.password,
        'password-confirm': () => passwordCopy.confirm,
        'ai-review': () => ({
            title: 'Ready to save',
            body: [assistants[state.choice ?? 'claude-session'].name, state.evidence ?? '', reviewNote(state.choice)],
        }),
        connect: () => ({
            title: `Connect ${appNames[responderApps[state.choice ?? 'claude-session'] ?? 'claude-code']}`,
            body: ['AiBinator connects it on this computer so it gets the AIBI tools. Nothing to sign in to.'],
        }),
        service: () => ({
            title: 'Install AiBinator',
            body: [
                'Installs AiBinator with its own copy and a background service that starts when you log in. Afterwards, type aibinator in any terminal to open this app, and you can delete the folder you cloned.',
                'A AiBinator you started by hand is never stopped.',
            ],
        }),
        ports: () => portsCopy(state),
        aibi: () => aibiCopy(state),
        verify: () => ({ title: 'Make sure it works', body: verifyLines(state.checks) }),
    };
    return copies[state.step]();
}

export function stepView(state: State, tick: number): StepView {
    const options = optionsFor(state);
    const view: StepView = { stage: stageOf[state.step], ...copy(state), selected: state.selected, tick, buttons: buttonsFor(state) };
    if (options) view.options = options;
    if (state.step === 'ai') view.tags = choices.map((choice) => assistants[choice].tag);
    if (textSteps.includes(state.step)) view.input = { value: state.input, masked: maskedSteps.includes(state.step) };
    for (const key of ['notice', 'error', 'busy'] as const) if (state[key]) view[key] = state[key];
    return view;
}
