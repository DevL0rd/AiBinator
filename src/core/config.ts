import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isIP, isIPv4 } from 'node:net';
import { animations, usableActions } from '../aibi/capabilities.js';
import { chatgptRedirect, validAppRedirect, oauthDirectory } from '../oauth/registration.js';

const scope = z.enum(['aibi.read', 'aibi.speak', 'aibi.act', 'memory.write']);
export type Scope = z.infer<typeof scope>;
export const scopeNames = scope.options;
const modelSlug = z
    .string()
    .trim()
    .regex(/^[\w.:/-]{1,100}$/);
const port = (value: number) => z.number().int().min(1).max(65535).default(value);
export const defaultPersonality =
    'You are warm, curious, playful and concise. You feel like a small embodied desktop companion, not a generic assistant.';
function without(...keys: string[]): (value: unknown) => unknown {
    return (value) => {
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([name]) => !keys.includes(name)));
    };
}

const aibiObject = z
    .object({
        mode: z.enum(['local', 'passthrough']).default('local'),
        personality: z.string().trim().max(2000).default(defaultPersonality),
        actions: z
            .array(z.string().min(1).max(80))
            .max(200)
            .default(() => [...usableActions]),
        animations: z
            .array(z.string().min(1).max(80))
            .max(600)
            .default(() => [...animations]),
        lanAddress: z
            .string()
            .trim()
            .refine((value) => value === '' || isIPv4(value), 'Enter an IPv4 address or leave empty')
            .default(''),
        dns: z.boolean().default(true),
        capture: z.boolean().default(false),
        dnsUpstream: z
            .string()
            .trim()
            .regex(/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/)
            .default('1.1.1.1'),
        httpPort: port(80),
        httpsPort: port(443),
        dnsPort: port(53),
    })
    .strict();
const voiceObject = z
    .object({
        liveModel: modelSlug.default('gemini-3.8-live'),
        liveVoice: z.string().trim().max(60).default(''),
        idleSeconds: z.number().int().min(10).max(600).default(30),
        speechThreshold: z.number().int().min(100).max(8000).default(4000),
        memoryLines: z.number().int().min(0).max(200).default(40),
    })
    .strict();
const policyObject = z
    .object({
        ownerName: z.string().trim().max(60).default(''),
        scopes: z.array(scope).default(() => [...scopeNames]),
        aibi: z.preprocess(without('disabledActions'), aibiObject).prefault({}),
        voice: z
            .preprocess(
                without('conversationStyle', 'echoStrength', 'echoDelayMs', 'interruptions', 'quietKeepsListening', 'resultWaitSeconds'),
                voiceObject,
            )
            .prefault({}),
    })
    .strict();
export const policySchema = policyObject;
export type PolicyConfig = z.infer<typeof policyObject>;

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:');
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), httpsUrl.optional());
const resourceUrl = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.union([httpsUrl, z.string().regex(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)]).optional(),
);
export const envSchema = z.object({
    AIBINATOR_POLICY_FILE: z.string().default('policy.json'),
    AIBINATOR_PORT: z.coerce.number().int().min(1024).max(65535).default(8789),
    AIBINATOR_BIND_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    AIBINATOR_AUTH_MODE: z.enum(['bearer', 'oauth']).default('bearer'),
    AIBINATOR_MCP_TOKEN: z.string().optional(),
    AIBINATOR_RESOURCE_URL: resourceUrl,
    AIBINATOR_OAUTH_ISSUER: optionalUrl,
    AIBINATOR_OAUTH_JWKS_URL: optionalUrl,
    AIBINATOR_OAUTH_SUBJECTS: z.string().default(''),
    AIBINATOR_OAUTH_SERVER: z.enum(['external', 'bundled']).default('bundled'),
    AIBINATOR_OAUTH_DATA_DIR: oauthDirectory,
    AIBINATOR_TRUSTED_PROXIES: z.string().default(''),
    AIBINATOR_OAUTH_REDIRECT_URIS: z.string().default(chatgptRedirect),
    AIBINATOR_ALLOWED_HOSTS: z.string().default(''),
    AIBINATOR_ALLOWED_ORIGINS: z.string().default(''),
    GEMINI_API_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(8).max(500).optional()),
});
export type Config = z.infer<typeof envSchema>;

