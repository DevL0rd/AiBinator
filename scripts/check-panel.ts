import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultOperatorConfig, operatorSchema, readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { validateEffort, type ProviderModels } from '../src/operator/providers.js';
import { readPanel, applyDraft, persistentWorkBlock, rebaseDrafts } from '../src/operator/panel-store.js';
import { editSetting, settings } from '../src/operator/settings-registry.js';
import { settingsList, settingsUpdate } from '../src/mcp/settings.js';
import { planReconnect } from '../src/operator/reconnect.js';
import { csv, envSchema, validateAuth } from '../src/core/config.js';
import { domainError, editPublicDomain, publicDomain } from '../src/operator/connection-domain.js';
import { aibiStatus } from './fixtures.js';

const noReconnect = () => Promise.resolve(() => Promise.resolve(''));

function checkDomain(): void {
    const external = {
        AIBINATOR_RESOURCE_URL: 'https://old.example/mcp',
        AIBINATOR_AUTH_MODE: 'oauth',
        AIBINATOR_OAUTH_SERVER: 'external',
        AIBINATOR_OAUTH_ISSUER: 'https://identity.example',
        AIBINATOR_ALLOWED_HOSTS: 'old.example,extra.example',
    };
    const changed = editPublicDomain(external, 'new.example');
    assert.equal(changed.AIBINATOR_RESOURCE_URL, 'https://new.example/mcp');
    assert.equal(changed.AIBINATOR_OAUTH_ISSUER, external.AIBINATOR_OAUTH_ISSUER, 'an external provider is left alone');
    const derived = envSchema.parse({
        AIBINATOR_RESOURCE_URL: 'https://new.example/mcp',
        AIBINATOR_AUTH_MODE: 'oauth',
        AIBINATOR_TRUSTED_PROXIES: '127.0.0.1',
    });
    validateAuth(derived);
    assert.equal(derived.AIBINATOR_OAUTH_ISSUER, 'https://new.example', 'the issuer is the public domain');
    assert.equal(derived.AIBINATOR_OAUTH_JWKS_URL, 'https://new.example/oauth/jwks');
    assert.ok(csv(derived.AIBINATOR_ALLOWED_HOSTS).includes('new.example'), 'the public host is allowed automatically');
    assert.ok(csv(derived.AIBINATOR_ALLOWED_ORIGINS).includes('https://new.example'));
    const fresh = editPublicDomain({ AIBINATOR_AUTH_MODE: 'bearer' }, 'new.example');
    assert.equal(fresh.AIBINATOR_AUTH_MODE, 'oauth', 'a public domain turns on the built-in sign-in');
    assert.equal(fresh.AIBINATOR_OAUTH_SERVER, 'bundled');
    assert.equal(fresh.AIBINATOR_TRUSTED_PROXIES, '127.0.0.1,::1');
    assert.throws(() => editPublicDomain(external, 'http://localhost'));
    const cleared = editPublicDomain(fresh, '');
    assert.equal(cleared.AIBINATOR_RESOURCE_URL, '', 'the public domain can be cleared');
    assert.equal(cleared.AIBINATOR_AUTH_MODE, 'bearer', 'clearing it goes back to local-only access');
    assert.equal(editPublicDomain(external, '').AIBINATOR_AUTH_MODE, 'oauth', 'an external provider is left alone');
    assert.equal(publicDomain('https://new.example/mcp'), 'new.example', 'domain is displayed without protocol');
    assert.equal(domainError('bot.example.com'), undefined);
    for (const bad of ['https://bot.example.com', 'bot.example.com/mcp', 'localhost', '10.0.0.1', 'not a domain', ''])
        assert.ok(domainError(bad), bad);
}

