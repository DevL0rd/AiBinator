import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { collector, HttpReader, rebuild, requestLine, type Head, type Message } from './http.js';
import { aibiHost } from './network.js';

type Scheme = 'http' | 'https';

export interface Incoming {
    head: Head;
    method: string;
    path: string;
    query: URLSearchParams;
    scheme: Scheme;
    remote: string;
    chunks(): AsyncIterable<Buffer>;
}

export interface Exchange {
    message: Message;
    method: string;
    path: string;
    query: URLSearchParams;
    scheme: Scheme;
    remote: string;
    forward(replacement?: Message): Promise<Message>;
}

export interface Routes {
    streams(method: string, path: string): boolean;
    stream(request: Incoming): Promise<Buffer>;
    handle(exchange: Exchange, socket: net.Socket): Promise<Buffer | 'served'>;
    failed(detail: string): void;
}

class Body {
    private readonly parts: Buffer[] = [];
    private ended = false;
    private wake?: () => void;

    push(chunk: Buffer): void {
        this.parts.push(Buffer.from(chunk));
        this.wake?.();
    }

    end(): void {
        this.ended = true;
        this.wake?.();
    }

    async *read(): AsyncIterable<Buffer> {
        for (;;) {
            const next = this.parts.shift();
            if (next) yield next;
            else if (this.ended) return;
            else await new Promise<void>((resolve) => (this.wake = resolve));
        }
    }
}

export interface Cloud {
    address(): Promise<string>;
    httpPort: number;
    httpsPort: number;
    ca?: string;
}

export function cloud(dnsServer: string): Cloud {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([dnsServer]);
    return {
        address: async () => {
            const [found] = await resolver.resolve4(aibiHost);
            if (!found) throw new Error(`${dnsServer} did not return an address for ${aibiHost}`);
            return found;
        },
        httpPort: 80,
        httpsPort: 443,
    };
}

class Upstream {
    private socket?: Promise<net.Socket>;
    private reader?: HttpReader;
    private waiting: ((message: Message) => void)[] = [];
    private failing: ((error: Error) => void)[] = [];

    constructor(
        private readonly scheme: Scheme,
        private readonly target: Cloud,
    ) {}

    async send(message: Message): Promise<Message> {
        const socket = await this.connect();
        return new Promise((resolve, reject) => {
            this.waiting.push(resolve);
            this.failing.push(reject);
            socket.write(rebuild(message));
        });
    }

    close(): void {
        void this.socket?.then(
            (socket) => socket.destroy(),
            () => undefined,
        );
    }

    private connect(): Promise<net.Socket> {
        this.socket ??= this.open().catch((error: unknown) => {
            this.socket = undefined;
            throw error;
        });
        return this.socket;
    }

    private async open(): Promise<net.Socket> {
        const host = await this.target.address();
        this.reader = new HttpReader(
            collector((message) => {
                this.failing.shift();
                this.waiting.shift()?.(message);
            }),
            true,
        );
        const socket =
            this.scheme === 'https'
                ? tls.connect({
                      host,
                      port: this.target.httpsPort,
                      servername: aibiHost,
                      minVersion: 'TLSv1.2',
                      ...(this.target.ca ? { ca: this.target.ca } : {}),
                  })
                : net.connect({ host, port: this.target.httpPort });
        socket.on('data', (chunk: Buffer) => this.reader?.push(chunk));
        socket.on('end', () => this.reader?.close());
        socket.on('error', (error: Error) => this.fail(error));
        socket.on('close', () => {
            this.socket = undefined;
            this.fail(new Error('The AIBI cloud closed the connection'));
        });
        return socket;
    }

    private fail(error: Error): void {
        this.waiting = [];
        for (const reject of this.failing.splice(0)) reject(error);
    }
}

class Connection {
    private work: Promise<void> = Promise.resolve();
    private readonly upstream: Upstream;
    private readonly remote: string;
    private body?: Body;
    private collect?: ReturnType<typeof collector>;

    constructor(
        private readonly socket: net.Socket,
        private readonly scheme: Scheme,
        private readonly routes: Routes,
        target: Cloud,
    ) {
        this.upstream = new Upstream(scheme, target);
        this.remote = socket.remoteAddress ?? '';
        const reader = new HttpReader({ head: (head) => this.head(head), body: (chunk) => this.chunk(chunk), end: () => this.end() });
        socket.on('data', (chunk) => this.safely(() => reader.push(chunk)));
        socket.on('error', () => socket.destroy());
        socket.on('close', () => this.upstream.close());
    }

    private safely(action: () => void): void {
        try {
            action();
        } catch (error) {
            this.routes.failed(error instanceof Error ? error.message : 'Unreadable request');
            this.socket.destroy();
        }
    }

    private head(head: Head): void {
        const { method, path, query } = requestLine(head.startLine);
        if (this.routes.streams(method, path)) {
            const body = (this.body = new Body());
            const request = { head, method, path, query, scheme: this.scheme, remote: this.remote, chunks: () => body.read() };
            this.queue(() => this.routes.stream(request));
            return;
        }
        this.collect = collector((message) => this.queue((socket) => this.routes.handle(this.exchange(message), socket)));
        this.collect.head(head);
    }

    private chunk(chunk: Buffer): void {
        if (this.body) this.body.push(chunk);
        else this.collect?.body(chunk);
    }

    private end(): void {
        this.body?.end();
        this.body = undefined;
        this.collect?.end();
        this.collect = undefined;
    }

    private exchange(message: Message): Exchange {
        const { method, path, query } = requestLine(message.startLine);
        return {
            message,
            method,
            path,
            query,
            scheme: this.scheme,
            remote: this.remote,
            forward: (replacement) => this.upstream.send(replacement ?? message),
        };
    }

    private queue(task: (socket: net.Socket) => Promise<Buffer | 'served'>): void {
        const pending = task(this.socket);
        this.work = this.work.then(async () => {
            try {
                const reply = await pending;
                if (reply !== 'served' && !this.socket.destroyed) this.socket.write(reply);
            } catch (error) {
                this.routes.failed(error instanceof Error ? error.message : 'Request failed');
                this.socket.destroy();
            }
        });
    }
}

export interface ProxyOptions {
    httpPort: number;
    httpsPort: number;
    key: string;
    cert: string;
    cloud: Cloud;
}

function listen(server: net.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

export class Proxy {
    private servers: net.Server[] = [];
    private readonly sockets = new Set<net.Socket>();

    constructor(private readonly routes: Routes) {}

    async start(options: ProxyOptions): Promise<void> {
        const track = (socket: net.Socket, scheme: Scheme) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
            new Connection(socket, scheme, this.routes, options.cloud);
        };
        const secure = tls.createServer({ key: options.key, cert: options.cert, minVersion: 'TLSv1.2' }, (socket) =>
            track(socket, 'https'),
        );
        secure.on('tlsClientError', (error, socket) => {
            const from = (socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
            if (from === '127.0.0.1' || from === '::1') return;
            const reason = /certificate unknown|unknown ca|bad certificate/i.test(error.message)
                ? 'it rejected AiBinator’s certificate'
                : error.message;
            this.routes.failed(`TLS handshake with ${from} failed: ${reason}`);
        });
        const plain = net.createServer((socket) => track(socket, 'http'));
        try {
            await listen(secure, options.httpsPort);
            this.servers.push(secure);
            await listen(plain, options.httpPort);
            this.servers.push(plain);
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        for (const socket of this.sockets) socket.destroy();
        await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        this.servers = [];
    }

    get running(): boolean {
        return this.servers.length === 2;
    }
}
