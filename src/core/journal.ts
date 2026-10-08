import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { replaceFile } from './replace-file.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import { canonical } from './canonical.js';
import { sanitizedError, UncertainOutcome } from './errors.js';

const recordSchema = z.object({
    fingerprint: z.string(),
    state: z.enum(['pending', 'done']),
    createdAt: z.number(),
    result: z.unknown().optional(),
});
type RecordEntry = z.infer<typeof recordSchema>;

const day = 24 * 60 * 60_000;

export class Journal {
    private records = Object.create(null) as Record<string, RecordEntry>;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        readonly file: string,
        readonly capacity = 4096,
        readonly now = Date.now,
        readonly retentionMs = day,
    ) {}

    async load(): Promise<void> {
        try {
            this.records = z.record(z.string(), recordSchema).parse(JSON.parse(await readFile(this.file, 'utf8')));
            this.prune();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw sanitizedError('Cannot load idempotency journal');
        }
    }

    private prune(): void {
        const cutoff = this.now() - this.retentionMs;
        for (const [key, record] of Object.entries(this.records)) if (record.createdAt < cutoff) delete this.records[key];
        const done = Object.entries(this.records)
            .filter(([, record]) => record.state === 'done')
            .sort(([, a], [, b]) => a.createdAt - b.createdAt);
        for (const [key] of done.slice(0, Math.max(0, Object.keys(this.records).length - this.capacity + 1))) delete this.records[key];
    }

    private async save(): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(this.records), { mode: 0o600, flag: 'wx', flush: true });
            await replaceFile(temporary, this.file);
        } finally {
            await unlink(temporary).catch(() => {});
        }
    }

    private locked<T>(work: () => Promise<T>): Promise<T> {
        const next = this.chain.then(work);
        this.chain = next.catch(() => undefined);
        return next;
    }

    async execute(key: string, input: unknown, action: () => Promise<unknown>, preflight?: () => void): Promise<unknown> {
        const hashedKey = createHash('sha256').update(key).digest('hex');
        const fingerprint = createHash('sha256').update(canonical(input, true)).digest('hex');
        const claim = await this.locked(() => this.claim(hashedKey, fingerprint, preflight));
        if ('result' in claim) return claim.result;
        let result: unknown;
        try {
            result = await action();
        } catch (error) {
            if (!(error instanceof UncertainOutcome)) await this.locked(() => this.release(hashedKey));
            throw error;
        }
        await this.locked(async () => {
            this.records[hashedKey] = { fingerprint, state: 'done', createdAt: this.now(), result };
            await this.save();
        });
        return result;
    }

    private async claim(hashedKey: string, fingerprint: string, preflight?: () => void): Promise<{ result: unknown } | { claimed: true }> {
        this.prune();
        const previous = this.records[hashedKey];
        if (previous) return { result: this.replay(previous, fingerprint) };
        if (Object.keys(this.records).length >= this.capacity) throw new Error('Idempotency journal is full of unresolved operations');
        preflight?.();
        this.records[hashedKey] = { fingerprint, state: 'pending', createdAt: this.now() };
        await this.save();
        return { claimed: true };
    }

    private async release(hashedKey: string): Promise<void> {
        delete this.records[hashedKey];
        await this.save();
    }

    private replay(record: RecordEntry, fingerprint: string): unknown {
        if (record.fingerprint !== fingerprint) throw new Error('Idempotency key was used for different input');
        if (record.state === 'pending') throw new Error('Outcome uncertain; check what happened before trying again');
        return record.result;
    }
}
