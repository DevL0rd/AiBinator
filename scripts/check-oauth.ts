import assert from 'node:assert/strict';
import { registrationSchema } from '../src/oauth/registration.js';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { jwtVerify, importJWK, SignJWT } from 'jose';
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { applyPendingOwner, requestOwnerPassword, type KeyMaterial } from '../src/oauth/provision.js';
import { readPrivate } from '../src/oauth/storage.js';
import { Authenticator } from '../src/mcp/auth.js';
import { OAuthFixture, authorization, callback, form, redirect, verifier } from './oauth-fixture.js';
import { posixOnly } from './fixtures.js';
import { checkClientExpiry, checkConsentPage, checkLoginLimits, checkOAuthFiles, checkPasswordReset } from './check-oauth-limits.js';

async function registration(f: OAuthFixture): Promise<string> {
    const dcr = (value: unknown) =>
        f.fetch('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    for (const invalid of [
        { redirect_uris: ['https://attacker.example/callback'] },
        { redirect_uris: [callback], grant_types: ['refresh_token'] },
        { redirect_uris: [callback], token_endpoint_auth_method: 'private_key_jwt' },
        { redirect_uris: [callback], scope: 'openid profile aibinator:control' },
        { redirect_uris: [callback], jwks_uri: 'https://127.0.0.1/private' },
        { redirect_uris: [callback], client_id: 'chosen-by-caller' },
    ])
        assert.equal((await dcr({ token_endpoint_auth_method: 'none', ...invalid })).status, 400, 'Unsafe DCR rejected');
    const response = await dcr({
        redirect_uris: [callback],
        client_name: 'ChatGPT',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    });
    assert.equal(response.status, 201, 'Safe DCR accepted');
    const client = (await response.json()) as Record<string, unknown>;
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(client.client_secret, undefined);
    return String(client.client_id);
}

