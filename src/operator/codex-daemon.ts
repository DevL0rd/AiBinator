import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { z } from 'zod';
import type { CodexTransport } from './codex-protocol.js';
import { codexCommand } from './codex-config.js';

const exec = promisify(execFile);
const status = z.object({ status: z.string(), socketPath: z.string().optional() });

async function daemonStatus(): Promise<z.infer<typeof status>> {
    const { command, args, env } = await codexCommand();
    const { stdout } = await exec(command, [...args, 'app-server', 'daemon', 'version'], { env, timeout: 30_000 });
    return status.parse(JSON.parse(stdout));
}

export async function codexDaemonSocket(): Promise<string> {
    const current = await daemonStatus().catch(() => undefined);
    if (current?.status === 'running' && current.socketPath) return current.socketPath;
    const { command, args, env } = await codexCommand();
    await exec(command, [...args, 'app-server', 'daemon', 'start'], { env, timeout: 60_000 });
    const started = await daemonStatus();
    if (started.status !== 'running' || !started.socketPath) throw new Error('The Codex app-server daemon did not start');
    return started.socketPath;
}

function frameText(data: WebSocket.RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return (data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data).toString('utf8');
}

export function daemonTransport(socket: string): CodexTransport {
    const ws = new WebSocket('ws://localhost/', { createConnection: () => connect(socket) });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const pending: string[] = [];
    createInterface({ input: stdin }).on('line', (line) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(line);
        else pending.push(line);
    });
    ws.on('open', () => {
        for (const line of pending.splice(0)) ws.send(line);
    });
    ws.on('message', (data: WebSocket.RawData) => stdout.write(`${frameText(data)}\n`));
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    return {
        stdin,
        stdout,
        onError: (listener) => {
            ws.on('error', listener);
        },
        onExit: (listener) => {
            ws.once('close', (code) => {
                listener(`Codex daemon connection closed (${code})`);
                stdout.end();
            });
        },
        stop: async () => {
            if (ws.readyState !== WebSocket.CLOSED) ws.close();
            await closed;
        },
    };
}
