import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { finished, verifyChecks, verifyLines } from '../src/operator/onboarding-verify.js';
import { readOperatorConfig, writeOperatorConfig, type OperatingMode } from '../src/operator/config.js';
import { inScratch, withLocal, type LiveFake, liveFake, syncLive } from './onboarding-fakes.js';

const summary = (checks: { label: string; ok: boolean }[]) => checks.map((check) => `${check.ok ? '+' : '-'} ${check.label}`);
const aibiLabels = ['AIBI’s voice has a Gemini key', 'AIBI server is listening', 'DNS server is answering', 'AIBI has called'];

async function select(live: LiveFake, mode: OperatingMode, enabled: boolean): Promise<void> {
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode, enabled });
    syncLive(live);
}

async function checkRunning(live: LiveFake): Promise<void> {
    await select(live, 'manual-mcp', false);
    const offline = await verifyChecks();
    assert.deepEqual(
        summary(offline),
        ['- AiBinator is running', ...aibiLabels.map((label) => `- ${label}`)],
        'another MCP app needs no responder checks',
    );
    assert.equal(finished(offline), false);
    const lines = verifyLines(offline);
    assert.equal(lines[0], '○ AiBinator is running');
    assert.equal(lines[4], '○ AIBI has called (optional)', 'the call from AIBI is optional');
    assert.match(lines.at(-1)!, /^Next: Go back and install the background service/);
    assert.equal(offline[1]!.hint, 'Add a Google Gemini key on the Voice page.');
    await writeFile('.env', 'GEMINI_API_KEY="fixture-gemini-key"\n');
    live.online = true;
    const ready = await verifyChecks('manual-mcp');
    assert.ok(ready.every((check) => check.ok));
    assert.deepEqual(verifyLines(ready).at(-1), 'Everything is connected and working.');
    assert.equal(verifyLines(ready).filter((line) => line.startsWith('✓')).length, 5);
}

async function checkAibi(live: LiveFake): Promise<void> {
    live.aibi = { lastContact: null };
    const waiting = await verifyChecks('manual-mcp');
    assert.equal(finished(waiting), true, 'setup can finish before AIBI calls');
    assert.match(waiting.at(-1)!.hint, /Point AIBI’s DNS at 192\.168\.1\.20/);
    assert.match(verifyLines(waiting).at(-1)!, /^Next: Point AIBI’s DNS/);
    live.aibi = { lastContact: null, address: '' };
    assert.match((await verifyChecks('manual-mcp')).at(-1)!.hint, /DNS at this computer/);
    live.aibi = { proxy: { state: 'failed', error: 'Port 443 is taken' }, dns: { state: 'off' } };
    const broken = await verifyChecks('manual-mcp');
    assert.deepEqual([broken[2]!.ok, broken[2]!.hint], [false, 'Port 443 is taken']);
    assert.equal(broken[3]!.ok, true, 'a switched-off DNS server is fine');
    assert.equal(finished(broken), false);
    live.aibi = { proxy: { state: 'starting' }, dns: { state: 'failed' } };
    const starting = await verifyChecks('manual-mcp');
    assert.match(starting[2]!.hint, /aibinator ports/);
    assert.deepEqual([starting[3]!.ok, starting[3]!.hint], [false, 'Check the AIBI page.']);
    live.aibi = { dns: { state: 'failed', error: 'Port 53 is taken' } };
    assert.equal((await verifyChecks('manual-mcp'))[3]!.hint, 'Port 53 is taken');
    live.aibi = {};
}

async function checkResponder(live: LiveFake): Promise<void> {
    await select(live, 'codex-local', false);
    const waiting = await verifyChecks();
    assert.deepEqual(summary(waiting).slice(0, 3), ['+ AiBinator is running', '- Codex is connected', '- Codex is ready for work']);
    assert.equal(waiting[1]!.hint, 'Codex: Not installed. Go back and connect it.');
    assert.equal(waiting[2]!.start, true, 'the responder can be started from the wizard');
    assert.equal(waiting[2]!.hint, 'Choose Finish to start it.');
    await select(live, 'codex-local', true);
    assert.equal((await verifyChecks())[2]!.ok, true, 'a started responder is ready');
    live.mode = 'off';
    const switching = await verifyChecks('codex-local');
    assert.deepEqual([switching[2]!.ok, switching[2]!.hint], [false, 'AiBinator is switching to it. Check again in a moment.']);
    live.mode = undefined;
    live.blockedReason = 'Waiting for Codex to sign in.';
    const blocked = await verifyChecks('codex-local');
    assert.deepEqual([blocked[2]!.ok, blocked[2]!.hint], [false, 'Waiting for Codex to sign in.'], 'a blocked responder is not ready');
    live.blockedReason = undefined;
    assert.equal((await verifyChecks('claude-session'))[2]!.label, 'Claude Code is ready for work');
}

async function withEmptyPath<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.PATH;
    await mkdir('empty', { recursive: true });
    process.env.PATH = resolve('empty');
    try {
        return await run();
    } finally {
        process.env.PATH = previous;
    }
}

export async function checkOnboardingVerify(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, () =>
            withEmptyPath(async () => {
                await checkRunning(live);
                await checkAibi(live);
                await checkResponder(live);
            }),
        );
        assert.deepEqual(live.probes, [], 'verifying never reaches the internet');
    });
}