async function discovery(f: OAuthFixture): Promise<void> {
    const response = await f.fetch('/.well-known/oauth-authorization-server');
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(metadata.response_types_supported, ['code']);
    assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal((await f.fetch('/oauth/jwks', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
    assert.equal((await f.fetch('/oauth/jwks', { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await f.fetch('/oauth/jwks', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const proxies = f.config.AIBINATOR_TRUSTED_PROXIES;
    f.config.AIBINATOR_TRUSTED_PROXIES = '192.0.2.1';
    assert.equal((await f.fetch('/oauth/jwks', { headers: { 'X-Forwarded-For': '192.0.2.1' } })).status, 403);
    f.config.AIBINATOR_TRUSTED_PROXIES = proxies;
    const protectedResource = await f.fetch('/.well-known/oauth-protected-resource/mcp');
    assert.equal(((await protectedResource.json()) as { resource: string }).resource, f.config.AIBINATOR_RESOURCE_URL);
    assert.equal((await f.fetch('/mcp', { method: 'POST', body: '{}' })).status, 401);
}

async function loginConsent(f: OAuthFixture, client: string, password: string): Promise<string> {
    const response = await f.fetch(authorization(f, client));
    assert.equal(response.status, 303, 'Authorization requests login');
    assert.ok(response.headers.getSetCookie().every((cookie) => /secure/i.test(cookie) && /httponly/i.test(cookie)));
    const path = response.headers.get('location')!;
    let csrf = await form(f, path);
    const values = { csrf, action: 'login', password };
    assert.equal((await f.post(path, { ...values, csrf: 'invalid' })).status, 403);
    assert.equal((await f.post(path, values, { Cookie: '' })).status, 400, 'Interaction cookie required');
    assert.equal((await f.post(path, values, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.post(path, { ...values, password: 'wrong-password-value' })).status, 403);
    assert.equal((await f.post(path, values)).status, 403, 'CSRF cannot be replayed');
    csrf = await form(f, path);
    const resumed = await redirect(f, await f.post(path, { ...values, csrf }));
    assert.equal(resumed.status, 303, 'Login proceeds to consent');
    const consentPath = resumed.headers.get('location')!;
    const consent = await form(f, consentPath);
    assert.equal((await f.post(consentPath, { csrf: 'invalid', action: 'allow' })).status, 403);
    const completed = await redirect(f, await f.post(consentPath, { csrf: consent, action: 'allow' }));
    assert.equal(completed.status, 303, 'Consent issues code');
    const destination = new URL(completed.headers.get('location')!);
    assert.equal(destination.origin + destination.pathname, callback);
    assert.equal(destination.searchParams.get('iss'), f.config.AIBINATOR_OAUTH_ISSUER);
    assert.equal(destination.searchParams.get('state'), 'offline-state');
    assert.ok(destination.searchParams.get('code'));
    return destination.searchParams.get('code')!;
}

async function pkce(f: OAuthFixture, client: string): Promise<void> {
    for (const parameters of [
        { code_challenge: '' },
        { code_challenge_method: 'plain' },
        { response_type: 'token' },
        { scope: 'openid' },
        { resource: 'https://other.example/mcp' },
    ]) {
        const response = await f.fetch(authorization(f, client, parameters));
        const destination = response.headers.get('location');
        const error =
            destination &&
            (new URL(destination).searchParams.has('error') || new URLSearchParams(new URL(destination).hash.slice(1)).has('error'));
        assert.ok(response.status === 400 || error, `Invalid ${Object.keys(parameters)[0]} flow rejected (HTTP ${response.status})`);
    }
    const refresh = await f.post('/oauth/token', { grant_type: 'refresh_token', client_id: client, refresh_token: 'invalid' });
    assert.equal(refresh.status, 400);
}

async function tokenChecks(f: OAuthFixture, client: string, code: string): Promise<void> {
    const parameters = {
        grant_type: 'authorization_code',
        client_id: client,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: f.config.AIBINATOR_RESOURCE_URL,
    };
    assert.equal(
        (await f.post('/oauth/token', { ...parameters, code_verifier: 'incorrect-verifier' })).status,
        400,
        'Wrong PKCE verifier denied',
    );
    const [response, replay] = await Promise.all([f.post('/oauth/token', parameters), f.post('/oauth/token', parameters)]);
    assert.equal(replay.status, 400, 'Concurrent code replay denied');
    assert.equal(response.status, 200, 'Code survives restart and exchanges');
    const token = (await response.json()) as {
        access_token: string;
        expires_in: number;
        id_token?: string;
        refresh_token?: string;
        scope: string;
    };
    assert.equal(token.expires_in, 300);
    assert.equal(typeof token.id_token, 'string');
    assert.equal(typeof token.refresh_token, 'string');
    assert.equal(token.scope, 'aibinator:control');
    const { payload, protectedHeader } = await jwtVerify(token.access_token, f.oauth!.verifyKey, {
        issuer: f.config.AIBINATOR_OAUTH_ISSUER,
        audience: f.config.AIBINATOR_RESOURCE_URL,
    });
    assert.equal(protectedHeader.typ, 'at+jwt');
    assert.equal(payload.sub, f.oauth!.owner.subject);
    assert.equal(payload.scope, 'aibinator:control');
    assert.equal(payload.exp! - payload.iat!, 300);
    await authenticatedMcp(f, token.access_token);
    await f.stop();
    await f.start();
    await authenticatedMcp(f, token.access_token);
    assert.equal((await f.post('/oauth/token', parameters)).status, 400, 'Code replay denied');
    const keys = await readPrivate<KeyMaterial>(`${f.config.AIBINATOR_OAUTH_DATA_DIR}/keys.json`);
    const privateKey = await importJWK(keys.jwks.keys[0]!, 'RS256');
    const auth = new Authenticator(f.config, f.oauth!.verifyKey);
    for (const change of [
        { aud: 'https://wrong.example/mcp' },
        { scope: 'other' },
        { exp: 1 },
        { sub: 'stranger' },
        { exp: payload.iat! + 3600 },
    ]) {
        const invalid = await new SignJWT({ ...payload, ...change }).setProtectedHeader(protectedHeader).sign(privateKey);
        assert.equal(await auth.accepts({ headers: { authorization: `Bearer ${invalid}` } } as IncomingMessage), false);
    }
}

async function refreshChecks(f: OAuthFixture, client: string): Promise<void> {
    const consent = await f.fetch(authorization(f, client));
    const path = consent.headers.get('location')!;
    const csrf = await form(f, path);
    const completed = await redirect(f, await f.post(path, { csrf, action: 'allow' }));
    const code = new URL(completed.headers.get('location')!).searchParams.get('code')!;
    const issued = await f.post('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: client,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: f.config.AIBINATOR_RESOURCE_URL,
    });
    assert.equal(issued.status, 200);
    const { refresh_token: refreshToken } = (await issued.json()) as { refresh_token: string };
    const parameters = {
        grant_type: 'refresh_token',
        client_id: client,
        refresh_token: refreshToken,
        resource: f.config.AIBINATOR_RESOURCE_URL,
    };
    const first = await f.post('/oauth/token', parameters);
    assert.equal(first.status, 200, 'Refresh succeeds');
    let replacement = (await first.json()) as { refresh_token: string };
    assert.notEqual(replacement.refresh_token, refreshToken, 'Refresh rotates');
    for (const scope of [undefined, 'aibinator:control', 'openid aibinator:control']) {
        const refreshed = await f.post('/oauth/token', {
            grant_type: 'refresh_token',
            client_id: client,
            refresh_token: replacement.refresh_token,
            ...(scope ? { scope } : {}),
        });
        assert.equal(refreshed.status, 200, 'Refresh permits omitted resource and supported scopes');
        const result = (await refreshed.json()) as { refresh_token: string; access_token: string };
        const { payload } = await jwtVerify(result.access_token, f.oauth!.verifyKey, {
            issuer: f.config.AIBINATOR_OAUTH_ISSUER,
            audience: f.config.AIBINATOR_RESOURCE_URL,
        });
        assert.equal(payload.scope, 'aibinator:control');
        replacement = result;
    }
    assert.equal(
        (await f.post('/oauth/token', { ...parameters, refresh_token: replacement.refresh_token, scope: 'other' })).status,
        400,
        'Refresh cannot expand scope',
    );
    const [next, replay] = await Promise.all([
        f.post('/oauth/token', { ...parameters, refresh_token: replacement.refresh_token }),
        f.post('/oauth/token', { ...parameters, refresh_token: replacement.refresh_token }),
    ]);
    assert.equal(next.status, 200, 'First concurrent refresh succeeds');
    assert.equal(replay.status, 400, 'Concurrent reuse is rejected');
    assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');
    const newest = (await next.json()) as { refresh_token: string };
    assert.equal(
        (await f.post('/oauth/token', { ...parameters, refresh_token: newest.refresh_token })).status,
        400,
        'Replay revokes the entire token family',
    );
}

async function authenticatedMcp(f: OAuthFixture, token: string): Promise<void> {
    const request = (method: string, id: number) =>
        f.fetch('/mcp', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params:
                    method === 'initialize'
                        ? { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-oauth', version: '1' } }
                        : {},
            }),
        });
    const response = await request('initialize', 1);
    assert.equal(response.status, 200, 'Authenticated MCP initialize');
    assert.ok((await response.text()).includes('serverInfo'));
    const listedResponse = await request('tools/list', 2);
    const listedText = await listedResponse.text();
    const listed = JSON.parse(
        listedText.startsWith('event:')
            ? listedText
                  .split('\n')
                  .find((line) => line.startsWith('data: '))!
                  .slice(6)
            : listedText,
    ) as {
        result: { tools: { securitySchemes?: unknown; _meta?: { securitySchemes?: unknown } }[] };
    };
    assert.ok(listed.result.tools.length > 0);
    for (const tool of listed.result.tools) {
        assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['aibinator:control'] }]);
        assert.deepEqual(tool.securitySchemes, tool._meta?.securitySchemes);
    }
    const modern = await f.fetch('/mcp', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list',
            params: {
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                    [CLIENT_INFO_META_KEY]: { name: 'offline-oauth', version: '1' },
                },
            },
        }),
    });
    assert.equal(modern.status, 200);
    assert.deepEqual(
        ((await modern.json()) as typeof listed).result.tools.map((tool) => tool.securitySchemes),
        listed.result.tools.map((tool) => tool.securitySchemes),
    );
    assert.deepEqual(f.f.spoken, [], 'Listing tools never speaks through AIBI');
}

