import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localKeyMatches, loadLocalKey, loopbackHost } from '../src/mcp/local-key.js';
import { recoverController } from '../src/operator/controller-recovery.js';
import { ControllerStore, type ControllerState } from '../src/operator/controller-state.js';
import type { ProviderAdapter, ProviderEvent, ProviderReconciliation } from '../src/operator/provider-adapter.js';

type Proof = Omit<ProviderReconciliation, 'sessionId'> & { sessionId?: string };

function adapter(proofs: Record<string, Proof>, renamed = false): ProviderAdapter {
    return {
        openSession: (input: { sessionId?: string }) => Promise.resolve({ id: renamed ? 'replacement' : input.sessionId! }),
        reconcile: (sessionId: string, turnId?: string) => Promise.resolve({ sessionId, turnId, ...proofs[sessionId]! }),
    } as unknown as ProviderAdapter;
}

const conversation = (key: string, state: 'idle' | 'busy', sessionId?: string, turnId?: string) => ({
    key,
    originEventId: `event-${key}`,
    actorId: 'actor',
    channelId: 'channel',
    seen: {},
    state,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
});

const task = (id: string, state: 'running' | 'approval' | 'queued', sessionId?: string, turnId?: string) => ({
    id,
    conversationKey: 'conversation',
    originEventId: `event-${id}`,
    prompt: 'work',
    state,
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
});

async function seededStore(file: string): Promise<{ store: ControllerStore; generation: number }> {
    const store = new ControllerStore(file);
    await store.update((state) => {
        state.conversations.push(
            conversation('fresh', 'busy'),
            conversation('done', 'busy', 's-done', 'u-done'),
            conversation('busy', 'busy', 's-busy', 'u-busy'),
            conversation('rest', 'busy', 's-rest', 'u-rest'),
            conversation('quiet', 'idle', 's-quiet', 'u-quiet'),
            conversation('gone', 'busy', 's-gone', 'u-gone'),
        );
        state.tasks.push(
            task('unstarted', 'running', 's-unstarted'),
            task('failed', 'running', 's-failed', 'u-failed'),
            task('stopped', 'approval', 's-stopped', 'u-stopped'),
            task('asking', 'running', 's-asking', 'u-asking'),
            task('lost', 'running', 's-lost', 'u-lost'),
            task('moved', 'running', 's-moved', 'u-moved'),
            task('vague', 'running', 's-vague', 'u-vague'),
            task('waiting', 'queued'),
        );
    });
    return { store, generation: await store.acquire() };
}

const find = <T extends { id?: string; key?: string }>(items: T[], name: string) => items.find((item) => (item.id ?? item.key) === name)!;

function checkRecovered(state: ControllerState, events: ProviderEvent[]): void {
    assert.deepEqual(events, [
        { type: 'final', sessionId: 's-done', turnId: 'u-done', text: 'All done.' },
        { type: 'turn.failed', sessionId: 's-failed', turnId: 'u-failed', reason: 'failed' },
        { type: 'turn.failed', sessionId: 's-stopped', turnId: 'u-stopped', reason: 'user stopped it' },
    ]);
    assert.equal(find(state.conversations, 'fresh').state, 'idle', 'an unstarted conversation becomes idle');
    assert.equal(find(state.conversations, 'busy').state, 'busy');
    assert.equal(find(state.conversations, 'rest').state, 'idle');
    assert.equal(find(state.conversations, 'quiet').state, 'idle');
    const gone = find(state.conversations, 'gone');
    assert.deepEqual([gone.state, gone.turnId], ['idle', undefined], 'an unknown conversation turn is released');
    const unstarted = find(state.tasks, 'unstarted');
    assert.deepEqual([unstarted.state, unstarted.sessionId], ['queued', undefined], 'an unstarted task is queued again');
    assert.equal(find(state.tasks, 'asking').state, 'approval');
    assert.equal(find(state.tasks, 'moved').state, 'recovering', 'a proof for another session is ignored');
    assert.equal(find(state.tasks, 'vague').state, 'recovering', 'a completed proof without a turn changes nothing');
    assert.equal(find(state.tasks, 'waiting').state, 'queued');
    const lost = find(state.tasks, 'lost');
    assert.equal(lost.state, 'failed');
    assert.match(lost.result ?? '', /restarted while this was in progress/);
    assert.deepEqual(
        state.outbox.map((item) => [item.eventId, item.key]),
        [
            ['event-gone', 'controller-recovery-s-gone-1-0'],
            ['event-lost', 'controller-recovery-s-lost-1-0'],
        ],
        'lost work is reported back to its origin',
    );
}

