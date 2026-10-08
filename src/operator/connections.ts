import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localEndpoint, type LocalEndpoint } from '../mcp/local-client.js';
import { codexCommand, codexHome, serverBlock, withoutServers, writeCodexConfig } from './codex-config.js';
import { installPlugin, pluginState, runClaude, uninstallPlugin } from './claude-plugin.js';

const exec = promisify(execFile);
const name = 'aibinator';
const stale = [name, 'dotbot'];
export type AppId = 'claude-code' | 'codex';
export const statusHint: Record<string, string> = {
    Connected: 'Everything is set up.',
    'Not connected': 'Press Connect to set it up.',
    'Needs reconnect': 'It points at an old address. Press Connect to fix it.',
    'Not installed': 'Install the app on this computer first.',
};
export const appNames: Record<AppId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
export const responderApps: Partial<Record<string, AppId>> = { 'claude-session': 'claude-code', 'codex-local': 'codex' };
export interface AppState {
    id: AppId;
    cli: boolean;
    connected: boolean;
    status: string;
}
export interface CodexDeps {
    codex(args: string[]): Promise<string>;
    home(): Promise<string>;
    endpoint(): Promise<LocalEndpoint>;
}
const runCodex = async (args: string[]) => {
    const { command, args: prefix, env } = await codexCommand();
    return (await exec(command, [...prefix, ...args], { cwd: tmpdir(), env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
};
const codexDeps: CodexDeps = { codex: runCodex, home: codexHome, endpoint: () => localEndpoint() };

async function codexEntry(deps: CodexDeps): Promise<string | undefined> {
    const list = JSON.parse(await deps.codex(['mcp', 'list', '--json'])) as { name: string; transport?: { url?: string } }[];
    return list.find((item) => item.name === name)?.transport?.url;
}

async function codexState(deps: CodexDeps): Promise<AppState> {
    const url = await codexEntry(deps);
    const local = url === `${(await deps.endpoint()).base}/mcp`;
    if (!url) return { id: 'codex', cli: true, connected: false, status: 'Not connected' };
    return { id: 'codex', cli: true, connected: local, status: local ? 'Connected' : 'Needs reconnect' };
}

async function claudeState(): Promise<AppState> {
    const plugin = await pluginState();
    if (!plugin.cli) return { id: 'claude-code', cli: false, connected: false, status: 'Not installed' };
    const connected = plugin.installed && plugin.enabled;
    return { id: 'claude-code', cli: true, connected, status: connected ? 'Connected' : 'Not connected' };
}

export async function appState(id: AppId, deps = codexDeps): Promise<AppState> {
    try {
        return await (id === 'codex' ? codexState(deps) : claudeState());
    } catch {
        return { id, cli: false, connected: false, status: 'Not installed' };
    }
}

async function connectCodex(deps: CodexDeps): Promise<string> {
    await deps.codex(['--version']);
    const endpoint = await deps.endpoint();
    const url = `${endpoint.base}/mcp`;
    await writeCodexConfig(await deps.home(), (toml) => `${withoutServers(toml, stale)}\n\n${serverBlock(name, url, endpoint.key)}`);
    if ((await codexEntry(deps)) !== url) throw new Error('Codex did not pick up the AiBinator connection. Nothing else was changed.');
    return 'Codex connected to AiBinator on this computer. No sign-in needed.';
}

async function removeClaudeEntries(): Promise<void> {
    const file = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    const config = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { mcpServers?: Record<string, unknown> };
    for (const entry of stale) if (config.mcpServers?.[entry]) await runClaude(['mcp', 'remove', entry, '--scope', 'user']);
}

async function connectClaude(): Promise<string> {
    const message = await installPlugin();
    await removeClaudeEntries();
    return `${message} Every Claude Code session now has the AIBI tools, no sign-in needed.`;
}

export async function connectApp(id: AppId, deps = codexDeps): Promise<string> {
    return id === 'codex' ? connectCodex(deps) : connectClaude();
}

export async function disconnectApp(id: AppId, deps = codexDeps): Promise<string> {
    if (id === 'claude-code') {
        const message = (await pluginState()).installed ? await uninstallPlugin() : 'The local Claude plugin is not installed.';
        await removeClaudeEntries();
        return message;
    }
    await writeCodexConfig(await deps.home(), (toml) => `${withoutServers(toml, stale)}\n`);
    if (await codexEntry(deps)) throw new Error('Codex still lists AiBinator. Remove it from Codex.');
    return 'Codex disconnected from AiBinator.';
}
