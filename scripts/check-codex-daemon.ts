import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { socketPath } from './fixtures.js';
import { daemonTransport } from '../src/operator/codex-daemon.js';

export async function checkCodexDaemon(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-daemon-'));
    const socket = socketPath(directory, 'daemon');
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    server.on('connection', (client) =>
        client.on('message', (data: Buffer) => {
            const request = JSON.parse(data.toString('utf8')) as { id: number; method: string };
            client.send(JSON.stringify({ id: request.id, result: { echoed: request.method } }));
        }),
    );
    await new Promise<void>((resolve) => http.listen(socket, resolve));
    try {
        const transport = daemonTransport(socket);
        const lines = createInterface({ input: transport.stdout });
        const reply = new Promise<string>((resolve) => lines.once('line', resolve));
        transport.stdin.write(`${JSON.stringify({ id: 7, method: 'initialize' })}\n`);
        assert.deepEqual(
            JSON.parse(await reply),
            { id: 7, result: { echoed: 'initialize' } },
            'lines written before the socket opens are delivered',
        );
        const exited = new Promise<string>((resolve) => transport.onExit(resolve));
        await transport.stop();
        assert.match(await exited, /closed/);
    } finally {
        server.close();
        http.close();
        await rm(directory, { recursive: true, force: true });
    }
}
