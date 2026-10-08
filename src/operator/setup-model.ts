import ipaddr from 'ipaddr.js';
import { readStatusFile, statusFile } from './status-file.js';
import { watchFile } from './file-watch.js';
import { runtimePresent } from './status.js';
import { localModes, type OperatorConfig, type OperatingMode } from './config.js';
import type { AibiService } from '../aibi/service.js';

export const isLocal = (mode: OperatingMode) => localModes.includes(mode);

function localAddress(host: string): boolean {
    return (
        !host.includes('.') ||
        /(^|\.)(localhost|local|internal|test)$/.test(host) ||
        (ipaddr.isValid(host) && ipaddr.parse(host).range() !== 'unicast')
    );
}

export function publicEndpoint(value: string): string {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const localHost = localAddress(host);
    const credentials = Boolean(url.username || url.password);
    if (url.protocol !== 'https:' || credentials || url.search || url.hash || localHost)
        throw new Error('Use a public HTTPS domain without credentials, query or fragment.');
    if (url.pathname === '/') url.pathname = '/mcp';
    return url.href;
}
export function endpointError(value: string): string | undefined {
    try {
        publicEndpoint(value);
    } catch {
        return 'Use a public HTTPS domain, e.g. bot.example.com. Not a local address.';
    }
}
export function timeoutError(value: string): string | undefined {
    if (!/^\d+$/.test(value) || Number(value) < 30 || Number(value) > 1800) return 'Use a whole number from 30 to 1800 seconds.';
}
export interface LiveSetupStatus {
    operator: {
        mode: string;
        appliedConfigAt: string | null;
        activeEventId?: string | null;
        blockedReason?: string | null;
        supportedConfigVersion?: number;
    };
    aibi: ReturnType<AibiService['status']>;
    settings?: { applied: string | null; failed: string | null; error: string | null };
}
export async function liveSetupStatus(): Promise<LiveSetupStatus | null> {
    if (!(await runtimePresent())) return null;
    const status = (await readStatusFile().catch(() => null)) as LiveSetupStatus | null;
    return status?.operator && status.aibi ? status : null;
}
export function activationBlock(config: OperatorConfig, live: LiveSetupStatus | null, ready: boolean): string | undefined {
    if (!live) return 'Live status unavailable. Start the bridge or verify access before activating.';
    if (live.operator.activeEventId) return 'A local request is running. Wait before changing responders.';
    if (!ready) return 'Complete prerequisites first, or save settings paused.';
}

export function waitForLiveStatus(ready: (status: LiveSetupStatus) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stop();
            resolve(value);
        };
        const check = () => void liveSetupStatus().then((status) => status && ready(status) && finish(true));
        const stop = watchFile(statusFile, check);
        const timer = setTimeout(() => finish(false), timeoutMs);
        check();
    });
}
