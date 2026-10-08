import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Principal } from './owner.js';
import { applyDraft, readPanel } from '../operator/panel-store.js';
import { editSetting, settings, settingValue, type SettingDefinition } from '../operator/settings-registry.js';
import { requireOwner } from './owner.js';
import { guarded } from './tools.js';

const editable = (definition: SettingDefinition) => !definition.credential && !definition.readOnly;

function shown(definition: SettingDefinition, value: unknown): unknown {
    if (!definition.credential) return value;
    return value ? 'set' : 'not set';
}

export async function settingsList() {
    const snapshot = await readPanel();
    return settings.map((definition) => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        kind: definition.kind,
        ...(definition.choices ? { choices: definition.choices } : {}),
        ...(definition.minimum !== undefined ? { minimum: definition.minimum } : {}),
        ...(definition.maximum !== undefined ? { maximum: definition.maximum } : {}),
        value: shown(definition, settingValue(snapshot.documents[definition.source], definition)),
        editable: editable(definition),
        applies: definition.apply,
    }));
}

export async function settingsUpdate(changes: { id: string; value: unknown }[]): Promise<string> {
    const snapshot = await readPanel();
    let drafts = structuredClone(snapshot.documents);
    for (const change of changes) {
        const definition = settings.find((item) => item.id === change.id);
        if (!definition) throw new Error(`Unknown setting ${change.id}`);
        if (!editable(definition)) throw new Error(`${definition.label} can only be changed in the setup app`);
        drafts = { ...drafts, [definition.source]: editSetting(drafts[definition.source], definition, change.value) };
    }
    return (await applyDraft(snapshot, drafts)).message;
}

export function registerSettings(server: McpServer, principal: Principal | undefined, meta: unknown): void {
    const owner = <T>(action: () => Promise<T>) =>
        guarded(async () => {
            requireOwner(principal);
            return action();
        });
    server.registerTool(
        'aibinator_settings',
        {
            title: 'Read AiBinator settings',
            description:
                'Authenticated owner only. Every AiBinator setting with its id, meaning, allowed values and current value. Secrets show only whether they are set.',
            inputSchema: z.object({}).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            _meta: meta as Record<string, unknown> | undefined,
        },
        () => owner(settingsList),
    );
    server.registerTool(
        'aibinator_settings_update',
        {
            title: 'Change AiBinator settings',
            description:
                'Authenticated owner only. Change one or more settings by id (from aibinator_settings), validated and applied exactly like the setup app. Changing mode switches the primary responder. Secrets cannot be changed here.',
            inputSchema: z
                .object({
                    changes: z
                        .array(z.object({ id: z.string(), value: z.unknown() }).strict())
                        .min(1)
                        .max(25),
                })
                .strict(),
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            _meta: meta as Record<string, unknown> | undefined,
        },
        (args) => owner(() => settingsUpdate(args.changes.map((change) => ({ id: change.id, value: change.value })))),
    );
}
