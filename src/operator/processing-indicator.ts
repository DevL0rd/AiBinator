export class ProcessingIndicator {
    private active = new Map<string, string>();
    private timer?: ReturnType<typeof setInterval>;
    constructor(readonly typing: (eventId: string) => Promise<void>) {}
    set(sessionId: string, eventId: string, processing: boolean): void {
        if (processing) this.active.set(sessionId, eventId);
        else this.active.delete(sessionId);
        if (!this.active.size) {
            clearInterval(this.timer);
            this.timer = undefined;
            return;
        }
        if (!this.timer) {
            this.timer = setInterval(() => void this.pulse(), 8000);
            this.timer.unref();
        }
        if (processing) void this.pulse();
    }
    async pulse(): Promise<void> {
        for (const [sessionId, eventId] of this.active) {
            try {
                await this.typing(eventId);
            } catch {
                this.active.delete(sessionId);
            }
        }
        if (!this.active.size) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    stop(): void {
        this.active.clear();
        clearInterval(this.timer);
        this.timer = undefined;
    }
}
