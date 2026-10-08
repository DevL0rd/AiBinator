import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appState, connectApp, disconnectApp, type CodexDeps } from '../src/operator/connections.js';
import { withoutServers } from '../src/operator/codex-config.js';
import { connectorStatus, markWebAdded, webConnectors } from '../src/operator/web-connectors.js';
import { planReconnect } from '../src/operator/reconnect.js';
import type { SettingChange } from '../src/operator/settings-registry.js';

const endpoint = { base: 'http://127.0.0.1:8788', key: 'k'.repeat(43) };
const change = (id: string): SettingChange => ({ id: `environment.${id}`, label: id, before: 'a', after: 'b', apply: 'live' });

function servers(toml: string): { name: string; transport: { url: string } }[] {
    return [...toml.matchAll(/^\[mcp_servers\.([\w-]+)\]\nurl = "([^"]+)"/gm)].map((match) => ({
        name: match[1]!,
        transport: { url: match[2]! },
    }));
}

function fakeCodex(home: string): CodexDeps {
    return {
        home: () => Promise.resolve(home),
        endpoint: () => Promise.resolve(endpoint),
        codex: async (args) => (args[1] === 'list' ? JSON.stringify(servers(await readFile(join(home, 'config.toml'), 'utf8'))) : ''),
    };
}

const legacyConfig =
    'model = "x"\n\n[mcp_servers.other]\nurl = "https://other.example.com/mcp"\n\n[mcp_servers.dotbot]\nurl = "https://old.example.com/mcp"\n\n[mcp_servers.aibinator]\nurl = "https://bot.example.com/mcp"\n\n[mcp_servers.aibinator.env]\nX = "1"\n';

async function checkCodex(directory: string): Promise<void> {
    const home = join(directory, 'codex-home');
    const deps = fakeCodex(home);
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'config.toml'), legacyConfig);
        assert.equal((await appState('codex', deps)).status, 'Needs reconnect');
        assert.match(await connectApp('codex', deps), /No sign-in needed/);
        const toml = await readFile(join(home, 'config.toml'), 'utf8');
        assert.equal((await appState('codex', deps)).connected, true, 'connected to the local endpoint');
        assert.match(toml, /\[mcp_servers\.other\]\nurl = "https:\/\/other\.example\.com\/mcp"/, 'unrelated servers are kept');
        assert.doesNotMatch(toml, /mcp_servers\.dotbot|aibinator\.env|bot\.example\.com/, 'stale and legacy entries are replaced');
        assert.match(toml, /http_headers = \{ Authorization = "Bearer k{43}" \}/);
        assert.match(await disconnectApp('codex', deps), /disconnected/);
        assert.equal((await appState('codex', deps)).status, 'Not connected');
        assert.match(await readFile(join(home, 'config.toml'), 'utf8'), /mcp_servers\.other/);
        const missing: CodexDeps = { ...deps, codex: () => Promise.reject(new Error('ENOENT')) };
        assert.equal((await appState('codex', missing)).cli, false);
        await assert.rejects(connectApp('codex', missing), /ENOENT/);
        await checkReconnect(deps);
    } finally {
        process.chdir(previous);
    }
}

async function checkReconnect(deps: CodexDeps): Promise<void> {
    let base = endpoint.base;
    const ported: CodexDeps = { ...deps, endpoint: () => Promise.resolve({ ...endpoint, base }) };
    await connectApp('codex', ported);
    const finish = await planReconnect([change('AIBINATOR_PORT')], {}, ported);
    base = 'http://127.0.0.1:8799';
    assert.match(await finish(), /Codex now uses the new port/);
    assert.equal((await appState('codex', ported)).connected, true, 'Codex follows the new port instead of being disconnected');
    await disconnectApp('codex', ported);
    assert.equal(await (await planReconnect([change('AIBINATOR_PORT')], {}, ported))(), '', 'a disconnected Codex is left alone');
    await markWebAdded('chatgpt', 'https://old.example/mcp');
    const address = await planReconnect([change('AIBINATOR_RESOURCE_URL')], { AIBINATOR_RESOURCE_URL: 'https://new.example/mcp' });
    assert.match(await address(), /new address/);
    assert.equal(connectorStatus((await webConnectors()).chatgpt, 'https://new.example/mcp').text, 'Address changed', 'marks are kept');
    assert.match(await (await planReconnect([change('AIBINATOR_RESOURCE_URL')], {}))(), /stop working/);
    await (
        await planReconnect([change('AIBINATOR_AUTH_MODE')], {})
    )();
    assert.deepEqual(await webConnectors(), {}, 'a sign-in change forgets the web connectors');
}

function checkTables(): void {
    const toml = '[a]\nx = 1\n[mcp_servers."aibinator"]\nurl = "u"\n[mcp_servers.aibinator.headers]\nA = "b"\n[b]\ny = 2';
    assert.equal(withoutServers(toml, ['aibinator']), '[a]\nx = 1\n[b]\ny = 2', 'quoted tables and sub-tables are removed');
}

export async function checkApps(): Promise<void> {
    assert.equal(connectorStatus(undefined, 'https://a.example/mcp').current, false);
    assert.equal(connectorStatus('https://a.example/mcp', 'https://a.example/mcp').current, true);
    assert.match(
        connectorStatus('https://a.example/mcp', 'https://b.example/mcp').text,
        /changed/,
        'a new public address flags web connectors',
    );
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-apps-'));
    try {
        checkTables();
        await checkCodex(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
