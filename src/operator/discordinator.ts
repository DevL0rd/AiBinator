import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { z } from 'zod';
import type { OperatingMode } from './config.js';

export const conversationName = 'Coordinator';

function discordinatorHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    if (env.DISCORDINATOR_APP_HOME) return env.DISCORDINATOR_APP_HOME;
    if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'Discordinator');
    if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'Discordinator');
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'discordinator');
}

const settingsSchema = z.object({ mode: z.string(), backgroundOnly: z.boolean().default(false) }).loose();
const claudeSchema = z.object({ sessionId: z.uuid(), workspace: z.string() }).loose();
const codexSchema = z.object({ conversations: z.array(z.object({ key: z.string(), sessionId: z.string().optional() }).loose()) }).loose();

async function json(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
        return undefined;
    }
}

interface Shared {
    sessionId: string;
    workspace?: string;
}

export type Sharing = { state: 'shared'; shared: Shared } | { state: 'unavailable'; reason: string };

export async function sharedConversation(mode: OperatingMode, root = discordinatorHome()): Promise<Sharing> {
    const settings = settingsSchema.safeParse(await json(join(root, '.data', 'operator-settings.json')));
    if (!settings.success) return { state: 'unavailable', reason: `Discordinator is not set up on this computer (${root}).` };
    if (settings.data.mode !== mode)
        return {
            state: 'unavailable',
            reason: 'Discordinator uses a different responder. Choose the same responder in both to share the Coordinator.',
        };
    if (settings.data.backgroundOnly)
        return {
            state: 'unavailable',
            reason: 'Discordinator runs its responder privately in the background, so its Coordinator cannot be shared.',
        };
    if (mode === 'claude-session') {
        const saved = claudeSchema.safeParse(await json(join(root, '.data', 'claude-session.json')));
        return saved.success
            ? { state: 'shared', shared: { sessionId: saved.data.sessionId, workspace: saved.data.workspace } }
            : {
                  state: 'unavailable',
                  reason: 'Discordinator has not started the Coordinator conversation yet. Send it a Discord message first.',
              };
    }
    const state = codexSchema.safeParse(await json(join(root, '.data', 'controller-codex-local.json')));
    const thread = state.success ? state.data.conversations.find((item) => item.key === 'discordinator')?.sessionId : undefined;
    return thread
        ? { state: 'shared', shared: { sessionId: thread } }
        : {
              state: 'unavailable',
              reason: 'Discordinator has not started the Coordinator conversation yet. Send it a Discord message first.',
          };
}

export async function joinedSession(shared?: () => Promise<Sharing>): Promise<string | undefined> {
    if (!shared) return undefined;
    const sharing = await shared();
    if (sharing.state === 'unavailable') throw new Error(sharing.reason);
    return sharing.shared.sessionId;
}
