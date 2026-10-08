import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { advance, resumed } from '../src/operator/onboarding.js';
import type { State } from '../src/operator/onboarding-copy.js';
import { onboardingPhase } from '../src/operator/onboarding-store.js';
import { readOperatorConfig } from '../src/operator/config.js';
import { inScratch, withLocal, type LiveFake, liveFake } from './onboarding-fakes.js';

const start: State = { step: 'welcome', input: '', selected: 0, name: '' };
const press = (state: State, selected = 0, input = state.input) => advance({ ...state, selected, input }, () => undefined);
const phase = async () => onboardingPhase(parseEnv(await readFile('.env', 'utf8').catch(() => '')));
const gemini = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
const highPorts = JSON.stringify({ aibi: { httpPort: 8080, httpsPort: 8443, dnsPort: 5353 } });

async function voice(live: LiveFake): Promise<State> {
    const name = await press(start);
    assert.equal(name.step, 'name', 'Begin asks for a name');
    const key = await press(name, 0, '  Sam  ');
    assert.deepEqual([key.step, key.name], ['gemini', 'Sam'], 'the name is trimmed');
    await assert.rejects(press(key, 0, 'short'), /does not look like a Gemini API key/);
    live.gemini = 401;
    await assert.rejects(press(key, 0, 'fixture-gemini-key'), /Google did not accept that key/);
    assert.equal(await phase(), 'voice', 'a rejected key saves nothing');
    live.gemini = 200;
    const ai = await press(key, 0, ' fixture-gemini-key ');
    assert.equal(ai.step, 'ai');
    assert.equal(ai.notice, 'Gemini key works and is saved.');
    assert.equal(ai.input, '', 'the key is not kept on screen');
    assert.equal(parseEnv(await readFile('.env', 'utf8')).GEMINI_API_KEY, 'fixture-gemini-key');
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { ownerName: string }).ownerName, 'Sam');
    assert.equal(await phase(), 'ai', 'a restart resumes at the responder');
    assert.deepEqual(live.probes, [gemini, gemini], 'only plausible keys are checked with Google');
    return ai;
}

