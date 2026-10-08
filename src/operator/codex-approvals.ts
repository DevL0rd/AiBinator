import { z } from 'zod';
import type { ApprovalDecision, ProviderApproval, ProviderRole, ProviderTool } from './provider-adapter.js';
import {
    approvalKey,
    object,
    string,
    sessionParams,
    type Connection,
    type PendingApproval,
    type ProtocolHooks,
    type RecordValue,
    type RequestId,
} from './codex-protocol.js';
import type { OperatorConfig } from './config.js';

const kinds: Record<string, ProviderApproval['kind']> = {
    'item/commandExecution/requestApproval': 'command',
    'item/fileChange/requestApproval': 'file',
    'item/permissions/requestApproval': 'permissions',
    'item/tool/requestUserInput': 'question',
    'mcpServer/elicitation/request': 'elicitation',
};
function permissionSubset(granted: unknown, requested: unknown): boolean {
    if (granted === null || granted === undefined) return true;
    if (Array.isArray(granted)) {
        return (
            Array.isArray(requested) &&
            granted.every((entry) => requested.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)))
        );
    }
    if (typeof granted === 'object') {
        const source = object(requested);
        return Object.entries(object(granted)).every(([key, value]) => Object.hasOwn(source, key) && permissionSubset(value, source[key]));
    }
    return granted === requested || (granted === false && typeof requested === 'boolean');
}
function offeredAnswer(question: RecordValue, values: string[]): boolean {
    if (!Array.isArray(question.options) || question.isOther) return true;
    const labels = question.options.map((option) => string(object(option).label));
    return values.every((value) => labels.includes(value));
}
function questionAnswers(params: RecordValue, decision: ApprovalDecision): unknown {
    const answers: Record<string, { answers: string[] }> = Object.create(null) as Record<string, { answers: string[] }>;
    if (decision.action !== 'allow-once') return { answers };
    if (!decision.answers) throw new Error('Question responses require explicit answers');
    const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
    const questionIds = new Set(questions.map((question) => string(question.id)));
    if (Object.keys(decision.answers).some((id) => !questionIds.has(id))) throw new Error('Unknown question ID');
    for (const question of questions) {
        const id = string(question.id);
        const values = decision.answers[id];
        if (!values || !values.length || values.some((value) => typeof value !== 'string'))
            throw new Error('Each question requires an explicit answer');
        if (!offeredAnswer(question, values)) throw new Error('Answer is not an offered choice');
        answers[id] = { answers: [...values] };
    }
    return { answers };
}
function permissionResult(params: RecordValue, decision: ApprovalDecision): unknown {
    const permissions = decision.action === 'allow-once' ? (decision.permissions ?? params.permissions) : {};
    if (!permissionSubset(permissions, params.permissions)) throw new Error('Permission grant exceeds the request');
    return { permissions, scope: 'turn' };
}
function action(decision: ApprovalDecision): string {
    if (decision.action === 'allow-once') return 'accept';
    return decision.action === 'deny' ? 'decline' : 'cancel';
}
function executionResult(params: RecordValue, decision: ApprovalDecision): unknown {
    const choice = action(decision);
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes(choice))
        throw new Error('Decision is not offered by app-server');
    return { decision: choice };
}
function elicitationResult(params: RecordValue, decision: ApprovalDecision): unknown {
    if (decision.action !== 'allow-once') return { action: action(decision), content: null };
    if (decision.content === undefined && params.mode !== 'url') throw new Error('Accepted elicitation requires explicit content');
    return { action: 'accept', content: decision.content ?? null };
}
export function approvalResult(pending: PendingApproval, decision: ApprovalDecision): unknown {
    switch (pending.request.kind) {
        case 'command':
        case 'file':
            return executionResult(pending.params, decision);
        case 'permissions':
            return permissionResult(pending.params, decision);
        case 'question':
            return questionAnswers(pending.params, decision);
        case 'elicitation':
            return elicitationResult(pending.params, decision);
        default:
            throw new Error('Unsupported approval kind');
    }
}
function makeRequest(connection: Connection, id: RequestId, kind: ProviderApproval['kind'], params: RecordValue): ProviderApproval {
    const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
    return {
        key: approvalKey(connection.epoch, id),
        epoch: connection.epoch,
        sessionId: string(params.threadId),
        turnId: string(params.turnId),
        kind,
        title: string(params.reason) || string(params.message) || `${kind} request`,
        payload: structuredClone(params),
        ...(params.requestedSchema !== undefined ? { schema: structuredClone(params.requestedSchema) } : {}),
        ...(questions.some((question) => question.isSecret === true) ? { secret: true } : {}),
    };
}
export function requestApproval(connection: Connection, id: RequestId, method: string, params: RecordValue, hooks: ProtocolHooks): void {
    const kind = kinds[method];
    const session = connection.sessions.get(string(params.threadId));
    if (!kind || !session) {
        hooks.send({ id, error: { code: -32601, message: 'Unsupported request or unowned thread' } });
        return;
    }
    const turnId = string(params.turnId);
    if (turnId && session.turnId !== turnId) {
        hooks.send({ id, error: { code: -32602, message: 'Request does not belong to active turn' } });
        return;
    }
    if (kind !== 'elicitation' && !turnId) throw new Error('Approval has no turn ID');
    const request = makeRequest(connection, id, kind, params);
    if (connection.approvals.has(request.key) || connection.toolRequests.has(id)) throw new Error('Duplicate server request ID');
    connection.approvals.set(request.key, { id, request, params, answered: false });
    hooks.emit({ type: 'approval.requested', request });
}

