import assert from 'node:assert/strict';
import { editHint, initialInput, stage } from '../src/operator/ui/edit.js';
import { setting } from '../src/operator/ui/items.js';
import {
    assignSetting,
    editSetting,
    fieldError,
    previewChanges,
    settingValue,
    type SettingDefinition,
} from '../src/operator/settings-registry.js';
import { publicDomain } from '../src/operator/connection-domain.js';
import { actions } from '../src/aibi/capabilities.js';
import { snapshot } from './ui-fixtures.js';

const drafts = () => structuredClone(snapshot.documents);
const policyOf = (id: string, input: string | string[]) => stage(drafts(), setting(id), input).policy;
const aibiOf = (id: string, input: string | string[]) => policyOf(id, input).aibi as Record<string, unknown>;
const voiceOf = (id: string, input: string) => policyOf(id, input).voice as Record<string, unknown>;
const [first, second] = actions.map((action) => action.id);

function checkInitialInput(): void {
    const documents = drafts();
    documents.policy.aibi = { ...(documents.policy.aibi as object), actions: [first, second] };
    assert.equal(initialInput(setting('environment.GEMINI_API_KEY'), documents), '', 'credentials start empty');
    assert.equal(initialInput(setting('environment.AIBINATOR_RESOURCE_URL'), documents), 'bot.example.com');
    assert.equal(initialInput(setting('policy.aibi.actions'), documents), `${first}, ${second}`, 'lists are comma separated');
    assert.equal(initialInput(setting('policy.voice.idleSeconds'), documents), '30', 'numbers are shown as text');
}

function checkHints(): void {
    assert.match(editHint(setting('environment.AIBINATOR_RESOURCE_URL')), /Just the domain/);
    assert.match(editHint(setting('environment.GEMINI_API_KEY')), /hidden as you type/);
    assert.equal(editHint(setting('policy.voice.idleSeconds')), 'A whole number from 10 to 600.');
    assert.equal(editHint(setting('policy.voice.memoryLines')), 'A whole number from 0 to 200.', 'a zero minimum is still named');
    const open: SettingDefinition = { ...setting('policy.voice.idleSeconds'), minimum: undefined, maximum: undefined };
    assert.equal(editHint(open), 'A whole number.', 'unbounded numbers do not mention limits');
    assert.equal(editHint(setting('policy.aibi.actions')), 'Separate entries with commas.');
    assert.equal(editHint(setting('operator.instructions')), '');
}

function checkParsing(): void {
    assert.deepEqual(aibiOf('policy.aibi.actions', ` ${first} , ,${second} `).actions, [first, second]);
    assert.throws(() => policyOf('policy.aibi.actions', 'not_an_action'), /unsupported value/, 'only real actions can be listed');
    assert.equal(voiceOf('policy.voice.idleSeconds', ' 42 ').idleSeconds, 42, 'numbers are trimmed');
    assert.throws(() => policyOf('policy.voice.idleSeconds', '12.5'), /whole number/);
    assert.throws(() => policyOf('policy.voice.idleSeconds', '900'), /Maximum: 600/);
    assert.equal(aibiOf('policy.aibi.dns', 'true').dns, true);
    assert.equal(aibiOf('policy.aibi.dns', 'yes').dns, false, 'anything else is off');
    assert.deepEqual(policyOf('policy.scopes', ['aibi.read']).scopes, ['aibi.read'], 'checklists stage their array as is');
}

function checkStaging(): void {
    const key = setting('environment.GEMINI_API_KEY');
    assert.throws(() => stage(drafts(), key, ''), /Paste a new value/, 'a credential cannot be emptied');
    assert.equal(stage(drafts(), key, 'new-secret').environment.GEMINI_API_KEY, 'new-secret');
    const cleared = stage(drafts(), setting('environment.AIBINATOR_RESOURCE_URL'), '  ');
    assert.deepEqual(
        [cleared.environment.AIBINATOR_RESOURCE_URL, cleared.environment.AIBINATOR_AUTH_MODE],
        ['', 'bearer'],
        'an empty domain stops the web connectors',
    );
    const withModel = drafts();
    withModel.operator.codexModel = 'fast';
    const reset = stage(withModel, setting('operator.codexModel'), '');
    assert.equal(Object.hasOwn(reset.operator, 'codexModel'), false, 'clearing an optional model goes back to the default');
    const blank = stage(drafts(), setting('operator.workspace'), '');
    assert.equal(blank.operator.workspace, '', 'other text settings keep an empty value');
    assert.deepEqual(aibiOf('policy.aibi.actions', '').actions, [], 'an empty list switches every action off');
    assert.equal(aibiOf('policy.aibi.lanAddress', '').lanAddress, '', 'an empty address picks one automatically');
}

