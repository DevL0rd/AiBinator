import { randomUUID } from 'node:crypto';

export interface EventInput {
    kind: 'voice' | 'note';
    text: string;
    conversation: string;
}
export interface BotEvent extends EventInput {
    id: string;
    cursor: number;
    receivedAt: string;
}
export interface EventContext {
    event: BotEvent;
    expiresAt: number;
    respond?: (text: string, quiet?: boolean) => Promise<unknown>;
}

export class EventQueue {
    readonly epoch = randomUUID();
    private items: EventContext[] = [];
    private seen = new Map<string, number>();
    private sequence = 0;
    private discardedThrough = 0;
    private droppedOnDedupeLimit = 0;
    private waiters = new Set<() => void>();

    constructor(
        readonly capacity = 500,
        readonly ttlMs = 24 * 60 * 60_000,
        readonly now = Date.now,
    ) {}

    private prune(): void {
        const current = this.now();
        while (this.items[0] && this.items[0].expiresAt <= current) {
            this.discardedThrough = this.items.shift()!.event.cursor;
        }
        for (const [key, expires] of this.seen) if (expires <= current) this.seen.delete(key);
    }

    add(key: string, input: EventInput, respond?: EventContext['respond']): BotEvent | null {
        this.prune();
        if (this.seen.has(key)) return null;
        if (this.seen.size >= this.capacity * 4) {
            this.droppedOnDedupeLimit++;
            this.seen.delete(this.seen.keys().next().value!);
        }
        this.seen.set(key, this.now() + this.ttlMs);
        const event: BotEvent = {
            ...input,
            text: input.text.slice(0, 4000),
            id: randomUUID(),
            cursor: ++this.sequence,
            receivedAt: new Date(this.now()).toISOString(),
        };
        this.items.push({ event, expiresAt: this.now() + this.ttlMs, ...(respond ? { respond } : {}) });
        if (this.items.length > this.capacity) this.discardedThrough = this.items.shift()!.event.cursor;
        for (const wake of this.waiters) wake();
        return event;
    }

    context(id: string): EventContext {
        this.prune();
        const item = this.items.find((entry) => entry.event.id === id);
        if (!item) throw new Error('Request expired, dropped, or unknown');
        return item;
    }

    snapshot(after: number, limit: number) {
        this.prune();
        const events = this.items
            .filter((item) => item.event.cursor > after)
            .slice(0, limit)
            .map((item) => item.event);
        return {
            epoch: this.epoch,
            events,
            latestCursor: this.sequence,
            nextCursor: events.at(-1)?.cursor ?? after,
            gap: after < this.discardedThrough,
            discardedThrough: this.discardedThrough,
            droppedOnDedupeLimit: this.droppedOnDedupeLimit,
        };
    }

    async poll(after: number, limit: number, waitMs: number) {
        if (this.waiters.size >= 8) throw new Error('Too many pending polls');
        if (this.snapshot(after, limit).events.length || waitMs === 0) return this.snapshot(after, limit);
        await new Promise<void>((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve();
            };
            const timer = setTimeout(wake, waitMs);
            this.waiters.add(wake);
        });
        return this.snapshot(after, limit);
    }

    close(): void {
        for (const wake of this.waiters) wake();
    }
}
