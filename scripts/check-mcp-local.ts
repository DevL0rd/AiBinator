import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LocalHttpError, localCall, localEndpoint } from '../src/mcp/local-client.js';
import { descriptorResponse } from '../src/mcp/descriptors.js';
import { HttpServer } from '../src/mcp/http.js';
import type { AddressInfo } from 'node:net';
import { fakeConfig, fixture } from './fixtures.js';
import { loopbackServer } from './loopback-server.js';

const localKey = 'l'.repeat(43);

async function home(directory: string, name: string, files: Record<string, string>): Promise<string> {
    const path = resolve(directory, name);
    await mkdir(join(path, '.data'), { recursive: true });
    for (const [file, content] of Object.entries(files)) await writeFile(join(path, file), content);
    return path;
}

async function checkEndpoint(directory: string): Promise<void> {
    const configured = await home(directory, 'configured-home', {
        '.env': 'AIBINATOR_PORT=4321\n',
        '.data/local.key': `${localKey}\n`,
    });
    const keyOnly = await home(directory, 'key-only-home', { '.data/local.key': localKey });
    const empty = await home(directory, 'empty-home', {});
    const port = process.env.AIBINATOR_PORT;
    const cwd = process.cwd();
    try {
        delete process.env.AIBINATOR_PORT;
        assert.deepEqual(await localEndpoint(configured), { base: 'http://127.0.0.1:4321', key: localKey });
        assert.equal((await localEndpoint(keyOnly)).base, 'http://127.0.0.1:8789', 'The default port is used without configuration');
        await assert.rejects(localEndpoint(empty), /has not created its local key yet/);
        process.env.AIBINATOR_PORT = '5555';
        assert.equal((await localEndpoint(configured)).base, 'http://127.0.0.1:5555', 'The process environment wins over .env');
        process.chdir(configured);
        assert.equal((await localEndpoint()).key, localKey, 'The working directory is the default home');
    } finally {
        process.chdir(cwd);
        if (port === undefined) delete process.env.AIBINATOR_PORT;
        else process.env.AIBINATOR_PORT = port;
    }
}

const replies: Record<string, (response: ServerResponse) => void> = {
    stream: (response) =>
        response
            .writeHead(200, { 'Content-Type': 'text/event-stream' })
            .end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"streamed":true}}\n\n'),
    bare: (response) => response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('data: {"result":{"bare":true}}'),
    silent: (response) => response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('event: ping\n\n'),
    failing: (response) => response.writeHead(200).end('{"jsonrpc":"2.0","id":1,"error":{"message":"tool exploded"}}'),
    anonymous: (response) => response.writeHead(200).end('{"jsonrpc":"2.0","id":1,"error":{}}'),
    unavailable: (response) => response.writeHead(503).end(),
};

async function checkCalls(): Promise<void> {
    const server = await loopbackServer({
        '/mcp': (response, received) => replies[String(received.headers['mcp-method'])]!(response),
    });
    const endpoint = { base: server.base, key: localKey };
    try {
        assert.deepEqual(await localCall(endpoint, 'stream', { name: 'aibi_reply' }), { streamed: true });
        const sent = server.received[0]!;
        assert.equal(sent.headers.authorization, `Bearer ${localKey}`);
        assert.equal(sent.headers['mcp-name'], 'aibi_reply');
        assert.equal((JSON.parse(sent.body) as { params: { name: string } }).params.name, 'aibi_reply');
        assert.deepEqual(await localCall(endpoint, 'bare'), { bare: true });
        assert.equal(server.received[1]!.headers['mcp-name'], undefined, 'Calls without a tool name omit Mcp-Name');
        assert.equal(await localCall(endpoint, 'silent'), undefined, 'A stream without data has no result');
        await assert.rejects(localCall(endpoint, 'failing'), /tool exploded/);
        await assert.rejects(localCall(endpoint, 'anonymous'), /AiBinator request failed/);
        await assert.rejects(localCall(endpoint, 'unavailable'), (error) => error instanceof LocalHttpError && error.status === 503);
    } finally {
        await server.close();
    }
}