async function deniedConsent(f: OAuthFixture, client: string): Promise<void> {
    const response = await f.fetch(authorization(f, client));
    const path = response.headers.get('location')!;
    const csrf = await form(f, path);
    const denied = await redirect(f, await f.post(path, { csrf, action: 'deny' }));
    const destination = new URL(denied.headers.get('location')!);
    assert.equal(destination.searchParams.get('error'), 'access_denied');
    assert.equal(destination.searchParams.get('code'), null);
    assert.equal(destination.searchParams.get('iss'), f.config.AIBINATOR_OAUTH_ISSUER);
}

async function migrateExistingClient(f: OAuthFixture, client: string): Promise<void> {
    const adapter = f.oauth!.store.adapter('Client');
    const existing = await adapter.find(client);
    assert.ok(existing);
    existing.scope = 'aibinator:control';
    existing.grant_types = ['authorization_code'];
    await adapter.upsert(client, existing);
    await f.stop();
    await f.start();
    const migrated = await f.oauth!.store.adapter('Client').find(client);
    assert.equal(migrated?.scope, 'openid aibinator:control');
    assert.deepEqual(migrated?.grant_types, ['authorization_code', 'refresh_token']);
}

function checkClaudeRegistration(): void {
    const schema = registrationSchema([]);
    const claude = {
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        application_type: 'web',
        scope: 'aibinator:control',
        client_name: 'claudeai',
    };
    assert.ok(schema.safeParse(claude).success, 'claude.ai can register its confidential client');
    assert.ok(
        !schema.safeParse({ ...claude, redirect_uris: ['https://evil.example/api/mcp/auth_callback'] }).success,
        'unknown callbacks are refused',
    );
}

