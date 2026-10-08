import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireRuntime } from '../src/core/runtime.js';

type Promises = typeof import('node:fs/promises');
const fs = createRequire(import.meta.url)('node:fs/promises') as Promises;
const lock = join('.data', 'runtime.lock');

async function patched<K extends keyof Promises>(name: K, replacement: Promises[K], action: () => Promise<void>): Promise<void> {
    const original = fs[name];
    fs[name] = replacement;
    syncBuiltinESMExports();
    try {
        await action();
    } finally {
        fs[name] = original;
        syncBuiltinESMExports();
    }
}

const exists = (file: string) =>
    access(file).then(
        () => true,
        () => false,
    );

async function checkInaccessible(): Promise<void> {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    await patched(
        'open',
        () => Promise.reject(denied),
        async () => {
            await assert.rejects(acquireRuntime(), (error: Error) => {
                assert.match(error.message, /Runtime lock is inaccessible/);
                assert.equal(error.cause, denied);
                return true;
            });
        },
    );
}

async function checkUnknownAge(): Promise<void> {
    await writeFile(lock, '');
    await patched('stat', (() => Promise.reject(new Error('gone'))) as Promises['stat'], async () => {
        const release = await acquireRuntime();
        assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid), 'an empty lock of unknown age is reclaimed');
        await release();
        await release();
        assert.equal(await exists(lock), false, 'releasing twice is harmless');
    });
}

async function checkWriteFailure(): Promise<void> {
    const realOpen = fs.open;
    let handle: FileHandle | undefined;
    const failing = async (...args: Parameters<Promises['open']>) => {
        handle = await realOpen(...args);
        handle.writeFile = () => Promise.reject(new Error('disk full'));
        return handle;
    };
    await patched('open', failing, async () => {
        await assert.rejects(acquireRuntime(), /disk full/);
    });
    assert.ok(handle);
    await assert.rejects(handle.stat(), 'the half-written lock handle is closed');
    assert.equal(await exists(lock), false, 'a lock that could not be written is removed');
}

export async function checkRuntimeLock(directory: string): Promise<void> {
    const previous = process.cwd();
    const home = await mkdtemp(join(directory, 'runtime-'));
    process.chdir(home);
    try {
        await mkdir('.data', { recursive: true });
        await checkInaccessible();
        await checkUnknownAge();
        await checkWriteFailure();
    } finally {
        process.chdir(previous);
    }
}
