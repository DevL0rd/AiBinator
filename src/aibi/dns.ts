import dgram from 'node:dgram';
import net from 'node:net';
import { aibiHost } from './network.js';

const ttlSeconds = 30;

export interface DnsOptions {
    address: string;
    port: number;
    upstream: string;
}

export interface DnsEvents {
    answered(remote: string): void;
    warning(title: string, detail: string): void;
}

type Question = { id: number; flags: number; name: string; type: number; classCode: number; end: number };

export function question(message: Buffer): Question | undefined {
    if (message.length < 17 || message.readUInt16BE(4) < 1) return undefined;
    let offset = 12;
    const labels: string[] = [];
    while (offset < message.length) {
        const length = message[offset]!;
        if ((length & 0xc0) !== 0) return undefined;
        offset += 1;
        if (length === 0) break;
        if (offset + length > message.length) return undefined;
        labels.push(message.subarray(offset, offset + length).toString('ascii'));
        offset += length;
    }
    if (offset + 4 > message.length || !labels.length) return undefined;
    return {
        id: message.readUInt16BE(0),
        flags: message.readUInt16BE(2),
        name: labels.join('.').replace(/\.$/, '').toLowerCase(),
        type: message.readUInt16BE(offset),
        classCode: message.readUInt16BE(offset + 2),
        end: offset + 4,
    };
}

const ours = (name?: string) => Boolean(name && (name === aibiHost || name.endsWith(`.${aibiHost}`)));

export function localAnswer(query: Buffer, address: string): Buffer | undefined {
    const asked = question(query);
    if (!asked || !ours(asked.name)) return undefined;
    const count = asked.type === 1 && asked.classCode === 1 ? 1 : 0;
    const header = Buffer.alloc(12);
    header.writeUInt16BE(asked.id, 0);
    header.writeUInt16BE(0x8000 | (asked.flags & 0x0100) | 0x0400 | 0x0080, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(count, 6);
    const asks = query.subarray(12, asked.end);
    if (!count) return Buffer.concat([header, asks]);
    const answer = Buffer.alloc(16);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(ttlSeconds, 6);
    answer.writeUInt16BE(4, 10);
    address.split('.').forEach((part, index) => (answer[12 + index] = Number(part)));
    return Buffer.concat([header, asks, answer]);
}

function failure(query: Buffer): Buffer | undefined {
    if (query.length < 12) return undefined;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8000 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | 2, 2);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    return Buffer.concat([header, query.subarray(12)]);
}

function forward(message: Buffer, upstream: string): Promise<Buffer> {
    const [host = '1.1.1.1', port = '53'] = upstream.split(':');
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(`DNS upstream ${upstream} timed out`));
        }, 2500);
        socket.once('message', (response) => {
            clearTimeout(timer);
            socket.close();
            resolve(response);
        });
        socket.once('error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(error);
        });
        socket.send(message, Number(port), host);
    });
}

export class DnsServer {
    private udp?: dgram.Socket;
    private tcp?: net.Server;
    private readonly lastAnswer = new Map<string, number>();

    constructor(
        private readonly options: DnsOptions,
        private readonly events: DnsEvents,
    ) {}

    async start(): Promise<void> {
        const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        udp.on(
            'message',
            (message, remote) =>
                void this.reply(message, remote.address).then((answer) => answer && udp.send(answer, remote.port, remote.address)),
        );
        udp.on('error', (error) => this.events.warning('DNS server error', error.message));
        await new Promise<void>((resolve, reject) => {
            udp.once('error', reject);
            udp.bind(this.options.port, this.options.address, () => {
                udp.off('error', reject);
                resolve();
            });
        });
        this.udp = udp;
        const tcp = net.createServer((socket) => this.stream(socket));
        tcp.on('error', (error) => this.events.warning('DNS TCP server error', error.message));
        await new Promise<void>((resolve) =>
            tcp.listen(this.options.port, this.options.address, () => resolve()).once('error', () => resolve()),
        );
        if (tcp.listening) this.tcp = tcp;
    }

    async stop(): Promise<void> {
        await Promise.all([
            new Promise<void>((resolve) => (this.udp ? this.udp.close(() => resolve()) : resolve())),
            new Promise<void>((resolve) => (this.tcp ? this.tcp.close(() => resolve()) : resolve())),
        ]);
        this.udp = undefined;
        this.tcp = undefined;
    }

    private async reply(message: Buffer, remote: string): Promise<Buffer | undefined> {
        try {
            const local = localAnswer(message, this.options.address);
            if (!local) return await forward(message, this.options.upstream);
            this.noteAnswer(remote);
            return local;
        } catch (error) {
            this.events.warning('DNS query failed', error instanceof Error ? error.message : 'unknown error');
            return failure(message);
        }
    }

    private noteAnswer(remote: string): void {
        const now = Date.now();
        if (now - (this.lastAnswer.get(remote) ?? 0) < 15_000) return;
        this.lastAnswer.set(remote, now);
        this.events.answered(remote);
    }

    private stream(socket: net.Socket): void {
        let buffer = Buffer.alloc(0);
        socket.on('error', () => socket.destroy());
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2) {
                const message = buffer.subarray(2, buffer.readUInt16BE(0) + 2);
                buffer = buffer.subarray(message.length + 2);
                void this.reply(message, socket.remoteAddress ?? '').then((answer) => {
                    if (!answer || socket.destroyed) return;
                    const prefix = Buffer.alloc(2);
                    prefix.writeUInt16BE(answer.length, 0);
                    socket.write(Buffer.concat([prefix, answer]));
                });
            }
        });
    }
}
