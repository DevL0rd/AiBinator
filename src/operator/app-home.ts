import { access, constants, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';

export const keptData = ['.env', 'policy.json', '.data'];
export const installRecordPath = (root: string) => join(root, '.data', 'install.json');

export interface InstallRecord {
    origin: string;
    branch: string;
    node: string;
    nodeVersion: string;
    launcher: string;
    installedAt: string;
}

export function appHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    if (env.AIBINATOR_APP_HOME) return env.AIBINATOR_APP_HOME;
    if (platform === 'win32') {
        if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set, so there is no place to install AiBinator.');
        return win32.join(env.LOCALAPPDATA, 'AiBinator');
    }
    if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'AiBinator');
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'aibinator');
}

export async function installRecord(root = appHome()): Promise<InstallRecord | undefined> {
    try {
        return JSON.parse(await readFile(installRecordPath(root), 'utf8')) as InstallRecord;
    } catch {
        return undefined;
    }
}

const writable = (directory: string) =>
    access(directory, constants.W_OK).then(
        () => true,
        () => false,
    );

export async function launcherDirectory(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home = homedir(),
): Promise<string> {
    if (platform === 'win32') {
        if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set, so the aibinator command has nowhere to go.');
        return win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
    }
    if (platform !== 'darwin') return posix.join(home, '.local', 'bin');
    return macLauncherDirectory(env, home);
}

async function macLauncherDirectory(env: NodeJS.ProcessEnv, home: string): Promise<string> {
    const path = (env.PATH ?? '').split(delimiter);
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local', 'bin')])
        if (path.includes(directory) && (await writable(directory))) return directory;
    throw new Error(
        'None of /opt/homebrew/bin, /usr/local/bin or ~/.local/bin is on your PATH and writable, so the aibinator command cannot be added. Add ~/.local/bin to your PATH and install again.',
    );
}

const shell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function launcherScript(platform: NodeJS.Platform, root: string, node: string): { name: string; text: string } {
    if (platform === 'win32')
        return {
            name: 'aibinator.cmd',
            text: ['@echo off', 'setlocal', `cd /d "${root}" || exit /b 1`, `"${node}" dist\\src\\cli.js %*`, ''].join('\r\n'),
        };
    return {
        name: 'aibinator',
        text: `#!/bin/sh\ncd ${shell(root)} || exit 1\nexec ${shell(node)} dist/src/cli.js "$@"\n`,
    };
}
