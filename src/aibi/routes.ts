import type net from 'node:net';
import { actions } from './capabilities.js';
import type { ActivityLog } from './activity.js';
import type { TrafficCapture } from './capture.js';
import type { VoiceDesk } from './desk.js';
import {
    downloadFirmware,
    firmwareUrls,
    olderVersionRequest,
    patchedFirmware,
    patchedOffer,
    rememberIdentity,
    rememberOffer,
    rewriteOffer,
} from './firmware.js';
import { decodedBody, rebuild, type Message } from './http.js';
import { encode, summarize, tagged, type Reply } from './protocol.js';
import type { Exchange, Incoming, Routes } from './proxy.js';
import type { Speeches } from './speech.js';

export interface RouteHost {
    mode(): 'local' | 'passthrough';
    desk: VoiceDesk;
    speeches: Speeches;
    activity: ActivityLog;
    capture: TrafficCapture;
    contact(remote: string, path: string): void;
    report(summary: string): void;
}

const ok = (reply: Reply | Buffer, headers?: Record<string, string>) => encode('HTTP/1.1 200 OK', reply, headers);
const known = /^\/(time|token\/|aibi\/ota\/(res|allres)\/|aibi\/ai\/rockpaper)/;
const nativeIds = new Set(actions.map((action) => action.id));

function bodySummary(body: Buffer, contentType = ''): string {
    if (!body.length) return '';
    const raw = body.toString('utf8');
    try {
        const values = contentType.includes('json')
            ? (JSON.parse(raw) as Record<string, unknown>)
            : contentType.includes('urlencoded')
              ? Object.fromEntries(new URLSearchParams(raw))
              : undefined;
        if (values)
            return Object.entries(values)
                .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
                .join(' | ')
                .slice(0, 500);
    } catch {
        return raw.slice(0, 300);
    }
    return /^[\t\n\r\x20-\x7e]*$/.test(raw) ? raw.slice(0, 300) : `${body.length} bytes of binary data`;
}

function parseJson(message: Message): Reply | undefined {
    try {
        return JSON.parse(decodedBody(message).toString('utf8')) as Reply;
    } catch {
        return undefined;
    }
}

function imageType(body: Buffer): string {
    if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    return 'image/jpeg';
}

export class AibiRoutes implements Routes {
    private readonly reported = new Map<string, number>();

    constructor(private readonly host: RouteHost) {}

    streams(method: string, path: string): boolean {
        return this.host.mode() === 'local' && method === 'POST' && path === '/aibi/voice/detectintent';
    }

    private seen(remote: string, path: string, headers: Record<string, string>): void {
        this.host.contact(remote, path);
        void rememberIdentity(headers)
            .then((saved) => saved && this.host.activity.add('firmware', 'Saved AIBI’s identity for firmware tools'))
            .catch(() => undefined);
    }

    async stream(request: Incoming): Promise<Buffer> {
        const started = new Date();
        this.seen(request.remote, request.path, request.head.headers);
        const parts: Buffer[] = [];
        const chunks = this.host.capture.on ? copied(request.chunks(), parts) : request.chunks();
        const reply = ok(
            await this.host.desk.listen(chunks, {
                index: Number(request.query.get('index') ?? 0) || 0,
                timeZone: request.query.get('timezone'),
                chat: request.query.get('role') === 'chatgpt',
            }),
        );
        this.host.capture.record({
            scheme: request.scheme,
            remote: request.remote,
            started,
            request: { ...request.head, body: Buffer.concat(parts) },
            response: reply,
        });
        return reply;
    }

    failed(detail: string): void {
        this.host.activity.add('warning', 'AIBI connection problem', detail);
    }

    async handle(exchange: Exchange, socket: net.Socket): Promise<Buffer | 'served'> {
        const started = new Date();
        this.seen(exchange.remote, exchange.path, exchange.message.headers);
        const reply = await this.respond(exchange, socket);
        this.host.capture.record({ scheme: exchange.scheme, remote: exchange.remote, started, request: exchange.message, response: reply });
        return reply;
    }

    private async respond(exchange: Exchange, socket: net.Socket): Promise<Buffer | 'served'> {
        const trapped = await this.firmware(exchange);
        if (trapped) return trapped;
        if (this.host.mode() === 'passthrough' || exchange.path === '/aibi/ota/version') return this.observe(exchange);
        const speech = exchange.method === 'GET' ? /^\/(?:tts|poweron)\/dl\/([\w.-]+)$/.exec(exchange.path) : null;
        if (speech) return this.speech(speech[1]!, socket);
        return (await this.local(exchange)) ?? this.forward(exchange, !known.test(exchange.path));
    }

    private speech(id: string, socket: net.Socket): Buffer | 'served' {
        const stream = this.host.speeches.find(id);
        if (!stream) return encode('HTTP/1.1 404 Not Found', { error: 'tts_not_found' }, { Connection: 'close' });
        stream.serve(socket);
        return 'served';
    }

