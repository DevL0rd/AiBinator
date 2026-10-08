import type { OperatingMode, OperatorConfig } from '../config.js';
import type { Documents, PanelSnapshot } from '../panel-store.js';
import type { SettingChange } from '../settings-registry.js';
import type { LiveSetupStatus } from '../setup-model.js';
import type { ProviderModels } from '../providers.js';
import type { ManagedServiceStatus } from '../service-status.js';
import type { WebConnectors } from '../web-connectors.js';
import type { AppId, AppState } from '../connections.js';
import type { Line } from './canvas.js';
import type { Tone } from './theme.js';

export const pages = [
    { id: 'home', label: 'Home', icon: '⌂' },
    { id: 'assistant', label: 'Responder', icon: '✦' },
    { id: 'aibi', label: 'AIBI', icon: '◕' },
    { id: 'abilities', label: 'Abilities', icon: '✧' },
    { id: 'voice', label: 'Voice', icon: '◉' },
    { id: 'memory', label: 'Memory', icon: '⊞' },
    { id: 'apps', label: 'Apps', icon: '⇄' },
    { id: 'system', label: 'System', icon: '◫' },
] as const;
export type PageId = (typeof pages)[number]['id'];

export type ActionId =
    | 'start'
    | 'pause'
    | 'refresh'
    | 'open-session'
    | 'app-claude-code'
    | 'app-codex'
    | 'web-claude'
    | 'web-chatgpt'
    | 'sign-in-password'
    | 'install-service'
    | 'restart-service'
    | 'update'
    | 'clear-memory'
    | 'allow-ports';

export type Intent =
    | { type: 'page'; page: PageId }
    | { type: 'edit'; setting: string }
    | { type: 'toggle'; setting: string }
    | { type: 'mode'; mode: OperatingMode }
    | { type: 'run'; action: ActionId }
    | { type: 'save' }
    | { type: 'discard' }
    | { type: 'info'; title: string; body: string };

export interface Observations {
    live: LiveSetupStatus | null;
    runtime: boolean;
    active: OperatorConfig;
    codex: ProviderModels;
    claude: ProviderModels;
    service: ManagedServiceStatus;
    observedAt: string;
}
export interface Extras {
    apps: Partial<Record<AppId, AppState>>;
    web?: WebConnectors;
    password?: boolean;
    update?: AppUpdate;
    ports?: boolean;
}
export interface AppUpdate {
    behind: number;
    current: string;
    latest: string;
    blocker?: string;
    error?: string;
}
export interface Activity {
    at: string;
    text: string;
    tone: Tone;
}
export interface View {
    snapshot: PanelSnapshot;
    drafts: Documents;
    observed: Observations;
    extras: Extras;
    changes: SettingChange[];
    activity: Activity[];
    busy?: string;
    tick: number;
}
export interface Item {
    id: string;
    lines(size: number, selected: boolean, view: View): Line[];
    intent?: Intent;
}
export const focusable = (item: Item): boolean => Boolean(item.intent);