function toolSpecs(tools: ProviderTool[]): RecordValue[] {
    const names = new Set<string>();
    return tools.map((tool) => {
        if (!tool.name || names.has(tool.name)) throw new Error('Controller tools need distinct nonempty names');
        names.add(tool.name);
        return { type: 'function', name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) };
    });
}

export function controllerParams(
    config: OperatorConfig,
    input: { role: ProviderRole; sessionId?: string; shared?: boolean },
    tools: ProviderTool[],
): RecordValue {
    const params = sessionParams(config, input.sessionId, input.role, input.shared === true);
    if (input.role === 'controller' && !input.sessionId && tools.length) params.dynamicTools = toolSpecs(tools);
    return params;
}

function toolResult(success: boolean, text: string): RecordValue {
    return { success, contentItems: [{ type: 'inputText', text }] };
}

function controllerTool(connection: Connection, params: RecordValue, tools: ProviderTool[]): ProviderTool | undefined {
    const session = connection.sessions.get(string(params.threadId));
    if (session?.role !== 'controller' || session.turnId !== params.turnId || !string(params.callId) || params.namespace) return undefined;
    return tools.find((tool) => tool.name === params.tool);
}

export function requestTool(connection: Connection, id: RequestId, params: RecordValue, tools: ProviderTool[], hooks: ProtocolHooks): void {
    if (connection.toolRequests.has(id) || connection.approvals.has(approvalKey(connection.epoch, id)))
        throw new Error('Duplicate server request ID');
    const tool = controllerTool(connection, params, tools);
    if (!tool) {
        hooks.send({ id, result: toolResult(false, 'Tool is unavailable for this session or active turn') });
        return;
    }
    const key = JSON.stringify([params.threadId, params.turnId, params.callId]);
    if (connection.toolCalls.has(key)) {
        hooks.send({ id, result: toolResult(false, 'Duplicate tool call was not executed') });
        return;
    }
    const parsed = z.object(tool.inputShape).strict().safeParse(params.arguments);
    if (!parsed.success) {
        hooks.send({ id, result: toolResult(false, 'Tool arguments failed strict validation') });
        return;
    }
    connection.toolCalls.add(key);
    connection.toolRequests.set(id, { sessionId: string(params.threadId), turnId: string(params.turnId) });
    void invokeTool(connection, id, tool, parsed.data, hooks);
}

async function invokeTool(connection: Connection, id: RequestId, tool: ProviderTool, args: unknown, hooks: ProtocolHooks): Promise<void> {
    const request = connection.toolRequests.get(id)!;
    let result: RecordValue;
    try {
        const output = await tool.call(args, request.sessionId);
        result = toolResult(output.success, output.text);
    } catch (error) {
        result = toolResult(false, error instanceof Error ? error.message : 'Controller tool failed');
    }
    if (!connection.alive || connection.toolRequests.get(id) !== request) return;
    connection.toolRequests.delete(id);
    hooks.send({ id, result });
}
