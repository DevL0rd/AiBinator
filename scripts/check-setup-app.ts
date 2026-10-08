import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { useEffect } from 'react';
import { Text, useApp } from 'ink';
import { h } from '../src/operator/ui/render.js';
import { runSetup, type SetupApp } from '../src/operator/setup-app.js';
import type { Observations } from '../src/operator/ui/model.js';
import { inDirectory, withEnv } from './host-fixture.js';
import { observed } from './ui-fixtures.js';

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
    isTTY = true;
    columns = 100;
    rows = 40;
    writes: string[] = [];
    override _write(chunk: Buffer, _encoding: string, done: () => void) {
        this.writes.push(String(chunk));
        done();
    }
}

interface Visit {
    screens: string[];
    observedAt: string[];
    screen: Screen;
}

function fakes(visit: Visit, tty: boolean): Partial<SetupApp> {
    const screen = visit.screen;
    screen.isTTY = tty;
    let observedCount = 0;
    return {
        stdin: new Keyboard() as unknown as NodeJS.ReadStream,
        stdout: screen as unknown as NodeJS.WriteStream,
        observe: () => Promise.resolve<Observations>({ ...observed, observedAt: `observation ${++observedCount}` }),
        Dashboard: function Dashboard(props) {
            const { exit } = useApp();
            useEffect(() => {
                visit.screens.push('dashboard');
                visit.observedAt.push(props.observed.observedAt);
                exit();
            }, [exit, props.observed.observedAt]);
            return h(Text, null, 'dashboard');
        },
        Onboarding: function Onboarding({ onComplete }) {
            useEffect(() => {
                visit.screens.push('onboarding');
                onComplete();
            }, [onComplete]);
            return h(Text, null, 'onboarding');
        },
    };
}

async function visit(tty: boolean, key?: string): Promise<Visit & { printed: string[] }> {
    const seen: Visit = { screens: [], observedAt: [], screen: new Screen() };
    const printed: string[] = [];
    const { log } = console;
    console.log = (...parts: unknown[]) => printed.push(parts.join(' '));
    try {
        await withEnv({ GEMINI_API_KEY: key, AIBINATOR_POLICY_FILE: undefined }, () => runSetup(fakes(seen, tty)));
    } finally {
        console.log = log;
    }
    return { ...seen, printed };
}

export async function checkSetupApp(directory: string): Promise<void> {
    await inDirectory(resolve(directory, 'setup-app'), async () => {
        const plain = await visit(false);
        assert.deepEqual(plain.screens, [], 'without a terminal nothing is rendered');
        assert.deepEqual(plain.screen.writes, []);
        const summary = JSON.parse(plain.printed.join('\n')) as Record<string, unknown>;
        assert.deepEqual(Object.keys(summary), ['saved', 'live', 'service']);
        assert.deepEqual(summary.live, observed.live);
        assert.deepEqual(summary.service, observed.service);
        const first = await visit(true);
        assert.deepEqual(first.screens, ['onboarding', 'dashboard'], 'a first run starts with onboarding');
        assert.deepEqual(first.observedAt, ['observation 2'], 'the dashboard opens with fresh observations');
        assert.equal(first.screen.writes[0], '\x1b[?1049h\x1b[?25l');
        assert.equal(first.screen.writes.at(-1), '\x1b[?25h\x1b[?1049l', 'the terminal is restored');
        const returning = await visit(true, 'configured-gemini-key');
        assert.deepEqual(returning.screens, ['dashboard'], 'a saved Gemini key opens the dashboard');
        assert.deepEqual(returning.observedAt, ['observation 1']);
        assert.equal(returning.screen.writes.at(-1), '\x1b[?25h\x1b[?1049l');
    });
}
