import React, { useCallback, useEffect, useRef, useState } from 'react';
import { finished, useContact, useVerify, verifyChecks, type Check } from './onboarding-verify.js';
import { passwordError } from '../oauth/provision.js';
import { useApp, useInput, useStdout } from 'ink';
import { installApp, localShell } from './self-install.js';
import { appNames, connectApp, responderApps } from './connections.js';
import { readOperatorConfig, type OperatingMode } from './config.js';
import { readPanel, startSaved } from './panel-store.js';
import {
    checkGeminiKey,
    needsPassword,
    networkReadiness,
    onboardingPhase,
    saveAi,
    savePassword,
    saveVoice,
    validateAi,
    writePhase,
    type OnboardingPhase,
} from './onboarding-store.js';
import { buttonsFor, choices, count, startable, stepView, textSteps, type State, type Step } from './onboarding-copy.js';
import { wizardFrame } from './onboarding-view.js';
import { hits, targetAt, type Hit } from './ui/canvas.js';
import { h, Frame } from './ui/render.js';
import { useSgrMouse } from './ui/use-mouse.js';
import { typed, type Key } from './ui/keys.js';

type Setter = React.Dispatch<React.SetStateAction<State>>;

const previous: Partial<Record<Step, Step>> = {
    name: 'welcome',
    gemini: 'name',
    password: 'ai',
    'password-confirm': 'password',
    'ai-review': 'ai',
    service: 'ai-review',
    ports: 'service',
    aibi: 'ports',
    verify: 'aibi',
};

function back(state: State): State {
    return { ...state, step: previous[state.step] ?? state.step, input: '', selected: 0, error: undefined, notice: undefined };
}

const fresh = (state: State): State => ({ ...state, input: '', selected: 0, error: undefined, notice: undefined });
type Advance = (state: State, button: string | undefined, onComplete: () => void) => State | Promise<State>;

async function aiReview(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    await saveAi(state.choice!);
    return { ...fresh(state), step: responderApps[state.choice!] ? 'connect' : 'service' };
}

async function review(state: State): Promise<State> {
    return { ...state, step: 'ai-review', evidence: await validateAi(state.choice!) };
}

async function signIn(state: State): Promise<State> {
    return (await needsPassword()) ? { ...state, step: 'password' } : review(state);
}

async function gemini(state: State): Promise<State> {
    const key = state.input.trim();
    await checkGeminiKey(key);
    await saveVoice(state.name, key);
    return { ...fresh(state), step: 'ai', notice: 'Gemini key works and is saved.' };
}

async function ports(state: State, button: string | undefined): Promise<State> {
    const network = await networkReadiness();
    if (network.ports || button === 'Skip') return { ...fresh(state), step: 'aibi', network };
    return {
        ...state,
        network,
        error: 'Ports below 1024 are still not allowed, or the firewall still blocks them. Run aibinator ports in a terminal, then check again.',
    };
}

async function aibi(state: State, button: string | undefined): Promise<State> {
    if (button === 'Check again' && !state.contacted)
        return { ...state, network: await networkReadiness(), error: 'AIBI has not called yet. Check its DNS setting and restart it.' };
    await writePhase('verify');
    return { ...fresh(state), step: 'verify', checks: await verifyChecks(state.choice) };
}

const steps: Partial<Record<Step, Advance>> = {
    welcome: (state) => ({ ...fresh(state), step: 'name' }),
    name: (state) => ({ ...fresh(state), step: 'gemini', name: state.input.trim() }),
    gemini,
    ai: (state) => signIn({ ...fresh(state), choice: choices[state.selected]! }),
    password: (state) => {
        const error = passwordError(state.input);
        if (error) throw new Error(error);
        return { ...fresh(state), step: 'password-confirm', password: state.input };
    },
    'password-confirm': async (state) => {
        if (state.input !== state.password) throw new Error('The passwords do not match. Type it again.');
        await savePassword(state.input);
        return review({ ...fresh(state), password: undefined, notice: 'Password saved.' });
    },
    'ai-review': aiReview,
    connect: (state, button) => (button === 'Skip' || !state.error ? { ...fresh(state), step: 'service' } : fresh(state)),
    service: (state, button) => install(state, button),
    ports,
    aibi,
    verify: (state, _button, onComplete) => verify(state, onComplete),
};

