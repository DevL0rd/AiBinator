import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export interface Head {
    startLine: string;
    headers: Record<string, string>;
}

export interface Reader {
    head(head: Head): void;
    body(chunk: Buffer): void;
    end(): void;
}

export interface Message extends Head {
    body: Buffer;
}

type Framing =
    { mode: 'none' } | { mode: 'length'; left: number } | { mode: 'chunked'; left: number; step: 'size' | 'data' | 'crlf' | 'trailer' };

const crlf = Buffer.from('\r\n');
const limit = 64 * 1024;

export function parseHead(text: string): Head {
    const [startLine = '', ...lines] = text.split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return { startLine, headers };
}

export function requestLine(startLine: string): { method: string; target: string; path: string; query: URLSearchParams } {
    const [method = '', target = ''] = startLine.split(' ');
    const url = new URL(`http://local${target.startsWith('/') ? target : `/${target}`}`);
    return { method, target, path: url.pathname, query: url.searchParams };
}

function untilClose(head: Head): boolean {
    const status = Number(head.startLine.split(' ')[1]);
    return !head.headers['content-length'] && status >= 200 && status !== 204 && status !== 304;
}

function framing(head: Head, response: boolean): Framing {
    if (/\bchunked\b/i.test(head.headers['transfer-encoding'] ?? '')) return { mode: 'chunked', left: 0, step: 'size' };
    const length = Number(head.headers['content-length'] ?? '');
    if (Number.isSafeInteger(length) && length > 0) return { mode: 'length', left: length };
    return response && untilClose(head) ? { mode: 'length', left: Infinity } : { mode: 'none' };
}

export class HttpReader {
    private buffer: Buffer = Buffer.alloc(0);
    private frame?: Framing;

    constructor(
        private readonly reader: Reader,
        private readonly response = false,
    ) {}

    push(chunk: Buffer): void {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length && this.step());
        if (!this.frame && this.buffer.length > limit) throw new Error('HTTP header too large');
    }

    close(): void {
        if (this.frame?.mode === 'length' && this.frame.left === Infinity) this.finish();
    }

    private step(): boolean {
        if (!this.frame) return this.readHead();
        if (this.frame.mode === 'length') return this.readLength(this.frame);
        if (this.frame.mode === 'chunked') return this.readChunked(this.frame);
        return false;
    }

    private readHead(): boolean {
        while (this.buffer.subarray(0, 2).equals(crlf)) this.buffer = this.buffer.subarray(2);
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end === -1) return false;
        const head = parseHead(this.buffer.subarray(0, end).toString('latin1'));
        this.buffer = this.buffer.subarray(end + 4);
        this.frame = framing(head, this.response);
        this.reader.head(head);
        if (this.frame.mode === 'none') this.finish();
        return true;
    }

    private consume(frame: { left: number }): boolean {
        const take = Math.min(frame.left, this.buffer.length);
        if (!take) return false;
        this.reader.body(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        frame.left -= take;
        return true;
    }

    private readLength(frame: { left: number }): boolean {
        const consumed = this.consume(frame);
        if (frame.left === 0) this.finish();
        return consumed;
    }

    private readChunked(frame: Extract<Framing, { mode: 'chunked' }>): boolean {
        if (frame.step === 'data') return this.readChunkData(frame);
        const end = this.buffer.indexOf('\r\n');
        if (end === -1) return false;
        const line = this.buffer.subarray(0, end).toString('latin1');
        this.buffer = this.buffer.subarray(end + 2);
        if (frame.step === 'crlf') {
            frame.step = 'size';
            return true;
        }
        if (frame.step === 'trailer') {
            if (!line) this.finish();
            return true;
        }
        const size = Number.parseInt(line.split(';')[0]!.trim(), 16);
        if (!Number.isFinite(size)) throw new Error('Invalid chunk size');
        frame.left = size;
        frame.step = size === 0 ? 'trailer' : 'data';
        return true;
    }

    private readChunkData(frame: Extract<Framing, { mode: 'chunked' }>): boolean {
        const consumed = this.consume(frame);
        if (frame.left === 0) frame.step = 'crlf';
        return consumed;
    }

    private finish(): void {
        this.frame = undefined;
        this.reader.end();
    }
}

export function collector(onMessage: (message: Message) => void): Reader {
    let head: Head | undefined;
    let parts: Buffer[] = [];
    return {
        head: (next) => {
            head = next;
            parts = [];
        },
        body: (chunk) => parts.push(Buffer.from(chunk)),
        end: () => {
            if (head) onMessage({ ...head, body: Buffer.concat(parts) });
            head = undefined;
        },
    };
}

function encodeHead(startLine: string, headers: Record<string, string>): Buffer {
    return Buffer.from(
        `${[startLine, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)].join('\r\n')}\r\n\r\n`,
        'latin1',
    );
}

export function rebuild(message: Message): Buffer {
    const headers = { ...message.headers };
    delete headers['transfer-encoding'];
    if (message.body.length || 'content-length' in headers) headers['content-length'] = String(message.body.length);
    return Buffer.concat([encodeHead(message.startLine, headers), message.body]);
}

export function decodedBody(message: Message): Buffer {
    const encoding = (message.headers['content-encoding'] ?? '').toLowerCase();
    if (encoding.includes('gzip')) return gunzipSync(message.body);
    if (encoding.includes('deflate')) return inflateSync(message.body);
    if (encoding.includes('br')) return brotliDecompressSync(message.body);
    return message.body;
}
