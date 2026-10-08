import dgram from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export const aibiHost = 'api.aibipocket.com';

function usableIPv4(address: string): boolean {
    return isIPv4(address) && !address.startsWith('127.') && !address.startsWith('169.254.');
}

function outbound(): Promise<string> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const done = (address = '') => {
            resolve(address);
            try {
                socket.close();
            } catch {
                return;
            }
        };
        socket.once('error', () => done());
        socket.connect(53, '1.1.1.1', () => {
            const address = socket.address().address;
            done(usableIPv4(address) ? address : '');
        });
    });
}

function score(name: string, address: string): number {
    let value = 0;
    if (/wi-?fi|wlan|wlp/i.test(name)) value += 30;
    if (/ethernet|eth|enp|eno/i.test(name)) value += 20;
    if (address.startsWith('192.168.')) value += 10;
    if (address.startsWith('10.')) value += 8;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) value += 6;
    if (/vethernet|virtual|vmware|virtualbox|docker|wsl|hyper-v|virbr|br-|tailscale|zt/i.test(name)) value -= 50;
    return value;
}

function lanAddresses(): { name: string; address: string }[] {
    return Object.entries(networkInterfaces())
        .flatMap(([name, entries]) =>
            (entries ?? [])
                .filter((entry) => entry.family === 'IPv4' && !entry.internal && usableIPv4(entry.address))
                .map((entry) => ({ name, address: entry.address })),
        )
        .sort((a, b) => score(b.name, b.address) - score(a.name, a.address));
}

export async function lanAddress(configured = ''): Promise<string> {
    if (configured) {
        if (!lanAddresses().some((entry) => entry.address === configured))
            throw new Error(`${configured} is not an address of this computer`);
        return configured;
    }
    return (await outbound()) || lanAddresses()[0]?.address || '';
}

export function lanSubnet(address: string): string | undefined {
    const entry = Object.values(networkInterfaces())
        .flat()
        .find((item) => item?.family === 'IPv4' && item.address === address);
    if (!entry?.cidr) return undefined;
    const bits = Number(entry.cidr.split('/')[1]);
    const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0;
    const value = address.split('.').reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0) & mask;
    return `${[24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')}/${bits}`;
}
