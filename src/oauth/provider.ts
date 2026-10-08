import { errors, interactionPolicy, type Configuration } from 'oidc-provider';
import type { Config } from '../core/config.js';
import type { KeyMaterial, Owner } from './provision.js';
import { registrationSchema } from './registration.js';
import type { OAuthStore } from './storage.js';

export function providerConfiguration(config: Config, keys: KeyMaterial, owner: Owner, store: OAuthStore): Configuration {
    const resource = config.AIBINATOR_RESOURCE_URL!;
    const policy = interactionPolicy.base();
    policy
        .get('consent')!
        .checks.add(new interactionPolicy.Check('explicit_consent', 'Owner consent is required', (ctx) => !ctx.oidc.result?.consent));
    return {
        adapter: store.adapter,
        jwks: keys.jwks,
        cookies: providerCookies(keys),
        responseTypes: ['code'],
        scopes: ['openid', 'aibinator:control'],
        claims: { openid: ['sub'] },
        pkce: { required: () => true },
        clientDefaults: {
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: 'openid aibinator:control',
            application_type: 'web',
        },
        extraClientMetadata: {
            properties: ['aibinator_policy'],
            validator(ctx, _key, _value, metadata) {
                if (ctx?.oidc.route !== 'registration') return;
                const parsed = registrationSchema(config.AIBINATOR_OAUTH_REDIRECT_URIS.split(',')).safeParse(ctx.oidc.body);
                if (!parsed.success) {
                    console.error(`DCR rejected ${JSON.stringify(dcrDiagnostic(ctx.oidc.body, parsed.error.issues))}`);
                    throw new errors.InvalidClientMetadata('Only approved ChatGPT and Claude code clients are accepted');
                }
                console.log(`DCR accepted ${JSON.stringify(dcrDiagnostic(ctx.oidc.body))}`);
                Object.assign(metadata, parsed.data);
            },
        },
        features: providerFeatures(resource),
        interactions: { policy, url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
        routes: { authorization: '/oauth/auth', token: '/oauth/token', registration: '/oauth/register', jwks: '/oauth/jwks' },
        ttl: {
            AccessToken: 300,
            AuthorizationCode: 60,
            IdToken: 300,
            RefreshToken: 2592000,
            Interaction: 600,
            Session: 3600,
            Grant: 2592000,
        },
        issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
        rotateRefreshToken: true,
        expiresWithSession: () => false,
        findAccount: (_ctx, subject) =>
            subject === owner.subject ? { accountId: subject, claims: () => Promise.resolve({ sub: subject }) } : undefined,
        clientBasedCORS: () => false,
        renderError: (ctx, out) => {
            ctx.type = 'application/json';
            ctx.body = { error: out.error };
        },
    };
}

function providerCookies(keys: KeyMaterial): Configuration['cookies'] {
    return {
        keys: keys.cookies,
        long: { secure: true, httpOnly: true, sameSite: 'lax' },
        short: { secure: true, httpOnly: true, sameSite: 'lax' },
        names: {
            session: '__Host-aibinator-session',
            interaction: '__Secure-aibinator-interaction',
            resume: '__Secure-aibinator-resume',
        },
    };
}

function dcrDiagnostic(body: unknown, issues: { code: string; path: PropertyKey[] }[] = []): Record<string, unknown> {
    const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const redirects = Array.isArray(value.redirect_uris)
        ? value.redirect_uris.map((entry) => {
              try {
                  const url = new URL(String(entry));
                  return `${url.origin}${url.pathname}`;
              } catch {
                  return 'invalid-url';
              }
          })
        : [];
    return {
        keys: Object.keys(value).sort(),
        redirects,
        grant_types: value.grant_types,
        response_types: value.response_types,
        token_endpoint_auth_method: value.token_endpoint_auth_method,
        application_type: value.application_type,
        scope: value.scope,
        issues: issues.map((issue) => ({ code: issue.code, path: issue.path.map(String) })),
    };
}

function providerFeatures(resource: string): Configuration['features'] {
    return {
        devInteractions: { enabled: false },
        userinfo: { enabled: false },
        registration: { enabled: true, issueRegistrationAccessToken: false },
        registrationManagement: { enabled: false },
        requestObjects: { enabled: false },
        pushedAuthorizationRequests: { enabled: false },
        clientIdMetadataDocument: { enabled: false },
        resourceIndicators: {
            enabled: true,
            defaultResource: () => resource,
            useGrantedResource: () => true,
            getResourceServerInfo(_ctx, indicator) {
                if (indicator !== resource) throw new errors.InvalidTarget();
                return {
                    scope: 'aibinator:control',
                    audience: resource,
                    accessTokenTTL: 300,
                    accessTokenFormat: 'jwt',
                    jwt: { sign: { alg: 'RS256' } },
                };
            },
        },
    };
}
