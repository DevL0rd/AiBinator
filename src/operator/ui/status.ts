import type { OperatingMode } from '../config.js';
import type { Tone } from './theme.js';
import type { View } from './model.js';

export const assistants: Record<OperatingMode, { name: string; provider: string; blurb: string; tag?: { text: string; tone: Tone } }> = {
    'claude-session': {
        name: 'Claude Code',
        provider: 'Claude',
        tag: { text: 'RECOMMENDED', tone: 'good' },
        blurb: 'Work AIBI’s voice hands over goes to one ongoing Claude conversation. With Claude Desktop installed it opens there, starting the app if needed, so you can watch and chat; otherwise it runs in the background.',
    },
    'codex-local': {
        name: 'Codex',
        provider: 'Codex',
        blurb: 'Work AIBI’s voice hands over goes to one ongoing Codex conversation in the shared Codex service on this computer, so any Codex app attached to it can follow along. Uses your Codex login.',
    },
    'manual-mcp': {
        name: 'Another MCP app',
        provider: 'Your app',
        blurb: 'Any MCP-capable app connects to AiBinator, polls for AIBI requests and answers them itself.',
    },
};
export const assistantName = (mode: unknown): string => assistants[mode as OperatingMode]?.name ?? 'Paused';

export interface Signal {
    label: string;
    detail: string;
    tone: Tone;
}
type Operator = { mode?: string; blockedReason?: string | null; session?: { live?: boolean } | null; controller?: Controller | null };
type Controller = {
    connected?: boolean;
    failed?: boolean;
    busy?: number;
    approvals?: number;
    pendingDelivery?: number;
    deliveryError?: string | null;
};
export const operator = (view: View): Operator => view.observed.live?.operator ?? {};

export function runtimeSignal(view: View): Signal {
    if (view.observed.live) return { label: 'Running', detail: 'Serving AIBI', tone: 'good' };
    if (view.observed.runtime) return { label: 'Outdated', detail: 'Restart to update', tone: 'warn' };
    return { label: 'Stopped', detail: 'Not running', tone: 'bad' };
}

export function aibiSignal(view: View): Signal {
    const aibi = view.observed.live?.aibi;
    if (!aibi) return { label: 'Unknown', detail: 'Not reporting', tone: 'idle' };
    if (aibi.proxy.state === 'failed') return { label: 'Server down', detail: aibi.proxy.error ?? 'Did not start', tone: 'bad' };
    if (aibi.dns.state === 'failed') return { label: 'DNS down', detail: aibi.dns.error ?? 'Did not start', tone: 'warn' };
    if (aibi.voice.conversation) return { label: 'Talking', detail: 'Conversation open', tone: 'good' };
    if (!aibi.lastContact) return { label: 'Waiting', detail: 'AIBI has not called yet', tone: 'warn' };
    return { label: 'Connected', detail: `Last seen ${aibi.lastContact.at.slice(11, 16)} UTC`, tone: 'good' };
}

const modeSignals: Partial<Record<OperatingMode, (live: Operator) => Signal>> = {
    'claude-session': (live) => {
        if (!live.session) return controllerSignal(live.controller);
        return live.session.live
            ? { label: 'Listening', detail: 'Live in Desktop', tone: 'good' }
            : { label: 'Ready', detail: 'Opens Desktop on demand', tone: 'good' };
    },
    'codex-local': (live) => controllerSignal(live.controller),
};

export function assistantSignal(view: View): Signal {
    const live = operator(view);
    const mode = live.mode as OperatingMode | 'disabled' | undefined;
    if (!view.observed.live || !mode) return { label: 'Offline', detail: 'Nothing running', tone: 'idle' };
    if (mode === 'disabled') return { label: 'Paused', detail: 'Not taking work', tone: 'idle' };
    if (live.blockedReason) return { label: 'Blocked', detail: live.blockedReason, tone: 'warn' };
    return modeSignals[mode]?.(live) ?? { label: 'External', detail: 'Managed by your app', tone: 'info' };
}

function controllerSignal(controller?: Controller | null): Signal {
    if (!controller) return { label: 'Starting', detail: 'Connecting', tone: 'warn' };
    if (controller.failed) return { label: 'Reconnecting', detail: 'Restarting', tone: 'warn' };
    if (controller.deliveryError) return { label: 'Listening', detail: 'Retrying a reply', tone: 'warn' };
    return controller.busy
        ? { label: 'Working', detail: `${controller.busy} in progress`, tone: 'good' }
        : { label: 'Listening', detail: 'Ready for work', tone: 'good' };
}

export function savedDiffers(view: View): boolean {
    const live = view.observed.live?.operator;
    const active = view.observed.active;
    return Boolean(live) && active.enabled && live?.appliedConfigAt !== active.updatedAt;
}
