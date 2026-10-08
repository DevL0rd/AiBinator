import { settings } from '../../settings-registry.js';
import { serviceDescription } from '../../service-status.js';
import { actionItem, note, section, settingItem, statusItem } from '../items.js';
import type { Item, View } from '../model.js';

const elsewhere = new Set([
    'environment.AIBINATOR_RESOURCE_URL',
    'environment.AIBINATOR_AUTH_MODE',
    'environment.AIBINATOR_OAUTH_SERVER',
    'environment.GEMINI_API_KEY',
]);
const advanced = settings.filter((field) => field.source === 'environment' && !elsewhere.has(field.id)).map((field) => field.id);

export function systemItems(view: View): Item[] {
    const service = view.observed.service;
    const state = serviceDescription(service);
    return [
        ...section('service', 'Background service', 'Keeps AiBinator running after you log out', [
            statusItem(
                'service-state',
                'Service',
                `${state.charAt(0).toUpperCase()}${state.slice(1)}`,
                service.active ? 'good' : service.installed ? 'warn' : 'idle',
            ),
            actionItem(
                'install-service',
                service.installed ? 'Reinstall AiBinator' : 'Install AiBinator',
                { type: 'run', action: 'install-service' },
                'Installs its own copy, the aibinator command and a background service',
            ),
            ...(service.active
                ? [
                      actionItem(
                          'restart-service',
                          'Restart AiBinator',
                          { type: 'run', action: 'restart-service' },
                          'Restarts the background service',
                          'warn',
                      ),
                  ]
                : []),
        ]),
        ...section(
            'advanced',
            'Advanced',
            'Most people never need these',
            advanced.map((id) => settingItem(id)),
        ),
        ...section('backups', 'Backups', '', [
            note('backups-note', 'Before every save AiBinator keeps a private copy of the previous file in .data/setup-backups.'),
        ]),
    ];
}
