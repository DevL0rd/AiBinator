import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
    checkGeminiKey,
    needsOnboarding,
    needsPassword,
    networkReadiness,
    onboardingPhase,
    saveAi,
    savePassword,
    saveVoice,
    validateAi,
    writePhase,
} from '../src/operator/onboarding-store.js';
import { verifyChecks } from '../src/operator/onboarding-verify.js';
import { readOperatorConfig } from '../src/operator/config.js';
import { portsAllowed } from '../src/aibi/ports.js';
import { inScratch } from './onboarding-fakes.js';

type Output = { stdout: string; stderr: string };
type Call = { command: string; args: string[]; timeout: number };
const key = { GEMINI_API_KEY: 'fixture-gemini-key' };

async function withPath<T>(directory: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.PATH;
    process.env.PATH = resolve(directory);
    try {
        return await run();
    } finally {
        process.env.PATH = previous;
    }
}

async function fakePrograms(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    for (const name of ['codex', 'claude'])
        for (const extension of ['', '.exe']) await writeFile(join(directory, `${name}${extension}`), '', { mode: 0o755 });
}

function runner(calls: Call[], output: Output) {
    return (command: string, args: string[], options: { timeout: number }) => {
        calls.push({ command, args, timeout: options.timeout });
        return Promise.resolve(output);
    };
}

async function checkCliSignIn(): Promise<void> {
    await fakePrograms('bin');
    const calls: Call[] = [];
    const validate = (choice: 'codex-local' | 'claude-session', stdout: string, stderr = '') =>
        withPath('bin', () => validateAi(choice, {}, runner(calls, { stdout, stderr })));
    assert.equal(await validate('codex-local', 'Logged in using ChatGPT'), 'Codex CLI reported authenticated.');
    assert.equal(await validate('codex-local', '', 'Logged in using an API key'), 'Codex CLI reported authenticated.', 'stderr counts too');
    await assert.rejects(validate('codex-local', 'Not logged in'), /codex is unavailable or not authenticated/);
    assert.equal(await validate('claude-session', '{"loggedIn":true}'), 'Claude Code is installed and signed in.');
    assert.equal(await validate('claude-session', '{"authenticated":true}'), 'Claude Code is installed and signed in.');
    await assert.rejects(validate('claude-session', '{"loggedIn":false}'), /claude is unavailable or not authenticated/);
    await assert.rejects(validate('claude-session', 'not json'), /claude is unavailable/, 'unreadable output is not a sign-in');
    assert.deepEqual(
        calls.map((call) => [call.command.replace(/\.exe$/, ''), call.args, call.timeout]),
        [
            ...Array.from({ length: 3 }, () => [resolve('bin', 'codex'), ['login', 'status'], 8000]),
            ...Array.from({ length: 4 }, () => [resolve('bin', 'claude'), ['auth', 'status', '--json'], 8000]),
        ],
        'each provider CLI is asked for its own sign-in status',
    );
    await mkdir('empty', { recursive: true });
    const before = calls.length;
    await assert.rejects(
        withPath('empty', () => validateAi('codex-local', {}, runner(calls, { stdout: '', stderr: '' }))),
        /codex is unavailable/,
    );
    assert.equal(calls.length, before, 'a missing CLI is reported without running anything');
    await writeFile('manual.env', 'AIBINATOR_PORT=9123\n');
    assert.match(
        await validateAi('manual-mcp', { environment: 'manual.env' }),
        /http:\/\/127\.0\.0\.1:9123\/mcp/,
        'MCP apps get the address',
    );
}

async function checkPhases(): Promise<void> {
    assert.equal(await onboardingPhase({ GEMINI_API_KEY: '  ' }, 'marker.json'), 'voice', 'a blank Gemini key starts over');
    assert.equal(await onboardingPhase({}, 'marker.json'), 'voice');
    assert.equal(await onboardingPhase(key, 'missing-marker.json'), 'complete', 'a saved key without a marker is a finished setup');
    assert.equal(await needsOnboarding(key, 'missing-marker.json'), false);
    await writeFile('marker.json', 'not json');
    assert.equal(await onboardingPhase(key, 'marker.json'), 'voice', 'a damaged marker starts over');
    await writeFile('marker.json', '{"phase":"discord"}');
    assert.equal(await onboardingPhase(key, 'marker.json'), 'voice', 'an unknown phase starts over');
    for (const phase of ['ai', 'service', 'aibi', 'verify', 'complete'] as const) {
        await writePhase(phase, 'marker.json');
        assert.equal(await onboardingPhase(key, 'marker.json'), phase);
        assert.equal(await needsOnboarding(key, 'marker.json'), phase !== 'complete');
    }
    await mkdir('folder-marker', { recursive: true });
    await assert.rejects(onboardingPhase(key, 'folder-marker'), 'an unreadable marker is an error, not a fresh start');
}

