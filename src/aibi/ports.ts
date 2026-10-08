import { access, readFile } from 'node:fs/promises';
import type { Elevated } from '../operator/update-hooks.js';
import { closeFirewall, firewallOpen, openFirewall } from './firewall.js';

const setting = 'net.ipv4.ip_unprivileged_port_start';
const kernelFile = '/proc/sys/net/ipv4/ip_unprivileged_port_start';
export const portsFile = '/etc/sysctl.d/50-aibinator.conf';

async function lowestAllowed(platform = process.platform): Promise<number> {
    if (platform !== 'linux') return 0;
    const value = Number((await readFile(kernelFile, 'utf8').catch(() => '1024')).trim());
    return Number.isFinite(value) ? value : 1024;
}

export async function lowPortsAllowed(lowest: number, platform = process.platform): Promise<boolean> {
    return lowest >= (await lowestAllowed(platform));
}

export async function portsAllowed(lowest: number, platform = process.platform): Promise<boolean> {
    return (await lowPortsAllowed(lowest, platform)) && (await firewallOpen(platform));
}

async function allowLowPorts(elevated: Elevated, lowest: number): Promise<string> {
    if (await lowPortsAllowed(lowest)) return `This computer already lets AiBinator use port ${lowest} and up.`;
    await elevated.sudo(['tee', portsFile], `${setting}=${lowest}\n`);
    await elevated.sudo(['chmod', '644', portsFile]);
    await elevated.sudo(['sysctl', '-w', `${setting}=${lowest}`]);
    return `Programs on this computer may now use port ${lowest} and up without root, so AiBinator can answer AIBI on ports 53, 80 and 443. Saved in ${portsFile}.`;
}

export async function allowPorts(elevated: Elevated, lowest = 53): Promise<string> {
    const low = await allowLowPorts(elevated, lowest);
    const firewall = process.platform === 'linux' ? await openFirewall(elevated) : undefined;
    return firewall ? `${low}\n${firewall}` : low;
}

export async function removePorts(elevated: Elevated): Promise<void> {
    await closeFirewall(elevated);
    const present = await access(portsFile).then(
        () => true,
        () => false,
    );
    if (!present) return;
    await elevated.sudo(['rm', '-f', portsFile]);
    await elevated.sudo(['sysctl', '-w', `${setting}=1024`]);
    await elevated.sudo(['sysctl', '--system']);
}
