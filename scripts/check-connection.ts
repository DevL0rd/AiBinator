import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/core/config.js';
import { HttpServer } from '../src/mcp/http.js';
import { aibiStatus, fakeConfig, fixture } from './fixtures.js';

async function localFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const incoming = new Request(input, init);
    assert.equal(new URL(incoming.url).hostname, '127.0.0.1');
    const body = Buffer.from(await incoming.arrayBuffer());
    return new Promise((resolve, reject) => {
        const outgoing = request(
            incoming.url,
            { method: incoming.method, headers: Object.fromEntries(incoming.headers), signal: incoming.signal },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    const headers = new Headers();
                    for (let i = 0; i < response.rawHeaders.length; i += 2)
                        headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
                    resolve(
                        new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers }),
                    );
                });
            },
        );
        outgoing.on('error', reject);
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Offline HTTP request timed out')));
        outgoing.end(body);
    });
}

async function checkDefaults(directory: string): Promise<void> {
    const file = `${directory}/connection-policy.json`;
    await writeFile(file, '{}');
    const env = { AIBINATOR_POLICY_FILE: file };
    await assert.rejects(() => loadConfig(env));
    const bearer = { ...env, AIBINATOR_MCP_TOKEN: fakeConfig().AIBINATOR_MCP_TOKEN };
    const { config, policy } = await loadConfig(bearer);
    assert.equal(config.AIBINATOR_AUTH_MODE, 'bearer');
    assert.equal(config.AIBINATOR_BIND_HOST, '127.0.0.1');
    assert.equal(config.AIBINATOR_PORT, 8789);
    assert.equal(config.AIBINATOR_RESOURCE_URL, 'http://127.0.0.1:8789/mcp');
    assert.equal(config.GEMINI_API_KEY, undefined);
    assert.deepEqual(policy.scopes, ['aibi.read', 'aibi.speak', 'aibi.act', 'memory.write']);
    assert.deepEqual(
        [policy.aibi.mode, policy.aibi.httpPort, policy.aibi.httpsPort, policy.aibi.dnsPort],
        ['local', 80, 443, 53],
        'AIBI is answered locally on its own ports by default',
    );
    assert.equal((await loadConfig({ ...bearer, GEMINI_API_KEY: '' })).config.GEMINI_API_KEY, undefined, 'An empty Gemini key is unset');
    assert.equal((await loadConfig({ ...bearer, AIBINATOR_PORT: '8788' })).config.AIBINATOR_RESOURCE_URL, 'http://127.0.0.1:8788/mcp');
    for (const invalid of [
        { AIBINATOR_BIND_HOST: '0.0.0.0' },
        { AIBINATOR_BIND_HOST: '::' },
        { AIBINATOR_BIND_HOST: '192.168.1.2' },
        { AIBINATOR_AUTH_MODE: 'tunnel' },
        { AIBINATOR_AUTH_MODE: 'unsupported-provider-mode' },
        { AIBINATOR_PORT: '1023' },
        { AIBINATOR_PORT: '65536' },
        { AIBINATOR_MCP_TOKEN: 'replace-with-independent-random-secret-locally' },
        { AIBINATOR_AUTH_MODE: 'oauth' },
        { AIBINATOR_RESOURCE_URL: 'ftp://aibinator.example/mcp' },
        { GEMINI_API_KEY: 'short' },
    ])
        await assert.rejects(() => loadConfig({ ...bearer, ...invalid }));
    const oauth = {
        ...env,
        AIBINATOR_AUTH_MODE: 'oauth',
        AIBINATOR_OAUTH_SERVER: 'external',
        AIBINATOR_RESOURCE_URL: 'https://aibinator.example/mcp',
        AIBINATOR_ALLOWED_HOSTS: 'aibinator.example',
        AIBINATOR_OAUTH_ISSUER: 'https://issuer.example',
        AIBINATOR_OAUTH_JWKS_URL: 'https://issuer.example/keys',
        AIBINATOR_OAUTH_SUBJECTS: 'owner',
    };
    assert.equal((await loadConfig(oauth)).config.AIBINATOR_AUTH_MODE, 'oauth');
    for (const invalid of [
        { AIBINATOR_RESOURCE_URL: 'http://127.0.0.1:8789/mcp' },
        { AIBINATOR_RESOURCE_URL: '' },
        { AIBINATOR_OAUTH_ISSUER: 'http://issuer.example' },
        { AIBINATOR_OAUTH_JWKS_URL: '' },
        { AIBINATOR_OAUTH_SUBJECTS: ' , ' },
    ])
        await assert.rejects(() => loadConfig({ ...oauth, ...invalid }));
}

