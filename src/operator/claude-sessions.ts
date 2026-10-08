import { createConnection } from 'node:net';
import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { watchDirectory } from './file-watch.js';
import { handlesScheme, openUrl } from './open-url.js';

export interface LiveSession {
    pid: number;
    sessionId: string;
    cwd: string;
    socket: string;
    entrypoint?: string;
    status?: string;
}
const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
export const sessionsDir = () => join(configDir(), 'sessions');

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function entry(file: string): Promise<LiveSession | undefined> {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const { pid, sessionId, cwd, messagingSocketPath: socket } = raw;
    if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof socket !== 'string' || !alive(pid)) return undefined;
    return {
        pid,
        sessionId,
        socket,
        cwd: typeof cwd === 'string' ? cwd : '',
        ...(typeof raw.entrypoint === 'string' ? { entrypoint: raw.entrypoint } : {}),
        ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    };
}

export async function liveSession(sessionId: string, dir = sessionsDir()): Promise<LiveSession | undefined> {
    const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
    for (const name of files) {
        const found = await entry(join(dir, name)).catch(() => undefined);
        if (found?.sessionId === sessionId) return found;
    }
}

async function peerToken(pid: number, socket: string): Promise<string | undefined> {
    const name = `${pid}.${createHash('sha256').update(resolve(socket)).digest('hex')}.key`;
    const raw = await readFile(join(sessionsDir(), name), 'utf8').catch(() => undefined);
    return raw === undefined ? undefined : z.object({ peerToken: z.string() }).parse(JSON.parse(raw)).peerToken;
}

export async function deliver(session: Pick<LiveSession, 'pid' | 'socket'>, text: string): Promise<void> {
    const token = await peerToken(session.pid, session.socket);
    const frames = [...(token ? [{ type: 'auth', token }] : []), { type: 'user', message: { role: 'user', content: text } }];
    return new Promise((done, reject) => {
        const connection = createConnection(session.socket, () => {
            connection.end(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''), () => done());
        });
        connection.setTimeout(10_000, () => connection.destroy(new Error('The Claude session did not accept the message in time')));
        connection.on('error', reject);
    });
}

export async function transcriptPath(sessionId: string): Promise<string | undefined> {
    const projects = join(configDir(), 'projects');
    for (const folder of await readdir(projects).catch(() => [])) {
        const path = join(projects, folder, `${sessionId}.jsonl`);
        if (
            await access(path).then(
                () => true,
                () => false,
            )
        )
            return path;
    }
}

export async function conversationExists(sessionId: string): Promise<boolean> {
    return (await transcriptPath(sessionId)) !== undefined;
}

export const desktopInstalled = (): Promise<boolean> => handlesScheme('claude');

function waitForSession(sessionId: string, ready: (session: LiveSession) => boolean, waitMs: number): Promise<LiveSession | undefined> {
    return new Promise((resolve) => {
        const finish = (found?: LiveSession) => {
            clearTimeout(timer);
            stop();
            resolve(found);
        };
        const check = () => void liveSession(sessionId).then((found) => found && ready(found) && finish(found));
        const stop = watchDirectory(sessionsDir(), check, 100);
        const timer = setTimeout(() => finish(), waitMs);
        check();
    });
}

export async function showInDesktop(sessionId: string): Promise<void> {
    await openUrl(`claude://resume?session=${sessionId}`);
}

export async function openInDesktop(sessionId: string, waitMs = 90_000): Promise<LiveSession> {
    const existing = await liveSession(sessionId);
    if (existing) return existing;
    await showInDesktop(sessionId);
    const first = await waitForSession(sessionId, () => true, 15_000);
    if (first) return first;
    await showInDesktop(sessionId);
    const opened = await waitForSession(sessionId, () => true, waitMs);
    if (!opened) throw new Error('Claude Desktop did not open the Coordinator conversation');
    return opened;
}
