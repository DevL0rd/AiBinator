import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appHome, installRecord, installRecordPath, keptData, launcherDirectory, launcherScript, type InstallRecord } from './app-home.js';
import { installService, localHost, restartService, type ServiceHost } from './install.js';
import { managedServiceStatus } from './service-status.js';
import { stopService, unregisterService } from './service-control.js';
import { registerUpdateHook, removeUpdateHook, type Elevated } from './update-hooks.js';
import { allowPorts, removePorts } from '../aibi/ports.js';
import { installPlugin, pluginState, removePlugin } from './claude-plugin.js';

export interface Shell extends Elevated {
    interactive: boolean;
    git(cwd: string, args: string[]): Promise<string>;
    npm(cwd: string, args: string[]): Promise<void>;
}

const exists = (path: string) =>
    access(path).then(
        () => true,
        () => false,
    );

async function npmCli(): Promise<string> {
    const node = dirname(process.execPath);
    const candidates = [
        process.env.npm_execpath,
        join(node, 'node_modules/npm/bin/npm-cli.js'),
        join(node, '../lib/node_modules/npm/bin/npm-cli.js'),
    ];
    for (const candidate of candidates) if (candidate?.endsWith('npm-cli.js') && (await exists(candidate))) return candidate;
    throw new Error(`npm was not found next to ${process.execPath}. Install Node.js with npm and try again.`);
}

