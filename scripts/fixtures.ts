import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { policySchema, type Config } from '../src/core/config.js';
import { Policy } from '../src/core/policy.js';
import { EventQueue } from '../src/core/queue.js';
import { Journal } from '../src/core/journal.js';
import { Bridge } from '../src/core/bridge.js';
import type { LiveSetupStatus } from '../src/operator/setup-model.js';

export function fixture(file: string) {
    const policy = new Policy(policySchema.parse({}));
    const queue = new EventQueue();
    const journal = new Journal(file);
    const bridge = new Bridge(policy, queue, journal);
    const spoken: { text: string; quiet: boolean }[] = [];
    const event = queue.add('fixture', { kind: 'voice', text: 'What is the weather like?', conversation: 'fixture' }, (text, quiet) => {
        spoken.push({ text, quiet: quiet === true });
        return Promise.resolve({ spoken: !quiet });
    })!;
    return { policy, queue, journal, bridge, event, spoken };
}

export function fakeConfig(port = 8789): Config {
    return {
        AIBINATOR_POLICY_FILE: 'policy.json',
        AIBINATOR_PORT: port,
        AIBINATOR_BIND_HOST: '127.0.0.1',
        AIBINATOR_AUTH_MODE: 'bearer',
        AIBINATOR_MCP_TOKEN: 'local-validation-fixture-never-a-real-credential',
        AIBINATOR_OAUTH_SUBJECTS: '',
        AIBINATOR_OAUTH_SERVER: 'external',
        AIBINATOR_OAUTH_DATA_DIR: '.data/oauth',
        AIBINATOR_TRUSTED_PROXIES: '',
        AIBINATOR_OAUTH_REDIRECT_URIS: 'https://chatgpt.com/connector_platform_oauth_redirect',
        AIBINATOR_ALLOWED_HOSTS: '',
        AIBINATOR_ALLOWED_ORIGINS: '',
    };
}

export function aibiStatus(patch: Partial<LiveSetupStatus['aibi']> = {}): LiveSetupStatus['aibi'] {
    return {
        mode: 'local',
        address: '192.168.1.20',
        proxy: { state: 'running' },
        dns: { state: 'running' },
        ports: { http: 80, https: 443, dns: 53 },
        lastContact: { at: '2026-10-08T10:00:00.000Z', remote: '192.168.1.40', path: '/aibi/report/status' },
        calls: [{ path: '/aibi/report/status', count: 3, last: '2026-10-08T10:00:00.000Z' }],
        robot: '',
        voice: { conversation: false, waiting: 0, tasks: 0, configured: true },
        capture: { on: false, directory: '.data/aibi/traffic' },
        memory: 0,
        conversation: [],
        activity: [],
        ...patch,
    };
}

export const socketPath = (directory: string, name: string): string =>
    process.platform === 'win32' ? `\\\\.\\pipe\\aibinator-${name}-${randomUUID()}` : join(directory, `${name}.sock`);

export const posixOnly = process.platform !== 'win32';
