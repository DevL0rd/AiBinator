import { useEffect } from 'react';
import { parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { appNames, appState, responderApps } from './connections.js';
import { readOperatorConfig } from './config.js';
import { watchFile } from './file-watch.js';
import { statusFile } from './status-file.js';
import { liveSetupStatus, type LiveSetupStatus } from './setup-model.js';
import { assistants } from './ui/status.js';
import type { AiChoice } from './onboarding-store.js';

export interface Check {
    label: string;
    ok: boolean;
    hint: string;
    start?: boolean;
    optional?: boolean;
}

async function startCheck(mode: AiChoice, live: LiveSetupStatus | null): Promise<Check> {
    const active = await readOperatorConfig();
    const blocked = live?.operator.blockedReason;
    const starting = active.enabled && active.mode === mode;
    return {
        label: `${assistants[mode].name} is ready for work`,
        ok: live?.operator.mode === mode && !blocked && live.operator.appliedConfigAt === active.updatedAt,
        hint: blocked ?? (starting ? 'AiBinator is switching to it. Check again in a moment.' : 'Choose Finish to start it.'),
        start: true,
    };
}

function serverChecks(aibi: LiveSetupStatus['aibi'] | undefined): Check[] {
    const dns = aibi?.dns;
    return [
        {
            label: 'AIBI server is listening',
            ok: aibi?.proxy.state === 'running',
            hint: aibi?.proxy.error ?? 'Run aibinator ports in a terminal, then check again.',
        },
        {
            label: 'DNS server is answering',
            ok: dns?.state === 'running' || dns?.state === 'off',
            hint: dns?.error ?? 'Check the AIBI page.',
        },
    ];
}

function aibiChecks(live: LiveSetupStatus | null, key: boolean): Check[] {
    const aibi = live?.aibi;
    return [
        { label: 'AIBI’s voice has a Gemini key', ok: key, hint: 'Add a Google Gemini key on the Voice page.' },
        ...serverChecks(aibi),
        {
            label: 'AIBI has called',
            ok: Boolean(aibi?.lastContact),
            hint: `Point AIBI’s DNS at ${aibi?.address || 'this computer'} (AIBI page), then restart AIBI. You can finish now and do this later.`,
            optional: true,
        },
    ];
}

export async function verifyChecks(choice?: AiChoice): Promise<Check[]> {
    const mode = choice ?? (await readOperatorConfig()).mode;
    const live = await liveSetupStatus();
    const environment = parseEnv(await readFile('.env', 'utf8').catch(() => ''));
    const checks: Check[] = [
        {
            label: 'AiBinator is running',
            ok: Boolean(live),
            hint: 'Go back and install the background service, or start AiBinator with npm start.',
        },
    ];
    const app = responderApps[mode];
    if (app) {
        const state = await appState(app);
        checks.push({
            label: `${appNames[app]} is connected`,
            ok: state.connected,
            hint: `${appNames[app]}: ${state.status}. Go back and connect it.`,
        });
    }
    if (mode !== 'manual-mcp') checks.push(await startCheck(mode, live));
    return [...checks, ...aibiChecks(live, Boolean(environment.GEMINI_API_KEY))];
}

export const finished = (checks: Check[]): boolean => checks.every((check) => check.ok || check.optional);

export function verifyLines(checks: Check[] | undefined): string[] {
    if (!checks) return ['Checking that everything works…'];
    const pending = checks.find((check) => !check.ok);
    return [
        ...checks.map((check) => `${check.ok ? '✓' : '○'} ${check.label}${check.optional && !check.ok ? ' (optional)' : ''}`),
        pending ? `Next: ${pending.hint}` : 'Everything is connected and working.',
    ];
}

export function useVerify(active: boolean, choice: AiChoice | undefined, set: (checks: Check[]) => void): void {
    useEffect(() => {
        if (!active) return;
        const run = () => void verifyChecks(choice).then(set, () => undefined);
        run();
        const stops = [watchFile(statusFile, run), watchFile('.data/operator.json', run)];
        return () => stops.forEach((stop) => stop());
    }, [active, choice, set]);
}

export function useContact(active: boolean, set: (contacted: boolean) => void): void {
    useEffect(() => {
        if (!active) return;
        const run = () =>
            void liveSetupStatus().then(
                (live) => set(Boolean(live?.aibi.lastContact)),
                () => undefined,
            );
        run();
        return watchFile(statusFile, run);
    }, [active, set]);
}
