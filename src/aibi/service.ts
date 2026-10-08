import type { PolicyConfig } from '../core/config.js';
import type { Policy } from '../core/policy.js';
import type { EventQueue } from '../core/queue.js';
import type { VoiceProviders } from '../voice/gemini.js';
import { ActivityLog } from './activity.js';
import { TrafficCapture } from './capture.js';
import { VoiceDesk } from './desk.js';
import { DnsServer } from './dns.js';
import { Memory } from './memory.js';
import { lanAddress } from './network.js';
import { cloud, Proxy } from './proxy.js';
import { AibiRoutes } from './routes.js';
import { Speeches } from './speech.js';
import { tlsPair } from './tls.js';

export interface Responder {
    available(): boolean;
    answer(request: string, answer: string): Promise<string>;
    command(name: string, value: string): Promise<string>;
}

type Part = { state: 'off' | 'starting' | 'running' | 'failed'; error?: string };

const networkKeys = ['lanAddress', 'dns', 'dnsUpstream', 'httpPort', 'httpsPort', 'dnsPort'] as const;
const networkOf = (config: PolicyConfig) => JSON.stringify(networkKeys.map((key) => config.aibi[key]));

function problem(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EACCES') return 'Permission denied: this computer does not let AiBinator use that port. Run aibinator ports to allow it.';
    if (code === 'EADDRINUSE') return 'Another program is already using that port.';
    if (code === 'EADDRNOTAVAIL') return 'That address does not belong to this computer.';
    return error instanceof Error ? error.message : 'unknown error';
}

export class AibiService {
    readonly activity = new ActivityLog();
    readonly memory = new Memory();
    readonly speeches = new Speeches();
    readonly capture: TrafficCapture;
    readonly desk: VoiceDesk;
    private readonly proxy: Proxy;
    private dns?: DnsServer;
    private proxyState: Part = { state: 'off' };
    private dnsState: Part = { state: 'off' };
    private address = '';
    private lastContact?: { at: string; remote: string; path: string };
    private readonly calls = new Map<string, { count: number; last: string }>();
    private robot = '';
    private applying: Promise<void> = Promise.resolve();
    private unwatch?: () => void;
    onChange?: () => void;

    constructor(
        private readonly policy: Policy,
        queue: EventQueue,
        providers: VoiceProviders,
        private readonly responder: Responder,
    ) {
        this.desk = new VoiceDesk({
            policy,
            queue,
            memory: this.memory,
            activity: this.activity,
            speeches: this.speeches,
            providers,
            responder: () => responder.available(),
            answer: (request, answer) => responder.answer(request, answer),
            command: (name, value) => responder.command(name, value),
            robot: () => this.robot,
            changed: () => this.onChange?.(),
        });
        this.capture = new TrafficCapture(() => this.policy.config.aibi.capture);
        this.proxy = new Proxy(
            new AibiRoutes({
                mode: () => this.policy.config.aibi.mode,
                desk: this.desk,
                speeches: this.speeches,
                activity: this.activity,
                capture: this.capture,
                contact: (remote, path) => this.contact(remote, path),
                report: (summary) => (this.robot = summary),
            }),
        );
        this.activity.onChange = () => this.onChange?.();
    }

    async start(): Promise<void> {
        await Promise.all([this.activity.load(), this.memory.load()]);
        this.unwatch = this.policy.onChange((previous) => {
            const mode = this.policy.config.aibi.mode;
            if (previous.aibi.mode !== mode)
                this.activity.add('network', mode === 'local' ? 'AiBinator now answers AIBI' : 'AIBI now talks to its own cloud');
            if (networkOf(previous) !== networkOf(this.policy.config)) this.restart();
        });
        this.restart();
        await this.applying;
    }

    async stop(): Promise<void> {
        this.unwatch?.();
        await this.applying;
        await this.desk.end();
        await this.down();
        this.speeches.clear();
        await Promise.all([this.activity.flushed(), this.memory.flushed(), this.capture.flushed()]);
    }

    restart(): void {
        this.applying = this.applying.then(async () => {
            await this.down();
            await this.up();
            this.onChange?.();
        });
    }

    private async down(): Promise<void> {
        await this.dns?.stop();
        this.dns = undefined;
        await this.proxy.stop();
        this.proxyState = { state: 'off' };
        this.dnsState = { state: 'off' };
    }

    private async up(): Promise<void> {
        const settings = this.policy.config.aibi;
        this.proxyState = { state: 'starting' };
        try {
            this.address = await lanAddress(settings.lanAddress);
            const tls = await tlsPair();
            if (tls.created) this.activity.add('network', 'Created the certificate for api.aibipocket.com');
            await this.proxy.start({
                httpPort: settings.httpPort,
                httpsPort: settings.httpsPort,
                key: tls.key,
                cert: tls.cert,
                cloud: cloud(settings.dnsUpstream),
            });
            this.proxyState = { state: 'running' };
            this.activity.add(
                'network',
                `Listening for AIBI on ports ${settings.httpPort} and ${settings.httpsPort}`,
                `Mode: ${settings.mode}`,
            );
        } catch (error) {
            this.proxyState = { state: 'failed', error: problem(error) };
            this.activity.add('warning', 'AIBI server did not start', problem(error));
            return;
        }
        if (settings.dns) await this.startDns();
    }

    private async startDns(): Promise<void> {
        const settings = this.policy.config.aibi;
        if (!this.address) {
            this.dnsState = { state: 'failed', error: 'No network address was found for this computer' };
            return;
        }
        const dns = new DnsServer(
            { address: this.address, port: settings.dnsPort, upstream: settings.dnsUpstream },
            {
                answered: (remote) =>
                    this.activity.add('network', `Pointed ${remote} at this computer`, `api.aibipocket.com -> ${this.address}`),
                warning: (title, detail) => this.activity.add('warning', title, detail),
            },
        );
        try {
            await dns.start();
            this.dns = dns;
            this.dnsState = { state: 'running' };
        } catch (error) {
            this.dnsState = { state: 'failed', error: problem(error) };
            this.activity.add('warning', 'DNS server did not start', problem(error));
        }
    }

    private contact(remote: string, path: string): void {
        const first = !this.lastContact;
        const seen = this.calls.get(path);
        this.calls.set(path, { count: (seen?.count ?? 0) + 1, last: new Date().toISOString() });
        this.lastContact = { at: new Date().toISOString(), remote: remote.replace(/^::ffff:/, ''), path };
        if (first) this.activity.add('network', 'AIBI connected', `${this.lastContact.remote} asked for ${path}`);
        this.onChange?.();
    }

    status() {
        const settings = this.policy.config.aibi;
        return {
            mode: settings.mode,
            address: this.address,
            proxy: this.proxyState,
            dns: settings.dns ? this.dnsState : { state: 'off' as const },
            ports: { http: settings.httpPort, https: settings.httpsPort, dns: settings.dnsPort },
            lastContact: this.lastContact ?? null,
            calls: [...this.calls.entries()]
                .map(([path, seen]) => ({ path, ...seen }))
                .sort((a, b) => b.last.localeCompare(a.last))
                .slice(0, 12),
            robot: this.robot,
            voice: this.desk.status(),
            capture: { on: this.capture.on, directory: this.capture.directory },
            memory: this.memory.size,
            conversation: this.memory.recent(8),
            activity: this.activity.recent(30),
        };
    }
}
