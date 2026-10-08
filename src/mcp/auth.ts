import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { IncomingMessage } from 'node:http';
import type { Principal } from './owner.js';
import { csv, type Config } from '../core/config.js';
import { localKeyMatches, localPrincipalId, loopbackHost } from './local-key.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export class Authenticator {
    private readonly verifyJwt;
    localKey?: string;
    constructor(
        readonly config: Config,
        verifyKey?: JWTVerifyGetKey,
    ) {
        this.verifyJwt =
            config.AIBINATOR_AUTH_MODE === 'oauth'
                ? (verifyKey ?? createRemoteJWKSet(new URL(config.AIBINATOR_OAUTH_JWKS_URL!), { timeoutDuration: 5000 }))
                : undefined;
    }

    async accepts(request: IncomingMessage): Promise<boolean> {
        return (await this.authenticate(request)) !== null;
    }

    ownerAllowed = (id: string): boolean => {
        if (id === localPrincipalId) return true;
        if (this.config.AIBINATOR_AUTH_MODE === 'bearer')
            return id === `bearer:${digest(this.config.AIBINATOR_MCP_TOKEN!).toString('hex')}`;
        return csv(this.config.AIBINATOR_OAUTH_SUBJECTS).some((subject) => id === this.oauthOwner(subject));
    };

    async authenticate(request: IncomingMessage): Promise<Principal | null> {
        const header = request.headers.authorization ?? '';
        if (this.localRequest(request)) return { id: localPrincipalId };
        const match = /^Bearer ([^\s]{1,8192})$/.exec(header);
        if (!match?.[1]) {
            console.error(
                `MCP authorization unavailable ${JSON.stringify({
                    at: new Date().toISOString(),
                    headerPresent: Boolean(header),
                    bearerFormat: false,
                    protocol: request.headers['mcp-protocol-version'],
                })}`,
            );
            return null;
        }
        if (this.config.AIBINATOR_AUTH_MODE === 'bearer') {
            if (!timingSafeEqual(digest(match[1]), digest(this.config.AIBINATOR_MCP_TOKEN!))) return null;
            return { id: `bearer:${digest(this.config.AIBINATOR_MCP_TOKEN!).toString('hex')}` };
        }
        return this.authenticateOauth(match[1]);
    }

    localRequest(request: IncomingMessage): boolean {
        return (
            loopbackHost(request.headers.host, this.config.AIBINATOR_PORT) && localKeyMatches(request.headers.authorization, this.localKey)
        );
    }

    private async authenticateOauth(token: string): Promise<Principal | null> {
        try {
            const { payload, protectedHeader } = await jwtVerify(token, this.verifyJwt!, {
                issuer: this.config.AIBINATOR_OAUTH_ISSUER!,
                audience: this.config.AIBINATOR_RESOURCE_URL!,
                algorithms: ['RS256', 'ES256'],
                requiredClaims: ['exp', 'iat', 'sub'],
            });
            if (this.config.AIBINATOR_OAUTH_SERVER === 'bundled' && !bundledProfile(protectedHeader.typ, payload.exp!, payload.iat!))
                return this.denied('bundled_token_profile');
            if (!csv(this.config.AIBINATOR_OAUTH_SUBJECTS).includes(payload.sub!)) return this.denied('subject');
            if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('aibinator:control')) return this.denied('scope');
            return { id: this.oauthOwner(payload.sub!), expiresAt: payload.exp! * 1000 };
        } catch (error) {
            return this.denied(errorCode(error));
        }
    }

    private denied(reason: string): null {
        console.error(`OAuth bearer denied ${JSON.stringify({ reason })}`);
        return null;
    }

    private oauthOwner(subject: string): string {
        return `oauth:${digest(JSON.stringify([this.config.AIBINATOR_OAUTH_ISSUER, subject])).toString('hex')}`;
    }

    challenge(): string {
        if (this.config.AIBINATOR_AUTH_MODE === 'bearer') return 'Bearer realm="AiBinator"';
        const metadata = new URL('/.well-known/oauth-protected-resource', this.config.AIBINATOR_RESOURCE_URL).href;
        return `Bearer resource_metadata="${metadata}", scope="aibinator:control"`;
    }

    metadata() {
        return {
            resource: this.config.AIBINATOR_RESOURCE_URL,
            authorization_servers: [this.config.AIBINATOR_OAUTH_ISSUER],
            scopes_supported: ['aibinator:control'],
            bearer_methods_supported: ['header'],
        };
    }
}

function bundledProfile(type: string | undefined, expires: number, issued: number): boolean {
    return type === 'at+jwt' && expires - issued <= 300 && issued <= Date.now() / 1000 + 5;
}

function errorCode(error: unknown): string {
    if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return 'jwt';
    return /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'jwt';
}
