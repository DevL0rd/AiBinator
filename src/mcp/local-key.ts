import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const localKeyPath = '.data/local.key';
export const localPrincipalId = 'local:owner';
const digest = (value: string) => createHash('sha256').update(value).digest();

export async function loadLocalKey(path = localKeyPath): Promise<string> {
    try {
        const key = (await readFile(path, 'utf8')).trim();
        if (key.length >= 43) return key;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32).toString('base64url');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600, flag: 'w' });
    return key;
}

export function loopbackHost(host: string | undefined, port: number): boolean {
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function localKeyMatches(header: string | undefined, key: string | undefined): boolean {
    const match = /^Bearer ([^\s]{1,8192})$/.exec(header ?? '');
    return Boolean(key && match?.[1] && timingSafeEqual(digest(match[1]), digest(key)));
}
