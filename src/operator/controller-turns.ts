import type { OperatorConfig } from './config.js';
import type { ProviderAdapter, ProviderEvent } from './provider-adapter.js';

export type StopReason = 'stop' | 'timeout' | 'cancel';
type Finished = Extract<ProviderEvent, { type: 'final' | 'turn.failed' }>;
type Timer = ReturnType<typeof setTimeout>;

export function shortReason(reason: unknown): string {
    const text = reason instanceof Error ? reason.message : String(reason);
    const clean = text
        .replaceAll('`', "'")
        .replace(/\/(?:home|Users)\/[^/\s]+/g, '~')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.slice(0, 200) || 'unknown error';
}

export class TurnClock {
    private readonly timeouts = new Map<string, Timer>();
    private readonly idle = new Map<string, Timer>();
    private readonly reasons = new Map<string, StopReason>();
    private readonly finals = new Map<string, Finished[]>();

    constructor(
        readonly adapter: ProviderAdapter,
        readonly config: OperatorConfig,
        readonly failed: () => void,
        readonly idleMs: number,
    ) {}

    async interrupt(sessionId: string, turnId: string, reason: StopReason): Promise<void> {
        this.expect(sessionId, turnId, reason);
        await this.adapter.interrupt(sessionId, turnId);
    }

    expect(sessionId: string, turnId: string, reason: StopReason): void {
        this.reasons.set(`${sessionId}:${turnId}`, reason);
    }

    arm(sessionId: string, turnId: string): void {
        const seconds = this.config.timeoutSeconds;
        const key = `${sessionId}:${turnId}`;
        if (!seconds || this.timeouts.has(key)) return;
        const timer = setTimeout(() => {
            this.timeouts.delete(key);
            void this.interrupt(sessionId, turnId, 'timeout').catch(() => this.failed());
        }, seconds * 1000);
        this.timeouts.set(key, timer);
    }

    outcome(event: Finished): string {
        const reason = this.reasons.get(`${event.sessionId}:${event.turnId}`);
        if (event.type === 'final' && (event.text.trim() || !reason)) return event.text;
        if (reason === 'stop') return 'Stopped.';
        if (reason === 'timeout') return `Timed out after ${this.config.timeoutSeconds}s.`;
        if (reason === 'cancel') return 'Cancelled.';
        return `The provider stopped with an error (${shortReason(event.type === 'turn.failed' ? event.reason : 'no reply')}). I have not retried the action.`;
    }

    release(sessionId: string, turnId: string): void {
        const key = `${sessionId}:${turnId}`;
        clearTimeout(this.timeouts.get(key));
        this.timeouts.delete(key);
        this.reasons.delete(key);
    }

    defer(event: Finished, state: string): void {
        if (state === 'idle') return;
        const pending = this.finals.get(event.sessionId) ?? [];
        if (pending.length < 32) pending.push(event);
        this.finals.set(event.sessionId, pending);
    }

    deferred(sessionId: string, turnId: string): Finished[] {
        const pending = this.finals.get(sessionId) ?? [];
        this.finals.delete(sessionId);
        return pending.filter((item) => item.turnId === turnId);
    }

    rest(sessionId: string, close: () => void): void {
        if (!this.adapter.closeSession) return;
        this.wake(sessionId);
        const timer = setTimeout(() => {
            this.idle.delete(sessionId);
            close();
        }, this.idleMs);
        timer.unref();
        this.idle.set(sessionId, timer);
    }

    wake(sessionId: string): void {
        clearTimeout(this.idle.get(sessionId));
        this.idle.delete(sessionId);
    }

    clear(): void {
        for (const timer of [...this.timeouts.values(), ...this.idle.values()]) clearTimeout(timer);
        this.timeouts.clear();
        this.idle.clear();
        this.reasons.clear();
        this.finals.clear();
    }
}
