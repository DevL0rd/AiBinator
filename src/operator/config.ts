import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

export type OperatingMode = z.infer<typeof operatingMode>;
const operatingMode = z.enum(['codex-local', 'claude-session', 'manual-mcp']);
export const localModes: readonly OperatingMode[] = ['codex-local', 'claude-session'];

const operatorObject = z
    .object({
        version: z.literal(1),
        mode: operatingMode,
        enabled: z.boolean(),
        exclusiveLocal: z.boolean().optional(),
        workspace: z.string().min(1),
        timeoutSeconds: z.union([z.literal(0), z.number().int().min(30).max(1800)]).default(0),
        codexModel: z.string().trim().max(200).optional(),
        codexEffort: z.string().trim().max(32).optional(),
        claudeModel: z.string().trim().max(200).optional(),
        claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        workerCodexModel: z.string().trim().max(200).optional(),
        workerCodexEffort: z.string().trim().max(32).optional(),
        workerClaudeModel: z.string().trim().max(200).optional(),
        workerClaudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        instructions: z.string().max(8000).optional(),
        progressSeconds: z.number().int().min(15).max(600).optional(),
        activityVisibility: z.boolean().default(true),
        backgroundOnly: z.boolean().default(false),
        shareConversation: z.boolean().default(true),
        updatedAt: z.iso.datetime(),
    })
    .strict();
export const operatorSchema = operatorObject;
export type OperatorConfig = z.infer<typeof operatorObject>;

export interface ModelChoice {
    model?: string;
    effort?: string;
}

const choice = (model?: string, effort?: string): ModelChoice => ({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) });

export function claudeChoice(config: OperatorConfig, worker = false): ModelChoice {
    if (!worker) return choice(config.claudeModel, config.claudeEffort);
    return choice(
        config.workerClaudeModel || config.claudeModel,
        config.workerClaudeEffort || (config.workerClaudeModel ? undefined : config.claudeEffort),
    );
}

export function codexChoice(config: OperatorConfig, worker = false): ModelChoice {
    if (!worker) return choice(config.codexModel, config.codexEffort);
    return choice(
        config.workerCodexModel || config.codexModel,
        config.workerCodexEffort || (config.workerCodexModel ? undefined : config.codexEffort),
    );
}

export const operatorPath = '.data/operator.json';
export const defaultOperatorConfig = (): OperatorConfig => ({
    version: 1,
    mode: 'claude-session',
    enabled: false,
    workspace: homedir(),
    timeoutSeconds: 0,
    activityVisibility: true,
    backgroundOnly: false,
    shareConversation: true,
    updatedAt: new Date().toISOString(),
});

export async function readOperatorConfig(path = operatorPath): Promise<OperatorConfig> {
    try {
        return operatorSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return defaultOperatorConfig();
    }
}

export async function writeOperatorConfig(config: OperatorConfig, path = operatorPath): Promise<void> {
    const parsed = operatorSchema.parse({ ...config, updatedAt: new Date().toISOString() });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await replaceFile(temporary, path);
}
