import { readFile } from 'node:fs/promises';
import { loadConfig, type Config, type PolicyConfig } from './core/config.js';
import { PresenceWriter } from './operator/presence.js';
import { StatusWriter } from './operator/status-file.js';
import { Policy } from './core/policy.js';
import { EventQueue } from './core/queue.js';
import { Journal } from './core/journal.js';
import { Bridge } from './core/bridge.js';
import { HttpServer } from './mcp/http.js';
import { Authenticator } from './mcp/auth.js';
import { acquireRuntime } from './core/runtime.js';
import { BundledOAuth } from './oauth/server.js';
import { OperatorService } from './operator/service.js';
import { CommandService } from './operator/commands.js';
import { loadLocalKey } from './mcp/local-key.js';
import { restartOnChange, restartRequestFile } from './operator/environment-watcher.js';
import { PolicyWatcher } from './operator/policy-watcher.js';
import { AibiService } from './aibi/service.js';
import { Gemini } from './voice/gemini.js';
import { baseEnvironment, environmentStamp, reconfigure, watchEnvironment, type Reconfigurable } from './reconfigure.js';

export interface Host {
    env: NodeJS.ProcessEnv;
    exitCode?: typeof process.exitCode;
    on(event: 'unhandledRejection', listener: (error: unknown) => void): unknown;
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    exit(code: number): void;
}

export async function launch(host: Host = process): Promise<void> {
    await main(host).catch(() => {
        console.error('AiBinator could not start; check local configuration');
        host.exitCode = 1;
    });
}

const bundled = (config: Config) => config.AIBINATOR_AUTH_MODE === 'oauth' && config.AIBINATOR_OAUTH_SERVER === 'bundled';

async function main(host: Host): Promise<void> {
    const base = baseEnvironment(host.env, await readFile('.env', 'utf8').catch(() => ''));
    const { config, policy } = await loadConfig(host.env);
    const release = await acquireRuntime();
    let stage = 'oauth';
    try {
        const oauth = bundled(config) ? await BundledOAuth.open(config) : undefined;
        try {
            stage = 'server';
            await run(host, config, policy, release, oauth, base);
        } catch (error) {
            await oauth?.close();
            throw error;
        }
    } catch (error) {
        await release();
        failure('AiBinator initialization failed', stage, error);
        throw error;
    }
}

type SettingsReport = { applied: string | null; failed: string | null; error: string | null };

async function createRuntime(config: Config, policyConfig: PolicyConfig, oauth?: BundledOAuth) {
    const policy = new Policy(policyConfig);
    const queue = new EventQueue();
    const journal = new Journal('.data/reply-idempotency.json', 16384, Date.now, 7 * 24 * 60 * 60_000);
    await journal.load();
    const bridge = new Bridge(policy, queue, journal);
    const runtime = {
        bridge,
        oauth,
        access: { auth: new Authenticator(config, oauth?.verifyKey) },
        operator: undefined as unknown as OperatorService,
        aibi: undefined as unknown as AibiService,
        http: undefined as unknown as HttpServer,
        people: new PolicyWatcher(config.AIBINATOR_POLICY_FILE, policy),
        presence: new PresenceWriter(),
        settings: { applied: null, failed: null, error: null } as SettingsReport,
        watching: [] as (() => void)[],
        touch: () => undefined as void,
        status: (): unknown => liveStatus(runtime),
        listen: (): HttpServer => listener(config, runtime, localKey),
    };
    runtime.aibi = new AibiService(policy, queue, new Gemini(() => config.GEMINI_API_KEY), {
        available: () => runtime.operator.available(),
        answer: (request, answer) => runtime.operator.answer(request, answer),
        command: async (name, value) => {
            const reply = await new CommandService(runtime.operator).run(name, { name: value });
            return [reply.title, ...reply.lines].join('. ');
        },
    });
    runtime.operator = new OperatorService(queue, bridge, runtime.aibi.memory);
    bridge.desk = runtime.aibi.desk;
    bridge.aibi = runtime.aibi;
    const localKey = await loadLocalKey();
    runtime.http = runtime.listen();
    const statusFile = new StatusWriter(() => ({ ...bridge.status(), ...liveStatus(runtime) }));
    runtime.touch = () => statusFile.touch();
    runtime.operator.onStatus = runtime.touch;
    runtime.aibi.onChange = runtime.touch;
    runtime.touch();
    return runtime;
}

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

