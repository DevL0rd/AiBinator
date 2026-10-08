import { claudeProgram } from './executables.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { dirname, join, resolve } from 'node:path';
import { buildAiBinator } from './install.js';
import { runFile, type Runner } from './run.js';

const marketplace = 'aibinator-local';
const plugin = 'aibinator';
const pluginId = `${plugin}@${marketplace}`;

export interface PluginState {
    cli: boolean;
    marketplace: boolean;
    path?: string;
    installed: boolean;
    enabled: boolean;
}

function pluginFiles(home: string): Record<string, unknown> {
    const description = 'Requests from AIBI arrive in this Claude session through AiBinator, and replies are spoken by AIBI.';
    return {
        '.claude-plugin/marketplace.json': {
            name: marketplace,
            description: 'AiBinator plugins generated on this computer',
            owner: { name: 'AiBinator' },
            plugins: [{ name: plugin, description, source: `./${plugin}` }],
        },
        [`${plugin}/.claude-plugin/plugin.json`]: {
            name: plugin,
            version: '1.0.0',
            description,
            author: { name: 'DevL0rd' },
            keywords: ['aibi', 'robot', 'voice'],
        },
        [`${plugin}/.mcp.json`]: {
            mcpServers: {
                aibinator: {
                    command: process.execPath,
                    args: [join(home, 'dist/src/channel/bridge.js')],
                    env: { AIBINATOR_HOME: home },
                },
            },
        },
    };
}

async function writeIfChanged(path: string, value: unknown): Promise<boolean> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if ((await readFile(path, 'utf8').catch(() => '')) === text) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, text, { mode: 0o600 });
    await replaceFile(`${path}.tmp`, path);
    return true;
}

async function claudeJson(args: string[], run: Runner): Promise<unknown> {
    const claude = await claudeProgram();
    const { stdout } = await run(claude.command, [...claude.args, ...args, '--json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.trim().split('\n').at(-1) ?? '[]';
    return JSON.parse(stdout.trim().startsWith('[') ? stdout : line);
}

export async function pluginState(run: Runner = runFile): Promise<PluginState> {
    try {
        const [plugins, marketplaces] = (await Promise.all([
            claudeJson(['plugin', 'list'], run),
            claudeJson(['plugin', 'marketplace', 'list'], run),
        ])) as [{ id: string; enabled?: boolean }[], { name: string; path?: string }[]];
        const installed = plugins.find((item) => item.id === pluginId);
        const listed = marketplaces.find((item) => item.name === marketplace);
        return {
            cli: true,
            marketplace: Boolean(listed),
            ...(listed?.path ? { path: listed.path } : {}),
            installed: Boolean(installed),
            enabled: installed?.enabled !== false && Boolean(installed),
        };
    } catch {
        return { cli: false, marketplace: false, installed: false, enabled: false };
    }
}

export async function runClaude(args: string[], run: Runner = runFile): Promise<void> {
    const claude = await claudeProgram();
    await run(claude.command, [...claude.args, ...args], { timeout: 120_000 });
}

async function register(root: string, before: PluginState, changed: boolean, run: Runner): Promise<void> {
    if (!before.marketplace) await runClaude(['plugin', 'marketplace', 'add', root, '--scope', 'user'], run);
    else if (changed) await runClaude(['plugin', 'marketplace', 'update', marketplace], run);
    if (!before.installed) await runClaude(['plugin', 'install', pluginId, '--scope', 'user'], run);
    else if (changed) await runClaude(['plugin', 'update', pluginId], run);
    if (before.installed && !before.enabled) await runClaude(['plugin', 'enable', pluginId], run);
}

export async function installPlugin(home = process.cwd(), run: Runner = runFile): Promise<string> {
    const root = resolve(home, '.data/claude-plugin');
    await buildAiBinator(run);
    await access(join(home, 'dist/src/channel/bridge.js'));
    let changed = false;
    for (const [path, value] of Object.entries(pluginFiles(resolve(home))))
        changed = (await writeIfChanged(join(root, path), value)) || changed;
    let before = await pluginState(run);
    if (!before.cli) throw new Error('Claude Code is not installed or not signed in. Install it, run claude once, then try again.');
    if (before.path && resolve(before.path) !== root) {
        await removePlugin(run);
        before = await pluginState(run);
    }
    await register(root, before, changed, run);
    const after = await pluginState(run);
    if (!after.installed || !after.enabled) throw new Error('Claude did not report the AiBinator plugin as installed and enabled.');
    return 'AiBinator plugin installed in Claude Code. Start a Claude session to begin listening.';
}

export async function removePlugin(run: Runner = runFile): Promise<void> {
    const state = await pluginState(run);
    if (state.installed) await runClaude(['plugin', 'uninstall', pluginId], run);
    if (state.marketplace) await runClaude(['plugin', 'marketplace', 'remove', marketplace], run);
}

export async function uninstallPlugin(run: Runner = runFile): Promise<string> {
    if ((await pluginState(run)).installed) await runClaude(['plugin', 'uninstall', pluginId], run);
    if ((await pluginState(run)).installed) throw new Error('Claude Code still lists the AiBinator plugin.');
    return 'AiBinator removed from Claude Code.';
}
