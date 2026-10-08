import type { ContextUsage, MessageQueue } from './claude-stream.js';
import type { ProviderApproval, ProviderReconciliation, ProviderRole } from './provider-adapter.js';
import type { ClaudePermissionResult, ClaudeQuery } from './claude-protocol.js';

export type TurnState = {
    id: string;
    text: string;
    originEventId: string;
    taskId?: string;
    state: ProviderReconciliation['state'];
    resultText?: string;
    reason?: string;
};
export type Resolution = (value: ClaudePermissionResult) => void;
export type PendingApproval = {
    epoch: string;
    sessionId: string;
    turnId: string;
    input: Record<string, unknown>;
    resolve: Resolution;
    detach(): void;
};

export type SessionState = {
    id: string;
    role: ProviderRole;
    queue: MessageQueue;
    query: ClaudeQuery;
    turns: TurnState[];
    history: Map<string, TurnState>;
    current?: TurnState;
    resumed: boolean;
    stream: Promise<void>;
    closed: boolean;
    usage?: ContextUsage;
};

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function approvalKind(toolName: string): ProviderApproval['kind'] {
    if (toolName === 'AskUserQuestion') return 'question';
    if (toolName === 'Bash') return 'command';
    if (['Edit', 'Write', 'NotebookEdit'].includes(toolName)) return 'file';
    return 'tool';
}
