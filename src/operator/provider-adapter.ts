import type { OperatorConfig } from './config.js';
import type { z } from 'zod';

export type ProviderRole = 'controller' | 'worker';
export type ProviderSession = { id: string };
export type ProviderTurn = { turnId: string };
export type ProviderReconciliation = {
    sessionId: string;
    state: 'idle' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'interrupted' | 'unknown';
    turnId?: string;
    text?: string;
    reason?: string;
};
export type ApprovalDecision =
    | { action: 'allow-once'; answers?: Record<string, string[]>; content?: unknown; permissions?: unknown }
    | { action: 'deny' }
    | { action: 'cancel' };

export type ProviderApproval = {
    key: string;
    epoch: string;
    sessionId: string;
    turnId: string;
    kind: 'command' | 'file' | 'permissions' | 'question' | 'elicitation' | 'tool';
    title: string;
    payload: unknown;
    schema?: unknown;
    secret?: boolean;
};

export type ProviderEvent =
    | { type: 'connected'; epoch: string }
    | { type: 'disconnected'; epoch: string; reason: string }
    | { type: 'session'; sessionId: string; resumed: boolean }
    | { type: 'turn.started'; sessionId: string; turnId: string }
    | { type: 'progress'; sessionId: string; turnId: string; text: string; activity?: boolean }
    | { type: 'final'; sessionId: string; turnId: string; text: string }
    | { type: 'turn.failed'; sessionId: string; turnId: string; reason: string }
    | { type: 'approval.requested'; request: ProviderApproval }
    | { type: 'approval.resolved'; key: string; epoch: string }
    | { type: 'context'; sessionId: string; percent: number }
    | { type: 'image'; sessionId: string; path?: string; data?: string }
    | { type: 'usage'; windows: UsageWindow[] };
export type ProviderNotice = Extract<ProviderEvent, { type: 'context' | 'image' | 'usage' }>;
export const isNotice = (event: ProviderEvent): event is ProviderNotice =>
    event.type === 'context' || event.type === 'image' || event.type === 'usage';

export type UsageWindow = { label: string; usedPercent: number; resetsAt?: string };

export type ProviderTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    inputShape: z.ZodRawShape;
    call(args: unknown, sessionId: string): Promise<{ success: boolean; text: string }>;
};
export type ProviderHooks = { onEvent(event: ProviderEvent): Promise<void>; tools?: ProviderTool[] };
export interface ProviderAdapter {
    connect(config: OperatorConfig, hooks: ProviderHooks): Promise<void>;
    openSession(input: { role: ProviderRole; conversationKey: string; sessionId?: string; shared?: boolean }): Promise<ProviderSession>;
    startTurn(sessionId: string, input: { text: string; originEventId: string; taskId?: string }): Promise<ProviderTurn>;
    steer(sessionId: string, turnId: string, text: string): Promise<void>;
    interrupt(sessionId: string, turnId: string): Promise<void>;
    resolveApproval(key: string, decision: ApprovalDecision): Promise<void>;
    reconcile?(sessionId: string, turnId?: string): Promise<ProviderReconciliation>;
    closeSession?(sessionId: string): Promise<void>;
    compact?(sessionId: string): Promise<void>;
    usage?(): Promise<UsageWindow[]>;
    close(): Promise<void>;
}
