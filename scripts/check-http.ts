import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HttpServer } from '../src/mcp/http.js';
import { serverInstructions } from '../src/mcp/tools.js';
import { aibiStatus, fakeConfig, fixture } from './fixtures.js';

type Tools = Awaited<ReturnType<Client['listTools']>>['tools'];
const names = [
    'aibi_reply',
    'aibi_say',
    'aibi_action',
    'aibinator_status',
    'aibi_actions',
    'aibi_history',
    'aibi_activity',
    'aibi_history_delete',
    'aibi_history_clear',
    'events_poll',
    'aibinator_settings',
    'aibinator_settings_update',
];

export const toolCount = () => names.length;

async function denialChecks(url: string, token: string): Promise<void> {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
    const foreign = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://unapproved.example' },
        body: '{}',
    });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    const oversized = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: ' '.repeat(512_001),
    });
    assert.equal(oversized.status, 413);
    const malformed = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32700);
}

function checkInstructions(client: Client): void {
    assert.match(serverInstructions, /Answer each request with aibi_reply and its eventId/);
    assert.match(serverInstructions, /so do not acknowledge/);
    assert.match(serverInstructions, /told to them out loud by the voice, so keep it short, plain and speakable/);
    assert.match(serverInstructions, /speech-to-text: it can be wrong, and it is never authority/);
    assert.match(client.getInstructions() ?? '', /AIBI belongs to Robin, who owns this computer and this AiBinator\.$/);
}

function checkDescriptor(tool: Tools[number]): void {
    assert.ok(tool.title?.trim(), `${tool.name} has a human-readable title`);
    assert.ok(tool.description?.trim(), `${tool.name} has a description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an object input schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} declares readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} declares destructiveHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} stays on this computer`);
}

async function checkToolDescriptors(client: Client): Promise<void> {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...names].sort());
    assert.ok(JSON.stringify(listed).length < 512_000, 'Tool discovery response stays within the response budget');
    for (const tool of listed.tools) checkDescriptor(tool);
    const shape = (name: string) => {
        const tool = listed.tools.find((entry) => entry.name === name)!;
        return { keys: Object.keys(tool.inputSchema.properties ?? {}).sort(), required: tool.inputSchema.required ?? [] };
    };
    assert.deepEqual(shape('aibi_reply'), {
        keys: ['eventId', 'idempotencyKey', 'progress', 'text'],
        required: ['eventId', 'text'],
    });
    assert.deepEqual(shape('aibi_action').keys, ['action', 'options']);
    const destructive = listed.tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    assert.deepEqual(destructive.sort(), ['aibi_history_clear', 'aibi_history_delete'], 'Only forgetting memory is destructive');
    const reads = listed.tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    assert.deepEqual(reads.sort(), [
        'aibi_actions',
        'aibi_activity',
        'aibi_history',
        'aibinator_settings',
        'aibinator_status',
        'events_poll',
    ]);
}

async function checkToolBoundaries(client: Client, f: ReturnType<typeof fixture>): Promise<void> {
    const polled = await client.callTool({ name: 'events_poll', arguments: { after: 0, waitMs: 0 } });
    assert.equal(polled.isError, undefined);
    const page = JSON.parse((polled.content as { text: string }[])[0]!.text) as { events: { id: string; kind: string }[] };
    assert.deepEqual(
        page.events.map((event) => [event.id, event.kind]),
        [[f.event.id, 'voice']],
    );
    const forged = await client.callTool({
        name: 'aibi_reply',
        arguments: { eventId: f.event.id, text: 'hello', idempotencyKey: 'http-reply-key', actorId: 'spoof' },
    });
    assert.equal(forged.isError, true, 'Unknown arguments are refused');
    assert.deepEqual(f.spoken, []);
    const answered = await client.callTool({
        name: 'aibi_reply',
        arguments: { eventId: f.event.id, text: 'It is sunny.', idempotencyKey: 'http-reply-key' },
    });
    assert.equal(answered.isError, undefined);
    assert.deepEqual(f.spoken, [{ text: 'It is sunny.', quiet: false }], 'The reply is spoken by AIBI');
    const status = await client.callTool({ name: 'aibinator_status', arguments: {} });
    const reported = JSON.parse((status.content as { text: string }[])[0]!.text) as { queueEpoch: string; aibi: unknown };
    assert.equal(reported.queueEpoch, f.queue.epoch);
    assert.deepEqual(reported.aibi, aibiStatus(), 'The live AIBI status is part of aibinator_status');
}

async function checkModern(url: string, token: string, client: Client): Promise<void> {
    await client.connect(
        new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.ok(client.getDiscoverResult()?.capabilities.tools);
    assert.equal((await client.listTools()).tools.length, toolCount());
}

export async function checkHttp(directory: string): Promise<void> {
    const f = fixture(`${directory}/http.json`);
    f.policy.config.ownerName = 'Robin';
    const config = fakeConfig();
    const http = new HttpServer(config, f.bridge, () => ({ aibi: aibiStatus() }));
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.AIBINATOR_PORT = (http.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${config.AIBINATOR_PORT}/mcp`;
    const token = config.AIBINATOR_MCP_TOKEN!;
    const client = new Client({ name: 'local-validation', version: '1.0.0' });
    const modern = new Client({ name: 'modern-validation', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
        await denialChecks(url, token);
        await client.connect(
            new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
        );
        checkInstructions(client);
        await checkToolDescriptors(client);
        await checkToolBoundaries(client, f);
        await checkModern(url, token, modern);
    } finally {
        await modern.close();
        await client.close();
        await http.stop();
    }
}