export async function checkOAuth(directory: string): Promise<void> {
    checkClaudeRegistration();
    await checkOAuthFiles(directory);
    const f = new OAuthFixture(directory);
    const password = `offline-fixture-${randomBytes(16).toString('hex')}`;
    await assert.rejects(() => f.start(), 'Missing setup fails closed');
    await assert.rejects(() => requestOwnerPassword(f.config.AIBINATOR_OAUTH_DATA_DIR, 'short'), /12 characters/);
    await requestOwnerPassword(f.config.AIBINATOR_OAUTH_DATA_DIR, password);
    assert.ok(await applyPendingOwner(f.config.AIBINATOR_OAUTH_DATA_DIR), 'a requested password enrolls the owner');
    if (posixOnly) assert.equal((await stat(`${f.config.AIBINATOR_OAUTH_DATA_DIR}/owner.json`)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(`${f.config.AIBINATOR_OAUTH_DATA_DIR}/owner.json`, 'utf8')).includes(password));
    await f.start();
    try {
        await discovery(f);
        const client = await registration(f);
        await migrateExistingClient(f, client);
        await pkce(f, client);
        const code = await loginConsent(f, client, password);
        await f.stop();
        await f.start();
        await tokenChecks(f, client, code);
        await refreshChecks(f, client);
        await checkConsentPage(f, client);
        await deniedConsent(f, client);
        await checkLoginLimits(f, client, password);
        await checkPasswordReset(f, client, password);
        await checkClientExpiry(f, client);
        console.log(
            'Bundled OAuth passed: DCR, client expiry, S256, owner login/consent, CSRF, JWT claims, MCP init, persistence, failed-login limits and password-reset revocation. In-process, no network.',
        );
    } finally {
        await f.stop();
    }
}
