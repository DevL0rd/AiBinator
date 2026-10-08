type Post = (eventId: string, text: string, key: string) => Promise<unknown>;

const thresholds = [90, 75, 50, 25];

export function contextWarning(percent: number): string {
    return percent >= 90
        ? `⚠️ **Context ${percent}% full.** Run \`/compact\` now, or start fresh with \`/new\`.`
        : `⚠️ **Context ${percent}% full.** Use \`/compact\` when it suits you.`;
}

export function usageWarning(label: string, percent: number, resetsAt?: string): string {
    const resets = resetsAt ? ` Resets <t:${Math.floor(Date.parse(resetsAt) / 1000)}:R>.` : '';
    return `${percent >= 90 ? '⚠️' : 'ℹ️'} **${label} ${percent}% used.**${resets}`;
}

export class ThresholdMeter {
    private readonly percents = new Map<string, number>();
    private readonly warned = new Map<string, number>();

    constructor(readonly post: Post) {}

    percent(key: string): number | undefined {
        return this.percents.get(key);
    }

    record(key: string, percent: number, eventId: string | undefined, text: string): void {
        this.percents.set(key, percent);
        const reached = thresholds.find((threshold) => percent >= threshold) ?? 0;
        const warned = this.warned.get(key) ?? 0;
        if (reached < warned) this.warned.set(key, reached);
        if (!reached || reached <= warned || !eventId) return;
        this.warned.set(key, reached);
        void this.post(eventId, text, `threshold-${key}-${reached}-${Date.now()}`).catch(() => undefined);
    }
}
