import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPending, requestOwnerPassword } from '../src/oauth/provision.js';
import { lockDirectory, privatelyOwned, readPrivate, writePrivate } from '../src/oauth/storage.js';
import { OAuthFixture, authorization, form, redirect } from './oauth-fixture.js';

async function loginPath(f: OAuthFixture, client: string): Promise<string> {
    return (await f.fetch(authorization(f, client, { prompt: 'login' }))).headers.get('location')!;
}

async function login(f: OAuthFixture, path: string, password: string): Promise<number> {
    const csrf = await form(f, path);
    return (await f.post(path, { csrf, action: 'login', password })).status;
}

async function globalFailures(f: OAuthFixture): Promise<number> {
    const budget = await f.oauth!.store.find('Budget', (id) => id === 'login');
    return ((budget?.extra?.times as number[] | undefined) ?? []).length;
}

export async function checkLoginLimits(f: OAuthFixture, client: string, password: string): Promise<void> {
    const before = await globalFailures(f);
    assert.equal(await login(f, await loginPath(f, client), password), 303, 'Successful logins do not spend the failure budget');
    assert.equal(await globalFailures(f), before);
    const attacked = await loginPath(f, client);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal(await login(f, attacked, 'wrong'), 403);
    assert.equal(await login(f, attacked, 'wrong'), 429, 'An interaction is limited after five failures');
    await f.stop();
    await f.start();
    assert.equal(await login(f, attacked, password), 429, 'The per-interaction limit persists');
    assert.equal(await login(f, await loginPath(f, client), password), 303, 'Failures elsewhere cannot lock out the owner');
    await f.oauth!.store.mutate((records) => {
        records['Budget:login'] = {
            payload: { extra: { times: Array.from({ length: 100 }, () => Date.now()) } },
            expires: Date.now() + 60_000,
        };
    });
    assert.equal(await login(f, await loginPath(f, client), 'wrong'), 429, 'A global failure ceiling still applies');
    await f.oauth!.store.mutate((records) => {
        delete records['Budget:login'];
    });
}

export async function checkConsentPage(f: OAuthFixture, client: string): Promise<void> {
    const path = (await f.fetch(authorization(f, client))).headers.get('location')!;
    const html = await (await f.fetch(path)).text();
    assert.match(html, /<span>App<\/span><span>ChatGPT<\/span>/, 'Consent shows the registered app name');
    assert.match(html, /<span>Returns to<\/span><span>chatgpt\.com<\/span>/);
    assert.ok(!html.includes(client), 'Consent does not show the opaque client ID');
}

export async function checkClientExpiry(f: OAuthFixture, consented: string): Promise<void> {
    const store = f.oauth!.store;
    const adapter = store.adapter('Client');
    const template = (await adapter.find(consented))!;
    await store.mutate((records) => {
        for (let index = 0; index < 199; index++) {
            records[`Client:unconsented-${index}`] = {
                payload: { ...template, client_id: `unconsented-${index}` },
                expires: Date.now() + 60_000 + index,
            };
        }
        records['Client:legacy'] = { payload: { ...template, client_id: 'legacy' } };
        delete records['Migration:client-expiry'];
    });
    assert.equal(await store.consentedClientCount(), 2);
    await adapter.upsert('newest', { ...template, client_id: 'newest' });
    assert.equal(await adapter.find('unconsented-0'), undefined, 'The oldest unconsented client makes room');
    assert.ok(await adapter.find('newest'));
    assert.ok(await adapter.find(consented), 'Consented clients are never evicted');
    await f.stop();
    await f.start();
    assert.equal(await f.oauth!.store.consentedClientCount(), 1, 'Legacy clients without a grant start expiring');
    const now = Date.now;
    Date.now = () => now() + 25 * 60 * 60_000;
    try {
        assert.equal(await f.oauth!.store.adapter('Client').find('newest'), undefined, 'Clients without consent expire');
        assert.equal(await f.oauth!.store.adapter('Client').find('legacy'), undefined);
        assert.ok(await f.oauth!.store.adapter('Client').find(consented));
    } finally {
        Date.now = now;
    }
}

async function remaining(f: OAuthFixture, model: string): Promise<boolean> {
    return (await f.oauth!.store.find(model, () => true)) !== undefined;
}

export async function checkPasswordReset(f: OAuthFixture, client: string, password: string): Promise<void> {
    assert.ok(await remaining(f, 'Session'), 'A sign-in exists before the reset');
    const replacement = `${password}-replaced`;
    const directory = f.config.AIBINATOR_OAUTH_DATA_DIR;
    await requestOwnerPassword(directory, replacement);
    for (let waited = 0; (await ownerPending(directory)) && waited < 5000; waited += 25) await delay(25);
    assert.equal(await ownerPending(directory), false, 'The running server applies the new password');
    for (const model of ['Grant', 'RefreshToken', 'Session', 'AuthorizationCode'])
        assert.equal(await remaining(f, model), false, `${model} records are revoked by a password reset`);
    assert.equal(await login(f, await loginPath(f, client), password), 403, 'The previous password stops working');
    const path = await loginPath(f, client);
    const resumed = await redirect(f, await f.post(path, { csrf: await form(f, path), action: 'login', password: replacement }));
    const consent = resumed.headers.get('location')!;
    assert.equal((await f.post(consent, { csrf: await form(f, consent), action: 'allow' })).status, 303, 'The new password signs in');
}

async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');
    return child.pid!;
}

export async function checkOAuthFiles(directory: string): Promise<void> {
    assert.ok(privatelyOwned({ mode: 0o100666, uid: 0 }, 'win32', undefined), 'Windows relies on profile ACLs');
    assert.ok(privatelyOwned({ mode: 0o100600, uid: 1000 }, 'linux', 1000));
    assert.ok(!privatelyOwned({ mode: 0o100644, uid: 1000 }, 'linux', 1000), 'POSIX group/other access is refused');
    assert.ok(!privatelyOwned({ mode: 0o100600, uid: 1001 }, 'darwin', 1000), 'POSIX foreign ownership is refused');
    const files = join(directory, 'oauth-files');
    await mkdir(files, { recursive: true, mode: 0o700 });
    await writeFile(join(files, 'state.json.pending'), 'interrupted', { mode: 0o600 });
    await writePrivate(join(files, 'state.json'), { recovered: true });
    assert.deepEqual(await readPrivate(join(files, 'state.json')), { recovered: true }, 'A crashed write cannot block later writes');
    const lock = join(files, 'operation.lock');
    for (const stale of [String(await deadPid()), '']) {
        await writeFile(lock, stale, { mode: 0o600 });
        const release = await lockDirectory(files);
        await assert.rejects(lockDirectory(files), /EEXIST/, 'A live lock holder keeps the lock');
        await release();
    }
}
