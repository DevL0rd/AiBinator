import type Provider from 'oidc-provider';

const codes = new Set(['invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'invalid_target', 'unsupported_grant_type']);
const details = new Set([
    'refresh token not found',
    'client mismatch',
    'refresh token is expired',
    'refresh token already used',
    'authorization code is expired',
    'authorization code redirect_uri mismatch',
    'authorization code not found',
    'authorization code already used',
    'PKCE verification failed',
]);

export function oauthDiagnostics(provider: Provider): void {
    provider.on('grant.error', (ctx, error) => {
        const grant = ctx.oidc.params?.grant_type;
        console.error(
            `OAuth grant failed ${JSON.stringify({
                at: new Date().toISOString(),
                status: ctx.status,
                error: codes.has(error.error) ? error.error : 'other',
                detail: details.has(error.error_detail ?? '') ? error.error_detail : undefined,
                grantType: grant === 'authorization_code' || grant === 'refresh_token' ? grant : 'other',
                publicClient: ctx.oidc.client?.tokenEndpointAuthMethod === 'none',
            })}`,
        );
    });
}
