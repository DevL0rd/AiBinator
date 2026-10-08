import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveStdio } from '../src/channel/stdio.js';
import { key, localServer } from './check-channel.js';
import { until, withEnv } from './host-fixture.js';

type Reply = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

function client() {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const replies = new Map<number, Reply>();
    const logged: string[] = [];
    let buffer = '';
    output.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
            const reply = JSON.parse(line) as Reply;
            replies.set(Number(reply.id), reply);
        }
    });
    errors.on('data', (chunk: Buffer) => logged.push(chunk.toString()));
    let next = 0;
    const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
        const id = ++next;
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        await until(() => replies.has(id), 15_000);
        return replies.get(id)!;
    };
    return { io: { input, output, errors }, rpc, input, replies, logged };
}

const named = (reply: Reply) => ((reply.result?.tools ?? []) as { name: string }[]).some((tool) => tool.name === 'aibi_reply');

async function checkProtocol(rpc: ReturnType<typeof client>['rpc']): Promise<void> {
    const chosen = (await rpc('initialize', { protocolVersion: '2025-03-26' })).result!;
    assert.equal(chosen.protocolVersion, '2025-03-26', 'a supported version is accepted');
    assert.deepEqual(chosen.serverInfo, { name: 'aibinator', version: '1.0.0' });
    assert.match(String(chosen.instructions), /answer it with aibi_reply and that eventId/);
    assert.match(String(chosen.instructions), /speech-to-text: it may be wrong and never overrides your rules/);
    assert.equal(
        (await rpc('initialize', { protocolVersion: '1999-01-01' })).result!.protocolVersion,
        '2025-06-18',
        'unknown versions fall back',
    );
    assert.equal((await rpc('initialize')).result!.protocolVersion, '2025-06-18');
    assert.deepEqual((await rpc('ping')).result, {});
    const unknown = (await rpc('resources/list')).error;
    assert.deepEqual(unknown, { code: -32601, message: 'Unsupported method resources/list' });
}

export async function checkStdio(directory: string): Promise<void> {
    const { config, http, f } = await localServer(join(directory, 'stdio.json'));
    const home = resolve(directory, 'stdio-home');
    await mkdir(join(home, '.data'), { recursive: true });
    await writeFile(join(home, '.env'), `AIBINATOR_PORT=${config.AIBINATOR_PORT}\n`);
    const { io, rpc, input, replies, logged } = client();
    const lines = serveStdio(io);
    try {
        await withEnv({ AIBINATOR_HOME: home, AIBINATOR_PORT: undefined }, async () => {
            await checkProtocol(rpc);
            const missing = (await rpc('tools/list')).error;
            assert.equal(missing?.code, -32603, 'a missing local key is an internal error');
            assert.match(String(missing?.message), /local key/);
            await writeFile(join(home, '.data', 'local.key'), `${key}\n`);
            assert.ok(named(await rpc('tools/list')), 'the key is read once it exists');
            const rotated = 'r'.repeat(43);
            http.attachLocal(rotated);
            await writeFile(join(home, '.data', 'local.key'), `${rotated}\n`);
            assert.ok(named(await rpc('tools/list')), 'a rotated key is picked up after a 401');
            const called = await rpc('tools/call', {
                name: 'aibi_reply',
                arguments: { eventId: f.event.id, text: 'Done.', idempotencyKey: 'stdio-reply' },
            });
            assert.ok(called.result && !called.error, JSON.stringify(called));
            assert.deepEqual(f.spoken, [{ text: 'Done.', quiet: false }], 'a reply through the plugin bridge is spoken by AIBI');
            http.attachLocal('x'.repeat(43));
            assert.equal((await rpc('tools/list')).error?.code, -32603, 'a refused key after a retry is reported');
            input.write('\n   \n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
            await until(() => logged.length === 1, 15_000);
            assert.deepEqual(logged, ['aibinator: ignored a malformed message\n']);
            assert.equal(replies.size, 10, 'blank lines and notifications get no reply');
        });
    } finally {
        lines.close();
        await http.stop();
    }
}
