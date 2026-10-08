import { IncomingMessage, ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';

function decodeChunks(body: Buffer): Buffer {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
        const line = body.indexOf('\r\n', offset);
        const size = Number.parseInt(body.subarray(offset, line).toString(), 16);
        if (!size) break;
        chunks.push(body.subarray(line + 2, line + 2 + size));
        offset = line + size + 4;
    }
    return Buffer.concat(chunks);
}

export async function inProcessHttp(server: Server, path: string, init: RequestInit): Promise<Response> {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
        writableHighWaterMark: 64 * 1024 * 1024,
        read() {},
        write(chunk: Buffer, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
        },
    });
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const request = new IncomingMessage(socket as Socket);
    request.method = init.method ?? 'GET';
    request.url = path;
    request.httpVersion = '1.1';
    request.httpVersionMajor = 1;
    request.httpVersionMinor = 1;
    request.headers = Object.fromEntries(new Headers(init.headers));
    request.rawHeaders = Object.entries(request.headers).flatMap(([key, value]) => [key, String(value)]);
    request.complete = true;
    const data = typeof init.body === 'string' ? init.body : '';
    request.headers['content-length'] = String(Buffer.byteLength(data));
    request.push(data || null);
    if (data) request.push(null);
    const response = new ServerResponse(request);
    response.assignSocket(socket as Socket);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('In-process HTTP request timed out after 5s'));
        }, 5000);
        response.once('finish', () => {
            clearTimeout(timer);
            const packet = Buffer.concat(chunks);
            const split = packet.indexOf('\r\n\r\n');
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.getHeaders())) {
                for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
            }
            const rawBody = packet.subarray(split + 4);
            const body = /transfer-encoding: chunked/i.test(packet.subarray(0, split).toString()) ? decodeChunks(rawBody) : rawBody;
            socket.destroy();
            resolve(
                new Response([204, 304].includes(response.statusCode) ? null : new Uint8Array(body), {
                    status: response.statusCode,
                    headers,
                }),
            );
        });
        server.emit('request', request, response);
    });
}
