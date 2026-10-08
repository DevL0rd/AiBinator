import { activityLine, toolLabel } from './activity-format.js';
import type { ClaudeMessage, ClaudeUserMessage } from './claude-protocol.js';

export class MessageQueue implements AsyncIterable<ClaudeUserMessage> {
    private readonly values: ClaudeUserMessage[] = [];
    private readonly waiters: Array<(value: IteratorResult<ClaudeUserMessage>) => void> = [];
    private ended = false;

    push(value: ClaudeUserMessage): void {
        if (this.ended) throw new Error('Claude session is closed');
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value, done: false });
        else this.values.push(value);
    }

    close(): void {
        this.ended = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
        return {
            next: async () => {
                const value = this.values.shift();
                if (value) return { value, done: false };
                if (this.ended) return { value: undefined, done: true };
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}

type Value = (key: string) => string;
const fileName = (value: Value, ...keys: string[]) => (keys.map(value).find(Boolean) ?? '').split('/').pop() ?? '';
const helper = (value: Value) => value('description') || 'Starting a helper agent';
const edit = (value: Value) => `Editing ${fileName(value, 'file_path', 'notebook_path')}`;

const friendly: Record<string, (value: Value) => string> = {
    Bash: (value) => value('description') || 'Running a command',
    Edit: edit,
    Write: edit,
    NotebookEdit: edit,
    Read: (value) => `Reading ${fileName(value, 'file_path')}`,
    WebSearch: (value) => `Searching the web for “${value('query')}”`,
    Grep: (value) => (value('pattern') ? `Searching files for “${value('pattern').slice(0, 60)}”` : 'Searching files'),
    Glob: () => 'Finding files',
    WebFetch: () => 'Reading a web page',
    Agent: helper,
    Task: helper,
    Monitor: () => 'Watching for a result',
    Skill: () => 'Loading a skill',
};

export function toolActivity(name: string, input: unknown): string {
    const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const value: Value = (key) => (typeof fields[key] === 'string' ? fields[key] : '');
    return activityLine(friendly[name]?.(value) ?? toolLabel(name));
}

export function progressText(message: ClaudeMessage): Array<{ text: string; activity: boolean }> {
    if (message.type !== 'assistant') return [];
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    return content.flatMap((block): Array<{ text: string; activity: boolean }> => {
        const item = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
        if (item.type === 'text' && typeof item.text === 'string') return [{ text: item.text, activity: false }];
        if (item.type === 'tool_use' && typeof item.name === 'string')
            return [{ text: toolActivity(item.name, item.input), activity: true }];
        return [];
    });
}

type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
export type ContextUsage = { tokens: number; model?: string };

export function mainUsage(entry: { type?: string; message?: unknown; parent_tool_use_id?: unknown }): ContextUsage | undefined {
    if (entry.type !== 'assistant' || entry.parent_tool_use_id) return undefined;
    const message = entry.message as { usage?: Usage; model?: unknown } | undefined;
    const usage = message?.usage;
    if (!usage) return undefined;
    const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return { tokens, ...(typeof message.model === 'string' ? { model: message.model } : {}) };
}

export function contextWindow(result: Record<string, unknown>, model?: string): number | undefined {
    if (!model) return undefined;
    const models = Object.entries((result.modelUsage ?? {}) as Record<string, { contextWindow?: number; canonicalModel?: string }>);
    const match = models.find(
        ([key, usage]) => key === model || key.replace(/\[[^\]]*\]$/, '') === model || usage.canonicalModel === model,
    );
    const window = match?.[1].contextWindow;
    return window && window > 0 ? window : undefined;
}
