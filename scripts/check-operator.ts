import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { defaultOperatorConfig, readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { activationBlock, endpointError, publicEndpoint, timeoutError } from '../src/operator/setup-model.js';
import { parseServiceStatus, startBlocked } from '../src/operator/service-status.js';
import { OperatorService } from '../src/operator/service.js';
import { Memory } from '../src/aibi/memory.js';
import { aibiStatus, fixture } from './fixtures.js';

function checkReadiness(): void {
    const absent = parseServiceStatus('LoadState=not-found\nActiveState=inactive\n');
    const stopped = parseServiceStatus('LoadState=loaded\nActiveState=inactive\n');
    const active = parseServiceStatus('LoadState=loaded\nActiveState=active\n');
    assert.equal(absent.installed, false);
    assert.equal(stopped.installed, true);
    assert.equal(stopped.active, false);
    assert.equal(active.active, true);
    assert.equal(startBlocked(absent, true, false), true, 'manual listener prevents managed start');
    assert.equal(startBlocked(absent, false, true), true, 'live manual PID prevents managed start');
    assert.equal(startBlocked(active, false, false), true, 'existing managed service is not restarted on install');
    assert.equal(startBlocked(stopped, false, false), false);
}

async function checkUnavailable(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-service-'));
    const previous = process.cwd();
    process.chdir(directory);
    try {
        await writeOperatorConfig({ ...defaultOperatorConfig(), mode: 'codex-local', enabled: true, exclusiveLocal: false });
        const f = fixture(join(directory, 'journal.json'));
        const service = new OperatorService(f.queue, f.bridge, new Memory());
        service.start();
        const notified = () => f.spoken.some((item) => item.text.startsWith('Assistant unavailable: Exclusive local ownership'));
        for (let index = 0; index < 100 && !notified(); index++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(notified(), 'a request that arrived before start is answered with why the assistant is unavailable');
        assert.equal(service.available(), false);
        assert.equal(service.working(), false);
        await assert.rejects(async () => service.answer('abc', 'yes'), /No question is waiting/);
        await service.stop();
    } finally {
        process.chdir(previous);
        await rm(directory, { recursive: true, force: true });
    }
}

export async function checkOperator(): Promise<void> {
    await checkUnavailable();
    assert.equal(defaultOperatorConfig().workspace, homedir());
    checkReadiness();
    assert.equal(publicEndpoint('bot.example.com'), 'https://bot.example.com/mcp');
    for (const bad of [
        'http://bot.example.com',
        'localhost',
        '127.0.0.1',
        '10.0.0.1',
        'https://u:p@bot.example.com',
        'https://bot.example.com/?token=x',
    ])
        assert.ok(endpointError(bad), bad);
    assert.equal(timeoutError('600'), undefined);
    for (const bad of ['0', '1801', '3.5', 'abc']) assert.ok(timeoutError(bad));
    const live = { operator: { mode: 'disabled', activeEventId: null, appliedConfigAt: null }, aibi: aibiStatus() };
    assert.equal(
        activationBlock({ ...defaultOperatorConfig(), mode: 'codex-local' }, live, true),
        undefined,
        'connected wake-ups never block a local responder',
    );
    assert.equal(activationBlock({ ...defaultOperatorConfig(), mode: 'manual-mcp' }, live, true), undefined);
    assert.match(activationBlock(defaultOperatorConfig(), null, true)!, /unavailable/);
    assert.match(
        activationBlock(defaultOperatorConfig(), { ...live, operator: { ...live.operator, activeEventId: 'active' } }, true)!,
        /running/,
    );
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-operator-'));
    try {
        const path = join(directory, 'operator.json');
        assert.equal((await readOperatorConfig(path)).mode, 'claude-session', 'Claude Code is the default responder');
        const config = { ...defaultOperatorConfig(), mode: 'codex-local' as const, enabled: true };
        await writeOperatorConfig(config, path);
        assert.equal((await readOperatorConfig(path)).mode, 'codex-local');
        assert.equal((await readFile(path, 'utf8')).includes('token'), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
