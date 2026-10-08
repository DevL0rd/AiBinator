import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HttpServer } from '../src/mcp/http.js';
import { localCall } from '../src/mcp/local-client.js';
import { aibiStatus, fakeConfig, fixture } from './fixtures.js';

export const key = 'k'.repeat(43);

function statusFor(base: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const outgoing = request(`${base}/mcp`, { method: 'POST', headers }, (response) => {
            resolve(response.statusCode ?? 0);
            response.resume();
        });
        outgoing.on('error', reject);
        outgoing.end('{}');
    });
}

export async function localServer(file: string) {
    const f = fixture(file);
    const config = fakeConfig();
    const http = new HttpServer(config, f.bridge, () => ({ aibi: aibiStatus() }));
    http.attachLocal(key);
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.AIBINATOR_PORT = (http.server.address() as AddressInfo).port;
    return { f, config, http, base: `http://127.0.0.1:${config.AIBINATOR_PORT}` };
}

export async function checkChannel(directory: string): Promise<void> {
    const { http, base } = await localServer(`${directory}/local.json`);
    try {
        const tools = (await localCall({ base, key }, 'tools/list')).tools as { name: string }[];
        assert.ok(
            tools.some((tool) => tool.name === 'aibi_reply'),
            'the local key grants the owner tool surface',
        );
        await assert.rejects(localCall({ base, key: 'x'.repeat(43) }, 'tools/list'), /401/, 'a wrong key is refused');
        const tunnel = await statusFor(base, {
            Host: 'aibinator.example',
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        });
        assert.ok([401, 403].includes(tunnel), 'the local key never works through a public host name');
    } finally {
        await http.stop();
    }
}

function bridgeClient(child: ChildProcessWithoutNullStreams) {
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = '';
    let next = 0;
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop()!;
        for (const part of parts.filter((item) => item.trim())) {
            const message = JSON.parse(part) as Record<string, unknown>;
            waiting.get(Number(message.id))?.(message);
        }
    });
    return (method: string, params: Record<string, unknown> = {}) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => reject(new Error('bridge did not answer')), 15_000);
            waiting.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
}

const listed = (reply: Record<string, unknown>) =>
    ((reply.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).some((tool) => tool.name === 'aibi_reply');

export async function checkBridgeProcess(directory: string): Promise<void> {
    const { config, http } = await localServer(`${directory}/bridge.json`);
    const home = join(directory, 'bridge-home');
    await mkdir(join(home, '.data'), { recursive: true });
    await writeFile(join(home, '.env'), `AIBINATOR_PORT=${config.AIBINATOR_PORT}\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/channel/bridge.ts'], {
        env: { ...process.env, AIBINATOR_HOME: home, AIBINATOR_PORT: String(config.AIBINATOR_PORT) },
    });
    try {
        const rpc = bridgeClient(child);
        const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
        assert.equal(
            (init.result as { protocolVersion: string }).protocolVersion,
            '2025-06-18',
            'The bridge starts before the local key exists',
        );
        const missing = (await rpc('tools/list')).error as { code: number } | undefined;
        assert.equal(missing?.code, -32603, 'A missing local key is reported without stopping the bridge');
        await writeFile(join(home, '.data/local.key'), `${key}\n`);
        assert.ok(listed(await rpc('tools/list')), 'The key is read once it exists');
        const rotated = 'r'.repeat(43);
        http.attachLocal(rotated);
        await writeFile(join(home, '.data/local.key'), `${rotated}\n`);
        assert.ok(listed(await rpc('tools/list')), 'A rotated key is picked up after a 401');
        const unknown = (await rpc('resources/list')).error as { code: number } | undefined;
        assert.equal(unknown?.code, -32601, 'Unknown methods are reported as not found');
    } finally {
        child.kill();
        await http.stop();
    }
}
