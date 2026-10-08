import { readFile } from 'node:fs/promises';

export const runtimeLockFile = '.data/runtime.lock';

export async function runtimePresent(): Promise<boolean> {
    try {
        const pid = Number((await readFile(runtimeLockFile, 'utf8')).trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
