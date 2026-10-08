import { spawn } from 'node:child_process';
import { appendFileSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { serviceLogFile, supervisorPidFile } from './windows-service.js';

interface Runtime {
    stdout: Readable;
    stderr: Readable;
    once(event: 'exit', listener: (code: number | null) => void): unknown;
}

interface Supervision {
    start: () => Runtime;
    exit: (code: number) => void;
    retryMs: number;
    logLimit: number;
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const startRuntime = (): Runtime =>
    spawn(process.execPath, ['--env-file=.env', 'dist/src/main.js'], {
        env: { ...process.env, AIBINATOR_SERVICE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

const service: Supervision = {
    start: startRuntime,
    exit: (code) => process.exit(code),
    retryMs: 5000,
    logLimit: 10 * 1024 * 1024,
};

async function logWriter(limit: number): Promise<(chunk: Buffer) => void> {
    let written = (await stat(serviceLogFile).catch(() => undefined))?.size ?? 0;
    return (chunk) => {
        if (written + chunk.length > limit) {
            renameSync(serviceLogFile, `${serviceLogFile}.old`);
            written = 0;
        }
        appendFileSync(serviceLogFile, chunk, { mode: 0o600 });
        written += chunk.length;
    };
}

export async function supervise(options: Partial<Supervision> = {}): Promise<void> {
    const { start, exit, retryMs, logLimit } = { ...service, ...options };
    const log = await logWriter(logLimit);
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const running = Number(await readFile(supervisorPidFile, 'utf8').catch(() => ''));
    if (running && running !== process.pid && alive(running)) return exit(0);
    await writeFile(supervisorPidFile, String(process.pid), { mode: 0o600 });
    const run = (): void => {
        const child = start();
        child.stdout.on('data', log);
        child.stderr.on('data', log);
        child.once('exit', (code) => {
            if (code === 0) void rm(supervisorPidFile, { force: true }).then(() => exit(0));
            else setTimeout(run, retryMs);
        });
    };
    run();
}