function checkValidation(): void {
    const names = setting('policy.aibi.actions');
    const scopes = setting('policy.scopes');
    const idle = setting('policy.voice.idleSeconds');
    const cases: [SettingDefinition, unknown, string | undefined][] = [
        [setting('environment.AIBINATOR_BIND_HOST'), '0.0.0.0', 'This setting is enforced and cannot be edited'],
        [setting('policy.aibi.dns'), 'true', 'Choose on or off'],
        [idle, 1.5, 'Enter a whole number'],
        [idle, 9, 'Minimum: 10'],
        [idle, 601, 'Maximum: 600'],
        [setting('policy.aibi.dnsPort'), 0, 'Minimum: 1'],
        [setting('policy.aibi.httpPort'), 65536, 'Maximum: 65535'],
        [setting('operator.instructions'), 3, 'Enter text'],
        [setting('policy.aibi.mode'), 'world', 'Choose a supported value'],
        [names, first, 'Enter a list'],
        [names, Array.from({ length: 201 }, () => first), 'Maximum entries: 200'],
        [names, [first, 3], 'List entries must be text'],
        [names, [first, second], undefined],
        [scopes, ['not-a-scope'], 'List contains an unsupported value'],
        [scopes, ['aibi.read'], undefined],
        [{ ...names, kind: 'unknown' } as unknown as SettingDefinition, 'anything', undefined],
    ];
    for (const [definition, value, expected] of cases)
        assert.equal(fieldError(definition, value), expected, `${definition.id} ${JSON.stringify(value)}`);
    assert.throws(() => editSetting({}, names, first), /Enter a list/, 'editing refuses invalid values');
}

function checkPaths(): void {
    const field = (path: string): SettingDefinition => ({ ...setting('policy.aibi.mode'), path });
    assert.throws(() => settingValue({}, field('__proto__.polluted')), /Invalid setting path/);
    assert.throws(() => settingValue({}, field('aibi..mode')), /Invalid setting path/);
    assert.equal(settingValue({ aibi: 'flat' }, field('aibi.mode')), 'local', 'a non-object parent reads as the default');
    assert.equal(settingValue({}, { ...field('missing'), defaultValue: undefined }), undefined);
    assert.throws(() => assignSetting({ aibi: 'flat' }, field('aibi.mode'), 'passthrough'), /parent is not an object/);
    assert.throws(() => assignSetting({ aibi: [] }, field('aibi.mode'), 'passthrough'), /parent is not an object/);
    assert.throws(() => assignSetting({ aibi: null }, field('aibi.mode'), 'passthrough'), /parent is not an object/);
    assert.deepEqual(assignSetting({}, field('a.b.c'), 1), { a: { b: { c: 1 } } }, 'missing parents are created');
    const original = { aibi: { mode: 'local' } };
    assert.deepEqual(assignSetting(original, field('aibi.mode'), 'passthrough'), { aibi: { mode: 'passthrough' } });
    assert.equal(original.aibi.mode, 'local', 'the original document is untouched');
}

function checkPreview(): void {
    const key = previewChanges('environment', {}, { GEMINI_API_KEY: 'new' });
    assert.deepEqual(
        key.map((change) => [change.id, change.before, change.after]),
        [['environment.GEMINI_API_KEY', 'Not configured', '[redacted]']],
        'secrets are never shown',
    );
    const removed = previewChanges('environment', { AIBINATOR_RESOURCE_URL: 'https://a.example/mcp' }, {});
    assert.deepEqual([removed[0]?.before, removed[0]?.after], ['"https://a.example/mcp"', 'Not configured']);
    assert.equal(publicDomain('not a url'), 'not a url', 'text that is not a URL is shown as typed');
    assert.equal(publicDomain(undefined), '');
}

export function checkUiEdit(): void {
    checkInitialInput();
    checkHints();
    checkParsing();
    checkStaging();
    checkValidation();
    checkPaths();
    checkPreview();
}
