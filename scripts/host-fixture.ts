import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import type { Runner } from '../src/operator/run.js';

export interface Call {
    file: string;
    args: string[];
}

export function fakeRunner(reply: (call: Call) => string = () => ''): { run: Runner; calls: Call[] } {
    const calls: Call[] = [];
    const run: Runner = (file, args) => {
        const call = { file, args };
        calls.push(call);
        try {
            return Promise.resolve({ stdout: reply(call) });
        } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
    };
    return { run, calls };
}

export const failingRunner: Runner = (file) => Promise.reject(new Error(`${file} failed`));

export async function inDirectory<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const previous = process.cwd();
    await mkdir(directory, { recursive: true });
    process.chdir(directory);
    try {
        return await work();
    } finally {
        process.chdir(previous);
    }
}

export async function withEnv<T>(values: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const apply = (next: Record<string, string | undefined>) => {
        for (const [key, value] of Object.entries(next))
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
    };
    apply(values);
    try {
        return await work();
    } finally {
        apply(previous);
    }
}

export async function writeFiles(directory: string, files: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(files)) {
        await mkdir(join(directory, name, '..'), { recursive: true });
        await writeFile(join(directory, name), content, { mode: 0o755 });
    }
}

export async function listen(): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

export async function freePort(): Promise<number> {
    const { server, port } = await listen();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

export async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
