import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { localCall } from '../src/mcp/local-client.js';
import { readStatusFile, statusFile } from '../src/operator/status-file.js';
import { launch, type Host } from '../src/startup.js';
import { freePort, inDirectory, listen, until, withEnv } from './host-fixture.js';

const lockFile = join('.data', 'runtime.lock');
const refused = 'AiBinator could not start; check local configuration';
const failedPrefix = 'AiBinator startup failed ';

class FakeHost extends EventEmitter implements Host {
    exitCode?: typeof process.exitCode;
    exits: number[] = [];
    constructor(readonly env: NodeJS.ProcessEnv) {
        super();
    }
    exit(code: number): void {
        this.exits.push(code);
    }
}

interface Started {
    host: FakeHost;
    lines: string[];
}
interface Ports {
    httpPort: number;
    httpsPort: number;
}
type AibiState = { aibi?: { proxy: { state: string; error?: string }; ports: { http: number; https: number } } } | null;

async function captured(work: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    console.error = console.log;
    try {
        await work();
    } finally {
        console.log = log;
        console.error = error;
    }
    return lines;
}

async function start(env: NodeJS.ProcessEnv): Promise<Started> {
    const host = new FakeHost(env);
    return { host, lines: await captured(() => launch(host)) };
}

const settings = (port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    AIBINATOR_MCP_TOKEN: 'local-validation-fixture-never-a-real-credential',
    AIBINATOR_PORT: String(port),
    ...extra,
});

async function prepared<T>(root: string, name: string, work: (ports: Ports) => Promise<T>): Promise<T> {
    return inDirectory(join(root, name), async () => {
        await mkdir('.data', { recursive: true });
        const ports = { httpPort: await freePort(), httpsPort: await freePort() };
        await writeFile('policy.json', JSON.stringify({ aibi: { ...ports, dns: false } }));
        const result = await work(ports);
        await statusSettled();
        return result;
    });
}

async function statusSettled(): Promise<void> {
    const snapshot = () => `${existsSync(`${statusFile}.tmp`)}:${existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : ''}`;
    let previous = snapshot();
    let quiet = 0;
    const settled = await eventually(() => {
        const current = snapshot();
        quiet = current === previous && !current.startsWith('true') ? quiet + 1 : 0;
        previous = current;
        return Promise.resolve(quiet >= 3);
    });
    assert.ok(settled, 'the status file settles before the scenario ends');
}

async function wildcard(port: number): Promise<Server | undefined> {
    const server = createServer();
    return new Promise((done) => {
        server.once('error', () => done(undefined));
        server.listen(port, '0.0.0.0', () => done(server));
    });
}

async function portFree(port: number): Promise<boolean> {
    const server = await wildcard(port);
    if (!server) return false;
    await new Promise((done) => server.close(done));
    return true;
}

async function refusedAt(started: Started, detail: { stage?: string; error: string; code?: string }): Promise<void> {
    assert.equal(started.host.exitCode, 1);
    assert.equal(started.lines.at(-1), refused);
    const failed = started.lines.find((line) => line.startsWith(failedPrefix));
    assert.ok(failed, started.lines.join('\n'));
    assert.partialDeepStrictEqual(JSON.parse(failed.slice(failedPrefix.length)), detail);
    assert.ok(started.lines.includes('AiBinator initialization failed {"stage":"server","error":"Error"}'));
    await lockReleased();
}

