import { scalar } from '../../../core/text.js';
import { publicDomain } from '../../connection-domain.js';
import { connectorStatus, webHint, type WebId } from '../../web-connectors.js';
import { line, span } from '../canvas.js';
import { actionItem, card, heading, note, pill, section, settingItem } from '../items.js';
import type { Item, View } from '../model.js';
import { color, type Tone } from '../theme.js';

function webTone(status: string): Tone {
    if (status === 'Connected') return 'good';
    return status === 'Not connected' ? 'idle' : 'warn';
}

function webCard(id: WebId, title: string, status: string, about: string): Item {
    return card({
        id: `web-${id}`,
        intent: { type: 'run', action: `web-${id}` },
        title,
        badge: pill(status, webTone(status)),
        body: [line([span(about, color.soft)]), line([span(webHint[status] ?? '', color.muted)])],
    });
}

export function appsItems(view: View): Item[] {
    const domain = publicDomain(view.drafts.environment.AIBINATOR_RESOURCE_URL);
    const url = domain ? `https://${domain}/mcp` : undefined;
    const web = (id: WebId) => (domain ? connectorStatus(view.extras.web?.[id], url).text : 'Needs a public domain');
    return [
        heading('apps-cloud', 'Web connectors', domain ? `Reached through ${domain}` : 'Set a public domain below to use these'),
        webCard('claude', 'Claude (web)', web('claude'), 'AIBI tools in claude.ai and the Claude phone app.'),
        webCard('chatgpt', 'ChatGPT (web)', web('chatgpt'), 'AIBI tools in ChatGPT on the web and phone.'),
        ...section('address', 'Your public address', 'Optional · for web connectors', [
            note(
                'address-port',
                `Point your domain (Cloudflare Tunnel or a reverse proxy) at http://127.0.0.1:${scalar(view.drafts.environment.AIBINATOR_PORT) || '8789'}.`,
            ),
            settingItem('environment.AIBINATOR_RESOURCE_URL', 'Public domain'),
            actionItem('sign-in-password', 'Sign-in password', { type: 'run', action: 'sign-in-password' }, 'Set or change it'),
        ]),
        actionItem('refresh-apps', 'Check again', { type: 'run', action: 'refresh' }, 'Re-reads every app'),
    ];
}
