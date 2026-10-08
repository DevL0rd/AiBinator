import assert from 'node:assert/strict';
import { createElement } from 'react';
import { Dashboard } from '../src/operator/ui/app.js';
import { Onboarding } from '../src/operator/onboarding.js';
import { stepView, type State } from '../src/operator/onboarding-copy.js';
import { wizardFrame } from '../src/operator/onboarding-view.js';
import { hits } from '../src/operator/ui/canvas.js';
import { called, fakeServices, observed, snapshot, type Calls } from './ui-fixtures.js';
import { inScratch, liveFake, withLocal } from './onboarding-fakes.js';
import { mountTerminal } from './ink-terminal.js';

async function checkDashboardKeys(): Promise<void> {
    const calls: Calls = [];
    const services = fakeServices(calls);
    const screen = mountTerminal(createElement(Dashboard, { initial: snapshot, observed, services }), 0, 0);
    try {
        await screen.waitFor('Responder');
        assert.ok(screen.shown().split('\n').length >= 23, 'an unknown terminal size falls back to 80 × 24');
        screen.send('?');
        await screen.waitFor('Keys');
        screen.send('\x1b');
        await screen.waitFor('Your AIBI, powered by your AI');
        screen.send('7');
        await screen.waitFor('Web connectors');
        screen.send('\x1b[<65;3;6M');
        await screen.waitFor('Background service');
        for (let step = 0; step < 30; step++) {
            screen.send('j');
            await new Promise((resolve) => setImmediate(resolve));
        }
        await screen.waitFor('Trusted proxy addresses');
        assert.ok(!screen.shown().includes('Keeps AiBinator running after you log out'), 'the page scrolls to keep the selection visible');
        assert.ok(called(calls, 'readPanel').length > 0);
    } finally {
        await screen.close();
    }
}

function welcomeButton(columns: number, rows: number): { x: number; y: number } {
    const state: State = { step: 'welcome', input: '', selected: 0, name: '' };
    const button = hits(wizardFrame(stepView(state, 0), columns, rows - 1)).find((hit) => hit.target === 'btn:0');
    assert.ok(button, 'the welcome screen has a button');
    return { x: button.x0, y: button.y };
}

async function checkWizardMouse(directory: string): Promise<void> {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = '';
    try {
        await inScratch(directory, () =>
            withLocal(liveFake(), async () => {
                const screen = mountTerminal(createElement(Onboarding, { onComplete: () => undefined }), 0, 0);
                try {
                    await screen.waitFor('Welcome to AiBinator');
                    screen.send('\x1b');
                    await screen.waitFor('Welcome to AiBinator');
                    const { x, y } = welcomeButton(80, 24);
                    screen.send(`\x1b[<2;${x};${y}M`);
                    screen.send(`\x1b[<0;1;1M`);
                    await screen.waitFor('Welcome to AiBinator');
                    screen.send(`\x1b[<0;${x};${y}M`);
                    await screen.waitFor('What should AIBI call you?');
                } finally {
                    await screen.close();
                }
            }),
        );
    } finally {
        if (previous === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = previous;
    }
}

export async function checkUiApp(directory: string): Promise<void> {
    await checkDashboardKeys();
    await checkWizardMouse(directory);
}
