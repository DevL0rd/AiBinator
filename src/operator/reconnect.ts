import { appState, connectApp, type CodexDeps } from './connections.js';
import { publicDomain } from './connection-domain.js';
import { forgetWebConnectors, webConnectors } from './web-connectors.js';
import type { SettingChange } from './settings-registry.js';

const affected: Record<string, { codex: boolean; web: 'address' | 'sign-in' | false }> = {
    'environment.AIBINATOR_PORT': { codex: true, web: false },
    'environment.AIBINATOR_RESOURCE_URL': { codex: false, web: 'address' },
    'environment.AIBINATOR_AUTH_MODE': { codex: false, web: 'sign-in' },
    'environment.AIBINATOR_OAUTH_SERVER': { codex: false, web: 'sign-in' },
};

export const affectsConnections = (changes: readonly SettingChange[]): boolean => changes.some((change) => affected[change.id]);

function webNote(cleared: boolean, signIn: boolean): string {
    if (cleared) return ' Without a public domain, Claude (web) and ChatGPT (web) stop working.';
    return signIn
        ? ' Because how apps sign in changed, add Claude (web) and ChatGPT (web) again on the Apps page.'
        : ' Because the public address changed, add Claude (web) and ChatGPT (web) again with the new address on the Apps page.';
}

export async function planReconnect(
    changes: readonly SettingChange[],
    environment: Record<string, unknown>,
    deps?: CodexDeps,
): Promise<() => Promise<string>> {
    const hits = changes.flatMap((change) => (affected[change.id] ? [affected[change.id]!] : []));
    const codex = hits.some((hit) => hit.codex) && (await appState('codex', deps)).connected;
    const web = hits.some((hit) => hit.web) && Object.keys(await webConnectors()).length > 0;
    const signIn = hits.some((hit) => hit.web === 'sign-in');
    return async () => {
        const notes: string[] = [];
        if (codex) {
            await connectApp('codex', deps);
            notes.push(' Codex now uses the new port.');
        }
        if (signIn) await forgetWebConnectors();
        if (web) notes.push(webNote(!publicDomain(environment.AIBINATOR_RESOURCE_URL), signIn));
        return notes.join('');
    };
}
