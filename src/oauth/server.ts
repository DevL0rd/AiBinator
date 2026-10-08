import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import Provider from 'oidc-provider';
import { createLocalJWKSet } from 'jose';
import { csv, type Config } from '../core/config.js';
import { readPrivate, lockDirectory, OAuthStore } from './storage.js';
import { applyPendingOwner, ensureKeys, ownerPending, pendingOwnerFile, type KeyMaterial, type Owner } from './provision.js';
import { watchFile } from '../operator/file-watch.js';
import { providerConfiguration } from './provider.js';
import { budget, OwnerInteractions } from './interactions.js';
import { oauthJson } from './forms.js';
import { httpsOrigin } from '../core/canonical.js';
import { oauthDiagnostics } from './diagnostics.js';

export class BundledOAuth {
    readonly verifyKey;
    readonly provider;
    private readonly interactions;
    private readonly callback;
    private tokenRequest: Promise<void> = Promise.resolve();
    private readonly unwatch: () => void;
    private constructor(
        readonly config: Config,
        readonly owner: Owner,
        keys: KeyMaterial,
        readonly store: OAuthStore,
        private readonly release: () => Promise<void>,
    ) {
        this.provider = new Provider(config.AIBINATOR_OAUTH_ISSUER!, providerConfiguration(config, keys, owner, store));
        oauthDiagnostics(this.provider);
        this.provider.proxy = true;
        this.callback = this.provider.callback();
        this.verifyKey = createLocalJWKSet({
            keys: keys.jwks.keys.map(({ d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicKey }) => publicKey),
        });
        this.interactions = new OwnerInteractions(this.provider, owner, store, config.AIBINATOR_RESOURCE_URL!);
        this.unwatch = watchFile(pendingOwnerFile(config.AIBINATOR_OAUTH_DATA_DIR), () => void this.refreshOwner());
        config.AIBINATOR_OAUTH_SUBJECTS = owner.subject;
    }

    async close(): Promise<void> {
        this.unwatch();
        await this.release();
    }

