import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { localKeyPath } from './local-key.js';

const protocolVersion = '2026-07-28';
export interface LocalEndpoint {
    base: string;
    key: string;
}

export class LocalHttpError extends Error {
    constructor(readonly status: number) {
        super(`AiBinator returned HTTP ${status}`);
    }
}

export async function localEndpoint(home = process.cwd()): Promise<LocalEndpoint> {
    const environment = await readFile(join(home, '.env'), 'utf8').then(parseEnv, (): Record<string, string> => ({}));
    const port = process.env.AIBINATOR_PORT ?? environment.AIBINATOR_PORT ?? '8789';
    const key = (
        await readFile(join(home, localKeyPath), 'utf8').catch(() => {
            throw new Error('AiBinator has not created its local key yet. Restart AiBinator, then try again.');
        })
    ).trim();
    return { base: `http://127.0.0.1:${port}`, key };
}

export async function localCall(endpoint: LocalEndpoint, method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000) {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const response = await fetch(`${endpoint.base}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
            Authorization: `Bearer ${endpoint.key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': protocolVersion,
            'Mcp-Method': method,
            ...(name ? { 'Mcp-Name': name } : {}),
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
                ...params,
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': protocolVersion,
                    'io.modelcontextprotocol/clientCapabilities': {},
                    'io.modelcontextprotocol/clientInfo': { name: 'aibinator-local', version: '1' },
                },
            },
        }),
    });
    if (!response.ok) throw new LocalHttpError(response.status);
    const message = rpcMessage(await response.text());
    if (message.error) throw new Error(message.error.message ?? 'AiBinator request failed');
    return message.result as Record<string, unknown>;
}

type RpcMessage = { result?: unknown; error?: { message?: string } };
function rpcMessage(text: string): RpcMessage {
    if (!text.startsWith('event:') && !text.startsWith('data:')) return JSON.parse(text) as RpcMessage;
    const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .at(-1)
        ?.slice(5);
    return JSON.parse(data ?? '{}') as RpcMessage;
}
