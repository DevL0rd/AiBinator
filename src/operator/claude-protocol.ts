import { claudeExecutable } from './executables.js';

/** Minimal public surface used from @anthropic-ai/claude-agent-sdk.
 * Kept structural so tests can inject a zero-network implementation.
 */
export type ClaudeUserMessage = {
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id?: string;
};

export type ClaudePermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

export type ClaudePermissionContext = {
    signal: AbortSignal;
    suggestions?: unknown[];
};

export type ClaudeQueryOptions = {
    cwd: string;
    pathToClaudeCodeExecutable?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    systemPrompt?: { type: 'preset'; preset: 'claude_code'; append: string; snapshot: true };
    resume?: string;
    sessionId?: string;
    mcpServers?: Record<string, unknown>;
    canUseTool(toolName: string, input: Record<string, unknown>, context: ClaudePermissionContext): Promise<ClaudePermissionResult>;
};

export type ClaudeMessage = Record<string, unknown> & {
    type?: string;
    subtype?: string;
    session_id?: string;
    result?: string;
    message?: { content?: unknown[]; model?: string; usage?: Record<string, number> };
};

export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
    interrupt(): Promise<void>;
    close(): void;
}

export type ClaudeQueryFactory = (input: { prompt: AsyncIterable<ClaudeUserMessage>; options: ClaudeQueryOptions }) => ClaudeQuery;

type ClaudeToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ClaudeToolDefinition = unknown;
export type ClaudeToolFactory = (
    name: string,
    description: string,
    inputShape: Record<string, unknown>,
    handler: (args: unknown) => Promise<ClaudeToolResult>,
) => ClaudeToolDefinition;
export type ClaudeMcpFactory = (input: { name: string; version: string; tools: ClaudeToolDefinition[] }) => unknown;

export async function loadClaudeQuery(): Promise<ClaudeQueryFactory> {
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
        query: ClaudeQueryFactory;
    };
    const executable = await claudeExecutable();
    return (input) => sdk.query({ ...input, options: { ...input.options, pathToClaudeCodeExecutable: executable } });
}

export async function loadClaudeMcp(): Promise<{ createSdkMcpServer: ClaudeMcpFactory; tool: ClaudeToolFactory }> {
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
        createSdkMcpServer: ClaudeMcpFactory;
        tool: ClaudeToolFactory;
    };
    return { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool };
}
