import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHead, type Head } from './http.js';

const textual = /json|text|xml|javascript|urlencoded/i;

export interface Captured {
    scheme: string;
    remote: string;
    started: Date;
    request: Head & { body: Buffer };
    response: Buffer | 'served';
}

function split(raw: Buffer): Head & { body: Buffer } {
    const end = raw.indexOf('\r\n\r\n');
    if (end === -1) return { startLine: raw.toString('latin1'), headers: {}, body: Buffer.alloc(0) };
    return { ...parseHead(raw.subarray(0, end).toString('latin1')), body: raw.subarray(end + 4) };
}

export class TrafficCapture {
    private sequence = 0;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly enabled: () => boolean,
        readonly directory = '.data/aibi/traffic',
        private readonly limit = 1000,
    ) {}

    get on(): boolean {
        return this.enabled();
    }

    record(entry: Captured): void {
        if (!this.enabled()) return;
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(++this.sequence).padStart(6, '0')}`;
        this.writing = this.writing.then(() => this.write(name, entry)).catch(() => undefined);
    }

    flushed(): Promise<void> {
        return this.writing;
    }

    private async write(name: string, entry: Captured): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const request = await this.part(name, 'request', entry.request);
        const response = entry.response === 'served' ? 'live speech stream' : await this.part(name, 'response', split(entry.response));
        const record = {
            started: entry.started.toISOString(),
            at: new Date().toISOString(),
            scheme: entry.scheme,
            remote: entry.remote,
            request,
            response,
        };
        await writeFile(join(this.directory, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await this.prune();
    }

    private async part(name: string, side: string, message: Head & { body: Buffer }) {
        const type = message.headers['content-type'] ?? '';
        const base = { startLine: message.startLine, headers: message.headers, bytes: message.body.length };
        if (!message.body.length) return base;
        if (textual.test(type) && !message.headers['content-encoding']) return { ...base, body: message.body.toString('utf8') };
        const file = `${name}.${side}.bin`;
        await writeFile(join(this.directory, file), message.body, { mode: 0o600 });
        return { ...base, bodyFile: file };
    }

    private async prune(): Promise<void> {
        const records = (await readdir(this.directory)).filter((file) => file.endsWith('.json')).sort();
        for (const old of records.slice(0, Math.max(0, records.length - this.limit))) {
            const stem = old.slice(0, -'.json'.length);
            await Promise.all(
                [old, `${stem}.request.bin`, `${stem}.response.bin`].map((file) => rm(join(this.directory, file), { force: true })),
            );
        }
    }
}
