import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';

const file = '.data/runtime.lock';

function running(pid: number): boolean {
    if (!pid || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function claim() {
    try {
        return await open(file, 'wx', 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Runtime lock is inaccessible', { cause: error });
        const pid = Number(await readFile(file, 'utf8').catch(() => ''));
        const age = Date.now() - ((await stat(file).catch(() => undefined))?.mtimeMs ?? 0);
        if (running(pid) || (!pid && age < 10_000))
            throw new Error(`AiBinator is already running${pid ? ` (process ${pid})` : ''}`, { cause: error });
        await unlink(file);
        return open(file, 'wx', 0o600);
    }
}

export async function acquireRuntime(): Promise<() => Promise<void>> {
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const handle = await claim();
    try {
        await handle.writeFile(String(process.pid));
    } catch (error) {
        await handle.close();
        await unlink(file);
        throw error;
    }
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(file);
    };
}