async function checkDiscovery(url: URL, headers: Record<string, string>): Promise<void> {
    const denied = await localFetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(denied.status, 401);
    assert.equal(
        denied.headers.get('www-authenticate'),
        'Bearer resource_metadata="https://aibinator.example/.well-known/oauth-protected-resource", scope="aibinator:control"',
    );
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const metadata = await localFetch(new URL(path, url), { headers });
        assert.equal(metadata.status, 200);
        assert.equal(metadata.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await metadata.json(), {
            resource: 'https://aibinator.example/mcp',
            authorization_servers: ['https://issuer.example'],
            scopes_supported: ['aibinator:control'],
            bearer_methods_supported: ['header'],
        });
    }
}

async function checkDenials(url: URL, token: string): Promise<void> {
    const credentials: Record<string, string>[] = [
        { Host: 'aibinator.example', Authorization: 'Bearer invalid.signature.value' },
        { Host: 'aibinator.example', 'X-Forwarded-For': '127.0.0.1', 'X-User-Id': 'owner' },
    ];
    for (const headers of credentials) assert.equal((await localFetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
    const boundaries: Record<string, string>[] = [
        { Host: 'unlisted.example' },
        { Host: 'aibinator.example.evil.example' },
        { Host: 'aibinator.example', Origin: 'https://unlisted.example' },
    ];
    for (const headers of boundaries)
        assert.equal(
            (await localFetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: '{}' })).status,
            403,
        );
}

async function checkOAuthHttp(directory: string): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'connection', alg: 'RS256' }] });
    const config = {
        ...fakeConfig(),
        AIBINATOR_AUTH_MODE: 'oauth' as const,
        AIBINATOR_RESOURCE_URL: 'https://aibinator.example/mcp',
        AIBINATOR_ALLOWED_HOSTS: 'aibinator.example',
        AIBINATOR_ALLOWED_ORIGINS: 'https://client.example',
        AIBINATOR_OAUTH_ISSUER: 'https://issuer.example',
        AIBINATOR_OAUTH_JWKS_URL: 'https://issuer.example/keys',
        AIBINATOR_OAUTH_SUBJECTS: 'owner',
    };
    const f = fixture(`${directory}/oauth-http.json`);
    const http = new HttpServer(config, f.bridge, () => ({ aibi: aibiStatus() }), keys);
    const client = new Client({ name: 'oauth-connection-validation', version: '1.0.0' });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    config.AIBINATOR_PORT = (http.server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${config.AIBINATOR_PORT}/mcp`);
    try {
        const token = await new SignJWT({ scope: 'aibinator:control' })
            .setProtectedHeader({ alg: 'RS256', kid: 'connection' })
            .setSubject('owner')
            .setIssuer(config.AIBINATOR_OAUTH_ISSUER)
            .setAudience(config.AIBINATOR_RESOURCE_URL)
            .setIssuedAt()
            .setExpirationTime('1m')
            .sign(privateKey);
        await checkDiscovery(url, { Host: 'aibinator.example' });
        await checkDenials(url, token);
        await client.connect(
            new StreamableHTTPClientTransport(url, {
                fetch: localFetch,
                requestInit: {
                    headers: { Host: 'aibinator.example', Origin: 'https://client.example', Authorization: `Bearer ${token}` },
                },
            }),
        );
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'aibinator_status'));
        const status = await client.callTool({ name: 'aibinator_status', arguments: {} });
        assert.equal(status.isError, undefined);
        assert.deepEqual(f.spoken, [], 'Reading status never speaks through AIBI');
    } finally {
        await client.close();
        await http.stop();
    }
}

export async function checkConnection(directory: string): Promise<void> {
    await checkDefaults(directory);
    await checkOAuthHttp(directory);
}
