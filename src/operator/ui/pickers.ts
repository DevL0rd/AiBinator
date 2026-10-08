import { actions, animations } from '../../aibi/capabilities.js';
import { settingValue, type SettingDefinition } from '../settings-registry.js';
import type { UiState } from './state.js';

export interface Picker {
    field: SettingDefinition;
    labels: Record<string, string>;
    chosen: string[];
}

const described: Record<string, Record<string, string>> = {
    'policy.aibi.actions': Object.fromEntries(actions.map((action) => [action.id, `${action.id} · ${action.description}`])),
    'policy.aibi.animations': Object.fromEntries(animations.map((name) => [name, name])),
};

export function pickerFor(field: SettingDefinition, state: UiState): Picker | undefined {
    const labels = described[field.id];
    if (!labels) return undefined;
    const chosen = (settingValue(state.drafts[field.source], field) as string[] | undefined) ?? [];
    return { field, labels, chosen: [...chosen] };
}
