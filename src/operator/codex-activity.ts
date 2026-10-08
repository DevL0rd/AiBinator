import { activityLine, toolLabel } from './activity-format.js';

type Item = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const clip = (value: string, limit = 120): string => {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const paths = (changes: unknown): string[] =>
    (Array.isArray(changes) ? changes : []).map((change) => text((change as Item | null)?.path)).filter(Boolean);

function fileChange(item: Item): string | undefined {
    const files = paths(item.changes).map((path) => path.split('/').pop()!);
    if (!files.length) return undefined;
    return `Editing ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
}

const actionWords: Record<string, (target: string, query: string) => string> = {
    read: (target) => (target ? `Reading ${target}` : 'Reading a file'),
    search: (_target, query) => (query ? `Searching files for “${query}”` : 'Searching files'),
    listFiles: (target) => (target ? `Listing files in ${target}` : 'Listing files'),
};

function commandAction(actions: unknown): string {
    const action = ((Array.isArray(actions) ? actions[0] : undefined) ?? {}) as Item;
    const target = clip(text(action.name) || text(action.path).split('/').pop() || '', 60);
    return actionWords[text(action.type)]?.(target, clip(text(action.query), 60)) ?? 'Running a command';
}

const describers: Record<string, (item: Item) => string | undefined> = {
    commandExecution: (item) => (text(item.command) ? commandAction(item.commandActions) : undefined),
    fileChange,
    mcpToolCall: (item) => (text(item.server) === 'aibinator' ? undefined : toolLabel(text(item.tool))),
    dynamicToolCall: (item) => (text(item.tool) ? toolLabel(text(item.tool)) : undefined),
    webSearch: (item) => (text(item.query) ? `Searching the web for “${clip(text(item.query), 80)}”` : 'Searching the web'),
    imageGeneration: () => 'Generating an image',
    collabAgentToolCall: () => 'Working with a helper agent',
    contextCompaction: () => 'Compacting the conversation',
};

export function codexActivity(item: Item): string | undefined {
    const described = describers[text(item.type)]?.(item);
    return described === undefined ? described : activityLine(described);
}

const baselineTokens = 12_000;

export function contextPercent(usage: Item): number | undefined {
    const window = Number(usage.modelContextWindow);
    const used = Number((usage.last as Item | undefined)?.totalTokens);
    if (!Number.isFinite(window) || window <= baselineTokens || !Number.isFinite(used)) return undefined;
    const effective = window - baselineTokens;
    const remaining = ((effective - Math.max(0, used - baselineTokens)) / effective) * 100;
    return 100 - Math.round(Math.min(100, Math.max(0, remaining)));
}

const windowLabel = (minutes: number) =>
    minutes <= 300
        ? `${Math.round(minutes / 60)}-hour limit`
        : minutes >= 10_000
          ? 'Weekly limit'
          : `${Math.round(minutes / 1440)}-day limit`;

export function codexUsage(response: Item): { label: string; usedPercent: number; resetsAt?: string }[] {
    const snapshot = (response.rateLimits ?? {}) as Item;
    return [snapshot.primary, snapshot.secondary].flatMap((value) => {
        const window = (value ?? {}) as Item;
        if (typeof window.usedPercent !== 'number') return [];
        const resets = Number(window.resetsAt);
        return [
            {
                label: windowLabel(Number(window.windowDurationMins) || 300),
                usedPercent: Math.round(window.usedPercent),
                ...(resets ? { resetsAt: new Date(resets * 1000).toISOString() } : {}),
            },
        ];
    });
}