    private async firmware(exchange: Exchange): Promise<Buffer | undefined> {
        if (exchange.method !== 'GET') return undefined;
        if (exchange.path.startsWith('/ota-blocked/'))
            return encode(
                'HTTP/1.1 403 Forbidden',
                { errcode: 403, errmsg: 'Firmware download blocked by AiBinator' },
                { Connection: 'close' },
            );
        const patched = await patchedFirmware();
        if (!patched) return undefined;
        if (exchange.path === patched.urlPath) {
            this.host.activity.add('firmware', 'Patched firmware served', patched.name);
            return ok(patched.bytes, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${patched.name}"`,
                Connection: 'close',
            });
        }
        if (exchange.path === '/aibi/ota/version') {
            this.host.activity.add('firmware', 'Offered patched firmware', `${patched.versionName} (${patched.md5})`);
            return ok(patchedOffer(patched), { Connection: 'close' });
        }
        return undefined;
    }

    private async local(exchange: Exchange): Promise<Buffer | undefined> {
        const { method, path, query, message } = exchange;
        const zone = query.get('tz') ?? query.get('timezone');
        const desk = this.host.desk;
        const routes: Record<string, () => Buffer | Promise<Buffer>> = {
            'GET /aibi/permission': () => ok(tagged('permission', { permission: true })),
            'POST /aibi/report/status': () => this.status(message),
            'POST /aibi/messages/send': () => this.friendMessage(message),
            'GET /aibi/messages/receive': () => ok(tagged('getmessage', { m_list: [] })),
            'GET /aibi/messages/confirm': () => ok(tagged('get message')),
            'GET /aibi/poweron/voice': async () => ok(await desk.powerOn(zone)),
            'GET /aibi/speech/tts': async () => ok(await desk.readAloud(query.get('q') ?? '')),
            'GET /aibi/chat/start': async () => ok(await desk.chatStart(zone)),
            'POST /aibi/ai/imgrecog': async () => ok(await desk.look(message.body, imageType(message.body))),
        };
        return routes[`${method} ${path}`]?.();
    }

    private status(message: Message): Buffer {
        const summary = bodySummary(message.body, message.headers['content-type']);
        this.host.report(summary);
        this.host.activity.add('status', 'AIBI reported its status', summary);
        return ok(tagged('status'));
    }

    private friendMessage(message: Message): Buffer {
        this.host.activity.add('request', 'AIBI sent a friend message', bodySummary(message.body, message.headers['content-type']));
        return ok(tagged('sendmessage'));
    }

    private async forward(exchange: Exchange, unknown: boolean): Promise<Buffer> {
        if (unknown) this.newRequest(exchange);
        try {
            return rebuild(await exchange.forward());
        } catch (error) {
            this.host.activity.add(
                'warning',
                `Could not reach the AIBI cloud for ${exchange.path}`,
                error instanceof Error ? error.message : '',
            );
            return encode('HTTP/1.1 502 Bad Gateway', { errcode: 502, errmsg: 'AIBI cloud unreachable' }, { Connection: 'close' });
        }
    }

    private newRequest(exchange: Exchange): void {
        const key = `${exchange.method} ${exchange.path}`;
        if (Date.now() - (this.reported.get(key) ?? 0) < 3_600_000) return;
        this.reported.set(key, Date.now());
        const query = exchange.query.toString();
        const body = bodySummary(exchange.message.body, exchange.message.headers['content-type']);
        this.host.activity.add('unknown', `New request: ${key}`, [query && `query ${query}`, body].filter(Boolean).join(' · '));
    }

    private async observe(exchange: Exchange): Promise<Buffer> {
        const older = olderVersionRequest(exchange.message.startLine);
        let response: Message;
        try {
            response = await exchange.forward(older ? { ...exchange.message, startLine: older } : undefined);
        } catch (error) {
            this.host.activity.add(
                'warning',
                `Could not reach the AIBI cloud for ${exchange.path}`,
                error instanceof Error ? error.message : '',
            );
            return encode('HTTP/1.1 502 Bad Gateway', { errcode: 502, errmsg: 'AIBI cloud unreachable' }, { Connection: 'close' });
        }
        if (older) this.host.activity.add('firmware', 'Asked the cloud for updates as an older version', older);
        if (exchange.path === '/aibi/ota/version') return this.capture(exchange, response);
        this.learn(exchange, response);
        return rebuild(response);
    }

    private learn(exchange: Exchange, response: Message): void {
        const json = parseJson(response);
        if (!json) return;
        const summary = summarize(json);
        if (!summary.behavior && !summary.url) return;
        const detail = [summary.queryText && `heard "${summary.queryText}"`, summary.text && `said "${summary.text}"`]
            .filter(Boolean)
            .join(', ');
        this.host.activity.add('request', `Cloud answered ${exchange.path}: ${summary.behavior || 'speech'}`, detail);
        if (summary.behavior && !nativeIds.has(summary.behavior) && summary.behavior !== 'interact_speak')
            this.host.activity.add('unknown', `New behavior seen: ${summary.behavior}`, JSON.stringify(summary.params).slice(0, 500));
    }

    private capture(exchange: Exchange, response: Message): Buffer {
        const json = parseJson(response);
        if (!json) return rebuild(response);
        const urls = firmwareUrls(json);
        void rememberOffer(json).catch(() => undefined);
        for (const url of urls)
            void downloadFirmware(url, exchange.message.headers)
                .then((saved) => this.host.activity.add('firmware', 'Firmware downloaded', `${saved.file} (${saved.bytes} bytes)`))
                .catch((error: unknown) =>
                    this.host.activity.add('warning', 'Firmware download failed', error instanceof Error ? error.message : url),
                );
        this.host.activity.add(
            'firmware',
            'Update offer trapped',
            urls.length ? `${urls.length} firmware link(s) captured and hidden from AIBI` : 'no firmware link',
        );
        const body = Buffer.from(JSON.stringify(rewriteOffer(json)));
        const headers = { ...response.headers };
        delete headers['content-encoding'];
        return rebuild({ ...response, headers, body });
    }
}

async function* copied(source: AsyncIterable<Buffer>, parts: Buffer[]): AsyncIterable<Buffer> {
    for await (const chunk of source) {
        parts.push(chunk);
        yield chunk;
    }
}
