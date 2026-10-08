import { animations, usableActions } from '../../../aibi/capabilities.js';
import { note, section, settingItem } from '../items.js';
import type { Item, View } from '../model.js';

export function abilitiesItems(view: View): Item[] {
    const aibi = view.drafts.policy.aibi as { actions?: unknown } | undefined;
    const chosen = new Set(Array.isArray(aibi?.actions) ? (aibi.actions as string[]) : usableActions);
    const on = usableActions.filter((id) => chosen.has(id)).length;
    return [
        ...section('abilities-body', 'Body', `${on} of ${usableActions.length} actions on`, [
            settingItem('policy.aibi.actions', 'Actions'),
            settingItem('policy.aibi.animations', 'Animations'),
            note(
                'abilities-note',
                `The voice picks these by itself: dancing, singing, games, lights, turning, timers, alarms and more, and ${animations.length} firmware animations it can answer with.`,
            ),
        ]),
        ...section('abilities-apps', 'Connected apps', 'What your responder and other apps may do', [
            settingItem('policy.scopes', 'Allowed'),
        ]),
    ];
}
