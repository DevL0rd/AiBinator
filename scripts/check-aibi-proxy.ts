import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { generate } from 'selfsigned';
import { collector, HttpReader, parseHead, type Message } from '../src/aibi/http.js';
import { Proxy } from '../src/aibi/proxy.js';
import { TrafficCapture } from '../src/aibi/capture.js';
import { AibiRoutes } from '../src/aibi/routes.js';
import { deskFixture } from './aibi-fakes.js';

type Pems = { key: string; cert: string };
const port = () => 20_000 + Math.floor(Math.random() * 30_000);

function exchange(socket: net.Socket, request: Buffer[]): Promise<Message> {
    return new Promise((resolve, reject) => {
        const reader = new HttpReader(collector(resolve), true);
        socket.on('data', (chunk: Buffer) => reader.push(chunk));
        socket.on('end', () => reader.close());
        socket.on('error', reject);
        void (async () => {
            for (const part of request) {
                socket.write(part);
                await new Promise((done) => setTimeout(done, 5));
            }
        })();
    });
}

const secure = (at: number) => tls.connect({ host: '127.0.0.1', port: at, rejectUnauthorized: false });
const plain = (at: number) => net.connect({ host: '127.0.0.1', port: at });
const get = (path: string) => [Buffer.from(`GET ${path} HTTP/1.1\r\nHost: api.aibipocket.com\r\n\r\n`)];
const json = (message: Message) => JSON.parse(message.body.toString()) as Record<string, unknown>;

function fakeCloud(pems: Pems, seen: string[]) {
    const answer = (socket: net.Socket) =>
        new HttpReader(
            collector((message) => {
                seen.push(message.startLine);
                const path = message.startLine.split(' ')[1] ?? '';
                const body = path.startsWith('/aibi/ota/version')
                    ? {
                          updates: { host: 'res.example', firmware: '/aibi/version/9/1.6.0.zip' },
                          url: 'http://127.0.0.1:1/aibi/version/9/1.6.0.zip',
                      }
                    : path.startsWith('/aibi/voice')
                      ? { queryResult: { rec_behavior: 'ability_brand_new', queryText: 'surprise', behavior_paras: { level: 3 } } }
                      : { cloud: path };
                const text = JSON.stringify(body);
                socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
            }),
        );
    const https = tls.createServer({ key: pems.key, cert: pems.cert }, (socket) => {
        const reader = answer(socket);
        socket.on('data', (chunk: Buffer) => reader.push(chunk));
    });
    const http = net.createServer((socket) => {
        const reader = answer(socket);
        socket.on('data', (chunk: Buffer) => reader.push(chunk));
    });
    return { https, http };
}

async function listen(server: net.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
}

async function checkLocal(ports: { http: number; https: number }, fixture: ReturnType<typeof deskFixture>): Promise<void> {
    assert.equal(json(await exchange(secure(ports.https), get('/aibi/permission'))).permission, true);
    fixture.gemini.reply = (session) => session.speak('Hello from AiBinator.');
    const audio = Buffer.alloc(16_000);
    for (let index = 0; index < 8000; index++) audio.writeInt16BE(index % 2 ? 6000 : -6000, index * 2);
    const head = Buffer.from(
        'POST /aibi/voice/detectintent?index=9&timezone=UTC HTTP/1.1\r\nHost: api.aibipocket.com\r\nTransfer-Encoding: chunked\r\n\r\n',
    );
    const chunks = [0, 4000, 8000, 12_000].map((at) =>
        Buffer.from(`${(4000).toString(16)}\r\n${audio.subarray(at, at + 4000).toString('latin1')}\r\n`, 'latin1'),
    );
    const reply = json(await exchange(secure(ports.https), [head, ...chunks, Buffer.from('0\r\n\r\n')]));
    const params = (reply.queryResult as { behavior_paras: { url: string; txt: string } }).behavior_paras;
    assert.equal(params.txt, 'Hello from AiBinator.');
    const mp3 = await exchange(plain(ports.http), get(new URL(params.url).pathname));
    assert.equal(mp3.headers['content-type'], 'audio/mpeg');
    assert.equal(mp3.body[0], 0xff, 'the voice is served as MP3 over plain HTTP');
    assert.equal((await exchange(plain(ports.http), get('/tts/dl/local-missing.mp3'))).startLine, 'HTTP/1.1 404 Not Found');
    assert.equal((await exchange(plain(ports.http), get('/ota-blocked/abc'))).startLine, 'HTTP/1.1 403 Forbidden');
}

async function checkForwarding(
    ports: { http: number; https: number },
    fixture: ReturnType<typeof deskFixture>,
    seen: string[],
): Promise<void> {
    assert.deepEqual(json(await exchange(secure(ports.https), get('/time'))), { cloud: '/time' }, 'known cloud requests are forwarded');
    const unknown = await exchange(secure(ports.https), get('/aibi/never/seen?x=1'));
    assert.deepEqual(json(unknown), { cloud: '/aibi/never/seen?x=1' });
    const kinds = fixture.host.activity.recent(50).map((entry) => `${entry.kind}:${entry.title}`);
    assert.ok(kinds.includes('unknown:New request: GET /aibi/never/seen'), 'never-before-seen requests are reported');
    assert.ok(!kinds.some((kind) => kind.includes('/time')), 'known requests are not reported as new');
    const status = Buffer.from('{"battery":77,"charging":true}');
    const head = Buffer.from(
        `POST /aibi/report/status HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: ${status.length}\r\n\r\n`,
    );
    assert.equal(json(await exchange(secure(ports.https), [head, status])).responsetag, 'status');
    assert.ok(seen.includes('GET /time HTTP/1.1'));
}

