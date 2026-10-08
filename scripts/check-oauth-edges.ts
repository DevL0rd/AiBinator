import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BundledOAuth } from '../src/oauth/server.js';
import { pendingOwnerFile, requestOwnerPassword } from '../src/oauth/provision.js';
import { validAppRedirect } from '../src/oauth/registration.js';
import { writePrivate } from '../src/oauth/storage.js';
import { OAuthFixture, authorization, callback, form, redirect } from './oauth-fixture.js';

async function checkBrokenSetup(directory: string): Promise<void> {
    const cases = [
        { name: 'unenrolled', owner: { identifier: 'owner', subject: 'owner-subject', passwordHash: 'plain' }, error: /Owner enrollment/ },
        {
            name: 'keyless',
            owner: { identifier: 'owner', subject: 'owner-subject', passwordHash: '$argon2id$fixture' },
            error: /key setup/,
        },
    ];
    for (const item of cases) {
        const data = join(directory, `oauth-${item.name}`);
        await mkdir(data, { recursive: true, mode: 0o700 });
        await writePrivate(join(data, 'keys.json'), { jwks: { keys: [] }, cookies: [] }, true);
        await writePrivate(join(data, 'owner.json'), item.owner, true);
        const config = { ...new OAuthFixture(directory).config, AIBINATOR_OAUTH_DATA_DIR: data };
        await assert.rejects(BundledOAuth.open(config), item.error);
        await assert.rejects(BundledOAuth.open(config), item.error, 'A failed start releases its directory lock');
    }
}

function checkAppRedirects(): void {
    assert.equal(validAppRedirect('https://chatgpt.com/connector/oauth/abc_123'), true);
    assert.equal(validAppRedirect('https://chat.openai.com/aip/g-123/oauth/callback'), true);
    assert.equal(validAppRedirect('https://chatgpt.com/connector/oauth/abc?next=1'), false, 'Query strings are refused');
    assert.equal(validAppRedirect('https://chatgpt.com/elsewhere'), false);
}

async function register(f: OAuthFixture, body: unknown): Promise<Response> {
    return f.fetch('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function checkEndpointLimits(f: OAuthFixture): Promise<string> {
    assert.equal((await f.fetch('/oauth/register')).status, 405, 'Registration is POST only');
    const created = await register(f, { redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'ChatGPT' });
    assert.equal(created.status, 201);
    const client = String(((await created.json()) as { client_id: string }).client_id);
    const scalar = await register(f, { token_endpoint_auth_method: 'none', redirect_uris: callback });
    assert.equal(scalar.status, 400, 'A redirect list is required');
    for (let attempt = 0; attempt < 8; attempt++) await register(f, {});
    const limited = await register(f, { redirect_uris: [callback], token_endpoint_auth_method: 'none' });
    assert.equal(limited.status, 429, 'Registration is rate limited');
    assert.deepEqual(await limited.json(), { error: 'Registration limited' });
    const oversized = await f.fetch('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=${'x'.repeat(9000)}`,
    });
    assert.equal(oversized.status, 413);
    return client;
}

async function checkAuthorizationShape(f: OAuthFixture, client: string): Promise<void> {
    const post = await f.fetch(authorization(f, client), { method: 'POST' });
    assert.equal(post.status, 400, 'Authorization requests must be GET');
    const scopeless = authorization(f, client).replace(/&scope=[^&]+/, '');
    assert.equal((await f.fetch(scopeless)).status, 400, 'A missing scope is refused');
    const unknown = await f.fetch(authorization(f, 'unknown-client'));
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: 'invalid_client' }, 'Provider errors render as bare JSON');
}

async function checkInteractionGuards(f: OAuthFixture, client: string, password: string): Promise<void> {
    const path = (await f.fetch(authorization(f, client))).headers.get('location')!;
    const forged = await f.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
    assert.equal(forged.status, 403, 'Interaction posts need a same-origin form');
    const mismatched = await f.fetch(`${path}x`);
    assert.equal(mismatched.status, 400);
    assert.deepEqual(await mismatched.json(), { error: 'Invalid interaction' });
    const resumed = await redirect(f, await f.post(path, { csrf: await form(f, path), action: 'login', password }));
    const consent = resumed.headers.get('location')!;
    const refused = await f.post(consent, { csrf: await form(f, consent), action: 'maybe' });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'Owner consent required' });
}

async function checkBrokenPasswordUpdate(f: OAuthFixture): Promise<void> {
    const pending = pendingOwnerFile(f.config.AIBINATOR_OAUTH_DATA_DIR);
    await writePrivate(pending, { passwordHash: 'not-argon2' });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...values: unknown[]) => errors.push(values.join(' '));
    try {
        await (f.oauth as unknown as { refreshOwner(): Promise<void> }).refreshOwner();
    } finally {
        console.error = original;
        await unlink(pending);
    }
    assert.ok(
        errors.includes('OAuth owner password update failed: Pending owner password is not an Argon2id hash'),
        'A broken password request is reported without stopping the server',
    );
}

export async function checkOAuthEdges(directory: string): Promise<void> {
    await checkBrokenSetup(directory);
    checkAppRedirects();
    const base = join(directory, 'oauth-edges');
    await mkdir(base, { recursive: true });
    const f = new OAuthFixture(base);
    const password = `offline-fixture-${randomBytes(16).toString('hex')}`;
    await requestOwnerPassword(f.config.AIBINATOR_OAUTH_DATA_DIR, password);
    await f.start();
    try {
        const client = await checkEndpointLimits(f);
        await checkAuthorizationShape(f, client);
        await checkInteractionGuards(f, client, password);
        await checkBrokenPasswordUpdate(f);
    } finally {
        await f.stop();
    }
}
