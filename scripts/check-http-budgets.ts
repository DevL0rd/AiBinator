import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { localCall } from '../src/mcp/local-client.js';
import type { fixture } from './fixtures.js';
import { key, localServer } from './check-channel.js';

async function legacyReply(client: Client, f: ReturnType<typeof fixture>): Promise<void> {
    assert.equal(client.getProtocolEra(), 'legacy');
    const sent = await client.callTool({
        name: 'aibi_reply',
        arguments: { eventId: f.event.id, text: 'Legacy answer', idempotencyKey: 'legacy-reply' },
    });
    assert.equal(sent.isError, undefined, 'Authenticated legacy-protocol clients can answer AIBI');
    assert.deepEqual(f.spoken, [{ text: 'Legacy answer', quiet: false }]);
}

async function separateBudgets(url: string, base: string, client: Client): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    const limited = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'Public request budget exhausted' });
    assert.ok((await client.listTools()).tools.length, 'Authenticated remote clients keep their own budget');
    assert.ok(
        ((await localCall({ base, key }, 'tools/list')).tools as unknown[]).length,
        'Local principals are not starved by public traffic',
    );
}

export async function checkHttpBudgets(directory: string): Promise<void> {
    const { f, config, http, base } = await localServer(`${directory}/http-budgets.json`);
    const client = new Client({ name: 'legacy-validation', version: '1.0.0' });
    try {
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${config.AIBINATOR_MCP_TOKEN}` } },
            }),
        );
        await legacyReply(client, f);
        await separateBudgets(`${base}/mcp`, base, client);
    } finally {
        await client.close();
        await http.stop();
    }
}