async function checkEarlyRefusals(root: string): Promise<void> {
    await inDirectory(join(root, 'unconfigured'), async () => {
        const started = await start({});
        assert.deepEqual(started.lines, [refused], 'missing configuration is refused before the lock');
        assert.equal(started.host.exitCode, 1);
        assert.equal(existsSync(lockFile), false);
    });
    await prepared(root, 'locked', async () => {
        await writeFile(lockFile, String(process.ppid));
        const started = await start(settings(await freePort()));
        assert.deepEqual(started.lines, [refused], 'a running instance keeps its lock');
        assert.equal(existsSync(statusFile), false, 'nothing else starts');
        assert.equal(await readFile(lockFile, 'utf8'), String(process.ppid));
    });
    await prepared(root, 'oauth', async () => {
        const oauth = {
            AIBINATOR_AUTH_MODE: 'oauth',
            AIBINATOR_RESOURCE_URL: 'https://bot.example/mcp',
            AIBINATOR_TRUSTED_PROXIES: '127.0.0.1',
        };
        const started = await start(settings(await freePort(), oauth));
        assert.ok(started.lines.includes('AiBinator initialization failed {"stage":"oauth","error":"Error"}'), started.lines.join('\n'));
        assert.equal(existsSync(statusFile), false, 'bundled OAuth without an owner stops before the runtime');
        assert.equal(existsSync(lockFile), false);
    });
}

async function checkStartupFailures(root: string): Promise<void> {
    await prepared(root, 'port', async () => {
        const { server, port } = await listen();
        try {
            await refusedAt(await start(settings(port)), { stage: 'http', error: 'Error', code: 'EADDRINUSE' });
        } finally {
            await new Promise((done) => server.close(done));
        }
    });
    await prepared(root, 'presence', async ({ httpPort }) => {
        await writeFile(join('.data', 'presence.json'), '{not json');
        await refusedAt(await start(settings(await freePort())), { error: 'SyntaxError' });
        assert.ok(await portFree(httpPort), 'a failed start stops AIBI’s server');
    });
}

async function checkAibiPortTaken(root: string): Promise<void> {
    await prepared(root, 'aibi-busy', async ({ httpPort }) => {
        const blocker = await wildcard(httpPort);
        assert.ok(blocker);
        try {
            const started = await start(settings(await freePort()));
            assert.equal(started.host.exitCode, undefined, 'AiBinator keeps running when AIBI’s port is taken');
            const failed = await eventually(async () => ((await readStatusFile()) as AibiState)?.aibi?.proxy.state === 'failed');
            assert.ok(failed, 'the status file reports that AIBI’s server did not start');
            const status = (await readStatusFile()) as AibiState;
            assert.equal(status?.aibi?.proxy.error, 'Another program is already using that port.');
            started.host.emit('SIGTERM');
            await lockReleased();
        } finally {
            await new Promise((done) => blocker.close(done));
        }
    });
}

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
    for (let attempt = 0; attempt < 150; attempt++) {
        if (await check()) return true;
        await new Promise((done) => setTimeout(done, 100));
    }
    return false;
}

async function lockReleased(): Promise<void> {
    await until(() => !existsSync(lockFile), 15_000);
}

async function checkRunning(root: string): Promise<void> {
    await prepared(root, 'running', async (ports) => {
        const port = await freePort();
        const started = await start(settings(port));
        assert.deepEqual(started.lines, [`AiBinator MCP listening on http://127.0.0.1:${port}/mcp`]);
        assert.equal(started.host.exitCode, undefined);
        assert.equal(existsSync(lockFile), true);
        const endpoint = { base: `http://127.0.0.1:${port}`, key: (await readFile(join('.data', 'local.key'), 'utf8')).trim() };
        const tools = (await localCall(endpoint, 'tools/list')).tools as { name: string }[];
        assert.ok(tools.some((tool) => tool.name === 'aibi_reply'));
        const running = await eventually(async () => ((await readStatusFile()) as AibiState)?.aibi?.proxy.state === 'running');
        assert.ok(running, 'the status file reflects AIBI’s server');
        const status = (await readStatusFile()) as AibiState;
        assert.deepEqual(status?.aibi?.ports, { http: ports.httpPort, https: ports.httpsPort, dns: 53 });
        assert.equal(await portFree(ports.httpPort), false, 'AIBI is answered on its configured port');
        const failure = Object.assign(new Error('late'), { code: 'ELATE' });
        const reported = await captured(() => Promise.resolve(started.host.emit('unhandledRejection', failure)));
        assert.deepEqual(reported, ['AiBinator unhandled rejection {"stage":"runtime","error":"Error","code":"ELATE"}']);
        started.host.emit('SIGINT');
        await lockReleased();
        started.host.emit('SIGTERM');
        await new Promise((done) => setImmediate(done));
        assert.equal(started.host.exitCode, undefined);
        assert.deepEqual(started.host.exits, []);
        assert.ok(await portFree(ports.httpPort), 'shutdown frees AIBI’s ports');
        await assert.rejects(localCall(endpoint, 'tools/list'), 'the server is closed');
    });
}

