import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Received {
    path: string;
    method: string;
    headers: IncomingMessage['headers'];
    body: string;
}
type Route = (response: ServerResponse, received: Received) => void;

export async function loopbackServer(routes: Record<string, Route>) {
    const received: Received[] = [];
    const server = createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
            const entry = {
                path: incoming.url ?? '/',
                method: incoming.method ?? '',
                headers: incoming.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            };
            received.push(entry);
            const route = routes[entry.path];
            if (route) route(response, entry);
            else response.writeHead(404).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const close = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { base: `http://127.0.0.1:${port}`, received, close };
}
