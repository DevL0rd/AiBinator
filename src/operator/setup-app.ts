import { stdin, stdout } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { useState, type FunctionComponent } from 'react';
import { render } from 'ink';
import { h } from './ui/render.js';
import { Dashboard } from './ui/app.js';
import { observations } from './ui/observe.js';
import type { Observations } from './ui/model.js';
import { readPanel } from './panel-store.js';
import { Onboarding } from './onboarding.js';
import { needsOnboarding } from './onboarding-store.js';

export interface SetupApp {
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WriteStream;
    observe: () => Promise<Observations>;
    Dashboard: FunctionComponent<Parameters<typeof Dashboard>[0]>;
    Onboarding: FunctionComponent<Parameters<typeof Onboarding>[0]>;
}

const defaults: SetupApp = { stdin, stdout, observe: () => observations(), Dashboard, Onboarding };

export async function runSetup(options: Partial<SetupApp> = {}): Promise<void> {
    const app = { ...defaults, ...options };
    await mkdir('.data', { recursive: true, mode: 0o700 });
    const firstRun = await needsOnboarding(process.env);
    let snapshot = await readPanel();
    let observed = await app.observe();

    function Setup() {
        const [ready, setReady] = useState(!firstRun);
        if (ready) return h(app.Dashboard, { initial: snapshot, observed });
        return h(app.Onboarding, {
            onComplete: () => {
                void Promise.all([readPanel(), app.observe()]).then(([nextSnapshot, nextObserved]) => {
                    snapshot = nextSnapshot;
                    observed = nextObserved;
                    setReady(true);
                });
            },
        });
    }

    if (!app.stdin.isTTY || !app.stdout.isTTY) {
        console.log(JSON.stringify({ saved: snapshot.documents.operator, live: observed.live, service: observed.service }, null, 2));
        return;
    }
    app.stdout.write('\x1b[?1049h\x1b[?25l');
    try {
        const ink = render(h(Setup), {
            stdin: app.stdin,
            stdout: app.stdout,
            exitOnCtrlC: false,
            patchConsole: true,
        });
        await ink.waitUntilExit();
    } finally {
        app.stdout.write('\x1b[?25h\x1b[?1049l');
    }
}
