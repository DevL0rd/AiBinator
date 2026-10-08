import { editSetting, settingValue, type SettingDefinition } from '../settings-registry.js';
import { domainError, publicDomain } from '../connection-domain.js';
import type { Documents } from '../panel-store.js';
import type { Observations } from './model.js';
import { scalar } from '../../core/text.js';
import { effortOptions, type ProviderModels } from '../providers.js';

const optional = [
    'codexModel',
    'codexEffort',
    'claudeModel',
    'claudeEffort',
    'workerCodexModel',
    'workerCodexEffort',
    'workerClaudeModel',
    'workerClaudeEffort',
    'instructions',
];
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

type Options = (drafts: Documents, observed: Observations) => string[];
const models =
    (provider: 'codex' | 'claude'): Options =>
    (_drafts, observed) => ['', ...observed[provider].models.map((model) => model.id)];
const efforts =
    (provider: 'codex' | 'claude', ...fields: string[]): Options =>
    (drafts, observed) => ['', ...effortOptions(observed[provider], fields.map((field) => text(drafts.operator[field])).find(Boolean))];
const pickers: Record<string, Options> = {
    codexModel: models('codex'),
    claudeModel: models('claude'),
    workerCodexModel: models('codex'),
    workerClaudeModel: models('claude'),
    codexEffort: efforts('codex', 'codexModel'),
    claudeEffort: efforts('claude', 'claudeModel'),
    workerCodexEffort: efforts('codex', 'workerCodexModel', 'codexModel'),
    workerClaudeEffort: efforts('claude', 'workerClaudeModel', 'claudeModel'),
};

export function editOptions(field: SettingDefinition, drafts: Documents, observed: Observations): string[] {
    const picker = field.source === 'operator' ? pickers[field.path] : undefined;
    if (picker) return picker(drafts, observed);
    if (field.kind === 'choice') return [...(field.choices ?? [])];
    return [];
}

const modelLabels = (models: ProviderModels): Record<string, string> => ({
    '': models.defaultModel.name,
    ...Object.fromEntries(models.models.map((model) => [model.id, model.name] as const)),
});

export function optionLabels(field: SettingDefinition, observed: Observations): Record<string, string> {
    if (field.path === 'codexModel') return modelLabels(observed.codex);
    if (field.path === 'claudeModel') return modelLabels(observed.claude);
    if (field.path === 'workerCodexModel') return { ...modelLabels(observed.codex), '': 'Same as the responder' };
    if (field.path === 'workerClaudeModel') return { ...modelLabels(observed.claude), '': 'Same as the responder' };
    return {};
}

export const toggleable = (field: SettingDefinition): boolean =>
    field.kind === 'boolean' || (field.kind === 'choice' && field.choices?.join() === 'true,false');
export const multiSelect = (field: SettingDefinition): boolean => field.kind === 'list' && Boolean(field.choices?.length);

export function initialInput(field: SettingDefinition, drafts: Documents): string {
    const value = settingValue(drafts[field.source], field);
    if (field.credential) return '';
    if (field.id === 'environment.AIBINATOR_RESOURCE_URL') return publicDomain(value);
    if (Array.isArray(value)) return value.join(', ');
    return scalar(value);
}

export function editHint(field: SettingDefinition): string {
    if (field.id === 'environment.AIBINATOR_RESOURCE_URL')
        return 'Just the domain, like bot.example.com. No https:// and no path. Leave it empty to stop the web connectors.';
    if (field.credential) return 'Paste the new value. It is hidden as you type and never shown again.';
    if (field.kind === 'integer')
        return `A whole number${field.minimum !== undefined ? ` from ${field.minimum}` : ''}${field.maximum !== undefined ? ` to ${field.maximum}` : ''}.`;
    if (field.kind === 'list') return 'Separate entries with commas.';
    return '';
}

function parseDomain(value: string): string {
    const error = value ? domainError(value) : undefined;
    if (error) throw new Error(error);
    return value;
}
const parsers: Partial<Record<SettingDefinition['kind'], (value: string) => unknown>> = {
    integer: (value) => {
        if (!/^-?\d+$/.test(value)) throw new Error('Enter a whole number.');
        return Number(value);
    },
    boolean: (value) => value === 'true',
    list: (value) =>
        value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
};

function parse(field: SettingDefinition, input: string): unknown {
    const value = input.trim();
    if (field.id === 'environment.AIBINATOR_RESOURCE_URL') return parseDomain(value);
    return parsers[field.kind]?.(value) ?? input;
}

export function stage(drafts: Documents, field: SettingDefinition, input: string | string[]): Documents {
    const value = Array.isArray(input) ? input : parse(field, input);
    if (field.credential && !value) throw new Error('Paste a new value, or press Esc to keep the current one.');
    const document = editSetting(drafts[field.source], field, value);
    if (value === '' && field.source === 'operator' && optional.includes(field.path)) delete document[field.path];
    return { ...drafts, [field.source]: document };
}

export function toggled(drafts: Documents, field: SettingDefinition): Documents {
    return stage(drafts, field, String(String(settingValue(drafts[field.source], field)) !== 'true'));
}
