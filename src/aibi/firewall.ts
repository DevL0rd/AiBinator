import { readFile } from 'node:fs/promises';
import type { Elevated } from '../operator/update-hooks.js';
import { lanAddress, lanSubnet } from './network.js';

const tag = 'AiBinator';
const hexTag = Buffer.from(tag).toString('hex');

interface Files {
    config: string;
    rules: string;
}

const ufwFiles: Files = { config: '/etc/ufw/ufw.conf', rules: '/etc/ufw/user.rules' };

async function text(path: string): Promise<string | undefined> {
    return readFile(path, 'utf8').catch(() => undefined);
}

async function ufwEnabled(files: Files): Promise<boolean> {
    return /^\s*ENABLED\s*=\s*yes\s*$/im.test((await text(files.config)) ?? '');
}

function ourRules(rules: string): string[][] {
    return rules
        .split('\n')
        .filter((line) => line.startsWith('### tuple ###') && line.includes(`comment=${hexTag}`))
        .map((line) => line.slice('### tuple ###'.length).trim().split(/\s+/));
}

export async function firewallOpen(platform = process.platform, files = ufwFiles): Promise<boolean> {
    if (platform !== 'linux' || !(await ufwEnabled(files))) return true;
    const rules = await text(files.rules);
    if (rules === undefined) return true;
    const protocols = new Set(ourRules(rules).map(([, protocol]) => protocol));
    return protocols.has('tcp') && protocols.has('udp');
}

export async function openFirewall(elevated: Elevated, files = ufwFiles): Promise<string | undefined> {
    if (await firewallOpen('linux', files)) return undefined;
    const subnet = lanSubnet(await lanAddress());
    if (!subnet) throw new Error('No network address was found for this computer, so its firewall was not opened for AIBI.');
    await elevated.sudo(['ufw', 'allow', 'from', subnet, 'to', 'any', 'port', '53,80,443', 'proto', 'tcp', 'comment', tag]);
    await elevated.sudo(['ufw', 'allow', 'from', subnet, 'to', 'any', 'port', '53', 'proto', 'udp', 'comment', tag]);
    return `The ufw firewall now lets your network (${subnet}) reach AiBinator on ports 53, 80 and 443.`;
}

export async function closeFirewall(elevated: Elevated, files = ufwFiles): Promise<void> {
    const rules = await text(files.rules);
    if (!rules) return;
    for (const [action = '', protocol = '', port = '', , , source = ''] of ourRules(rules))
        await elevated.sudo(['ufw', 'delete', action, 'from', source, 'to', 'any', 'port', port, 'proto', protocol]);
}