const modelData: ProviderModels = {
    source: 'fixture',
    observedAt: new Date().toISOString(),
    note: '',
    defaultModel: { id: '', name: 'Default', efforts: ['medium'] },
    models: [{ id: 'fixture-model', name: 'Fixture', efforts: ['high'] }],
};
function checkConfiguration() {
    const config = { ...defaultOperatorConfig(), mode: 'codex-local' as const, codexModel: 'fixture-model', codexEffort: 'high' };
    validateEffort('Codex', config.codexEffort, config.codexModel, modelData);
    assert.throws(() => validateEffort('Codex', 'low', config.codexModel, modelData), /not offered/);
    validateEffort('Claude', 'medium', undefined, modelData);
    assert.throws(() => validateEffort('Claude', 'high', undefined, modelData), /not offered/, 'default model efforts are checked');
    assert.equal(operatorSchema.parse(config).timeoutSeconds, 0);
    for (const mode of ['codex-local', 'claude-session', 'manual-mcp']) assert.equal(operatorSchema.parse({ ...config, mode }).mode, mode);
    for (const mode of ['chatgpt-events', 'chatgpt-poll'])
        assert.equal(operatorSchema.safeParse({ ...config, mode }).success, false, `${mode} is no longer a responder`);
    assert.equal(
        operatorSchema.parse({ ...config, shareConversation: undefined }).shareConversation,
        true,
        'conversations are shared by default',
    );
    for (const timeoutSeconds of [1, 29, -1, 1801]) assert.equal(operatorSchema.safeParse({ ...config, timeoutSeconds }).success, false);
    const live = {
        aibi: aibiStatus(),
        operator: {
            mode: 'codex-local',
            appliedConfigAt: config.updatedAt,
            activeEventId: null,
            controller: { busy: 0, approvals: 0, tasks: [{ state: 'recovering' }] },
        },
    };
    assert.match(persistentWorkBlock(live, config.updatedAt) ?? '', /controller work or recovery/);
    live.operator.controller.tasks = [];
    assert.equal(persistentWorkBlock(live, config.updatedAt), undefined);
}
async function checkDraft(): Promise<void> {
    await writeFile('policy.json', '{}');
    await writeFile(
        '.env',
        'GEMINI_API_KEY=fixture-gemini-key\nAIBINATOR_MCP_TOKEN=fixture-credential-at-least-32-characters\nAIBINATOR_AUTH_MODE=bearer\nAIBINATOR_POLICY_FILE=policy.json\n',
    );
    const snapshot = await readPanel();
    const draft = structuredClone(snapshot.documents);
    draft.operator.mode = 'manual-mcp';
    draft.operator.enabled = false;
    const applied = await applyDraft(snapshot, draft, noReconnect);
    assert.equal(applied.snapshot.documents.operator.mode, 'manual-mcp');
    const combined = structuredClone(applied.snapshot.documents);
    combined.operator.instructions = 'Keep it short.';
    combined.environment.AIBINATOR_RESOURCE_URL = 'https://fixture.example/mcp';
    combined.policy = editSetting(
        combined.policy,
        settings.find((field) => field.id === 'policy.aibi.mode')!,
        'passthrough',
    );
    const multi = await applyDraft(applied.snapshot, combined, noReconnect);
    assert.equal(multi.snapshot.documents.operator.instructions, 'Keep it short.');
    assert.equal(multi.snapshot.documents.environment.AIBINATOR_RESOURCE_URL, 'https://fixture.example/mcp');
    assert.equal((multi.snapshot.documents.policy.aibi as { mode: string }).mode, 'passthrough');
    assert.match(
        multi.message,
        /applied them right away, without restarting|uses them as soon as it is running/,
        'every saved source is reported',
    );
    assert.match(multi.message, /Another MCP app takes over once AiBinator finishes/, 'a responder switch waits for AiBinator');
    assert.match(multi.message, /AIBI settings saved and applied\./);
    const policyField = settings.find((field) => field.id === 'policy.voice.memoryLines')!;
    const policyDraft = structuredClone(applied.snapshot.documents);
    policyDraft.policy = editSetting(policyDraft.policy, policyField, 77);
    await writeFile('policy.json', '{"voice":{"memoryLines":88}}');
    await assert.rejects(applyDraft(applied.snapshot, policyDraft, noReconnect), /changed elsewhere/);
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { voice: { memoryLines: number } }).voice.memoryLines, 88);
    const rebased = rebaseDrafts(applied.snapshot, policyDraft, await readPanel());
    assert.equal((rebased.policy.voice as { memoryLines: number }).memoryLines, 77, 'drafts survive an outside change');
    assert.equal(
        (rebased.environment as { AIBINATOR_RESOURCE_URL?: string }).AIBINATOR_RESOURCE_URL,
        'https://fixture.example/mcp',
        'outside changes are kept',
    );
    await checkPaused();
}
async function checkPaused(): Promise<void> {
    const snapshot = await readPanel();
    const draft = structuredClone(snapshot.documents);
    draft.operator.mode = 'manual-mcp';
    const switched = await applyDraft(snapshot, draft, noReconnect);
    assert.equal((await readOperatorConfig()).enabled, true, 'choosing a responder starts it');
    await writeOperatorConfig({ ...(await readOperatorConfig()), enabled: false });
    const edited = structuredClone(switched.snapshot.documents);
    edited.operator.instructions = 'Be brief.';
    const kept = await applyDraft(switched.snapshot, edited, noReconnect);
    assert.equal((await readOperatorConfig()).enabled, false, 'editing a paused responder keeps it paused');
    assert.match(kept.message, /stays paused/);
    const failing = structuredClone(kept.snapshot.documents);
    failing.operator.instructions = 'Be very brief.';
    const failed = await applyDraft(kept.snapshot, failing, () => Promise.resolve(() => Promise.reject(new Error('fixture failure'))));
    assert.equal(failed.warning, true, 'a failure after writing is a warning');
    assert.match(failed.message, /^Saved, but fixture failure/);
    assert.equal(failed.snapshot.documents.operator.instructions, 'Be very brief.', 'the new snapshot is returned');
    await writeOperatorConfig({ ...defaultOperatorConfig(), mode: 'codex-local' });
    await rm('.data/operator-settings.json');
    assert.equal((await readPanel()).documents.operator.mode, 'codex-local', 'without saved setup settings the active responder is shown');
}
async function checkReconnect(): Promise<void> {
    const unrelated = [{ id: 'policy.aibi.mode', label: 'Mode', before: 'local', after: 'passthrough', apply: 'live' as const }];
    assert.equal(await (await planReconnect(unrelated, {}))(), '', 'settings that do not affect connections never touch apps');
}
async function checkSettingsTools(): Promise<void> {
    await checkReconnect();
    await writeFile('policy.json', '{}');
    const listed = await settingsList();
    const key = listed.find((item) => item.id === 'environment.GEMINI_API_KEY');
    assert.equal(key?.value, 'set', 'secrets are never revealed');
    assert.equal(key?.editable, false);
    assert.equal(listed.find((item) => item.id === 'operator.shareConversation')?.value, true);
    await assert.rejects(settingsUpdate([{ id: 'environment.GEMINI_API_KEY', value: 'x' }]), /setup app/);
    await assert.rejects(settingsUpdate([{ id: 'policy.nope', value: 1 }]), /Unknown setting/);
    await assert.rejects(settingsUpdate([{ id: 'policy.aibi.dnsPort', value: 0 }]), /Minimum: 1/);
    assert.match(await settingsUpdate([{ id: 'policy.aibi.mode', value: 'passthrough' }]), /AIBI settings saved/);
    assert.equal((JSON.parse(await readFile('policy.json', 'utf8')) as { aibi: { mode: string } }).aibi.mode, 'passthrough');
}
export async function checkPanel(): Promise<void> {
    checkDomain();
    checkConfiguration();
    const directory = await mkdtemp(join(tmpdir(), 'aibinator-panel-check-'));
    const originalDirectory = process.cwd();
    try {
        process.chdir(directory);
        await checkDraft();
        await checkSettingsTools();
    } finally {
        process.chdir(originalDirectory);
        await rm(directory, { recursive: true, force: true });
    }
}