async function checkGemini(): Promise<void> {
    const seen: { url: string; key: string | null }[] = [];
    const google = (answer: () => Promise<Response>) =>
        ((url: string, init: RequestInit) => {
            seen.push({ url, key: new Headers(init.headers).get('x-goog-api-key') });
            return answer();
        }) as typeof fetch;
    const status = (code: number) => google(() => Promise.resolve(new Response('{}', { status: code })));
    await checkGeminiKey('  fixture-gemini-key  ', status(200));
    assert.deepEqual(seen, [{ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', key: 'fixture-gemini-key' }]);
    await assert.rejects(checkGeminiKey(' short ', status(200)), /does not look like a Gemini API key/);
    assert.equal(seen.length, 1, 'an obviously wrong key is not sent to Google');
    for (const code of [400, 401, 403])
        await assert.rejects(checkGeminiKey('fixture-gemini-key', status(code)), /Google did not accept that key/, `HTTP ${code}`);
    await assert.rejects(checkGeminiKey('fixture-gemini-key', status(503)), /HTTP 503\)\. Try again in a moment/);
    const offline = google(() => Promise.reject(new Error('offline')));
    await assert.rejects(checkGeminiKey('fixture-gemini-key', offline), /Google could not be reached/);
}

async function checkSaveVoice(): Promise<void> {
    const files = { environment: 'voice.env', policy: 'voice-policy.json', marker: 'voice-marker.json' };
    await writeFile('voice.env', 'AIBINATOR_PORT=9000\n');
    await writeFile('voice-policy.json', '{"aibi":{"mode":"passthrough"}}');
    await saveVoice(`  ${'S'.repeat(70)}  `, '  fixture-gemini-key  ', files);
    const environment = parseEnv(await readFile('voice.env', 'utf8'));
    assert.equal(environment.GEMINI_API_KEY, 'fixture-gemini-key', 'the key is trimmed');
    assert.equal(environment.AIBINATOR_POLICY_FILE, 'voice-policy.json');
    assert.equal(environment.AIBINATOR_PORT, '9000', 'other settings are kept');
    assert.equal(environment.AIBINATOR_AUTH_MODE, 'bearer');
    assert.ok((environment.AIBINATOR_MCP_TOKEN ?? '').length >= 32, 'a private MCP key is created');
    const policy = JSON.parse(await readFile('voice-policy.json', 'utf8')) as { ownerName: string; aibi: { mode: string } };
    assert.equal(policy.ownerName, 'S'.repeat(60), 'long names are shortened');
    assert.equal(policy.aibi.mode, 'passthrough', 'the existing policy is kept');
    assert.equal(await onboardingPhase(environment, files.marker), 'ai', 'a restart resumes at the responder');
    await saveVoice('Sam', 'second-gemini-key', files);
    const again = parseEnv(await readFile('voice.env', 'utf8'));
    assert.equal(again.GEMINI_API_KEY, 'second-gemini-key');
    assert.equal(again.AIBINATOR_MCP_TOKEN, environment.AIBINATOR_MCP_TOKEN, 'the MCP key is never replaced');
    assert.equal((await readFile('voice.env', 'utf8')).match(/GEMINI_API_KEY=/g)?.length, 1, 'the key is replaced in place');
}

async function checkNetwork(): Promise<void> {
    await writeFile('network.env', 'AIBINATOR_POLICY_FILE="network-policy.json"\n');
    await writeFile('network-policy.json', JSON.stringify({ aibi: { httpPort: 8080, httpsPort: 8443, dnsPort: 5353 } }));
    const high = await networkReadiness({ environment: 'network.env' });
    assert.equal(high.ports, true, 'ports above 1024 never need permission');
    assert.equal(typeof high.address, 'string');
    await writeFile('network-policy.json', JSON.stringify({ aibi: { lanAddress: '203.0.113.9' } }));
    const standard = await networkReadiness({ environment: 'network.env' });
    assert.equal(standard.address, '', 'an address this computer does not have is not offered');
    assert.equal(standard.ports, await portsAllowed(53), 'AIBI’s own ports follow what this computer allows');
}

async function checkResponderFiles(): Promise<void> {
    const files = { environment: 'responder.env', marker: 'responder-marker.json' };
    await writeFile('responder.env', '');
    assert.equal(await needsPassword(files), false, 'without a public domain no password is needed');
    await writeFile(
        'responder.env',
        'AIBINATOR_RESOURCE_URL="https://bot.example.com/mcp"\nAIBINATOR_OAUTH_DATA_DIR=".data/oauth-wizard"\n',
    );
    assert.equal(await needsPassword(files), true, 'a public domain needs a sign-in password');
    await assert.rejects(savePassword('short', files), /at least 12/);
    await savePassword('fixture-password-long', files);
    assert.equal(await needsPassword(files), false, 'a saved password is enough');
    await saveAi('manual-mcp', files);
    const saved = await readOperatorConfig();
    assert.deepEqual([saved.mode, saved.enabled], ['manual-mcp', false], 'the responder is saved paused');
    const settings = JSON.parse(await readFile(join('.data', 'operator-settings.json'), 'utf8')) as { mode: string };
    assert.equal(settings.mode, 'manual-mcp', 'the setup app sees the same responder');
    assert.equal(await onboardingPhase(key, files.marker), 'service');
}

async function checkLocalApps(): Promise<void> {
    await mkdir('empty', { recursive: true });
    const checks = await withPath('empty', async () => [await verifyChecks('claude-session'), await verifyChecks('codex-local')]);
    for (const [index, name] of ['Claude Code', 'Codex'].entries()) {
        const app = checks[index]![1]!;
        assert.equal(app.label, `${name} is connected`, `${name} must be connected`);
        assert.deepEqual([app.ok, app.hint], [false, `${name}: Not installed. Go back and connect it.`]);
    }
}

export async function checkOnboardingStore(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        await checkCliSignIn();
        await checkPhases();
        await checkGemini();
        await checkSaveVoice();
        await checkNetwork();
        await checkResponderFiles();
        await checkLocalApps();
    });
}
