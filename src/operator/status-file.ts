import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';

export const statusFile = '.data/status.json';

export async function readStatusFile(): Promise<unknown> {
    return JSON.parse(await readFile(statusFile, 'utf8').catch(() => 'null'));
}

export class StatusWriter {
    private pending = false;
    private last = '';
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly read: () => unknown) {}

    touch(): void {
        if (this.pending) return;
        this.pending = true;
        setImmediate(() => {
            this.pending = false;
            const text = JSON.stringify(this.read());
            if (text === this.last) return;
            this.last = text;
            this.writing = this.writing.then(() => write(text)).catch(() => undefined);
        });
    }

    flushed(): Promise<void> {
        return this.writing;
    }
}

async function write(text: string): Promise<void> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    await writeFile(`${statusFile}.tmp`, text, { mode: 0o600 });
    await replaceFile(`${statusFile}.tmp`, statusFile);
}
