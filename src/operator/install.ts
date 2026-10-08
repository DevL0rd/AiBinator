import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { loadConfig } from '../core/config.js';
import { readOperatorConfig, writeOperatorConfig } from './config.js';
import { runtimePresent } from './status.js';
import { bridgeListening, managedServiceStatus, startBlocked } from './service-status.js';
import { installWindowsService, requestRestart, startWindowsService, supervisorPidFile, supervisorRunning } from './windows-service.js';
import { waitForFile } from './file-watch.js';
import { installMacService, restartMacService, startMacService } from './mac-service.js';
import { runFile, type Runner } from './run.js';

export interface ServiceHost {
    platform: NodeJS.Platform;
    home: string;
    run: Runner;
}
export const localHost = (): ServiceHost => ({ platform: process.platform, home: homedir(), run: runFile });
const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export function serviceUnit(root: string, node: string, path: string): string {
    if (/[\n\r]/.test(root + path)) throw new Error('The AiBinator folder path and PATH cannot contain line breaks.');
    return `[Unit]\nDescription=AiBinator, the brain for AIBI\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${root}\nEnvironment=${quote(`PATH=${path}`)}\nEnvironment=AIBINATOR_SERVICE=1\nExecStart=${quote(node)} --env-file=${quote(join(root, '.env'))} ${quote(join(root, 'dist/src/main.js'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

const userPath = () =>
    (process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => entry && !entry.includes(`${sep}node_modules${sep}`))
        .filter((entry, index, all) => all.indexOf(entry) === index)
        .join(delimiter);

export async function buildAiBinator(run: Runner = runFile): Promise<void> {
    await run(process.execPath, ['node_modules/typescript/bin/tsc'], { timeout: 180_000 });
}

async function registerService({ platform, home, run }: ServiceHost): Promise<void> {
    if (platform === 'win32') return installWindowsService(process.cwd(), process.execPath, run);
    if (platform === 'darwin') return installMacService(process.cwd(), home, process.execPath, userPath(), run);
    const directory = join(home, '.config/systemd/user');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'aibinator.service'), serviceUnit(process.cwd(), process.execPath, userPath()), {
        mode: 0o600,
    });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', 'aibinator.service']);
}

async function startService({ platform, home, run }: ServiceHost): Promise<void> {
    if (platform === 'darwin') return startMacService(home, run);
    if (platform !== 'win32') {
        await run('systemctl', ['--user', 'start', 'aibinator.service']);
        await run('systemctl', ['--user', 'is-active', '--quiet', 'aibinator.service']);
        return;
    }
    await rm(supervisorPidFile, { force: true });
    const started = waitForFile(supervisorPidFile, 15_000);
    await startWindowsService(process.cwd(), run);
    if (!(await started) || !(await supervisorRunning())) throw new Error('The AiBinator service did not start. See .data/service.log.');
}

export async function installService(host = localHost()): Promise<string> {
    if (host.platform !== 'linux' && host.platform !== 'win32' && host.platform !== 'darwin')
        throw new Error('Automatic service installation supports Linux (systemd), macOS (launchd) and Windows.');
    await loadConfig({ ...process.env, ...parseEnv(await readFile('.env', 'utf8')) });
    await buildAiBinator(host.run);
    await writeOperatorConfig(await readOperatorConfig());
    await registerService(host);
    const state = await managedServiceStatus(host.platform, host.run, host.home);
    if (startBlocked(state, await bridgeListening(), await runtimePresent()))
        return state.active
            ? 'Service installed and enabled; existing managed runtime left running. No restart performed.'
            : 'Installed / enabled, NOT started: existing manual runtime or listener detected. Arrange a safe manual-to-service transition, then start the service. No process was stopped.';
    await startService(host);
    return 'Service installed, enabled and running.';
}

export async function restartService({ platform, home, run } = localHost()): Promise<string> {
    const state = await managedServiceStatus(platform, run, home);
    if (!state.available || !state.installed || !state.active) throw new Error('No active managed service to restart.');
    if (platform === 'win32') {
        await requestRestart();
        return 'Restart requested. AiBinator restarts as soon as its current work is done.';
    }
    if (platform === 'darwin') {
        await restartMacService(run);
        return 'Service restarted; settings applied.';
    }
    await run('systemctl', ['--user', 'restart', 'aibinator.service']);
    await run('systemctl', ['--user', 'is-active', '--quiet', 'aibinator.service']);
    return 'Service restarted; settings applied.';
}