const schemes = [{ type: 'oauth2', scopes: ['aibinator:control'] }];
const listed = JSON.stringify({ result: { tools: [{ name: 'secured', _meta: { securitySchemes: schemes } }, { name: 'open' }] } });
const rpc = (headers: Record<string, string>, body = '{"method":"tools/list"}') =>
    new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body });
const answer =
    (body: BodyInit, type?: string, status = 200) =>
    () =>
        Promise.resolve(new Response(body, { status, headers: type ? { 'Content-Type': type, 'Content-Length': '1' } : {} }));
type Listed = { result?: { tools?: { name: string; securitySchemes?: unknown }[] } };

async function checkJsonDescriptors(): Promise<void> {
    const declared = await descriptorResponse(rpc({ 'Mcp-Method': 'tools/list' }), answer(listed, 'application/json'), true);
    const tools = ((await declared.json()) as Listed).result!.tools!;
    assert.deepEqual(tools[0]!.securitySchemes, schemes, 'OAuth tool descriptors expose their security schemes');
    assert.equal(tools[1]!.securitySchemes, undefined);
    assert.equal(declared.headers.get('content-length'), null, 'The rewritten body drops the stale length');
    const fromBody = await descriptorResponse(rpc({}), answer(listed, 'application/json'), true);
    assert.deepEqual(((await fromBody.json()) as Listed).result!.tools![0]!.securitySchemes, schemes, 'The method can come from the body');
    for (const [request, fetch, oauth] of [
        [rpc({}), answer(listed, 'application/json'), false],
        [rpc({}, '{'), answer(listed, 'application/json'), true],
        [rpc({ 'Mcp-Method': 'tools/call' }), answer(listed, 'application/json'), true],
        [rpc({ 'Mcp-Method': 'tools/list' }), answer(listed, 'application/json', 500), true],
        [rpc({ 'Mcp-Method': 'tools/list' }), answer(listed, 'text/plain'), true],
        [rpc({ 'Mcp-Method': 'tools/list' }), answer(new TextEncoder().encode(listed)), true],
    ] as const) {
        const response = await descriptorResponse(request, fetch, oauth);
        assert.equal(((await response.json()) as Listed).result!.tools![0]!.securitySchemes, undefined, 'Other responses pass through');
    }
    const empty = await descriptorResponse(rpc({ 'Mcp-Method': 'tools/list' }), answer('{"result":{}}', 'application/json'), true);
    assert.deepEqual(await empty.json(), { result: {} });
}

async function checkStreamDescriptors(): Promise<void> {
    const parts = ['event: message\nda', `ta: ${listed}\n`, 'data: not-json\n', `data: ${listed}`];
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
            controller.close();
        },
    });
    const response = await descriptorResponse(rpc({ 'Mcp-Method': 'tools/list' }), answer(stream, 'text/event-stream'), true);
    const lines = (await response.text()).split('\n');
    assert.equal(lines[0], 'event: message');
    for (const line of [lines[1]!, lines[3]!]) {
        const tools = (JSON.parse(line.slice(6)) as Listed).result!.tools!;
        assert.deepEqual(tools[0]!.securitySchemes, schemes, 'Streamed descriptors split across chunks are rewritten');
    }
    assert.equal(lines[2], 'data: not-json', 'Invalid JSON stream lines pass through unchanged');
    assert.equal(lines.length, 4);
}

async function checkLifecycle(directory: string): Promise<void> {
    const http = new HttpServer(fakeConfig(0), fixture(join(directory, 'lifecycle.json')).bridge, () => ({}));
    await http.start();
    const port = (http.server.address() as AddressInfo).port;
    http.config.AIBINATOR_PORT = port;
    const busy = new HttpServer(fakeConfig(port), fixture(join(directory, 'lifecycle-busy.json')).bridge, () => ({}));
    try {
        const unknown = await fetch(`http://127.0.0.1:${port}/elsewhere`);
        assert.equal(unknown.status, 404);
        assert.deepEqual(await unknown.json(), { error: 'Unknown endpoint' });
        await assert.rejects(busy.start(), /EADDRINUSE/, 'A taken port fails the start');
    } finally {
        await http.stop();
    }
}

export async function checkMcpLocal(directory: string): Promise<void> {
    await checkEndpoint(directory);
    await checkCalls();
    await checkJsonDescriptors();
    await checkStreamDescriptors();
    await checkLifecycle(directory);
}
