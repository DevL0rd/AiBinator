import { readFile } from 'node:fs/promises';
import { watchFile } from './file-watch.js';

const read = (path: string) => readFile(path, 'utf8').catch(() => '');

export const restartRequestFile = '.data/service-restart';

export function restartOnChange(paths: string[], whenIdle: () => Promise<void>, restart: () => Promise<void>): () => void {
    if (!process.env.AIBINATOR_SERVICE) return () => undefined;
    let restarting = false;
    const stops = paths.map((path) => {
        const loaded = read(path);
        return watchFile(path, () => {
            void Promise.all([loaded, read(path)]).then(async ([before, now]) => {
                if (restarting || before === now) return;
                restarting = true;
                console.error(`${path} changed; restarting to apply it once idle`);
                await whenIdle();
                await restart();
            });
        });
    });
    return () => stops.forEach((stop) => stop());
}