async function checkRestart(root: string): Promise<void> {
    await prepared(root, 'restart', ({ httpPort }) =>
        withEnv({ AIBINATOR_SERVICE: '1' }, async () => {
            const started = await start(settings(await freePort()));
            let request = 0;
            const restarted = await captured(() =>
                eventually(async () => {
                    if (started.host.exits.length) return true;
                    await writeFile(join('.data', 'service-restart'), String(++request));
                    return false;
                }),
            );
            assert.deepEqual(started.host.exits, [75], 'a restart request stops and exits for the supervisor');
            assert.ok(restarted.some((line) => line.includes('service-restart changed')));
            assert.equal(existsSync(lockFile), false);
            assert.ok(await portFree(httpPort), 'AIBI’s server is stopped before the restart');
        }),
    );
}

async function checkLiveSettings(root: string): Promise<void> {
    await prepared(root, 'live', async () => {
        const [port, moved] = [await freePort(), await freePort()];
        const started = await start(settings(port));
        const key = (await readFile(join('.data', 'local.key'), 'utf8')).trim();
        const reachable = (at: number) =>
            localCall({ base: `http://127.0.0.1:${at}`, key }, 'tools/list').then(
                () => true,
                () => false,
            );
        const lines = await captured(async () => {
            await writeFile('.env', `AIBINATOR_PORT=${moved}\nGEMINI_API_KEY=gemini-fixture-key\n`);
            assert.ok(await eventually(() => reachable(moved)), 'the listener moved to the new port without a restart');
            assert.equal(await reachable(port), false, 'the old port is closed');
            await writeFile('.env', 'AIBINATOR_PORT=1\n');
            await eventually(() => Promise.resolve(existsSync('.env')));
            await new Promise((done) => setTimeout(done, 300));
        });
        assert.ok(
            lines.some((line) => /Applied new settings without restarting: .*AIBINATOR_PORT/.test(line) && line.includes('GEMINI_API_KEY')),
            lines.join('\n'),
        );
        assert.ok(lines.includes(`AiBinator MCP listening on http://127.0.0.1:${moved}/mcp`));
        assert.ok(
            lines.some((line) => line.includes('.env changed but could not be applied')),
            'an invalid edit is ignored',
        );
        assert.ok(await reachable(moved), 'it keeps serving after an invalid edit');
        assert.deepEqual(started.host.exits, [], 'nothing restarted the process');
        started.host.emit('SIGTERM');
        await lockReleased();
    });
}

async function checkFailedShutdown(root: string): Promise<void> {
    await prepared(root, 'failed-stop', async ({ httpPort }) => {
        const started = await start(settings(await freePort()));
        await rm(lockFile);
        started.host.emit('SIGTERM');
        await until(() => started.host.exitCode === 1, 15_000);
        assert.ok(await portFree(httpPort), 'AIBI’s server stops even when releasing the lock fails');
    });
}

export async function checkStartup(directory: string): Promise<void> {
    const root = resolve(directory, 'startup');
    await withEnv({ AIBINATOR_SERVICE: undefined }, async () => {
        await checkEarlyRefusals(root);
        await checkStartupFailures(root);
        await checkAibiPortTaken(root);
        await checkRunning(root);
        await checkRestart(root);
        await checkLiveSettings(root);
        await checkFailedShutdown(root);
    });
}