async function responder(ai: State): Promise<State> {
    const review = await press(ai, 2);
    assert.equal(review.step, 'ai-review', 'another MCP app needs no password without a public domain');
    assert.equal(review.choice, 'manual-mcp');
    assert.match(review.evidence ?? '', /http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.equal((await press(review, 1)).step, 'ai', 'Back returns to the responder list');
    const service = await press(review);
    assert.equal(service.step, 'service', 'MCP apps skip the connect step');
    assert.equal((await readOperatorConfig()).mode, 'manual-mcp');
    assert.equal(await phase(), 'service');
    assert.equal((await press(service, 2)).step, 'ai-review', 'Back returns to the review');
    await writeFile('policy.json', highPorts);
    const ports = await press(service);
    assert.equal(ports.step, 'ports', 'Skip moves on to AIBI’s ports');
    assert.equal(ports.network?.ports, true);
    assert.equal(await phase(), 'aibi', 'a restart resumes at AIBI');
    return ports;
}

async function ports(ready: State): Promise<State> {
    const blocked: State = { ...ready, network: { address: '', ports: false } };
    const checked = await press(blocked, 0);
    assert.equal(checked.step, 'aibi', 'Check again moves on once the ports are allowed');
    assert.equal(checked.network?.ports, true);
    await writeFile('policy.json', '{}');
    const again = await press(blocked, 0);
    assert.equal(again.step, again.network?.ports ? 'aibi' : 'ports', 'AIBI’s own ports follow what this computer allows');
    if (!again.network?.ports) assert.match(again.error ?? '', /Run aibinator ports in a terminal/);
    assert.equal((await press(blocked, 1)).step, 'aibi', 'Skip moves on without the ports');
    await writeFile('policy.json', highPorts);
    return press(ready);
}

async function aibi(state: State, live: LiveFake): Promise<State> {
    assert.equal(state.step, 'aibi', 'Continue moves on once the ports are ready');
    const waiting = await press(state, 0);
    assert.equal(waiting.step, 'aibi', 'Check again waits for AIBI to call');
    assert.match(waiting.error ?? '', /AIBI has not called yet/);
    assert.equal(await phase(), 'aibi');
    const skipped = await press(state, 1);
    assert.equal(skipped.step, 'verify', 'AIBI can be connected later');
    const verify = await press({ ...state, contacted: true }, 0);
    assert.equal(verify.step, 'verify', 'a call from AIBI continues');
    assert.equal(await phase(), 'verify');
    assert.deepEqual(
        verify.checks?.map((check) => check.ok),
        [false, true, false, false, false],
        'nothing runs yet, but the Gemini key is saved',
    );
    let completed = 0;
    const blocked = await advance(verify, () => completed++);
    assert.match(blocked.error ?? '', /Not everything is connected yet/);
    assert.equal(completed, 0);
    live.aibi = { lastContact: null };
    live.online = true;
    const done = await advance({ ...blocked, error: undefined }, () => completed++);
    assert.equal(completed, 1, 'finishing calls back once, even before AIBI called');
    assert.equal(done.error, undefined);
    assert.equal(await phase(), 'complete');
    return done;
}

async function passwordResponder(): Promise<void> {
    await writeFile('.env', 'GEMINI_API_KEY="fixture-gemini-key"\nAIBINATOR_RESOURCE_URL="https://bot.example.com/mcp"\n');
    const password = await press({ ...start, step: 'ai' }, 2);
    assert.equal(password.step, 'password', 'a public domain asks for a sign-in password');
    assert.equal(password.choice, 'manual-mcp');
    await assert.rejects(press(password, 0, 'short'), /at least 12/);
    const confirm = await press(password, 0, 'fixture-password-long');
    assert.equal(confirm.step, 'password-confirm');
    assert.equal(confirm.input, '', 'the confirmation starts empty');
    await assert.rejects(press(confirm, 0, 'fixture-password-wrong'), /do not match/);
    const review = await press(confirm, 0, 'fixture-password-long');
    assert.equal(review.step, 'ai-review');
    assert.equal(review.password, undefined, 'the password is not kept in memory');
    assert.equal(review.notice, 'Password saved.');
    assert.match(review.evidence ?? '', /https:\/\/bot\.example\.com\/mcp/, 'the public address is offered too');
    const again = await press({ ...start, step: 'ai' }, 2);
    assert.equal(again.step, 'ai-review', 'a saved password is not asked for again');
}

async function localResponder(): Promise<void> {
    const connect = await press({ ...start, step: 'ai-review', choice: 'codex-local' });
    assert.equal(connect.step, 'connect', 'local responders connect next');
    assert.equal((await readOperatorConfig()).mode, 'codex-local');
    assert.equal((await press(connect)).step, 'service', 'Continue after connecting');
    const failed = { ...connect, error: 'Install failed.' };
    const retry = await press(failed, 0);
    assert.equal(retry.step, 'connect', 'Retry stays to connect again');
    assert.equal(retry.error, undefined);
    assert.equal((await press(failed, 1)).step, 'service', 'Skip moves on without connecting');
    await passwordResponder();
}

function checkResume(): void {
    assert.deepEqual(resumed('voice', 'claude-session'), { step: 'welcome' });
    assert.deepEqual(resumed('complete', 'claude-session'), { step: 'welcome' });
    assert.deepEqual(resumed('ai', 'manual-mcp'), { step: 'ai' });
    assert.deepEqual(resumed('service', 'codex-local'), { step: 'service', choice: 'codex-local' });
    assert.deepEqual(resumed('aibi', 'manual-mcp'), { step: 'ports', choice: 'manual-mcp' }, 'AIBI starts at its ports');
    assert.deepEqual(resumed('verify', 'claude-session'), { step: 'verify', choice: 'claude-session' });
}

export async function checkOnboardingFlow(directory: string): Promise<void> {
    checkResume();
    assert.deepEqual(await press({ ...start, step: 'loading' }), { ...start, step: 'loading' }, 'loading has no action');
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, async () => {
            const ai = await voice(live);
            const ready = await ports(await responder(ai));
            await aibi(ready, live);
        });
    });
    await inScratch(directory, () => withLocal(liveFake(), localResponder));
}
