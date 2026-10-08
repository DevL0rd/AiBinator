import { statSync, unwatchFile, watch, watchFile as pollStats, type Stats } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

// On macOS fs.watch runs on FSEvents, and libuv restarts its shared stream whenever a watcher in the
// process is added or removed, so a change landing during that restart is never reported. Polling
// stats as a backstop keeps settings, status and policy reloads reliable there.
const pollMs = 500;

const signature = (stats: Stats | undefined) => (stats?.nlink ? `${stats.ino}:${stats.mtimeMs}:${stats.size}` : 'missing');
const currentSignature = (path: string) => signature(statSync(path, { throwIfNoEntry: false }));

// Polls only report a state the watcher has not already reported, so one change is not delivered twice.
function poll(path: string, changed: () => void, reported: () => string, platform: NodeJS.Platform): () => void {
    if (platform !== 'darwin') return () => undefined;
    const listener = (current: Stats) => signature(current) !== reported() && changed();
    pollStats(path, { persistent: false, interval: pollMs }, listener);
    return () => unwatchFile(path, listener);
}

function settledWatch(
    directory: string,
    polled: string,
    matches: (file: string | null) => boolean,
    onChange: () => void,
    settleMs: number,
    platform: NodeJS.Platform,
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reported = currentSignature(polled);
    const settled = () => {
        reported = currentSignature(polled);
        onChange();
    };
    const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(settled, settleMs);
    };
    const watcher = watch(directory, { persistent: false }, (_event, file) => {
        if (matches(file)) changed();
    });
    watcher.on('error', () => undefined);
    const stopPoll = poll(polled, changed, () => reported, platform);
    return () => {
        clearTimeout(timer);
        watcher.close();
        stopPoll();
    };
}

export function watchFile(path: string, onChange: () => void, settleMs = 50, platform = process.platform): () => void {
    const name = basename(path);
    return settledWatch(dirname(path), path, (file) => !file || file === name, onChange, settleMs, platform);
}

export function watchDirectory(directory: string, onChange: () => void, settleMs = 50, platform = process.platform): () => void {
    return settledWatch(directory, directory, () => true, onChange, settleMs, platform);
}

export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
    const exists = () =>
        access(path).then(
            () => true,
            () => false,
        );
    return new Promise((resolve) => {
        let settled = false;
        const finish = (found: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stop();
            resolve(found);
        };
        const check = () => void exists().then((found) => found && finish(true));
        const stop = watchFile(path, check);
        const timer = setTimeout(() => finish(false), timeoutMs);
        check();
    });
}
