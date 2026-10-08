import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { HttpServer } from '../src/mcp/http.js';
import { BundledOAuth } from '../src/oauth/server.js';
import { fakeConfig, fixture } from './fixtures.js';
import { inProcessHttp } from './in-process-http.js';

export class OAuthFixture {
    readonly config;
    readonly f;
    http?: HttpServer;
    oauth?: BundledOAuth;
    private cookies = new Map<string, { value: string; path: string }>();
    constructor(directory: string) {
        this.config = {
            ...fakeConfig(),
            AIBINATOR_AUTH_MODE: 'oauth' as const,
            AIBINATOR_OAUTH_SERVER: 'bundled' as const,
            AIBINATOR_RESOURCE_URL: 'https://aibinator.example/mcp',
            AIBINATOR_OAUTH_ISSUER: 'https://aibinator.example',
            AIBINATOR_OAUTH_JWKS_URL: 'https://aibinator.example/oauth/jwks',
            AIBINATOR_ALLOWED_HOSTS: 'aibinator.example',
            AIBINATOR_TRUSTED_PROXIES: '127.0.0.1',
            AIBINATOR_OAUTH_DATA_DIR: `${directory}/oauth`,
        };
        this.f = fixture(`${directory}/bundled-journal.json`);
    }
    async start(): Promise<void> {
        this.oauth = await BundledOAuth.open(this.config);
        this.http = new HttpServer(this.config, this.f.bridge, () => ({ aibi: 'mock' }), undefined, this.oauth);
    }
    async stop(): Promise<void> {
        await this.oauth?.close();
        this.http = undefined;
    }
    fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
        const target = new URL(path, this.config.AIBINATOR_OAUTH_ISSUER);
        assert.equal(target.origin, this.config.AIBINATOR_OAUTH_ISSUER, 'Tests never follow a public callback');
        const cookie = [...this.cookies.values()]
            .filter((entry) => target.pathname.startsWith(entry.path))
            .map((entry) => entry.value)
            .join('; ');
        const headers = new Headers({ Host: 'aibinator.example:443', 'X-Forwarded-Proto': 'https', Cookie: cookie });
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        const response = await inProcessHttp(this.http!.server, `${target.pathname}${target.search}`, { ...init, headers });
        for (const value of response.headers.getSetCookie()) {
            const part = value.split(';')[0]!;
            const name = part.split('=')[0]!;
            const cookiePath = /; path=([^;]+)/i.exec(value)?.[1] ?? '/';
            this.cookies.set(`${name}:${cookiePath}`, { value: part, path: cookiePath });
        }
        return response;
    };
    post(path: string, values: Record<string, string>, headers = {}): Promise<Response> {
        const origin: Record<string, string> = path.includes('/interaction/') ? { Origin: 'https://aibinator.example:443' } : {};
        return this.fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...origin, ...headers },
            body: new URLSearchParams(values).toString(),
        });
    }
}

export async function form(f: OAuthFixture, path: string): Promise<string> {
    const response = await f.fetch(path);
    assert.equal(response.status, 200, 'Interaction page');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.match(
        response.headers.get('content-security-policy') ?? '',
        /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; form-action 'self' https:\/\/chatgpt\.com; frame-ancestors 'none'; base-uri 'none'$/,
        'only the page’s own stylesheet is allowed; no scripts',
    );
    const html = await response.text();
    const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    assert.ok(csrf, 'CSRF field present');
    return csrf;
}

export async function redirect(f: OAuthFixture, response: Response): Promise<Response> {
    assert.equal(response.status, 303, 'Interaction redirect');
    return f.fetch(response.headers.get('location')!);
}

export const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

export function authorization(f: OAuthFixture, client: string, extra = {}): string {
    return `/oauth/auth?${new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: 'code', scope: 'openid aibinator:control', resource: f.config.AIBINATOR_RESOURCE_URL, state: 'offline-state', nonce: 'offline-nonce', code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`;
}
