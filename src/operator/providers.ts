import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk';
import type { UsageWindow } from './provider-adapter.js';
import { claudeChoice, codexChoice, type OperatorConfig } from './config.js';
import { codexHome } from './codex-config.js';
import { claudeExecutable } from './executables.js';

const cachedModel = z.object({
    slug: z.string(),
    display_name: z.string().optional(),
    visibility: z.string().optional(),
    supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]),
});
interface ProviderModel {
    id: string;
    name: string;
    efforts: string[];
}
export interface ProviderModels {
    source: string;
    observedAt: string;
    models: ProviderModel[];
    defaultModel: ProviderModel;
    note: string;
}
const unavailable = (source: string, note: string): ProviderModels => ({
    source,
    observedAt: new Date().toISOString(),
    models: [],
    defaultModel: { id: '', name: 'Default', efforts: [] },
    note,
});
export async function codexModels(): Promise<ProviderModels> {
    const path = join(await codexHome(), 'models_cache.json');
    try {
        const cache = z.object({ fetched_at: z.string(), models: z.array(cachedModel) }).parse(JSON.parse(await readFile(path, 'utf8')));
        return {
            source: 'Codex model list from your Codex account',
            observedAt: cache.fetched_at,
            models: cache.models
                .filter((model) => model.visibility !== 'hide')
                .map((model) => ({
                    id: model.slug,
                    name: model.display_name ?? model.slug,
                    efforts: model.supported_reasoning_levels.map((level) => level.effort),
                })),
            defaultModel: { id: '', name: 'Codex default', efforts: [] },
            note: 'Codex refreshes this list whenever it runs.',
        };
    } catch {
        return unavailable('Codex model list unavailable', 'Sign in to Codex and run it once to load its models.');
    }
}
const noPrompt: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined) }),
};
const claudeModel = (row: ModelInfo): ProviderModel => ({
    id: row.value,
    name: row.description.split(' · ')[0] || row.displayName,
    efforts: row.supportedEffortLevels ?? [],
});
type ClaudeSession = <T>(work: (session: Query) => Promise<T>) => Promise<T>;
async function withClaude<T>(work: (session: Query) => Promise<T>): Promise<T> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const session = query({ prompt: noPrompt, options: { cwd: homedir(), pathToClaudeCodeExecutable: await claudeExecutable() } });
    try {
        return await work(session);
    } finally {
        session.close();
    }
}

export async function claudeModels(open: ClaudeSession = withClaude): Promise<ProviderModels> {
    try {
        const rows = await open((session) => session.supportedModels());
        const preset = rows.find((row) => row.value === 'default');
        return {
            source: 'Model list from your installed Claude Code',
            observedAt: new Date().toISOString(),
            models: rows.filter((row) => row !== preset).map(claudeModel),
            defaultModel: preset
                ? { ...claudeModel(preset), id: '', name: `Default (${claudeModel(preset).name})` }
                : { id: '', name: 'Default', efforts: [] },
            note: 'Read from Claude Code each time you refresh, so it always matches what your account offers.',
        };
    } catch (error) {
        return unavailable('Claude Code unavailable', error instanceof Error ? error.message : 'Claude Code could not list its models');
    }
}

const claudeWindows: Record<string, string> = {
    five_hour: '5-hour limit',
    seven_day: 'Weekly limit',
    seven_day_opus: 'Weekly Opus limit',
    seven_day_sonnet: 'Weekly Sonnet limit',
};

export async function claudeUsage(open: ClaudeSession = withClaude): Promise<UsageWindow[]> {
    const report = await open((session) => session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    if (!report.rate_limits_available || !report.rate_limits)
        throw new Error('Claude plan limits are not available for this sign-in (API key or cloud provider).');
    const limits = report.rate_limits as Record<string, { utilization: number | null; resets_at: string | null } | undefined>;
    return Object.entries(claudeWindows).flatMap(([key, label]) => {
        const window = limits[key];
        if (window?.utilization == null) return [];
        return [{ label, usedPercent: Math.round(window.utilization), ...(window.resets_at ? { resetsAt: window.resets_at } : {}) }];
    });
}
const effortsFor = (models: ProviderModels, id: string | undefined): string[] =>
    (id ? models.models.find((item) => item.id === id) : models.defaultModel)?.efforts ?? [];
export function validateEffort(provider: string, effort: string | undefined, model: string | undefined, models: ProviderModels): void {
    if (effort && !effortsFor(models, model).includes(effort))
        throw new Error(
            `${provider} effort "${effort}" is not offered for the selected model. Pick another effort or leave it on Default.`,
        );
}
export const effortOptions = effortsFor;
export async function validateModel(config: OperatorConfig): Promise<void> {
    if (config.mode === 'codex-local') {
        const models = await codexModels();
        validateEffort('Codex', config.codexEffort, config.codexModel, models);
        validateEffort('Codex worker', codexChoice(config, true).effort, codexChoice(config, true).model, models);
    }
    if (config.mode === 'claude-session') {
        const models = await claudeModels();
        validateEffort('Claude', config.claudeEffort, config.claudeModel, models);
        validateEffort('Claude new-chat', claudeChoice(config, true).effort, claudeChoice(config, true).model, models);
    }
}
