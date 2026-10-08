import assert from 'node:assert/strict';
import { VoiceApprovals } from '../src/operator/voice-approvals.js';
import type { ApprovalDecision, ProviderApproval } from '../src/operator/provider-adapter.js';

const approval = (key: string, patch: Partial<ProviderApproval> = {}): ProviderApproval => ({
    key,
    epoch: 'epoch',
    sessionId: 'session',
    turnId: 'turn',
    kind: 'command',
    title: 'Run test command',
    payload: { command: 'npm test' },
    ...patch,
});

function harness() {
    const notes: { origin: string; note: string }[] = [];
    const decisions: { key: string; decision: ApprovalDecision; origin: string }[] = [];
    const state = { failing: false };
    const approvals = new VoiceApprovals(
        (origin, note) => notes.push({ origin, note }),
        (key, decision, origin) => {
            if (state.failing) return Promise.reject(new Error('provider gone'));
            decisions.push({ key, decision, origin });
            return Promise.resolve();
        },
    );
    const asked = async (request: ProviderApproval): Promise<string> => {
        await approvals.request(request, 'origin-event');
        return /\[Question ([0-9a-f]+)\]/.exec(notes.at(-1)!.note)![1]!;
    };
    return { approvals, notes, decisions, state, asked };
}

async function checkPermissions(): Promise<void> {
    const { approvals, notes, decisions, state, asked } = harness();
    const allow = await asked(approval('rpc-1'));
    assert.equal(notes[0]!.origin, 'origin-event');
    assert.match(
        notes[0]!.note,
        /needs permission: Run test command\. Command: npm test\..*answer_request/,
        'the request is told to the voice',
    );
    await assert.rejects(approvals.answer(allow, 'what is this'), /allow once, deny, or cancel/);
    assert.equal(approvals.waiting, 1, 'an unclear answer keeps the request waiting');
    assert.equal(await approvals.answer(allow, 'Yes, go ahead'), 'passed on; the work continues');
    assert.deepEqual(decisions.at(-1), { key: 'rpc-1', decision: { action: 'allow-once' }, origin: 'origin-event' });
    await assert.rejects(approvals.answer(allow, 'yes'), /no longer waiting/, 'an answered request cannot be answered again');
    assert.equal(await approvals.answer(await asked(approval('rpc-2')), "no, don't"), 'passed on: deny');
    assert.equal(await approvals.answer(await asked(approval('rpc-3')), 'cancel it'), 'passed on: cancel');
    const permissions = { network: true };
    await approvals.answer(await asked(approval('rpc-4', { kind: 'permissions', payload: { permissions } })), 'allow');
    assert.deepEqual(decisions.at(-1)!.decision, { action: 'allow-once', permissions }, 'granted permissions are passed on');
    state.failing = true;
    const retry = await asked(approval('rpc-5'));
    await assert.rejects(approvals.answer(retry, 'yes'), /provider gone/);
    assert.equal(approvals.waiting, 1, 'a failed resolve keeps the request pending');
    state.failing = false;
    await approvals.answer(retry, 'yes');
    assert.equal(decisions.at(-1)!.key, 'rpc-5');
    await assert.rejects(approvals.answer('ffffff', 'yes'), /no longer waiting/, 'an unknown id is refused');
}

async function checkQuestions(): Promise<void> {
    const { approvals, notes, decisions, asked } = harness();
    const payload = { questions: [{ id: 'q1', question: 'Which option?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] };
    const byLabel = await asked(approval('q-1', { kind: 'question', payload }));
    assert.match(notes.at(-1)!.note, /Which option\? Options: Alpha, Beta\./);
    await assert.rejects(approvals.answer(byLabel, 'neither'), /pick one of: Alpha, Beta/);
    await approvals.answer(byLabel, 'beta please');
    assert.deepEqual(decisions.at(-1)!.decision, { action: 'allow-once', answers: { q1: ['Beta'] } });
    await approvals.answer(await asked(approval('q-2', { kind: 'question', payload })), 'number 1');
    assert.deepEqual(decisions.at(-1)!.decision, { action: 'allow-once', answers: { q1: ['Alpha'] } }, 'options are picked by number');
    const claude = { input: { questions: [{ question: 'Name?' }] } };
    await approvals.answer(await asked(approval('q-3', { kind: 'question', payload: claude })), ' Robo ');
    assert.deepEqual(decisions.at(-1)!.decision, { action: 'allow-once', answers: { 'Name?': ['Robo'] } }, 'free answers are kept');
    const secret = { questions: [{ question: 'Password?', isSecret: true }] };
    assert.throws(() => approvals.request(approval('q-4', { kind: 'question', payload: secret }), 'origin-event'), /Secret/);
    assert.throws(() => approvals.request(approval('s-1', { secret: true }), 'origin-event'), /Secret input/);
    assert.throws(() => approvals.request(approval('e-1', { kind: 'elicitation' }), 'origin-event'), /cannot be answered out loud/);
    assert.equal(approvals.waiting, 0, 'requests that cannot be asked out loud are never left waiting');
}

async function checkInvalidation(): Promise<void> {
    const { approvals, asked } = harness();
    const first = await asked(approval('rpc-1'));
    const replaced = await asked(approval('rpc-1'));
    assert.equal(approvals.waiting, 1, 'asking again for the same request replaces the earlier question');
    await assert.rejects(approvals.answer(first, 'yes'), /no longer waiting/);
    approvals.invalidate('rpc-1');
    await assert.rejects(approvals.answer(replaced, 'yes'), /no longer waiting/, 'a request resolved elsewhere is withdrawn');
    await asked(approval('rpc-2'));
    await asked(approval('rpc-3'));
    approvals.invalidateAll();
    assert.equal(approvals.waiting, 0);
}

export async function checkProviderApproval(): Promise<void> {
    await checkPermissions();
    await checkQuestions();
    await checkInvalidation();
}
