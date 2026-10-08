export type SettingsSource = 'operator' | 'policy' | 'environment';
export type SettingsPage = 'responders' | 'models' | 'aibi' | 'abilities' | 'connections' | 'voice';
type SettingKind = 'boolean' | 'integer' | 'text' | 'list' | 'choice';
export interface SettingDefinition {
    id: string;
    source: SettingsSource;
    path: string;
    page: SettingsPage;
    label: string;
    description: string;
    kind: SettingKind;
    defaultValue?: unknown;
    choices?: readonly string[];
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    sensitive?: boolean;
    credential?: boolean;
    readOnly?: boolean;
    apply: 'live' | 'next-request' | 'reference' | 'external' | 'read-only';
}
type Spec = Omit<SettingDefinition, 'id' | 'source' | 'page' | 'apply'> & { apply?: SettingDefinition['apply'] };
export function group(
    source: SettingsSource,
    page: SettingsPage,
    apply: SettingDefinition['apply'],
    specs: readonly Spec[],
): SettingDefinition[] {
    return specs.map((spec) => ({
        ...spec,
        id: `${source}.${spec.path}`,
        source,
        page,
        apply: spec.readOnly ? 'read-only' : (spec.apply ?? apply),
    }));
}
