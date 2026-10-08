import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexProgram } from './executables.js';

export function codexHome(): Promise<string> {
    return Promise.resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
}

export interface CodexCli {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}

export async function codexCommand(): Promise<CodexCli> {
    return { ...(await codexProgram()), env: { ...process.env, CODEX_HOME: await codexHome() } };
}

const tableName = (header: string) => header.replace(/"/g, '');

export function withoutServers(toml: string, names: string[]): string {
    let skipping = false;
    const kept = toml.split('\n').filter((line) => {
        const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
        if (header)
            skipping = names.some(
                (name) => [`mcp_servers.${name}`].includes(tableName(header)) || tableName(header).startsWith(`mcp_servers.${name}.`),
            );
        return !skipping;
    });
    return kept.join('\n').trimEnd();
}

export function serverBlock(name: string, url: string, key: string): string {
    return `[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${key}`)} }\n`;
}

export async function writeCodexConfig(home: string, update: (toml: string) => string): Promise<void> {
    const path = join(home, 'config.toml');
    const original = await readFile(path, 'utf8').catch(() => '');
    await mkdir('.data/setup-backups', { recursive: true, mode: 0o700 });
    await writeFile(`.data/setup-backups/${Date.now()}-codex-config.json`, JSON.stringify({ path, original }), { mode: 0o600 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(`${path}.aibinator.tmp`, update(original), { mode: 0o600, flush: true });
    await replaceFile(`${path}.aibinator.tmp`, path);
}
