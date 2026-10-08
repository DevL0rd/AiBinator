import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { z } from 'zod';

export const presenceFile = '.data/presence.json';
const presenceSchema = z.object({
    startedAt: z.string().optional(),
    remoteAt: z.string().optional(),
    subscriptions: z.number().int().nonnegative().default(0),
});
export type Presence = z.infer<typeof presenceSchema>;

async function readPresence(): Promise<Presence> {
    const parsed = presenceSchema.safeParse(JSON.parse(await readFile(presenceFile, 'utf8').catch(() => '{}')));
    return parsed.success ? parsed.data : { subscriptions: 0 };
}

export class PresenceWriter {
    private value: Presence = { subscriptions: 0 };
    private writing: Promise<void> = Promise.resolve();

    async start(subscriptions: number): Promise<void> {
        const previous = await readPresence();
        this.update({ ...(previous.remoteAt ? { remoteAt: previous.remoteAt } : {}), startedAt: new Date().toISOString(), subscriptions });
        await this.writing;
    }

    update(patch: Partial<Presence>): void {
        const next = { ...this.value, ...patch };
        if (JSON.stringify(next) === JSON.stringify(this.value)) return;
        this.value = next;
        this.writing = this.writing
            .then(async () => {
                await mkdir('.data', { recursive: true, mode: 0o700 });
                await writeFile(`${presenceFile}.tmp`, JSON.stringify(this.value), { mode: 0o600 });
                await replaceFile(`${presenceFile}.tmp`, presenceFile);
            })
            .catch(() => undefined);
    }

    remoteSignedIn(): void {
        if (!this.value.remoteAt) this.update({ remoteAt: new Date().toISOString() });
    }
}
