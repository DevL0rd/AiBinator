import { readFile } from 'node:fs/promises';
import { policySchema } from '../core/config.js';
import type { Policy } from '../core/policy.js';
import { watchFile } from './file-watch.js';

export class PolicyWatcher {
    private unwatch?: () => void;
    private work: Promise<void> = Promise.resolve();
    constructor(
        public path: string,
        readonly policy: Policy,
    ) {}
    start(): void {
        this.unwatch = watchFile(this.path, () => {
            this.work = this.work.then(() =>
                this.reload().catch(() => {
                    console.error('Policy reload failed; the previous policy stays in effect');
                }),
            );
        });
    }
    async move(path: string): Promise<void> {
        await this.stop();
        this.path = path;
        await this.reload();
        this.start();
    }

    async stop(): Promise<void> {
        this.unwatch?.();
        await this.work;
    }
    private async reload(): Promise<void> {
        const next = policySchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
        this.policy.update(next);
        console.error('Policy reloaded');
    }
}