    private async refreshOwner(): Promise<void> {
        try {
            const next = await applyOwner(this.config.AIBINATOR_OAUTH_DATA_DIR, this.store);
            if (next) this.interactions.owner = next;
        } catch (error) {
            console.error(`OAuth owner password update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }

    static async open(config: Config): Promise<BundledOAuth> {
        const directory = config.AIBINATOR_OAUTH_DATA_DIR;
        const release = await lockDirectory(directory);
        try {
            await ensureKeys(directory);
            const keys = await readPrivate<KeyMaterial>(join(directory, 'keys.json'));
            const store = new OAuthStore(directory);
            await store.load();
            const owner =
                (await applyOwner(directory, store)) ??
                (await readPrivate<Owner>(join(directory, 'owner.json')).catch(() => {
                    throw new Error('Set a sign-in password in the setup app (Apps → Sign-in password)');
                }));
            if (!owner.subject || !owner.passwordHash.startsWith('$argon2id$')) throw new Error('Owner enrollment required');
            if (!keys.cookies.length || !keys.jwks.keys.length) throw new Error('OAuth key setup required');
            await migrateClients(store);
            return new BundledOAuth(config, owner, keys, store, release);
        } catch (error) {
            await release();
            throw error;
        }
    }

    private trusted(request: IncomingMessage): boolean {
        const issuer = new URL(this.config.AIBINATOR_OAUTH_ISSUER!);
        const remote = request.socket.remoteAddress ?? '';
        return (
            csv(this.config.AIBINATOR_TRUSTED_PROXIES).includes(remote) &&
            httpsOrigin(`https://${request.headers.host ?? ''}`) === issuer.origin &&
            request.headers['x-forwarded-proto'] === 'https' &&
            (!request.headers.origin || httpsOrigin(request.headers.origin) === issuer.origin)
        );
    }

    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
        const path = new URL(request.url ?? '/', this.config.AIBINATOR_OAUTH_ISSUER).pathname;
        if (!oauthPath(path)) return false;
        if (path === '/oauth/token') {
            response.once('finish', () => {
                console.error(
                    `OAuth token response ${JSON.stringify({ at: new Date().toISOString(), method: request.method, status: response.statusCode })}`,
                );
            });
        }
        if (!this.trusted(request)) return this.denyTrust(request, response, path);
        for (const header of ['forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-real-ip']) delete request.headers[header];
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'same-origin');
        const match = /^\/oauth\/interaction\/([A-Za-z0-9_-]+)$/.exec(path);
        if (match) return this.handleInteraction(request, response, match[1]!);
        if (!(await this.endpointAllowed(request, response, path))) return true;
        await this.dispatchProvider(request, response, path);
        return true;
    }

    private denyTrust(request: IncomingMessage, response: ServerResponse, path: string): true {
        console.error(
            `OAuth trust denied ${JSON.stringify({
                path,
                method: request.method,
                remote: request.socket.remoteAddress,
                host: request.headers.host,
                forwardedProto: request.headers['x-forwarded-proto'],
                origin: request.headers.origin,
            })}`,
        );
        oauthJson(response, 403, { error: 'HTTPS proxy, Host or Origin denied' });
        return true;
    }

    private async handleInteraction(request: IncomingMessage, response: ServerResponse, uid: string): Promise<true> {
        const sameOrigin = httpsOrigin(request.headers.origin ?? '') === new URL(this.config.AIBINATOR_OAUTH_ISSUER!).origin;
        if (request.method === 'POST' && !sameOrigin) oauthJson(response, 403, { error: 'Same-origin form required' });
        else await this.interactions.handle(request, response, uid);
        return true;
    }

    private async dispatchProvider(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
        if (path === '/oauth/token') {
            const pending = this.tokenRequest.then(() => this.callback(request, response));
            this.tokenRequest = pending.catch(() => {});
            await pending;
        } else await this.callback(request, response);
    }

    private async endpointAllowed(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
        if (path === '/oauth/register') {
            if (request.method !== 'POST') {
                oauthJson(response, 405, { error: 'Method denied' });
                return false;
            }
            if (
                (await this.store.consentedClientCount()) >= 200 ||
                (await budget(this.store, { registration: 10 }, 60_000)) === undefined
            ) {
                oauthJson(response, 429, { error: 'Registration limited' });
                return false;
            }
        }
        if (Number(request.headers['content-length'] ?? 0) > 8192) {
            oauthJson(response, 413, { error: 'Body too large' });
            return false;
        }
        return this.authorizationAllowed(request, response, path);
    }

    private authorizationAllowed(request: IncomingMessage, response: ServerResponse, path: string): boolean {
        if (path !== '/oauth/auth' || validAuthorization(request, this.config)) return true;
        oauthJson(response, 400, { error: 'Exact control scope and resource required' });
        return false;
    }
}

async function applyOwner(directory: string, store: OAuthStore): Promise<Owner | undefined> {
    if (!(await ownerPending(directory))) return undefined;
    await store.revokeSignIns();
    return applyPendingOwner(directory);
}

async function migrateClients(store: OAuthStore): Promise<void> {
    const migrated = await store.migrateChatgptClients();
    if (migrated) console.log(`Migrated ${migrated} approved ChatGPT OAuth client${migrated === 1 ? '' : 's'}`);
    const expiring = await store.expireUnconsentedClients();
    if (expiring) console.log(`${expiring} OAuth client${expiring === 1 ? '' : 's'} without consent will expire in 24 hours`);
}

function oauthPath(path: string): boolean {
    return path.startsWith('/oauth/') || ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(path);
}

function validAuthorization(request: IncomingMessage, config: Config): boolean {
    if (request.method !== 'GET') return false;
    const params = new URL(request.url!, config.AIBINATOR_OAUTH_ISSUER).searchParams;
    const scopes = params.get('scope')?.split(' ').filter(Boolean) ?? [];
    const accepted =
        (scopes.length === 1 && scopes[0] === 'aibinator:control') ||
        (scopes.length === 2 && new Set(scopes).size === 2 && scopes.includes('openid') && scopes.includes('aibinator:control'));
    return accepted && params.get('resource') === config.AIBINATOR_RESOURCE_URL;
}