function exec(file: string, args: string[], cwd: string, input?: string, interactive = false): Promise<string> {
    return new Promise((done, fail) => {
        const child = spawn(file, args, {
            cwd,
            stdio: [input === undefined && interactive ? 'inherit' : 'pipe', 'pipe', interactive ? 'inherit' : 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.once('error', fail);
        child.once('close', (code) =>
            code === 0 ? done(out) : fail(new Error(`${file} ${args[0] ?? ''} failed: ${(err || out).trim().slice(-600)}`)),
        );
        if (child.stdin) child.stdin.end(input ?? '');
    });
}

export function localShell(interactive: boolean): Shell {
    return {
        interactive,
        git: (cwd, args) => exec('git', args, cwd),
        npm: async (cwd, args) => void (await exec(process.execPath, [await npmCli(), ...args], cwd)),
        sudo: async (args, input) => void (await exec('sudo', interactive ? args : ['-n', ...args], homedir(), input, interactive)),
    };
}

export function httpsRemote(url: string): string {
    if (url.startsWith('git@')) return `https://${url.slice(4).replace(':', '/')}`;
    if (url.startsWith('ssh://git@')) return `https://${url.slice('ssh://git@'.length)}`;
    return url;
}

async function syncCode(shell: Shell, source: string, target: string, notes: string[]): Promise<{ origin: string; branch: string }> {
    const origin = httpsRemote((await shell.git(source, ['remote', 'get-url', 'origin'])).trim());
    const branch = (await shell.git(source, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'HEAD') throw new Error(`${source} is not on a branch. Check out a branch and install again.`);
    if ((await shell.git(source, ['status', '--porcelain', '--untracked-files=no'])).trim())
        notes.push(`${source} has uncommitted changes; only committed work is installed.`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (!(await exists(join(target, '.git')))) {
        await shell.git(target, ['init', '--quiet']);
        await shell.git(target, ['remote', 'add', 'origin', origin]);
    } else await shell.git(target, ['remote', 'set-url', 'origin', origin]);
    await shell.git(target, ['fetch', '--quiet', source, branch]);
    await shell.git(target, ['checkout', '--quiet', '--force', '-B', branch, 'FETCH_HEAD']);
    await shell.git(target, ['fetch', '--quiet', 'origin']);
    await shell.git(target, ['branch', '--quiet', `--set-upstream-to=origin/${branch}`]);
    return { origin, branch };
}

async function moveData(source: string, target: string): Promise<boolean> {
    if ((await exists(join(target, '.env'))) || !(await exists(join(source, '.env')))) return false;
    for (const name of keptData)
        if (await exists(join(source, name)))
            await cp(join(source, name), join(target, name), {
                recursive: true,
                errorOnExist: false,
                filter: (path) => !path.includes(join('.data', 'claude-plugin')),
            });
    return true;
}

async function writeLauncher({ platform, home }: ServiceHost, root: string): Promise<string> {
    const directory = await launcherDirectory(platform, process.env, home);
    const { name, text } = launcherScript(platform, root, process.execPath);
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, text);
    if (platform !== 'win32') await chmod(path, 0o755);
    return path;
}

async function portAccess(shell: Shell): Promise<string> {
    try {
        return await allowPorts(shell);
    } catch (error) {
        if (shell.interactive) throw error;
        return 'AIBI uses ports 53, 80 and 443, which need your password once: run aibinator ports in a terminal.';
    }
}

async function updateHook(shell: Shell, host: ServiceHost, target: string): Promise<string> {
    try {
        return await registerUpdateHook(host.run, shell, target, process.execPath);
    } catch (error) {
        if (shell.interactive) throw error;
        return 'System updates do not update AiBinator yet, because that needs your password: run aibinator install in a terminal once.';
    }
}

export async function installApp(shell: Shell, host: ServiceHost = localHost()): Promise<string[]> {
    const source = process.cwd();
    const target = appHome(host.platform);
    const notes: string[] = [];
    const service = await managedServiceStatus(host.platform, host.run, host.home);
    if (service.active) await stopService(host, source);
    const remote =
        resolve(source) === resolve(target)
            ? {
                  origin: (await shell.git(target, ['remote', 'get-url', 'origin'])).trim(),
                  branch: (await shell.git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
              }
            : await syncCode(shell, source, target, notes);
    if (resolve(source) !== resolve(target) && (await moveData(source, target)))
        notes.push(`Your settings were copied from ${source} to ${target}.`);
    process.chdir(target);
    await shell.npm(target, ['ci', '--no-audit', '--no-fund']);
    if ((await pluginState(host.run)).installed) notes.push(await installPlugin(target, host.run));
    const launcher = await writeLauncher(host, target);
    notes.push(await installService(host));
    if (host.platform === 'linux') notes.push(await updateHook(shell, host, target), await portAccess(shell));
    const record: InstallRecord = {
        ...remote,
        node: process.execPath,
        nodeVersion: process.version,
        launcher,
        installedAt: new Date().toISOString(),
    };
    await writeFile(installRecordPath(target), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return [`AiBinator is installed in ${target}. Run aibinator in a terminal to open its settings.`, ...notes];
}

export interface UpdateState {
    behind: number;
    ahead: number;
    dirty: boolean;
    current: string;
    latest: string;
}

export async function checkForUpdate(shell: Shell, root = appHome()): Promise<UpdateState> {
    await shell.git(root, ['fetch', '--quiet', 'origin']);
    const count = async (range: string) => Number((await shell.git(root, ['rev-list', '--count', range])).trim());
    return {
        behind: await count('HEAD..@{upstream}'),
        ahead: await count('@{upstream}..HEAD'),
        dirty: Boolean((await shell.git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()),
        current: (await shell.git(root, ['rev-parse', '--short', 'HEAD'])).trim(),
        latest: (await shell.git(root, ['rev-parse', '--short', '@{upstream}'])).trim(),
    };
}

export function updateBlocker(state: UpdateState): string | undefined {
    if (state.dirty) return 'The installed copy has local changes, so it was not updated.';
    if (state.ahead) return 'The installed copy has commits that are not on GitHub, so it was not updated.';
    return undefined;
}

async function pullAndBuild(shell: Shell, root: string, state: UpdateState, rebuild: boolean): Promise<void> {
    const blocked = state.behind ? updateBlocker(state) : undefined;
    if (blocked) throw new Error(blocked);
    const before = (await shell.git(root, ['rev-parse', 'HEAD'])).trim();
    if (state.behind) await shell.git(root, ['merge', '--ff-only', '--quiet', '@{upstream}']);
    process.chdir(root);
    const lockChanged = Boolean((await shell.git(root, ['diff', '--name-only', before, 'HEAD', '--', 'package-lock.json'])).trim());
    if (lockChanged || rebuild) await shell.npm(root, ['ci', '--no-audit', '--no-fund']);
    await shell.npm(root, ['run', 'build']);
}

export async function applyUpdate(shell: Shell, host: ServiceHost = localHost()): Promise<string> {
    const root = appHome(host.platform);
    const record = await installRecord(root);
    if (!record) throw new Error(`AiBinator is not installed in ${root}. Run aibinator install first.`);
    const state = await checkForUpdate(shell, root);
    const rebuild = record.nodeVersion !== process.version;
    if (!state.behind && !rebuild) return `AiBinator is up to date (${state.current}).`;
    await pullAndBuild(shell, root, state, rebuild);
    await writeFile(installRecordPath(root), `${JSON.stringify({ ...record, nodeVersion: process.version }, null, 2)}\n`, { mode: 0o600 });
    const service = await managedServiceStatus(host.platform, host.run, host.home);
    const restarted = service.active ? ` ${await restartService(host)}` : '';
    return state.behind
        ? `Updated AiBinator from ${state.current} to ${state.latest}.${restarted}`
        : `Rebuilt AiBinator for Node.js ${process.version}.${restarted}`;
}

async function removeFiles(root: string, purge: boolean): Promise<void> {
    if (purge) return rm(root, { recursive: true, force: true });
    for (const name of await readdir(root).catch(() => []))
        if (!keptData.includes(name)) await rm(join(root, name), { recursive: true, force: true });
}

export async function uninstallApp(shell: Shell, purge: boolean, host: ServiceHost = localHost()): Promise<string[]> {
    const root = appHome(host.platform);
    const record = await installRecord(root);
    process.chdir(homedir());
    await unregisterService(host, root);
    const plugin = await pluginState(host.run);
    if (plugin.path?.startsWith(root)) await removePlugin(host.run);
    if (record?.launcher) await rm(record.launcher, { force: true });
    if (host.platform === 'linux') {
        await removeUpdateHook(shell);
        await removePorts(shell);
    }
    await removeFiles(root, purge);
    return [
        'AiBinator is uninstalled.',
        purge
            ? `Your settings in ${root} were deleted.`
            : `Your settings stay in ${root}; installing again picks them up. Use --purge to delete them too.`,
    ];
}
