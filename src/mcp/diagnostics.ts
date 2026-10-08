import { randomUUID } from 'node:crypto';

type Rpc = { method?: unknown; params?: { protocolVersion?: unknown }; error?: { code?: unknown }; result?: unknown };

async function rpc(body: Request | Response): Promise<Rpc | undefined> {
    try {
        if (!body.headers.get('content-type')?.includes('application/json')) return undefined;
        const text = await body.clone().text();
        if (text.length > 512_000) return undefined;
        return JSON.parse(text) as Rpc;
    } catch {
        return undefined;
    }
}

function method(value: unknown): string | undefined {
    return typeof value === 'string' &&
        /^(server\/discover|initialize|ping|tools\/(list|call)|events\/(list|subscribe|unsubscribe)|notifications\/initialized)$/.test(
            value,
        )
        ? value
        : undefined;
}

export async function diagnose(request: Request, fetch: (request: Request) => Promise<Response>): Promise<Response> {
    const id = randomUUID();
    const input = await rpc(request);
    const response = await fetch(request);
    const output = await rpc(response);
    console.error(
        `MCP dispatch ${JSON.stringify({
            at: new Date().toISOString(),
            id,
            method: method(input?.method),
            protocol: request.headers.get('mcp-protocol-version'),
            initializeVersion: typeof input?.params?.protocolVersion === 'string' ? input.params.protocolVersion.slice(0, 32) : undefined,
            status: response.status,
            contentType: response.headers.get('content-type'),
            errorCode: typeof output?.error?.code === 'number' ? output.error.code : undefined,
            result: output?.result !== undefined,
        })}`,
    );
    return response;
}