export function csv(value: string): string[] {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function derivePublicAccess(config: Config): void {
    const resource = config.AIBINATOR_RESOURCE_URL;
    if (!resource || !httpsUrl.safeParse(resource).success) return;
    const url = new URL(resource);
    const add = (list: string, value: string) => [...new Set([...csv(list), value])].join(',');
    config.AIBINATOR_ALLOWED_HOSTS = add(config.AIBINATOR_ALLOWED_HOSTS, url.host);
    config.AIBINATOR_ALLOWED_ORIGINS = add(config.AIBINATOR_ALLOWED_ORIGINS, url.origin);
    if (config.AIBINATOR_OAUTH_SERVER === 'bundled') config.AIBINATOR_OAUTH_ISSUER = url.origin;
}

export function validateAuth(config: Config): void {
    derivePublicAccess(config);
    if (config.AIBINATOR_AUTH_MODE === 'bearer') {
        const token = config.AIBINATOR_MCP_TOKEN ?? '';
        if (token.length < 32 || token.startsWith('replace-')) throw new Error('Invalid MCP credential configuration');
        return;
    }
    if (config.AIBINATOR_OAUTH_SERVER === 'bundled') return validateBundled(config);
    const required = [config.AIBINATOR_RESOURCE_URL, config.AIBINATOR_OAUTH_ISSUER, config.AIBINATOR_OAUTH_JWKS_URL];
    if (required.some((value) => !value) || !csv(config.AIBINATOR_OAUTH_SUBJECTS).length) {
        throw new Error('Incomplete OAuth resource configuration');
    }
    if (!httpsUrl.safeParse(config.AIBINATOR_RESOURCE_URL).success) throw new Error('OAuth requires an HTTPS resource URL');
}

function validateBundled(config: Config): void {
    if (!config.AIBINATOR_RESOURCE_URL || !config.AIBINATOR_OAUTH_ISSUER)
        throw new Error('Bundled OAuth requires resource and issuer URLs');
    const issuer = new URL(config.AIBINATOR_OAUTH_ISSUER);
    const resource = new URL(config.AIBINATOR_RESOURCE_URL);
    if (
        config.AIBINATOR_OAUTH_ISSUER !== issuer.origin ||
        config.AIBINATOR_RESOURCE_URL !== `${issuer.origin}/mcp` ||
        resource.protocol !== 'https:'
    ) {
        throw new Error('Bundled OAuth requires an origin-only issuer and its exact HTTPS /mcp resource');
    }
    if (!csv(config.AIBINATOR_ALLOWED_HOSTS).includes(issuer.host))
        throw new Error('Bundled OAuth requires the exact issuer Host allowlist entry');
    const proxies = csv(config.AIBINATOR_TRUSTED_PROXIES);
    if (!proxies.length || proxies.some((proxy) => !isIP(proxy)))
        throw new Error('Bundled OAuth requires exact trusted proxy IP addresses');
    config.AIBINATOR_OAUTH_REDIRECT_URIS = bundledRedirects(config.AIBINATOR_OAUTH_REDIRECT_URIS);
    config.AIBINATOR_OAUTH_JWKS_URL = new URL('/oauth/jwks', issuer).href;
}

function bundledRedirects(value: string): string {
    const redirects = csv(value);
    if (!redirects.length || redirects.length > 4 || redirects.some((redirect) => !validAppRedirect(redirect))) {
        throw new Error('Bundled OAuth requires exact approved ChatGPT or Claude callback URLs');
    }
    return redirects.join(',');
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<{ config: Config; policy: PolicyConfig }> {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) throw new Error('Invalid environment configuration; check docs/configuration.md');
    validateAuth(parsed.data);
    parsed.data.AIBINATOR_RESOURCE_URL ??= `http://127.0.0.1:${parsed.data.AIBINATOR_PORT}/mcp`;
    const policy = policySchema.safeParse(JSON.parse(await readFile(parsed.data.AIBINATOR_POLICY_FILE, 'utf8')));
    if (!policy.success) throw new Error('Invalid policy configuration; check policy.example.json');
    return { config: parsed.data, policy: policy.data };
}