export function resumed(phase: OnboardingPhase, mode: OperatingMode): Pick<State, 'step' | 'choice'> {
    const steps: Partial<Record<OnboardingPhase, Step>> = { ai: 'ai', service: 'service', aibi: 'ports', verify: 'verify' };
    const step = steps[phase] ?? 'welcome';
    return step === 'welcome' || step === 'ai' ? { step } : { step, choice: mode };
}

export async function advance(state: State, onComplete: () => void): Promise<State> {
    const handler = steps[state.step];
    return handler ? handler(state, buttonsFor(state)[state.selected], onComplete) : state;
}

async function install(state: State, button: string | undefined): Promise<State> {
    if (button === 'Back') return back(state);
    if (button === 'Install') await installApp(localShell(false));
    await writePhase('aibi');
    return { ...fresh(state), step: 'ports', network: await networkReadiness() };
}

async function verify(state: State, onComplete: () => void): Promise<State> {
    let checks = await verifyChecks(state.choice);
    if (startable(checks) && checks.some((check) => !check.ok && check.start)) {
        await startSaved(await readPanel(), true);
        checks = await verifyChecks(state.choice);
    }
    if (!finished(checks)) return { ...state, checks, error: 'Not everything is connected yet. Follow the next step shown above.' };
    await writePhase('complete');
    onComplete();
    return { ...state, checks };
}

const initial: State = { step: 'loading', input: '', selected: 0, name: '', busy: 'Loading…' };
const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

function usePhase(setState: Setter): void {
    useEffect(() => {
        void Promise.all([onboardingPhase(process.env), readOperatorConfig()]).then(([phase, config]) =>
            setState((current) => ({ ...current, ...resumed(phase, config.mode), busy: undefined })),
        );
    }, [setState]);
}

function useLocalConnect(state: State, setState: Setter): void {
    const app = state.step === 'connect' && !state.busy && !state.error && !state.notice ? responderApps[state.choice!] : undefined;
    useEffect(() => {
        if (!app) return;
        setState((current) => ({ ...current, busy: `Connecting ${appNames[app]}…` }));
        void connectApp(app)
            .then((notice) => setState((current) => ({ ...current, busy: undefined, notice })))
            .catch((error: unknown) => setState((current) => ({ ...current, busy: undefined, error: message(error, 'Install failed.') })));
    }, [app, setState]);
}

function useTick(active: boolean): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setTick((value) => value + 1), 140);
        return () => clearInterval(timer);
    }, [active]);
    return tick;
}

function move(state: State, key: Key): State | undefined {
    const total = count(state);
    const delta = Number(key.downArrow || key.rightArrow) - Number(key.upArrow || key.leftArrow);
    return delta && total ? { ...state, selected: (state.selected + delta + total) % total } : undefined;
}

function wizardKey(
    state: State,
    input: string,
    key: Key,
    actions: { exit(): void; submit(next: State): void; set(next: State): void },
): void {
    if (key.ctrl && input === 'c') return actions.exit();
    if (state.busy || input.includes('[<')) return;
    if (key.escape) return actions.set(back(state));
    const moved = move(state, key);
    if (moved) return actions.set(moved);
    if (key.return) return actions.submit(state);
    if (textSteps.includes(state.step)) actions.set({ ...state, input: typed(state.input, input, key), error: undefined });
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [state, setState] = useState<State>(initial);
    const tick = useTick(Boolean(state.busy));
    const map = useRef<Hit[]>([]);
    const submit = (current: State) => {
        setState({ ...current, busy: 'Working…', error: undefined });
        void advance(current, onComplete)
            .then((next) => setState({ ...next, busy: undefined }))
            .catch((error: unknown) =>
                setState({ ...current, busy: undefined, error: message(error, 'Setup failed. Nothing was saved.') }),
            );
    };
    usePhase(setState);
    useLocalConnect(state, setState);
    const setChecks = useCallback((checks: Check[]) => setState((current) => ({ ...current, checks })), []);
    const setContacted = useCallback((contacted: boolean) => setState((current) => ({ ...current, contacted })), []);
    useVerify(state.step === 'verify', state.choice, setChecks);
    useContact(state.step === 'aibi', setContacted);
    useSgrMouse((code, x, y) => {
        const target = code === 0 && !state.busy ? targetAt(map.current, x, y) : undefined;
        if (target) submit({ ...state, selected: Number(target.split(':')[1]) });
    });
    useInput((input, key) => wizardKey(state, input, key, { exit, submit, set: setState }));
    const lines = wizardFrame(stepView(state, tick), stdout.columns || 80, (stdout.rows || 24) - 1);
    map.current = hits(lines);
    return h(Frame, { lines });
}
