import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { Mp3Stream, silence } from './audio.js';

const lifetimeMs = 120_000;
const host = 'http://api.aibipocket.com';
const rate = 24_000;
const leadMs = 1500;
const marginMs = 250;
const fillEveryMs = 100;

const bytesPerMs = 8;

export class SpeechStream {
    readonly id = `local-${randomUUID()}.mp3`;
    private readonly chunks: Buffer[] = [];
    private readonly encoder = new Mp3Stream();
    private state: 'open' | 'ended' | 'failed' = 'open';
    private samples = 0;
    private filler?: NodeJS.Timeout;

    constructor(readonly kind: 'tts' | 'poweron' = 'tts') {}

    get url(): string {
        return `${host}/${this.kind}/dl/${this.id}`;
    }

    get open(): boolean {
        return this.state === 'open';
    }

    write(pcm: Int16Array): void {
        if (this.state !== 'open') return;
        this.samples += pcm.length;
        this.push(this.encoder.encode(pcm));
    }

    writeMp3(data: Buffer): void {
        if (this.state === 'open') this.push(data);
    }

    end(): void {
        if (this.state !== 'open') return;
        this.push(this.encoder.finish());
        this.close('ended');
    }

    fail(): void {
        if (this.state === 'open') this.close('failed');
    }

    private push(data: Buffer): void {
        if (data.length) this.chunks.push(data);
    }

    private close(state: 'ended' | 'failed'): void {
        clearInterval(this.filler);
        this.state = state;
    }

    private keepAhead(started: number): void {
        this.filler = setInterval(() => {
            const missing = Math.floor(((Date.now() - started + marginMs) / 1000) * rate - this.samples);
            if (missing > 0) this.write(new Int16Array(missing));
        }, fillEveryMs);
        this.filler.unref();
    }

    serve(socket: Socket): void {
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n');
        const started = Date.now();
        let sent = 0;
        const pump = () => {
            if (socket.destroyed || this.state === 'failed') return stop(() => socket.destroy());
            const audio = Buffer.concat(this.chunks);
            const due = Math.min(audio.length, Math.floor((Date.now() - started + leadMs) * bytesPerMs));
            if (due > sent) socket.write(audio.subarray(sent, due));
            sent = Math.max(sent, due);
            if (this.state === 'ended' && sent >= audio.length) stop(() => socket.end());
        };
        const timer = setInterval(pump, fillEveryMs);
        const stop = (finish: () => void) => {
            clearInterval(timer);
            finish();
        };
        socket.once('close', () => clearInterval(timer));
        if (this.state === 'open' && !this.filler) this.keepAhead(started);
        pump();
    }
}

export class Speeches {
    private readonly streams = new Map<string, { stream: SpeechStream; expires: number }>();
    private quiet?: Buffer;

    create(kind: 'tts' | 'poweron' = 'tts'): SpeechStream {
        this.prune();
        const stream = new SpeechStream(kind);
        this.streams.set(stream.id, { stream, expires: Date.now() + lifetimeMs });
        return stream;
    }

    pause(): SpeechStream {
        this.quiet ??= silence(250);
        const stream = this.create();
        stream.writeMp3(this.quiet);
        stream.end();
        return stream;
    }

    find(id: string): SpeechStream | undefined {
        this.prune();
        return this.streams.get(id)?.stream;
    }

    clear(): void {
        for (const { stream } of this.streams.values()) stream.fail();
        this.streams.clear();
    }

    private prune(): void {
        const now = Date.now();
        for (const [id, entry] of this.streams) {
            if (entry.expires > now || entry.stream.open) continue;
            entry.stream.fail();
            this.streams.delete(id);
        }
    }
}
