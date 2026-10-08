export class RequestBudget {
    active = 0;
    private times: number[] = [];
    constructor(
        readonly perMinute: number,
        readonly message: string,
    ) {}

    spend(): boolean {
        const now = Date.now();
        this.times = this.times.filter((time) => time > now - 60_000);
        if (this.active >= 16 || this.times.length >= this.perMinute) return false;
        this.times.push(now);
        return true;
    }
}