function liveStatus(runtime: { operator: OperatorService; aibi: AibiService; settings: SettingsReport }) {
    return { aibi: runtime.aibi.status(), operator: runtime.operator.status(), settings: runtime.settings };
}

function listener(
    config: Config,
    runtime: { bridge: Bridge; status: () => unknown; oauth?: BundledOAuth | undefined; presence: PresenceWriter },
    localKey: string,
): HttpServer {
    const http = new HttpServer(config, runtime.bridge, runtime.status, undefined, runtime.oauth);
    http.attachLocal(localKey);
    http.onRemote = () => runtime.presence.remoteSignedIn();
    return http;
}

async function run(
    host: Host,
    config: Config,
    policyConfig: PolicyConfig,
    release: () => Promise<void>,
    oauth: BundledOAuth | undefined,
    base: NodeJS.ProcessEnv,
): Promise<void> {
    const runtime = await createRuntime(config, policyConfig, oauth);
    const stop = shutdownOnce(runtime, release);
    registerSignals(host, stop);
    let stage = 'http';
    try {
        await runtime.http.start();
        stage = 'aibi';
        await runtime.aibi.start();
        stage = 'operator';
        runtime.operator.start();
        runtime.people.start();
        runtime.settings.applied = environmentStamp(await readFile('.env', 'utf8').catch(() => ''));
        await runtime.presence.start(0);
        runtime.watching.push(
            restartOnChange(
                [restartRequestFile],
                () => runtime.operator.whenIdle(),
                async () => {
                    await stop();
                    host.exit(75);
                },
            ),
            watchEnvironment(
                '.env',
                base,
                (next, stamp) => applySettings(runtime, config, next, stamp),
                (stamp) => settingsFailed(runtime, stamp, 'the saved settings are not valid'),
            ),
        );
        console.log(`AiBinator MCP listening on http://127.0.0.1:${config.AIBINATOR_PORT}/mcp`);
    } catch (error) {
        failure('AiBinator startup failed', stage, error);
        await stop();
        throw new Error('Startup failed; check settings and port availability', { cause: error });
    }
}

function liveTargets(runtime: Runtime, config: Config): Reconfigurable {
    return {
        movePolicy: (path) => runtime.people.move(path),
        restartListener: async () => {
            await runtime.http.stop();
            await runtime.oauth?.close();
            runtime.oauth = bundled(config) ? await BundledOAuth.open(config) : undefined;
            runtime.access.auth = new Authenticator(config, runtime.oauth?.verifyKey);
            runtime.http = runtime.listen();
            await runtime.http.start();
            console.log(`AiBinator MCP listening on http://127.0.0.1:${config.AIBINATOR_PORT}/mcp`);
        },
    };
}

async function applySettings(runtime: Runtime, config: Config, next: Config, stamp: string): Promise<void> {
    try {
        const changed = await reconfigure(config, next, liveTargets(runtime, config));
        if (changed.includes('GEMINI_API_KEY')) await runtime.aibi.desk.end();
        if (changed.length) console.error(`Applied new settings without restarting: ${changed.join(', ')}`);
        runtime.settings = { applied: stamp, failed: null, error: null };
    } catch (error) {
        failure('Settings change could not be applied; the previous settings were restored', 'reconfigure', error);
        return settingsFailed(runtime, stamp, error instanceof Error ? error.message : 'the change could not be applied');
    }
    runtime.touch();
}

function settingsFailed(runtime: Runtime, stamp: string, error: string): void {
    runtime.settings = { ...runtime.settings, failed: stamp, error };
    runtime.touch();
}

function shutdownOnce(runtime: Runtime, release: () => Promise<void>): () => Promise<void> {
    let stopping: Promise<void> | undefined;
    return () =>
        (stopping ??= (async () => {
            for (const stop of runtime.watching) stop();
            await runtime.aibi.stop().catch(() => undefined);
            await runtime.people.stop();
            await Promise.all([runtime.http.stop(), runtime.operator.stop()]);
            await release();
        })());
}

function registerSignals(host: Host, stop: () => Promise<void>): void {
    host.on('unhandledRejection', (error) => failure('AiBinator unhandled rejection', 'runtime', error));
    const stopOnSignal = () => {
        void stop().catch(() => {
            host.exitCode = 1;
        });
    };
    host.once('SIGINT', stopOnSignal);
    host.once('SIGTERM', stopOnSignal);
}

function failure(label: string, stage: string, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    console.error(`${label} ${JSON.stringify({ stage, error: error instanceof Error ? error.name : typeof error, code })}`);
}
