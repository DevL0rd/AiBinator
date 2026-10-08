import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Bridge } from '../core/bridge.js';
import type { BotEvent } from '../core/queue.js';
import {
    conversationExists,
    deliver,
    liveSession,
    openInDesktop,
    showInDesktop,
    transcriptPath,
    sessionsDir,
    type LiveSession,
} from './claude-sessions.js';
import { watchDirectory } from './file-watch.js';
import { claudeProgram } from './executables.js';
import { SessionActivity } from './session-activity.js';
import { ProcessingIndicator } from './processing-indicator.js';
import { marks, type History } from './history.js';
import { requestText } from './request-format.js';
import { conversationName, type Sharing } from './discordinator.js';

const exec = promisify(execFile);
const stateFile = '.data/claude-session.json';
const stateSchema = z.object({
    sessionId: z.uuid(),
    workspace: z.string(),
    seen: z.record(z.string(), z.string()).default({}),
    briefed: z.string().optional(),
});
type SessionState = z.infer<typeof stateSchema>;

function liveMessage(event: BotEvent): string {
    return [
        requestText(event),
        `-> AIBI's voice already told them you are on it, so do not acknowledge. While you work you may send short status updates with aibi_reply (eventId "${event.id}", progress: true); they are logged, not spoken. Finish with exactly one aibi_reply with eventId "${event.id}" and no progress: it is told to them out loud, so keep it short and speakable.`,
    ].join('\n');
}

const nudge = 'Please handle the pending AIBI request above.';
const greeting = (brief: string) =>
    `This is the ${conversationName} conversation. AiBinator will deliver requests spoken to AIBI, the owner's little robot, here for you to answer with the aibi_reply tool (pass the eventId you are given).${brief ? `\n\n${brief}\n\n` : ' '}Reply with: Ready.`;
const rebriefing = (brief: string) =>
    `[Updated AiBinator instructions for requests from AIBI; they replace earlier AiBinator instructions only, and any other standing instructions in this conversation still apply]\n${brief || 'None.'}`;

async function savedState(workspace: string): Promise<SessionState | undefined> {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}')));
    return parsed.success && parsed.data.workspace === workspace ? parsed.data : undefined;
}

async function saveState(state: SessionState): Promise<void> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await replaceFile(`${stateFile}.tmp`, stateFile);
}

export async function openConversation(workspace: string): Promise<string> {
    const sessionId = (await savedState(workspace))?.sessionId;
    if (!sessionId) throw new Error('The Coordinator conversation is created with the first request through AIBI.');
    await showInDesktop(sessionId);
    return 'Opened the Coordinator conversation in Claude Desktop.';
}

export class SessionRouter {
    live?: LiveSession;
    private unwatch?: () => void;
    private sessionId?: string;
    private seen: Record<string, string> = {};
    private briefed?: string;
    private delivered: string[] = [];
    private readonly picked = new Set<string>();
    private readonly activity: SessionActivity;
    private readonly typing: ProcessingIndicator;

    constructor(
        readonly bridge: Bridge,
        readonly workspace: string,
        readonly launch: {
            model?: string;
            effort?: string;
            activity?: boolean;
            history?: History;
            finished?: (eventId: string) => void;
            changed?: () => void;
            brief?: (sessionId?: string) => string;
            shared?: () => Promise<Sharing>;
        } = {},
    ) {
        this.typing = new ProcessingIndicator((eventId) => this.bridge.typing(eventId));
        this.activity = new SessionActivity(
            (eventId, content, idempotencyKey) => this.bridge.respond({ eventId, content, idempotencyKey, status: true }),
            () => this.launch.activity === true,
            { pickedUp: (eventId) => this.picked.add(eventId), replied: (eventId) => this.settle(eventId) },
        );
    }

    async start(): Promise<void> {
        const saved = await savedState(this.workspace);
        this.sessionId = saved?.sessionId;
        this.seen = saved?.seen ?? {};
        this.briefed = saved?.briefed;
        this.unwatch = watchDirectory(sessionsDir(), () => void this.refresh(), 200);
        await this.refresh();
    }

    stop(): void {
        this.unwatch?.();
        this.activity.stop();
        this.typing.stop();
        this.picked.clear();
    }

