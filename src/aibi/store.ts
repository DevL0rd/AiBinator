import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { replaceFile } from '../core/replace-file.js';

export class JsonFile<T> {
    private writing: Promise<void> = Promise.resolve();
    private queued = false;

    constructor(
        readonly path: string,
        private readonly snapshot: () => T,
    ) {}

    async read(): Promise<unknown> {
        try {
            return JSON.parse(await readFile(this.path, 'utf8')) as unknown;
        } catch {
            return undefined;
        }
    }

    save(): void {
        if (this.queued) return;
        this.queued = true;
        this.writing = this.writing
            .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
            .then(async () => {
                this.queued = false;
                await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
                await writeFile(`${this.path}.tmp`, JSON.stringify(this.snapshot()), { mode: 0o600 });
                await replaceFile(`${this.path}.tmp`, this.path);
            })
            .catch(() => {
                this.queued = false;
            });
    }

    flushed(): Promise<void> {
        return this.writing;
    }
}
