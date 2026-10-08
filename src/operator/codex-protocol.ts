import { spawn } from 'node:child_process';
import { roleInstructions } from './manager-guide.js';
import type { CodexCli } from './codex-config.js';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { codexChoice, type OperatorConfig } from './config.js';
import type { ProviderApproval, ProviderEvent, ProviderRole, ProviderSession } from './provider-adapter.js';

export type RecordValue = Record<string, unknown>;
export type RequestId = string | number;
export type CodexTransport = {
    stdin: Writable;
    stdout: Readable;
    stderr?: Readable;
    onError(listener: (error: Error) => void): void;
    onExit(listener: (reason: string) => void): void;
    stop(): Promise<void>;
};
export type CodexAdapterOptions = {
    spawnTransport: (config: OperatorConfig) => CodexTransport;
    requestTimeoutMs?: number;
    maxLineBytes?: number;
};
type PendingCall = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
export type SessionState = {
    role: ProviderRole;
    conversationKey: string;
    starting: boolean;
    turnId?: string;
    messages: Map<string, { text: string; phase?: string }>;
    completed: Set<string>;
    resumed: boolean;
    submitted: boolean;
};
export type PendingApproval = {
    id: RequestId;
    request: ProviderApproval;
    params: RecordValue;
    answered: boolean;
};
export type Connection = {
    epoch: string;
    transport: CodexTransport;
    alive: boolean;
    ready: boolean;
    buffer: string;
    pending: Map<RequestId, PendingCall>;
    approvals: Map<string, PendingApproval>;
    sessions: Map<string, SessionState>;
    openings: Map<string, Promise<ProviderSession>>;
    deferred: Map<string, RecordValue[]>;
    toolRequests: Map<RequestId, { sessionId: string; turnId: string }>;
    toolCalls: Set<string>;
};

export const object = (value: unknown): RecordValue =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
export const string = (value: unknown): string => (typeof value === 'string' ? value : '');
export const idValue = (value: unknown): value is RequestId =>
    typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
export const approvalKey = (epoch: string, id: RequestId): string => `${epoch}:${typeof id}:${JSON.stringify(id)}`;
export const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }];
export const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const finalText = (items: unknown): string => {
    const messages = Array.isArray(items) ? items.map(object).filter((item) => item.type === 'agentMessage') : [];
    const finals = messages.filter((item) => item.phase === 'final_answer');
    const fallback = messages.filter((item) => !item.phase);
    return (finals.length ? finals : fallback).map((item) => string(item.text)).join('\n\n');
};
export function localTransport(config: OperatorConfig, cli: CodexCli): CodexTransport {
    const child = spawn(cli.command, [...cli.args, 'app-server', '--listen', 'stdio://'], {
        cwd: config.workspace,
        env: cli.env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onError: (listener) => {
            child.on('error', listener);
        },
        onExit: (listener) => {
            child.on('close', (code, signal) => listener(`Codex app-server closed (${signal ?? code ?? 'unknown'})`));
        },
        stop: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
                child.once('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
                child.kill('SIGTERM');
            });
        },
    };
}

export type ProtocolHooks = { send(message: RecordValue): void; emit(event: ProviderEvent): void };
export function clearApproval(connection: Connection, key: string, hooks: ProtocolHooks): void {
    if (connection.approvals.delete(key)) hooks.emit({ type: 'approval.resolved', key, epoch: connection.epoch });
}
export function sessionState(connection: Connection, id: string): SessionState {
    const session = connection.sessions.get(id);
    if (!session) throw new Error('Session is not owned by this adapter connection');
    return session;
}
export function activeState(connection: Connection, sessionId: string, turnId: string): SessionState {
    const session = sessionState(connection, sessionId);
    if (!turnId || session.turnId !== turnId) throw new Error('Turn is not the active turn of this session');
    return session;
}
export function settleResponse(connection: Connection, message: RecordValue): void {
    if (!idValue(message.id)) throw new Error('RPC response has no valid ID');
    const pending = connection.pending.get(message.id);
    if (!pending) return;
    connection.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
        const error = object(message.error);
        pending.reject(
            new Error(`Codex RPC ${typeof error.code === 'number' ? error.code : 'error'}: ${string(error.message) || 'Request failed'}`),
        );
        return;
    }
    if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new Error('RPC response has neither result nor error'));
}
export function deferFrame(connection: Connection, message: RecordValue, sessionId: string): boolean {
    if (!sessionId || connection.sessions.has(sessionId) || !connection.openings.size) return false;
    if ([...connection.deferred.values()].reduce((count, list) => count + list.length, 0) >= 1000)
        throw new Error('Too many events for sessions awaiting acknowledgement');
    const frames = connection.deferred.get(sessionId) ?? [];
    frames.push(message);
    connection.deferred.set(sessionId, frames);
    return true;
}

export function sessionParams(config: OperatorConfig, sessionId?: string, role: ProviderRole = 'controller', shared = false): RecordValue {
    return {
        cwd: config.workspace,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        ...(codexChoice(config, role === 'worker').model ? { model: codexChoice(config, role === 'worker').model } : {}),
        ...(shared ? {} : { developerInstructions: roleInstructions(role, config.instructions) }),
        ...(sessionId ? { threadId: sessionId } : {}),
    };
}

export function exactSessionID(connection: Connection, thread: RecordValue, expected?: string): string {
    const id = string(thread.id);
    if (!id || (expected !== undefined && expected !== id)) throw new Error('App-server returned an unexpected session ID');
    if (connection.sessions.has(id)) throw new Error('App-server reused an owned session ID');
    return id;
}

export function requestRPC(
    connection: Connection,
    method: string,
    params: RecordValue,
    timeout: number,
    hooks: ProtocolHooks,
    disconnect: (reason: string) => void,
): Promise<unknown> {
    const id = `${connection.epoch}:${randomUUID()}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const reason = `Codex RPC acknowledgement timed out: ${method}`;
            if (method === 'initialize') return disconnect(reason);
            connection.pending.delete(id);
            reject(new Error(reason));
        }, timeout);
        connection.pending.set(id, { resolve, reject, timer });
        try {
            hooks.send({ id, method, params });
        } catch (error) {
            clearTimeout(timer);
            connection.pending.delete(id);
            reject(error instanceof Error ? error : new Error('Could not send RPC'));
        }
    });
}

function decodeFrame(line: string, limit: number): RecordValue {
    if (Buffer.byteLength(line) > limit) throw new Error('Codex protocol line exceeds limit');
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Codex protocol frame');
    return object(parsed);
}

export function readFrames(
    connection: Connection,
    chunk: string,
    limit: number,
    hooks: { message(frame: RecordValue): void; disconnect(reason: string): void },
): void {
    connection.buffer += chunk;
    try {
        let newline: number;
        while ((newline = connection.buffer.indexOf('\n')) >= 0) {
            const line = connection.buffer.slice(0, newline);
            connection.buffer = connection.buffer.slice(newline + 1);
            if (line.trim()) hooks.message(decodeFrame(line, limit));
            if (!connection.alive) return;
        }
        if (Buffer.byteLength(connection.buffer) > limit) throw new Error('Codex protocol line exceeds limit');
    } catch (error) {
        hooks.disconnect(error instanceof Error ? error.message : 'Invalid Codex protocol frame');
    }
}