    async reset(): Promise<void> {
        await rm(stateFile, { force: true });
        this.sessionId = undefined;
        this.seen = {};
        this.briefed = undefined;
        this.live = undefined;
        this.activity.stop();
        this.typing.stop();
        this.picked.clear();
    }

    get conversationId(): string | undefined {
        return this.sessionId;
    }

    status() {
        return {
            live: Boolean(this.live),
            busy: this.live?.status === 'busy',
            entrypoint: this.live?.entrypoint ?? null,
            sessionId: this.sessionId ?? null,
        };
    }

    async route(event: BotEvent): Promise<void> {
        if (this.delivered.includes(event.id)) return;
        this.typing.set(event.id, event.id, true);
        let live: LiveSession;
        try {
            const sessionId = await this.conversation();
            live = (await liveSession(sessionId)) ?? (await openInDesktop(sessionId));
            this.live = live;
            const transcript = await transcriptPath(sessionId);
            if (transcript) await this.activity.follow(transcript, event.id);
            await deliver(live, await this.withBrief(await this.withHistory(event, liveMessage(event))));
        } catch (error) {
            this.settle(event.id);
            throw error;
        }
        this.delivered = [...this.delivered, event.id].slice(-500);
        void this.confirm(live, event.id);
    }

    private async confirm(live: LiveSession, eventId: string): Promise<void> {
        if (await this.activity.pickedUp(eventId, 8000)) return;
        if ((await liveSession(live.sessionId))?.status !== 'idle') return;
        await deliver(live, nudge).catch(() => undefined);
    }

    private settle(eventId: string): void {
        this.picked.delete(eventId);
        this.typing.set(eventId, eventId, false);
        this.launch.finished?.(eventId);
    }

    private async joined(): Promise<string> {
        const sharing = await this.launch.shared!();
        if (sharing.state === 'unavailable') throw new Error(sharing.reason);
        const { sessionId } = sharing.shared;
        if (!(await conversationExists(sessionId)))
            throw new Error('Discordinator’s Coordinator conversation was not found in Claude Code.');
        if (this.sessionId === sessionId) return sessionId;
        Object.assign(this, { sessionId, seen: {}, briefed: undefined });
        await this.save();
        return sessionId;
    }

    private async conversation(): Promise<string> {
        if (this.launch.shared) return this.joined();
        if (this.sessionId && (await conversationExists(this.sessionId))) return this.sessionId;
        const sessionId = randomUUID();
        const options = [
            ...(this.launch.model ? ['--model', this.launch.model] : []),
            ...(this.launch.effort ? ['--effort', this.launch.effort] : []),
        ];
        const claude = await claudeProgram();
        const brief = this.brief(sessionId);
        await exec(
            claude.command,
            [...claude.args, '-p', '--session-id', sessionId, '--name', conversationName, ...options, greeting(brief)],
            {
                cwd: this.workspace,
                timeout: 180_000,
            },
        );
        if (!(await conversationExists(sessionId))) throw new Error('Claude Code did not create the Coordinator conversation');
        await saveState({ sessionId, workspace: this.workspace, seen: {}, briefed: brief });
        this.sessionId = sessionId;
        this.seen = {};
        this.briefed = brief;
        return sessionId;
    }

    private brief(sessionId = this.sessionId): string {
        return this.launch.brief?.(sessionId) ?? this.bridge.policy.ownerNote();
    }

    private async save(): Promise<void> {
        await saveState({ sessionId: this.sessionId!, workspace: this.workspace, seen: this.seen, briefed: this.briefed });
    }

    private async withBrief(message: string): Promise<string> {
        const brief = this.brief();
        if (brief === this.briefed) return message;
        this.briefed = brief;
        await this.save();
        return `${rebriefing(brief)}\n\n${message}`;
    }

    private async withHistory(event: BotEvent, message: string): Promise<string> {
        if (!this.launch.history) return message;
        const result = await this.launch.history(event, this.seen);
        const seen = marks(result);
        if (Object.keys(seen).length) {
            Object.assign(this.seen, seen);
            await this.save();
        }
        return `${result.text}${message}`;
    }

    private async refresh(): Promise<void> {
        const live = this.sessionId ? await liveSession(this.sessionId) : undefined;
        this.live = live;
        this.launch.changed?.();
        if (live && live.status !== 'idle') return;
        for (const eventId of [...this.picked]) this.settle(eventId);
    }
}
