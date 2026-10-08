import assert from 'node:assert/strict';
import { buttonsFor, choices, count, startable, stepView, textSteps, type State, type Step } from '../src/operator/onboarding-copy.js';
import { assistants } from '../src/operator/ui/status.js';

const blank = (step: Step, patch: Partial<State> = {}): State => ({ step, input: '', selected: 0, name: '', ...patch });
const body = (step: Step, patch: Partial<State> = {}) => stepView(blank(step, patch), 0).body.join('\n');

function checkTitles(): void {
    const titles: [Step, Partial<State>, RegExp, number][] = [
        ['loading', {}, /^Welcome$/, 0],
        ['welcome', {}, /Welcome to AiBinator/, 0],
        ['name', {}, /What should AIBI call you/, 0],
        ['gemini', {}, /AIBI’s voice/, 0],
        ['ai', {}, /Who does the real work/, 1],
        ['password', {}, /sign-in password/, 1],
        ['password-confirm', {}, /Confirm/, 1],
        ['ai-review', {}, /Ready to save/, 1],
        ['connect', { choice: 'codex-local' }, /Connect Codex/, 1],
        ['service', {}, /Install AiBinator/, 2],
        ['ports', {}, /Allow AIBI’s ports/, 3],
        ['aibi', {}, /Point AIBI at this computer/, 3],
        ['verify', {}, /Make sure it works/, 3],
    ];
    for (const [step, patch, title, stage] of titles) {
        const view = stepView(blank(step, patch), 2);
        assert.match(view.title, title, step);
        assert.equal(view.stage, stage, `${step} belongs to stage ${stage}`);
        assert.equal(view.tick, 2);
        assert.ok(view.body.length > 0, `${step} explains itself`);
        assert.equal(Boolean(view.input), textSteps.includes(step), `${step} input`);
    }
    assert.equal(stepView(blank('connect'), 0).title, 'Connect Claude Code', 'Claude Code is the default local app');
    assert.equal(stepView(blank('gemini', { input: 'secret' }), 0).input?.masked, true, 'the Gemini key is hidden');
    assert.equal(stepView(blank('password'), 0).input?.masked, true);
    assert.equal(stepView(blank('password-confirm'), 0).input?.masked, true);
    assert.equal(stepView(blank('name', { input: 'Sam' }), 0).input?.masked, false, 'the name is visible');
}

function checkBodies(): void {
    assert.match(body('gemini'), /aistudio\.google\.com\/apikey/, 'the Gemini step says where to get a key');
    for (const [selected, choice] of choices.entries())
        assert.deepEqual(stepView(blank('ai', { selected }), 0).body, [assistants[choice].blurb], `${choice} blurb`);
    assert.deepEqual(stepView(blank('ai', { selected: 9 }), 0).body, [assistants['claude-session'].blurb]);
    const manual = stepView(blank('ai-review', { choice: 'manual-mcp', evidence: 'http://127.0.0.1:8789/mcp' }), 0).body;
    assert.deepEqual(manual, [
        assistants['manual-mcp'].name,
        'http://127.0.0.1:8789/mcp',
        'Your MCP app connects to AiBinator and answers by itself.',
    ]);
    assert.deepEqual(stepView(blank('ai-review'), 0).body, [assistants['claude-session'].name, '', 'It starts when you finish setup.']);
    assert.match(body('ports'), /aibinator ports/, 'blocked ports name the command that allows them');
    assert.match(body('ports'), /53 \(DNS\), 80 and 443/);
    const ready = stepView(blank('ports', { network: { address: '192.168.1.20', ports: true } }), 0);
    assert.equal(ready.title, 'Ports are ready');
    const pointing = body('aibi', { network: { address: '192.168.1.20', ports: true } });
    assert.match(pointing, /give AIBI \(or your whole network\) 192\.168\.1\.20 as its DNS server/, 'the DNS step names this computer');
    assert.match(pointing, /continues by itself as soon as AIBI calls/);
    assert.match(body('aibi'), /this computer’s address as its DNS server/, 'without an address the step stays generic');
    const contacted = stepView(blank('aibi', { contacted: true }), 0);
    assert.equal(contacted.title, 'AIBI is connected');
    assert.match(contacted.body.join(' '), /AIBI just called AiBinator/);
    assert.deepEqual(stepView(blank('verify'), 0).body, ['Checking that everything works…']);
    const checks = [{ label: 'AiBinator is running', ok: true, hint: '' }];
    assert.deepEqual(stepView(blank('verify', { checks }), 0).body, ['✓ AiBinator is running', 'Everything is connected and working.']);
}

function checkButtons(): void {
    const pending = { label: 'x', ok: false, hint: 'do it' };
    const network = (ports: boolean) => ({ network: { address: '', ports } });
    const cases: [State, string[]][] = [
        [blank('welcome'), ['Begin']],
        [blank('ai-review'), ['Save', 'Back']],
        [blank('connect'), ['Continue']],
        [blank('connect', { error: 'Install failed.' }), ['Retry', 'Skip']],
        [blank('service'), ['Skip', 'Install', 'Back']],
        [blank('ports'), ['Check again', 'Skip']],
        [blank('ports', network(false)), ['Check again', 'Skip']],
        [blank('ports', network(true)), ['Continue']],
        [blank('aibi'), ['Check again', 'Skip for now']],
        [blank('aibi', { contacted: true }), ['Continue']],
        [blank('verify'), ['Check again']],
        [blank('verify', { checks: [] }), ['Finish']],
        [blank('verify', { checks: [pending] }), ['Check again']],
        [blank('name'), []],
        [blank('gemini'), []],
        [blank('loading'), []],
    ];
    for (const [state, buttons] of cases) assert.deepEqual(buttonsFor(state), buttons, state.step);
    assert.equal(startable(undefined), false, 'nothing to start before the checks ran');
    assert.equal(
        startable([
            { ...pending, start: true },
            { ...pending, ok: true },
        ]),
        true,
    );
    assert.equal(startable([{ ...pending, optional: true }]), true, 'an optional check never holds up Finish');
    assert.equal(startable([pending, { ...pending, optional: true }]), false);
}

function checkOptions(): void {
    assert.deepEqual(
        stepView(blank('ai'), 0).options,
        choices.map((choice) => assistants[choice].name),
        'every responder is offered',
    );
    assert.deepEqual(stepView(blank('ai'), 0).tags, [{ text: 'RECOMMENDED', tone: 'good' }, undefined, undefined]);
    assert.equal(count(blank('ai')), choices.length);
    assert.equal(stepView(blank('ports'), 0).options, undefined, 'other steps only have buttons');
    assert.equal(count(blank('service')), 3, 'without options the buttons are counted');
    assert.equal(count(blank('aibi')), 2);
    const view = stepView(blank('welcome', { notice: 'Saved.', error: 'Oops.', busy: 'Working…' }), 0);
    assert.deepEqual([view.notice, view.error, view.busy], ['Saved.', 'Oops.', 'Working…']);
    assert.equal('notice' in stepView(blank('welcome'), 0), false, 'empty messages are left out');
}

export function checkOnboardingCopy(): void {
    checkTitles();
    checkBodies();
    checkButtons();
    checkOptions();
}
