import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { macServiceStatus } from './mac-service.js';
import { supervisorRunning, windowsServiceInstalled } from './windows-service.js';
import { runFile, type Runner } from './run.js';

export interface ManagedServiceStatus {
    available: boolean;
    installed: boolean;
    active: boolean;
}
export function serviceDescription(state: ManagedServiceStatus): string {
    if (!state.available) return 'unavailable / unverified';
    if (!state.installed) return 'not installed';
    return state.active ? 'active' : 'installed, stopped';
}
export function parseServiceStatus(output: string): ManagedServiceStatus {
    const values = Object.fromEntries(
        output
            .trim()
            .split('\n')
            .map((line) => line.split('=')),
    ) as Record<string, string | undefined>;
    return { available: true, installed: values.LoadState === 'loaded', active: values.ActiveState === 'active' };
}
export async function managedServiceStatus(
    platform = process.platform,
    run: Runner = runFile,
    home = homedir(),
): Promise<ManagedServiceStatus> {
    if (platform === 'win32') return { available: true, installed: await windowsServiceInstalled(run), active: await supervisorRunning() };
    if (platform === 'darwin') return macServiceStatus(home, run);
    try {
        const result = await run('systemctl', ['--user', 'show', 'aibinator.service', '--property=LoadState', '--property=ActiveState'], {
            timeout: 2000,
        });
        return parseServiceStatus(result.stdout);
    } catch {
        return { available: false, installed: false, active: false };
    }
}
export async function bridgeListening(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.AIBINATOR_PORT ?? 8789) });
        const finish = (listening: boolean) => {
            socket.destroy();
            resolve(listening);
        };
        socket.setTimeout(500);
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
    });
}
export function startBlocked(state: ManagedServiceStatus, listening: boolean, runtimeOwner: boolean): boolean {
    return state.active || listening || runtimeOwner;
}
