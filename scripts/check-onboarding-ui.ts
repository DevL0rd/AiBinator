import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { Onboarding } from '../src/operator/onboarding.js';
import { onboardingPhase } from '../src/operator/onboarding-store.js';
import { readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { inScratch, withLocal, type LiveFake, liveFake } from './onboarding-fakes.js';

class Keyboard extends PassThrough {
    isTTY = true;
    setRawMode() {
        return this;
    }
    ref() {
        return this;
    }
    unref() {
        return this;
    }
}

class Screen extends Writable {
    columns = 100;
    rows = 40;
    frame = '';
    override _write(chunk: Buffer, _encoding: string, done: () => void) {
        this.frame = String(chunk);
        done();
    }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(screen: Screen, text: string): Promise<void> {
    for (let attempt = 0; attempt < 1000 && !screen.frame.includes(text); attempt++) await pause();
    assert.ok(screen.frame.includes(text), `expected the wizard to show “${text}”:\n${screen.frame}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
}

type Keys = (text: string) => Promise<void>;

async function wizard(run: (keys: Keys, screen: Screen) => Promise<void>): Promise<number> {
    let completed = 0;
    const keyboard = new Keyboard();
    const screen = new Screen();
    const terminal = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const app = render(createElement(Onboarding, { onComplete: () => completed++ }), {
        stdin: keyboard as unknown as NodeJS.ReadStream,
        stdout: screen as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    try {
        await run(async (text) => {
            const before = screen.frame;
            keyboard.write(text);
            for (let attempt = 0; attempt < 50 && screen.frame === before; attempt++) await pause();
            await new Promise((resolve) => setTimeout(resolve, 100));
        }, screen);
    } finally {
        app.unmount();
        app.cleanup();
        if (terminal) Object.defineProperty(process.stdin, 'isTTY', terminal);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    return completed;
}

async function withKey<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = key;
    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
}

async function firstSteps(live: LiveFake, keys: Keys, screen: Screen): Promise<void> {
    await until(screen, 'Welcome to AiBinator');
    await keys('\x1b[B');
    await keys('\r');
    await until(screen, 'What should AIBI call you?');
    await keys('\x1b');
    await until(screen, 'Welcome to AiBinator');
    await keys('\r');
    await until(screen, 'What should AIBI call you?');
    await keys('Sam');
    await keys('\r');
    await until(screen, 'AIBI’s voice');
    live.gemini = 403;
    await keys('fixture-gemini-key');
    assert.ok(!screen.frame.includes('fixture-gemini-key'), 'the key is hidden while typed');
    await keys('\r');
    await until(screen, 'Google did not accept that key');
    live.gemini = 200;
    await keys('\r');
    await until(screen, 'Who does the real work?');
    await until(screen, 'Gemini key works and is saved.');
    await keys('\x03');
}

async function connectAibi(live: LiveFake): Promise<number> {
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode: 'manual-mcp' });
    await writeFile(join('.data', 'onboarding.json'), JSON.stringify({ phase: 'aibi' }));
    await writeFile('policy.json', JSON.stringify({ aibi: { httpPort: 8080, httpsPort: 8443, dnsPort: 5353 } }));
    live.aibi = { lastContact: null };
    live.online = true;
    return wizard(async (keys, screen) => {
        await until(screen, 'Allow AIBI’s ports');
        await keys('\r');
        await until(screen, 'Point AIBI at this computer');
        live.aibi = {};
        await until(screen, 'AIBI is connected');
        await keys('\r');
        await until(screen, '✓ AIBI has called');
        await until(screen, 'Everything is connected and working.');
        await keys('\r');
    });
}

async function finishVerify(live: LiveFake): Promise<number> {
    live.online = false;
    await writeFile(join('.data', 'onboarding.json'), JSON.stringify({ phase: 'verify' }));
    return wizard(async (keys, screen) => {
        await until(screen, '○ AiBinator is running');
        live.online = true;
        await until(screen, '✓ AiBinator is running');
        await keys('\r');
    });
}

export async function checkOnboardingUi(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, async () => {
            await withKey('', () => wizard((keys, screen) => firstSteps(live, keys, screen)));
            assert.match(await readFile('.env', 'utf8'), /GEMINI_API_KEY="fixture-gemini-key"/);
            await withKey('fixture-gemini-key', async () => {
                assert.equal(await connectAibi(live), 1, 'a call from AIBI leads straight to a finished setup');
                assert.equal(await finishVerify(live), 1, 'the checks update by themselves and Finish completes setup');
            });
            assert.equal(await onboardingPhase({ GEMINI_API_KEY: 'fixture-gemini-key' }), 'complete');
        });
    });
}
