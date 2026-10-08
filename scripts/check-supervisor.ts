import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { supervise } from '../src/operator/supervisor.js';
import { serviceLogFile, supervisorPidFile } from '../src/operator/windows-service.js';
import { inDirectory, until } from './host-fixture.js';

class FakeRuntime extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
}

async function checkAlreadyRunning(): Promise<void> {
    const exits: number[] = [];
    let started = 0;
    await writeFile(supervisorPidFile, String(process.ppid));
    await supervise({
        start: () => {
            started += 1;
            return new FakeRuntime();
        },
        exit: (code) => exits.push(code),
    });
    assert.deepEqual(exits, [0], 'a second supervisor exits when one is already running');
    assert.equal(started, 0);
    assert.equal(await readFile(supervisorPidFile, 'utf8'), String(process.ppid));
}

async function checkRestartsAndLogs(): Promise<void> {
    const exits: number[] = [];
    const children: FakeRuntime[] = [];
    await writeFile(supervisorPidFile, String(process.pid));
    await writeFile(serviceLogFile, 'hello');
    await supervise({
        start: () => {
            children.push(new FakeRuntime());
            return children.at(-1)!;
        },
        exit: (code) => exits.push(code),
        retryMs: 1,
        logLimit: 10,
    });
    assert.equal(await readFile(supervisorPidFile, 'utf8'), String(process.pid));
    assert.equal(children.length, 1);
    children[0]!.stderr.write('world!');
    await until(() => children[0]!.stderr.readableLength === 0);
    children[0]!.stdout.write('ok');
    await until(() => children[0]!.stdout.readableLength === 0);
    await new Promise((done) => setImmediate(done));
    assert.equal(await readFile(`${serviceLogFile}.old`, 'utf8'), 'hello', 'the log rotates once it reaches the limit');
    assert.equal(await readFile(serviceLogFile, 'utf8'), 'world!ok');
    children[0]!.emit('exit', 1);
    await until(() => children.length === 2);
    assert.deepEqual(exits, [], 'a crashed runtime is restarted');
    children[1]!.emit('exit', null);
    await until(() => children.length === 3);
    children[2]!.emit('exit', 0);
    await until(() => exits.length === 1);
    assert.deepEqual(exits, [0], 'a clean runtime exit stops the supervisor');
    await assert.rejects(access(supervisorPidFile), 'the supervisor removes its pid file on a clean exit');
}

export async function checkSupervisor(directory: string): Promise<void> {
    const root = resolve(directory, 'supervisor');
    await inDirectory(root, async () => {
        await supervise({ start: () => new FakeRuntime(), exit: () => undefined }).then(() => rm(supervisorPidFile));
        await checkAlreadyRunning();
        await checkRestartsAndLogs();
    });
}
