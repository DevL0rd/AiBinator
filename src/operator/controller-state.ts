import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BotEvent } from '../core/queue.js';

const inputSchema = z.object({
    id: z.string(),
    cursor: z.number(),
    receivedAt: z.string(),
    kind: z.enum(['voice', 'note']),
    text: z.string(),
    conversation: z.string(),
    replyTo: z.string().optional(),
});
const conversationSchema = z.object({
    key: z.string(),
    sessionId: z.string().optional(),
    originEventId: z.string(),
    seen: z.record(z.string(), z.string()).default({}),
    turnId: z.string().optional(),
    state: z.enum(['idle', 'busy', 'approval', 'recovering']),
});
const taskSchema = z.object({
    id: z.string(),
    conversationKey: z.string(),
    originEventId: z.string(),
    title: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    progress: z.string().optional(),
    prompt: z.string(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    state: z.enum(['queued', 'running', 'approval', 'completed', 'failed', 'cancelled', 'recovering']),
    result: z.string().optional(),
});
const outboxSchema = z.object({
    key: z.string(),
    eventId: z.string(),
    content: z.string(),
    loose: z.boolean().default(false),
    sent: z.boolean(),
    attempts: z.number().int().nonnegative().default(0),
    failed: z.boolean().default(false),
});
const stateSchema = z.object({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    inbox: z.array(inputSchema),
    seen: z.array(z.string()),
    conversations: z.array(conversationSchema),
    tasks: z.array(taskSchema),
    outbox: z.array(outboxSchema),
});
export type ControllerState = z.infer<typeof stateSchema>;
export type ControllerTask = z.infer<typeof taskSchema>;

export class ControllerStore {
    private value: ControllerState = { version: 1, generation: 0, inbox: [], seen: [], conversations: [], tasks: [], outbox: [] };
    private serial: Promise<unknown> = Promise.resolve();
    constructor(readonly file = '.data/controller.json') {}
    snapshot(): ControllerState {
        return structuredClone(this.value);
    }
    async load(): Promise<void> {
        try {
            this.value = this.validate(JSON.parse(await readFile(this.file, 'utf8')));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new Error('Cannot load private controller state', { cause: error });
        }
    }
    async acquire(): Promise<number> {
        let generation = 0;
        await this.update((state) => {
            generation = ++state.generation;
            for (const conversation of state.conversations) if (conversation.state !== 'idle') conversation.state = 'recovering';
            for (const task of state.tasks) if (task.state === 'running' || task.state === 'approval') task.state = 'recovering';
        });
        return generation;
    }
    async enqueue(event: BotEvent & { replyTo?: string }): Promise<boolean> {
        let added = false;
        await this.update((state) => {
            if (state.seen.includes(event.id)) return;
            state.inbox.push(event);
            state.seen.push(event.id);
            added = true;
        });
        return added;
    }
    update(action: (state: ControllerState) => void, generation?: number): Promise<void> {
        const next = this.serial.then(async () => {
            if (generation !== undefined && this.value.generation !== generation) throw new Error('Controller lease generation changed');
            const draft = this.snapshot();
            action(draft);
            const parsed = this.validate(prune(draft));
            await this.save(parsed);
            this.value = parsed;
        });
        this.serial = next.catch(() => undefined);
        return next;
    }
    private validate(value: unknown): ControllerState {
        const parsed = stateSchema.parse(value);
        if (parsed.inbox.length > 500 || parsed.seen.length > 25000 || parsed.tasks.length > 4096 || parsed.outbox.length > 25000)
            throw new Error('Controller state capacity reached; reconcile before accepting more work');
        if (Buffer.byteLength(JSON.stringify(parsed)) > 16 * 1024 * 1024) throw new Error('Controller state byte limit reached');
        return parsed;
    }
    private async save(state: ControllerState): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true });
            await replaceFile(temporary, this.file);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
}

const retained = { seen: 5000, outbox: 500, tasks: 500 };
const finishedTask = (task: ControllerTask) => ['completed', 'failed', 'cancelled'].includes(task.state);
function keepRecent<T>(items: T[], done: (item: T) => boolean, limit: number): T[] {
    const finished = items.filter(done);
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - limit)));
    return items.filter((item) => !drop.has(item));
}
function prune(state: ControllerState): ControllerState {
    state.seen = state.seen.slice(-retained.seen);
    state.outbox = keepRecent(state.outbox, (item) => item.sent || item.failed, retained.outbox);
    state.tasks = keepRecent(state.tasks, finishedTask, retained.tasks);
    return state;
}

export const conversationKey = (): string => 'aibinator';

export function controllerStatus<T extends Record<string, unknown>>(state: ControllerState, live: T) {
    return {
        ...live,
        pendingDelivery: state.outbox.filter((item) => !item.sent).length,
        queued: state.inbox.length,
        conversations: state.conversations.length,
        busy: state.conversations.filter((item) => item.state !== 'idle').length,
        tasks: state.tasks.map(({ id, state }) => ({ id, state })),
    };
}