async function checkControllerRecovery(directory: string): Promise<void> {
    const { store, generation } = await seededStore(join(directory, 'recovery.json'));
    assert.equal(generation, 1);
    const events: ProviderEvent[] = [];
    const proofs: Record<string, Proof> = {
        's-done': { state: 'completed', text: 'All done.' },
        's-busy': { state: 'running' },
        's-rest': { state: 'idle' },
        's-failed': { state: 'failed' },
        's-stopped': { state: 'interrupted', reason: 'user stopped it' },
        's-asking': { state: 'waiting-approval' },
        's-lost': { state: 'unknown' },
        's-gone': { state: 'unknown' },
        's-moved': { state: 'running', sessionId: 'someone-else' },
        's-vague': { state: 'completed', turnId: undefined },
    };
    await recoverController(adapter(proofs), store, generation, (event) => Promise.resolve(void events.push(event)));
    checkRecovered(store.snapshot(), events);

    const { store: other, generation: next } = await seededStore(join(directory, 'renamed.json'));
    await assert.rejects(
        recoverController(adapter(proofs, true), other, next, () => Promise.resolve()),
        /changed conversation identity/,
    );
    const before = other.snapshot();
    await recoverController({} as ProviderAdapter, other, next, () => Promise.resolve());
    assert.deepEqual(other.snapshot(), before, 'adapters without reconciliation leave state alone');
    await assert.rejects(
        recoverController(adapter(proofs), other, next + 1, () => Promise.resolve()),
        /lease generation changed/,
    );
}

async function checkLocalKey(directory: string): Promise<void> {
    const path = join(directory, 'keys', 'local.key');
    const key = await loadLocalKey(path);
    assert.match(key, /^[\w-]{43}$/);
    assert.equal(await readFile(path, 'utf8'), `${key}\n`);
    assert.equal(await loadLocalKey(path), key, 'an existing key is reused');
    await writeFile(path, 'too-short\n');
    const rotated = await loadLocalKey(path);
    assert.notEqual(rotated, key, 'a truncated key is replaced');
    assert.equal(rotated.length, 43);
    await mkdir(join(directory, 'keys', 'folder.key'), { recursive: true });
    await assert.rejects(loadLocalKey(join(directory, 'keys', 'folder.key')), (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');

    assert.equal(loopbackHost('127.0.0.1:8789', 8789), true);
    assert.equal(loopbackHost('localhost:8789', 8789), true);
    assert.equal(loopbackHost('localhost:9999', 8789), false);
    assert.equal(loopbackHost('aibinator.example:8789', 8789), false);
    assert.equal(loopbackHost(undefined, 8789), false);
    assert.equal(localKeyMatches(`Bearer ${rotated}`, rotated), true);
    assert.equal(localKeyMatches(`Bearer ${key}`, rotated), false);
    assert.equal(localKeyMatches(`Basic ${rotated}`, rotated), false);
    assert.equal(localKeyMatches(`Bearer ${rotated} extra`, rotated), false);
    assert.equal(localKeyMatches(undefined, rotated), false);
    assert.equal(localKeyMatches(`Bearer ${rotated}`, undefined), false);
}

export async function checkRecovery(directory: string): Promise<void> {
    await checkControllerRecovery(directory);
    await checkLocalKey(directory);
}
