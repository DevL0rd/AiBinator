import { operatorSettings } from './settings-operator.js';
import { policySettings } from './settings-policy.js';
import { environmentSettings } from './settings-environment.js';
import { voiceSettings } from './settings-voice.js';
import type { SettingDefinition, SettingsSource } from './settings-types.js';
import { editPublicDomain } from './connection-domain.js';
export type { SettingDefinition, SettingsSource } from './settings-types.js';
export const settings: readonly SettingDefinition[] = Object.freeze(
    [...operatorSettings, ...policySettings, ...environmentSettings, ...voiceSettings].map((setting) =>
        Object.freeze({ ...setting, choices: setting.choices ? Object.freeze([...setting.choices]) : undefined }),
    ),
);

export function searchSettings(query: string, catalog = settings): readonly SettingDefinition[] {
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return catalog.filter((setting) => {
        const text = `${setting.id} ${setting.label} ${setting.description} ${setting.page}`.toLocaleLowerCase();
        return tokens.every((token) => text.includes(token));
    });
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function pathParts(path: string): string[] {
    const parts = path.split('.');
    if (parts.some((part) => !part || forbidden.has(part))) throw new Error('Invalid setting path');
    return parts;
}
export function settingValue(document: Record<string, unknown>, definition: SettingDefinition): unknown {
    let value: unknown = document;
    for (const part of pathParts(definition.path)) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
            return definition.defaultValue === undefined ? undefined : structuredClone(definition.defaultValue);
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}
function integerError(definition: SettingDefinition, value: unknown): string | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'Enter a whole number';
    if (definition.minimum !== undefined && value < definition.minimum) return `Minimum: ${definition.minimum}`;
    if (definition.maximum !== undefined && value > definition.maximum) return `Maximum: ${definition.maximum}`;
}
function listError(definition: SettingDefinition, value: unknown): string | undefined {
    if (!Array.isArray(value)) return 'Enter a list';
    if (definition.maxItems !== undefined && value.length > definition.maxItems) return `Maximum entries: ${definition.maxItems}`;
    if (definition.kind === 'list' && value.some((item) => typeof item !== 'string')) return 'List entries must be text';
    if (definition.choices && (value as unknown[]).some((item) => typeof item !== 'string' || !definition.choices?.includes(item)))
        return 'List contains an unsupported value';
}
export function fieldError(definition: SettingDefinition, value: unknown): string | undefined {
    if (definition.readOnly) return 'This setting is enforced and cannot be edited';
    const validators: Partial<Record<SettingDefinition['kind'], () => string | undefined>> = {
        boolean: () => (typeof value === 'boolean' ? undefined : 'Choose on or off'),
        integer: () => integerError(definition, value),
        text: () => (typeof value === 'string' ? undefined : 'Enter text'),
        choice: () => (definition.choices?.includes(value as string) ? undefined : 'Choose a supported value'),
        list: () => listError(definition, value),
    };
    return validators[definition.kind]?.();
}

export function editSetting(document: Record<string, unknown>, definition: SettingDefinition, value: unknown): Record<string, unknown> {
    const error = fieldError(definition, value);
    if (error) throw new Error(error);
    if (definition.id === 'environment.AIBINATOR_RESOURCE_URL') return editPublicDomain(document, String(value));
    return assignSetting(document, definition, value);
}
export function assignSetting(document: Record<string, unknown>, definition: SettingDefinition, value: unknown): Record<string, unknown> {
    const parts = pathParts(definition.path);
    const result = structuredClone(document);
    let target = result;
    for (const part of parts.slice(0, -1)) {
        const existing = target[part];
        if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing)))
            throw new Error('Setting parent is not an object');
        if (!Object.hasOwn(target, part)) target[part] = {};
        target = target[part] as Record<string, unknown>;
    }
    target[parts.at(-1)!] = structuredClone(value);
    return result;
}
export interface SettingChange {
    id: string;
    label: string;
    before: string;
    after: string;
    apply: SettingDefinition['apply'];
}
export function previewChanges(
    source: SettingsSource,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    catalog = settings,
): SettingChange[] {
    return catalog
        .filter((definition) => definition.source === source)
        .flatMap((definition) => {
            const oldValue = settingValue(before, definition);
            const newValue = settingValue(after, definition);
            if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
            const show = (value: unknown) =>
                definition.sensitive
                    ? value === undefined
                        ? 'Not configured'
                        : '[redacted]'
                    : (JSON.stringify(value) ?? 'Not configured');
            return [{ id: definition.id, label: definition.label, before: show(oldValue), after: show(newValue), apply: definition.apply }];
        });
}
