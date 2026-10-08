import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/operator/claude-adapter.js';
import type { ClaudeQueryFactory, ClaudeUserMessage } from '../src/operator/claude-protocol.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { ConversationController } from '../src/operator/controller.js';
import { ControllerStore } from '../src/operator/controller-state.js';
import type { ProviderEvent } from '../src/operator/provider-adapter.js';
import { FakeQuery, waitFor, type FakeCall } from './check-claude-adapter.js';

const config = { ...defaultOperatorConfig(), mode: 'claude-session' as const, workspace: '/workspace' };
const event = (id: string) => ({
    id,
    text: id,
    kind: 'voice' as const,
    conversation: 'aibinator',
    cursor: 1,
    receivedAt: new Date().toISOString(),
});
const settle = async (predicate: () => boolean): Promise<void> => {
    for (let index = 0; index < 2000 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), 'background Claude did not settle');
};

function queries(calls: FakeCall[]): ClaudeQueryFactory {
    return ({ prompt, options }) => {
        const inputs: ClaudeUserMessage[] = [];
        const query = new FakeQuery(prompt, options, inputs);
        calls.push({ options, inputs, query });
        return query;
    };
}

async function checkWarmConversation(directory: string): Promise<void> {
    const calls: FakeCall[] = [];
    const sent: string[] = [];
    const adapter = new ClaudeAdapter(() => Promise.resolve(queries(calls)));
    const controller = new ConversationController(
        adapter,
        config,
        new ControllerStore(join(directory, 'claude-controller.json')),
        (_id, content) => {
            sent.push(content);
            return Promise.resolve();
        },
        () => Promise.resolve(),
        { sessionIdleMs: 300 },
    );
    await controller.start();
    await controller.ingest(event('first'));
    await settle(() => sent.includes('done:first'));
    await controller.ingest(event('second'));
    await settle(() => sent.includes('done:second'));
    assert.equal(calls.length, 1, 'the Claude query stays warm between turns');
    assert.equal(calls[0]!.query.closed, 0);
    await settle(() => calls[0]!.query.closed === 1);
    await controller.ingest(event('third'));
    await settle(() => sent.includes('done:third'));
    assert.equal(calls.length, 2, 'an idle conversation reopens after the idle timeout');
    assert.equal(calls[1]!.options.resume, calls[0]!.options.sessionId, 'the reopened query resumes the same conversation');
    await controller.reset();
    await settle(() => calls[1]!.query.closed === 1);
    await controller.stop();
}

async function checkMainThreadContext(): Promise<void> {
    const calls: FakeCall[] = [];
    const events: ProviderEvent[] = [];
    const adapter = new ClaudeAdapter(() => Promise.resolve(queries(calls)));
    await adapter.connect(config, {
        onEvent: (item) => {
            events.push(item);
            return Promise.resolve();
        },
    });
    const session = await adapter.openSession({ role: 'controller', conversationKey: 'context' });
    await adapter.startTurn(session.id, { text: 'busy', originEventId: 'context' });
    await waitFor(() => calls[0]!.inputs.length === 1);
    const query = calls[0]!.query;
    const usage = { input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000, output_tokens: 5_000 };
    query.push({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', usage, content: [] } });
    query.push({ type: 'assistant', parent_tool_use_id: 'agent', message: { model: 'claude-haiku', usage: { input_tokens: 190_000 } } });
    const modelUsage = { 'claude-opus-5-5': { contextWindow: 1_000_000 }, 'claude-haiku': { contextWindow: 200_000 } };
    query.push({ type: 'result', subtype: 'success', result: 'done', modelUsage });
    await waitFor(() => events.some((item) => item.type === 'context'));
    assert.deepEqual(
        events.filter((item) => item.type === 'context'),
        [{ type: 'context', sessionId: session.id, percent: 15 }],
        'only main-thread input, cache read and cache creation tokens count against the main model window',
    );
    query.releaseBusy!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((item) => item.type === 'context').length, 1, 'no model window match means no context percentage');
    await adapter.close();
}

export async function checkClaudeController(directory: string): Promise<void> {
    await checkWarmConversation(directory);
    await checkMainThreadContext();
}
