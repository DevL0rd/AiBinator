import { open, stat } from 'node:fs/promises';
import { toolActivity } from './claude-stream.js';
import { watchFile } from './file-watch.js';

type Post = (eventId: string, text: string, key: string) => Promise<unknown>;
type Entry = { type?: string; message?: { content?: unknown } };
type Block = Record<string, unknown>;
export type ActivityHooks = { pickedUp?(eventId: string): void; replied?(eventId: string): void };
const quiet = /aibi_|ToolSearch|TodoWrite/i;
const quoted = /aibi_reply \(eventId "([^"]+)"/g;

function parse(line: string): Entry | undefined {
    try {
        const entry: unknown = JSON.parse(line);
        return entry && typeof entry === 'object' ? entry : undefined;
    } catch {
        return undefined;
    }
}

function blocks(entry: Entry): Block[] {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return [];
    return content.map((block: unknown) => (block && typeof block === 'object' ? (block as Block) : {}));
}

function toolUses(entry: Entry): Block[] {
    if (entry.type !== 'assistant') return [];
    return blocks(entry).filter((block) => block.type === 'tool_use' && typeof block.name === 'string');
}

function steps(entry: Entry): string[] {
    return toolUses(entry)
        .filter((block) => !quiet.test(block.name as string))
        .map((block) => toolActivity(block.name as string, block.input));
}

function replies(entry: Entry): string[] {
    return toolUses(entry).flatMap((block) => {
        const input = block.input && typeof block.input === 'object' ? (block.input as Block) : {};
        const final = /aibi_reply$/.test(block.name as string) && input.progress !== true;
        return final && typeof input.eventId === 'string' ? [input.eventId] : [];
    });
}

function userText(entry: Entry): string {
    if (entry.type !== 'user') return '';
    const content = entry.message?.content;
    if (typeof content === 'string') return content;
    return blocks(entry)
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('\n');
}

export function transcriptSteps(line: string): string[] {
    const entry = parse(line);
    return entry ? steps(entry) : [];
}

export class SessionActivity {
    private path?: string;
    private offset = 0;
    private partial = '';
    private current?: string;
    private sequence = 0;
    private expected = new Set<string>();
    private seen: string[] = [];
    private readonly waiters = new Map<string, (seen: boolean) => void>();
    private reading: Promise<void> = Promise.resolve();
    private unwatch?: () => void;

    constructor(
        readonly post: Post,
        readonly enabled: () => boolean,
        readonly hooks: ActivityHooks = {},
    ) {}

    async follow(path: string, eventId: string): Promise<void> {
        if (this.path !== path) {
            this.stop();
            this.offset = (await stat(path)).size;
            this.path = path;
            this.unwatch = watchFile(path, () => {
                this.reading = this.reading.then(() => this.read(path)).catch(() => undefined);
            });
        }
        this.expected.add(eventId);
    }

    pickedUp(eventId: string, waitMs: number): Promise<boolean> {
        if (this.seen.includes(eventId)) return Promise.resolve(true);
        if (!this.expected.has(eventId)) return Promise.resolve(false);
        return new Promise((resolve) => {
            const timer = setTimeout(() => finish(false), waitMs);
            const finish = (seen: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(eventId);
                resolve(seen);
            };
            this.waiters.set(eventId, finish);
        });
    }

    stop(): void {
        this.unwatch?.();
        this.unwatch = undefined;
        this.path = undefined;
        this.partial = '';
        this.current = undefined;
        this.expected = new Set();
        for (const finish of [...this.waiters.values()]) finish(false);
    }

    private async read(path: string): Promise<void> {
        if (path !== this.path) return;
        const size = (await stat(path)).size;
        if (size <= this.offset) return;
        const handle = await open(path, 'r');
        try {
            const buffer = Buffer.alloc(size - this.offset);
            await handle.read(buffer, 0, buffer.length, this.offset);
            this.offset = size;
            const lines = (this.partial + buffer.toString('utf8')).split('\n');
            this.partial = lines.pop() ?? '';
            for (const entry of lines.map(parse)) if (entry) await this.handle(entry);
        } finally {
            await handle.close();
        }
    }

    private async handle(entry: Entry): Promise<void> {
        const delivered = [...userText(entry).matchAll(quoted)].map((match) => match[1]!).filter((id) => this.expected.has(id));
        const eventId = delivered.at(-1);
        if (eventId) this.deliveredEntry(eventId);
        for (const id of replies(entry)) this.hooks.replied?.(id);
        for (const step of steps(entry)) await this.publish(step);
    }

    private deliveredEntry(eventId: string): void {
        this.current = eventId;
        this.expected.delete(eventId);
        this.seen = [...this.seen, eventId].slice(-100);
        this.waiters.get(eventId)?.(true);
        this.hooks.pickedUp?.(eventId);
    }

    private async publish(step: string): Promise<void> {
        if (!this.current || !this.enabled()) return;
        await this.post(this.current, step, `session-activity-${this.current}-${this.offset}-${++this.sequence}`).catch(() => undefined);
    }
}
