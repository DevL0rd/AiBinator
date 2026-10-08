import { publicEndpoint } from './setup-model.js';
import { scalar } from '../core/text.js';

export function publicDomain(value: unknown): string {
    const text = scalar(value);
    if (!text) return '';
    try {
        return new URL(text).host;
    } catch {
        return text;
    }
}
export function domainError(value: string): string | undefined {
    const domain = value.trim();
    if (!domain) return 'Enter your public domain, like bot.example.com.';
    if (domain.includes('://') || domain.includes('/')) return 'Enter just the domain, like bot.example.com — no https:// and no path.';
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(domain)) return 'That does not look like a domain, e.g. bot.example.com.';
    try {
        publicEndpoint(domain);
    } catch {
        return 'Use a public domain, not a local or private address.';
    }
}
function domainEndpoint(value: string): string {
    const error = domainError(value);
    if (error) throw new Error(error);
    return publicEndpoint(value.trim());
}
export function editPublicDomain(document: Record<string, unknown>, value: string): Record<string, unknown> {
    const external = document.AIBINATOR_AUTH_MODE === 'oauth' && document.AIBINATOR_OAUTH_SERVER === 'external';
    if (!value.trim()) {
        const cleared = { ...structuredClone(document), AIBINATOR_RESOURCE_URL: '' };
        return external ? cleared : { ...cleared, AIBINATOR_AUTH_MODE: 'bearer' };
    }
    const next = new URL(domainEndpoint(value));
    const result = { ...structuredClone(document), AIBINATOR_RESOURCE_URL: `${next.origin}/mcp` };
    return external ? result : { ...result, ...bundledSignIn(document) };
}

function bundledSignIn(document: Record<string, unknown>): Record<string, unknown> {
    return {
        AIBINATOR_AUTH_MODE: 'oauth',
        AIBINATOR_OAUTH_SERVER: 'bundled',
        AIBINATOR_TRUSTED_PROXIES: scalar(document.AIBINATOR_TRUSTED_PROXIES) || '127.0.0.1,::1',
    };
}

export function mcpAddresses(environment: Record<string, unknown>): string[] {
    const domain = publicDomain(environment.AIBINATOR_RESOURCE_URL);
    return [
        `On this computer: http://127.0.0.1:${scalar(environment.AIBINATOR_PORT) || '8789'}/mcp, sending "Authorization: Bearer" with the key in .data/local.key.`,
        domain
            ? `From the web: https://${domain}/mcp, signing in with your AiBinator password.`
            : 'From the web: set a public domain on the Apps page first.',
    ];
}
