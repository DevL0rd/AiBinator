import { z } from 'zod';

export const chatgptRedirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const oauthDirectory = z
    .string()
    .regex(/^\.data\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/)
    .default('.data/oauth');
const allowed = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const claudeRedirects = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);

export function validAppRedirect(value: string): boolean {
    if (claudeRedirects.has(value)) return true;
    const url = new URL(value);
    return (
        allowed.has(url.origin) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.pathname === '/connector_platform_oauth_redirect' ||
            /^\/connector\/oauth\/[a-zA-Z0-9_-]{1,128}$/.test(url.pathname) ||
            /^\/aip\/[a-zA-Z0-9_-]{1,128}\/oauth\/callback$/.test(url.pathname))
    );
}

export function registrationSchema(redirects: string[]) {
    return z
        .object({
            redirect_uris: z
                .array(z.url().refine((value) => redirects.includes(value) || validAppRedirect(value)))
                .min(1)
                .max(4),
            grant_types: z
                .union([z.tuple([z.literal('authorization_code')]), z.tuple([z.literal('authorization_code'), z.literal('refresh_token')])])
                .default(['authorization_code']),
            response_types: z.tuple([z.literal('code')]).default(['code']),
            token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
            application_type: z.literal('web').default('web'),
            scope: z.union([z.literal('aibinator:control'), z.literal('openid aibinator:control')]).default('openid aibinator:control'),
            client_name: z
                .string()
                .regex(/^[\p{L}\p{N} ._()-]{1,80}$/u)
                .optional(),
        })
        .strict();
}
