import type { ControllerStore, ControllerState } from './controller-state.js';
import { splitMessage } from './message-split.js';

export function appendReply(state: ControllerState, eventId: string, content: string, key: string, loose = false): void {
    if (state.outbox.some((item) => item.key.startsWith(`${key}-`))) return;
    const chunks = content.trim() ? splitMessage(content) : ['The provider completed without a text response.'];
    for (const [index, chunk] of chunks.entries())
        state.outbox.push({ key: `${key}-${index}`, eventId, content: chunk, loose, sent: false, attempts: 0, failed: false });
}
const maxAttempts = 5;
const retryDelayMs = 15_000;
export class ControllerOutbox {
    error: string | null = null;
    private flushing = false;
    private retry?: ReturnType<typeof setTimeout>;
    constructor(
        readonly store: ControllerStore,
        readonly deliver: (eventId: string, content: string, key: string, loose: boolean) => Promise<unknown>,
        readonly generation: () => number,
    ) {}
    async queue(eventId: string, content: string, key: string, loose = false): Promise<void> {
        await this.store.update((state) => appendReply(state, eventId, content, key, loose), this.generation());
        await this.flush();
    }
    async flush(): Promise<void> {
        if (this.flushing) return;
        this.flushing = true;
        try {
            const blocked = new Set<string>();
            for (const item of this.store.snapshot().outbox.filter((item) => !item.sent && !item.failed)) {
                if (blocked.has(item.eventId)) continue;
                const delivered = await this.attempt(item);
                if (!delivered) blocked.add(item.eventId);
            }
            this.error = blocked.size ? 'Some replies could not be told to AIBI yet; they will be retried.' : null;
        } finally {
            this.flushing = false;
        }
        if (this.error) this.scheduleRetry();
    }
    private async attempt(item: ControllerState['outbox'][number]): Promise<boolean> {
        let delivered = true;
        try {
            await this.deliver(item.eventId, item.content, item.key, item.loose);
        } catch {
            delivered = false;
        }
        await this.store.update((state) => {
            const record = state.outbox.find((entry) => entry.key === item.key);
            if (!record) return;
            if (delivered) record.sent = true;
            else record.failed = ++record.attempts >= maxAttempts;
        }, this.generation());
        return delivered;
    }
    private scheduleRetry(): void {
        if (this.retry) return;
        this.retry = setTimeout(() => {
            this.retry = undefined;
            void this.flush().catch(() => undefined);
        }, retryDelayMs);
        this.retry.unref();
    }
    stop(): void {
        clearTimeout(this.retry);
        this.retry = undefined;
    }
}
