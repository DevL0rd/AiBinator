import assert from 'node:assert/strict';
import { delimiter, join, resolve } from 'node:path';
import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { claudeExecutable, claudeProgram, codexProgram } from '../src/operator/executables.js';
import { claudeModels, claudeUsage, codexModels, effortOptions, validateModel } from '../src/operator/providers.js';
import { withEnv, writeFiles } from './host-fixture.js';

const shim = '@ECHO off\r\nendLocal & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';

async function checkLookup(root: string): Promise<void> {
    const [forced, plain, windows, host] = ['forced', 'plain', 'windows', 'host'].map((name) => join(root, name));
    await writeFiles(root, {
        'forced/codex': '#!/bin/sh\nexport CODEX_HOME=/elsewhere\nexec codex "$@"\n',
        'plain/codex': '#!/bin/sh\n',
        'plain/claude': '#!/bin/sh\n',
        'windows/claude.cmd': shim,
        'windows/codex.exe': 'MZ',
        'host/claude': '',
        'host/claude.exe': '',
        'big/codex': `#!/bin/sh\nexport CODEX_HOME=/elsewhere\n${' '.repeat(65_536)}`,
    });
    await withEnv({ PATH: [join(root, 'missing'), forced!, plain!].join(delimiter) }, async () => {
        assert.deepEqual(
            await codexProgram('linux'),
            { command: join(plain!, 'codex'), args: [] },
            'wrappers that force CODEX_HOME are skipped',
        );
        assert.deepEqual(await claudeProgram('linux'), { command: join(plain!, 'claude'), args: [] });
    });
    await withEnv({ PATH: join(root, 'big') }, async () =>
        assert.equal((await codexProgram('linux')).command, join(root, 'big', 'codex'), 'large binaries are not scanned'),
    );
    await withEnv({ PATH: windows! }, async () => {
        assert.deepEqual(await claudeProgram('win32'), {
            command: process.execPath,
            args: [join(windows!, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')],
        });
        assert.deepEqual(await codexProgram('win32'), { command: join(windows!, 'codex.exe'), args: [] });
        await assert.rejects(claudeProgram('linux'), /Claude Code is not installed or not on PATH/);
    });
    await withEnv({ PATH: host! }, async () =>
        assert.ok([join(host!, 'claude'), join(host!, 'claude.exe')].includes(await claudeExecutable())),
    );
    await withEnv({ PATH: undefined }, async () => {
        await assert.rejects(codexProgram('win32'), /Codex is not installed or not on PATH/);
        await assert.rejects(claudeExecutable(), /Claude Code is not installed/);
    });
}

async function checkCodexModels(root: string): Promise<void> {
    const cache = {
        fetched_at: '2026-10-01T00:00:00Z',
        models: [
            { slug: 'gpt-a', display_name: 'GPT A', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
            { slug: 'secret', visibility: 'hide' },
            { slug: 'gpt-b', visibility: 'list' },
        ],
    };
    await writeFiles(root, { 'codex-home/models_cache.json': JSON.stringify(cache), 'broken-home/models_cache.json': '{' });
    await withEnv({ CODEX_HOME: join(root, 'codex-home') }, async () => {
        const models = await codexModels();
        assert.equal(models.observedAt, cache.fetched_at);
        assert.deepEqual(models.models, [
            { id: 'gpt-a', name: 'GPT A', efforts: ['low', 'high'] },
            { id: 'gpt-b', name: 'gpt-b', efforts: [] },
        ]);
        assert.deepEqual(effortOptions(models, 'gpt-a'), ['low', 'high']);
        assert.deepEqual(effortOptions(models, 'missing'), []);
        assert.deepEqual(effortOptions(models, undefined), []);
        const config = { ...defaultOperatorConfig(), mode: 'codex-local' as const, codexModel: 'gpt-a' };
        await validateModel({ ...config, codexEffort: 'high' });
        await validateModel(config);
        await assert.rejects(validateModel({ ...config, codexEffort: 'medium' }), /Codex effort "medium" is not offered/);
    });
    await withEnv({ CODEX_HOME: join(root, 'broken-home') }, async () => {
        const models = await codexModels();
        assert.equal(models.source, 'Codex model list unavailable');
        assert.deepEqual(models.models, []);
    });
}

const row = (value: string, description: string, supportedEffortLevels?: ModelInfo['supportedEffortLevels']): ModelInfo => ({
    value,
    displayName: value.toUpperCase(),
    description,
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
});

const session =
    (fake: Partial<Query>) =>
    <T>(work: (query: Query) => Promise<T>): Promise<T> =>
        work(fake as Query);

async function checkClaudeModels(): Promise<void> {
    const rows = [row('default', 'Opus · Most capable', ['low', 'high']), row('sonnet', 'Sonnet 5 · Fast'), row('haiku', '')];
    const models = await claudeModels(session({ supportedModels: () => Promise.resolve(rows) }));
    assert.equal(models.source, 'Model list from your installed Claude Code');
    assert.deepEqual(models.defaultModel, { id: '', name: 'Default (Opus)', efforts: ['low', 'high'] });
    assert.deepEqual(models.models, [
        { id: 'sonnet', name: 'Sonnet 5', efforts: [] },
        { id: 'haiku', name: 'HAIKU', efforts: [] },
    ]);
    const plain = await claudeModels(session({ supportedModels: () => Promise.resolve(rows.slice(1)) }));
    assert.deepEqual(plain.defaultModel, { id: '', name: 'Default', efforts: [] });
    const failed = await claudeModels(session({ supportedModels: () => Promise.reject(new Error('signed out')) }));
    assert.deepEqual([failed.source, failed.note, failed.models], ['Claude Code unavailable', 'signed out', []]);
    const odd = await claudeModels(session({ supportedModels: () => Promise.reject(new Error()) }));
    assert.equal(odd.source, 'Claude Code unavailable');
    await withEnv({ PATH: undefined }, async () => {
        const missing = await claudeModels();
        assert.match(missing.note, /Claude Code is not installed/, 'a missing CLI is reported instead of thrown');
        const config = { ...defaultOperatorConfig(), mode: 'claude-session' as const, claudeEffort: 'high' as const };
        await assert.rejects(validateModel(config), /Claude effort "high" is not offered/);
    });
}

type Usage = Awaited<ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>;
const usage = (report: Partial<Usage>) =>
    session({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(report as Usage) });

async function checkClaudeUsage(): Promise<void> {
    const windows = await claudeUsage(
        usage({
            rate_limits_available: true,
            rate_limits: {
                five_hour: { utilization: 41.6, resets_at: '2026-10-07T12:00:00Z' },
                seven_day: { utilization: 10, resets_at: null },
                seven_day_opus: { utilization: null, resets_at: null },
            },
        }),
    );
    assert.deepEqual(windows, [
        { label: '5-hour limit', usedPercent: 42, resetsAt: '2026-10-07T12:00:00Z' },
        { label: 'Weekly limit', usedPercent: 10 },
    ]);
    await assert.rejects(claudeUsage(usage({ rate_limits_available: false })), /plan limits are not available/);
}

export async function checkProviders(directory: string): Promise<void> {
    const root = resolve(directory, 'providers');
    await checkLookup(root);
    await checkCodexModels(root);
    await checkClaudeModels();
    await checkClaudeUsage();
}