async function checkPassthrough(
    ports: { http: number; https: number },
    fixture: ReturnType<typeof deskFixture>,
    seen: string[],
): Promise<void> {
    const offer = json(await exchange(secure(ports.https), get('/aibi/ota/version?type=1&version_num=9&current_name=1.6.0')));
    assert.ok(
        seen.some((line) => line.includes('version_num=8') && line.includes('current_name=1.5.0')),
        'the cloud is asked as an older version',
    );
    assert.match(String(offer.url), /^http:\/\/api\.aibipocket\.com\/ota-blocked\//, 'cloud firmware links are hidden from AIBI');
    const voice = Buffer.from('POST /aibi/voice/detectintent HTTP/1.1\r\nContent-Length: 4\r\n\r\nabcd');
    await exchange(secure(ports.https), [voice]);
    const titles = fixture.host.activity.recent(50).map((entry) => entry.title);
    assert.ok(titles.includes('New behavior seen: ability_brand_new'), 'new cloud behaviors are reported');
    assert.ok(titles.includes('Update offer trapped'));
}

type CapturePart = { startLine: string; bytes: number; body?: string; bodyFile?: string };
type CaptureRecord = { started: string; at: string; request: CapturePart; response: CapturePart | string };
const replyBody = (record: CaptureRecord) => (typeof record.response === 'string' ? '' : (record.response.body ?? ''));

async function checkCapture(capture: TrafficCapture): Promise<void> {
    await capture.flushed();
    const files = await readdir(capture.directory);
    const records = await Promise.all(
        files
            .filter((file) => file.endsWith('.json'))
            .map(async (file) => JSON.parse(await readFile(join(capture.directory, file), 'utf8')) as CaptureRecord),
    );
    const voice = records.find((record) => record.request.startLine.startsWith('POST /aibi/voice/detectintent'));
    assert.ok(voice, 'the microphone upload is captured');
    assert.equal(voice.request.bytes, 16_000, 'with the whole streamed body');
    assert.ok(Date.parse(voice.started) <= Date.parse(voice.at), 'with when the upload started and finished');
    assert.ok(files.includes(voice.request.bodyFile ?? ''), 'audio is saved as a file');
    assert.match(replyBody(voice), /Hello from AiBinator/, 'with the reply AIBI got');
    assert.ok(
        records.some((record) => record.response === 'live speech stream'),
        'speech downloads are noted',
    );
    assert.ok(
        records.some((record) => record.request.startLine === 'GET /time HTTP/1.1' && replyBody(record).includes('/time')),
        'forwarded cloud replies are captured',
    );
}

export async function checkAibiProxy(directory: string): Promise<void> {
    const pems = await generate([{ name: 'commonName', value: 'api.aibipocket.com' }], { keySize: 2048, algorithm: 'sha256' });
    const keys = { key: pems.private, cert: pems.cert };
    const seen: string[] = [];
    const cloudServers = fakeCloud(keys, seen);
    const cloudPorts = { https: await listen(cloudServers.https), http: await listen(cloudServers.http) };
    const fixture = deskFixture(await mkdtemp(join(directory, 'proxy-')));
    let mode: 'local' | 'passthrough' = 'local';
    const reports: string[] = [];
    const capture = new TrafficCapture(() => true, join(await mkdtemp(join(directory, 'traffic-')), 'traffic'));
    const proxy = new Proxy(
        new AibiRoutes({
            mode: () => mode,
            desk: fixture.desk,
            speeches: fixture.host.speeches,
            activity: fixture.host.activity,
            capture,
            contact: () => undefined,
            report: (summary) => reports.push(summary),
        }),
    );
    const ports = { http: port(), https: port() };
    const home = process.cwd();
    process.chdir(await mkdtemp(join(home, directory, 'cwd-')));
    try {
        await proxy.start({
            ...keys,
            httpPort: ports.http,
            httpsPort: ports.https,
            cloud: { address: () => Promise.resolve('127.0.0.1'), httpPort: cloudPorts.http, httpsPort: cloudPorts.https, ca: keys.cert },
        });
        await checkLocal(ports, fixture);
        await checkForwarding(ports, fixture, seen);
        await checkCapture(capture);
        assert.deepEqual(reports, ['battery: 77 | charging: true'], 'status reports reach the voice');
        mode = 'passthrough';
        await checkPassthrough(ports, fixture, seen);
    } finally {
        process.chdir(home);
        await proxy.stop();
        cloudServers.https.close();
        cloudServers.http.close();
    }
    assert.equal(parseHead('GET / HTTP/1.1\r\nX-A: b').headers['x-a'], 'b');
}
