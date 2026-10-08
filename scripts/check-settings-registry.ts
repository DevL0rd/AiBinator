import assert from 'node:assert/strict';
import { policySchema } from '../src/core/config.js';
import { defaultOperatorConfig } from '../src/operator/config.js';
import { editSetting, fieldError, previewChanges, searchSettings, settings, settingValue } from '../src/operator/settings-registry.js';

const field = (id: string) => {
    const definition = settings.find((item) => item.id === id);
    assert.ok(definition, `Missing setting ${id}`);
    return definition;
};
assert.equal(new Set(settings.map((item) => item.id)).size, settings.length, 'Stable IDs are unique');
const defaults = policySchema.parse({});
for (const definition of settings.filter((item) => item.source === 'policy')) {
    assert.deepEqual(
        settingValue(defaults, definition),
        definition.defaultValue,
        `${definition.id} matches the real policy schema default`,
    );
}
const operatorDefaults = defaultOperatorConfig() as Record<string, unknown>;
for (const id of ['operator.shareConversation', 'operator.backgroundOnly', 'operator.activityVisibility'])
    assert.equal(settingValue(operatorDefaults, field(id)), field(id).defaultValue, `${id} matches the operator default`);
assert.equal(field('operator.shareConversation').defaultValue, true, 'conversations are shared with the responder by default');
const removed = /DISCORD|servers|channels|people|triggers|context|media|mcpEvents|allowed(User|Role)Ids/;
assert.deepEqual(
    settings.filter((item) => removed.test(item.id)).map((item) => item.id),
    [],
    'no Discord settings are left',
);
for (const id of [
    'policy.ownerName',
    'policy.aibi.mode',
    'policy.aibi.personality',
    'policy.aibi.lanAddress',
    'policy.aibi.dns',
    'policy.aibi.dnsUpstream',
    'policy.aibi.httpPort',
    'policy.aibi.httpsPort',
    'policy.aibi.dnsPort',
    'policy.aibi.actions',
    'policy.aibi.animations',
    'policy.scopes',
    'environment.GEMINI_API_KEY',
    'policy.voice.liveModel',
    'policy.voice.liveVoice',
    'policy.voice.idleSeconds',
    'policy.voice.speechThreshold',
    'policy.voice.memoryLines',
])
    field(id);
assert.equal(searchSettings('forward other names')[0]?.id, 'policy.aibi.dnsUpstream');
assert.equal(searchSettings('does-not-exist').length, 0);
assert.equal(searchSettings('   ').length, settings.length);
const idle = field('policy.voice.idleSeconds');
assert.ok(fieldError(idle, 601));
assert.ok(fieldError(idle, 9));
assert.ok(fieldError(idle, 1.5));
assert.equal(fieldError(idle, 80), undefined);
const changed = editSetting(defaults, idle, 80);
assert.equal(defaults.voice.idleSeconds, 30, 'Editing preserves the original document');
assert.equal((changed.voice as Record<string, unknown>).idleSeconds, 80);
assert.equal(policySchema.parse(changed).voice.idleSeconds, 80, 'The result passes the authoritative schema');
assert.throws(() => editSetting(defaults, field('policy.aibi.mode'), 'anything'));
assert.throws(() => editSetting(defaults, field('policy.aibi.dnsPort'), 0));
assert.throws(() => editSetting({}, field('environment.AIBINATOR_BIND_HOST'), '0.0.0.0'));
const malicious = { ...idle, path: '__proto__.polluted' };
assert.throws(() => editSetting({}, malicious, 100));
assert.equal(({} as Record<string, unknown>).polluted, undefined);
const animations = settingValue({}, field('policy.aibi.animations')) as string[];
animations.push('dance');
assert.equal(
    (settingValue({}, field('policy.aibi.animations')) as string[]).includes('dance'),
    false,
    'Default arrays do not leak across drafts',
);
assert.ok(fieldError(field('policy.scopes'), ['not-a-scope']));
assert.ok(fieldError(field('policy.aibi.actions'), ['not_an_action']));
const preview = previewChanges('policy', defaults, changed);
assert.equal(preview.length, 1);
assert.equal(preview[0]?.apply, 'live');
assert.equal(preview[0]?.before, '30');
const secretPreview = previewChanges('environment', { GEMINI_API_KEY: 'old-secret' }, { GEMINI_API_KEY: 'new-secret' });
assert.equal(secretPreview.length, 1);
assert.equal(secretPreview[0]?.before, '[redacted]');
assert.equal(secretPreview[0]?.after, '[redacted]');
assert.ok(!JSON.stringify(secretPreview).includes('secret'));
assert.deepEqual(previewChanges('policy', {}, defaults), [], 'Omitted values resolve to real defaults without fake diffs');
console.log(
    `Settings registry: ${settings.length} existing settings verified; defaults, edits, search, redaction, immutable drafts, and path guards pass.`,
);
