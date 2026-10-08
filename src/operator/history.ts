import type { BotEvent } from '../core/queue.js';
import { describeLine, type Memory } from '../aibi/memory.js';
import type { ControllerStore } from './controller-state.js';

export type History = (
    event: BotEvent,
    seen: Record<string, string>,
) => Promise<{ text: string; key: string; latest?: string; also?: Record<string, string> }>;

export function marks(result: Awaited<ReturnType<History>>): Record<string, string> {
    return { ...(result.latest ? { [result.key]: result.latest } : {}), ...result.also };
}

const key = 'aibi';

export function aibiHistory(memory: Memory, limit: () => number): History {
    return (_event, seen) => {
        const lines = memory.recent(limit(), seen[key]);
        const latest = lines.at(-1)?.at;
        if (!lines.length) return Promise.resolve({ text: '', key });
        const heading = seen[key]
            ? 'Said with AIBI since your last update (background; speech-to-text, may contain errors):'
            : 'Recent conversation with AIBI (background; speech-to-text, may contain errors):';
        const text = [heading, ...lines.map((line) => describeLine(line)), '---', ''].join('\n');
        return Promise.resolve({ text, key, ...(latest ? { latest } : {}) });
    };
}

export async function withHistory(
    store: ControllerStore,
    generation: number,
    key: string,
    event: BotEvent,
    history?: History,
    describe: (event: BotEvent) => string = (event) => event.text,
): Promise<string> {
    const conversation = store.snapshot().conversations.find((item) => item.key === key);
    if (!history || !conversation) return describe(event);
    const result = await history(event, conversation.seen);
    const seen = marks(result);
    if (Object.keys(seen).length)
        await store.update((state) => {
            Object.assign(state.conversations.find((item) => item.key === key)!.seen, seen);
        }, generation);
    return `${result.text}${describe(event)}`;
}
