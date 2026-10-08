import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { statusFile } from '../src/operator/status-file.js';
import { watchFile } from '../src/operator/file-watch.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { environmentStamp } from '../src/reconfigure.js';
import type { LiveSetupStatus } from '../src/operator/setup-model.js';
import { aibiStatus } from './fixtures.js';

type Fetch = typeof fetch;
export interface LiveFake {
    blockedReason?: string;
    mode?: string;
    online: boolean;
    probes: string[];
    gemini: number;
    aibi: Partial<LiveSetupStatus['aibi']>;
    settingsError?: string;
    controller?: Record<string, unknown>;
    activeEventId?: string;
}

function operatorOf(live: LiveFake) {
    const saved = existsSync(join('.data', 'operator.json')) ? readFileSync(join('.data', 'operator.json'), 'utf8') : '';
    const config = (saved ? JSON.parse(saved) : {}) as { mode?: string; enabled?: boolean; updatedAt?: string };
    return {
        mode: live.mode ?? (config.enabled ? config.mode : 'off'),
        appliedConfigAt: config.updatedAt ?? null,
        blockedReason: live.blockedReason ?? null,
        activeEventId: live.activeEventId ?? null,
        ...(live.controller ? { controller: live.controller } : {}),
    };
}

function statusOf(live: LiveFake) {
    const stamp = environmentStamp(existsSync('.env') ? readFileSync('.env', 'utf8') : '');
    const settings = live.settingsError
        ? { applied: null, failed: stamp, error: live.settingsError }
        : { applied: stamp, failed: null, error: null };
    return { operator: operatorOf(live), aibi: aibiStatus(live.aibi), settings };
}

export function syncLive(live: LiveFake): void {
    if (!existsSync('.data')) return;
    if (!live.online) {
        rmSync(join('.data', 'runtime.lock'), { force: true });
        return;
    }
    writeFileSync(join('.data', 'runtime.lock'), String(process.pid));
    writeFileSync(statusFile, JSON.stringify(statusOf(live)));
}

export function liveFake(): LiveFake {
    const state: LiveFake = { online: false, probes: [], gemini: 200, aibi: {} };
    return new Proxy(state, {
        set(target, key, value) {
            Reflect.set(target, key, value);
            syncLive(target);
            return true;
        },
    });
}

export async function withLocal<T>(live: LiveFake, run: () => Promise<T>): Promise<T> {
    const previous = globalThis.fetch;
    globalThis.fetch = ((input: string | URL) => {
        live.probes.push(String(input));
        return Promise.resolve(new Response('{}', { status: live.gemini }));
    }) as Fetch;
    syncLive(live);
    const stop = watchFile(join('.data', 'operator.json'), () => syncLive(live));
    const stopEnvironment = watchFile('.env', () => syncLive(live));
    try {
        return await run();
    } finally {
        stop();
        stopEnvironment();
        globalThis.fetch = previous;
    }
}

export async function inScratch<T>(parent: string, run: () => Promise<T>): Promise<T> {
    await mkdir(parent, { recursive: true });
    const directory = resolve(await mkdtemp(join(parent, 'wizard-')));
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir('.data', { recursive: true });
        await writeFile(join('.data', 'local.key'), 'fixture-local-key\n');
        return await run();
    } finally {
        process.chdir(previous);
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
}
