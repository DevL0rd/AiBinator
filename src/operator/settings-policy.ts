import { defaultPersonality, scopeNames } from '../core/config.js';
import { animations, usableActions } from '../aibi/capabilities.js';
import { group } from './settings-types.js';

export const policySettings = [
    ...group('policy', 'aibi', 'live', [
        {
            path: 'ownerName',
            label: 'Your name',
            description: 'What AIBI and your assistant call you. Leave empty to stay anonymous.',
            kind: 'text',
            defaultValue: '',
        },
        {
            path: 'aibi.mode',
            label: 'Mode',
            description:
                'local: AiBinator answers AIBI itself with Gemini Live and your assistant. passthrough: AIBI talks to its own cloud as before, and AiBinator only watches, logs new behaviors and captures firmware updates.',
            kind: 'choice',
            choices: ['local', 'passthrough'],
            defaultValue: 'local',
        },
        {
            path: 'aibi.personality',
            label: 'Personality',
            description: 'How AIBI talks and behaves. Used by the live voice every conversation.',
            kind: 'text',
            defaultValue: defaultPersonality,
        },
        {
            path: 'aibi.lanAddress',
            label: 'This computer’s address',
            description:
                'The network address AIBI should reach this computer on. Empty picks it automatically; set it when this computer has several networks.',
            kind: 'text',
            defaultValue: '',
        },
        {
            path: 'aibi.dns',
            label: 'Built-in DNS server',
            description:
                'Answers api.aibipocket.com with this computer’s address and forwards every other name, so pointing AIBI’s DNS here is all it takes. Turn off if your router or another DNS server already points api.aibipocket.com here.',
            kind: 'boolean',
            defaultValue: true,
        },
        {
            path: 'aibi.capture',
            label: 'Capture raw traffic',
            description:
                'Saves every request AIBI makes and every reply it gets, with headers and bodies (microphone audio and photos as files), in .data/aibi/traffic. Keeps the latest 1,000. For figuring out new AIBI behavior; it holds everything AIBI hears, so leave it off otherwise.',
            kind: 'boolean',
            defaultValue: false,
        },
        {
            path: 'aibi.dnsUpstream',
            label: 'Forward other names to',
            description: 'DNS server for every other name, as an address with an optional :port.',
            kind: 'text',
            defaultValue: '1.1.1.1',
        },
        {
            path: 'aibi.httpPort',
            label: 'HTTP port',
            description: 'AIBI uses 80. Change only for testing.',
            kind: 'integer',
            minimum: 1,
            maximum: 65535,
            defaultValue: 80,
        },
        {
            path: 'aibi.httpsPort',
            label: 'HTTPS port',
            description: 'AIBI uses 443. Change only for testing.',
            kind: 'integer',
            minimum: 1,
            maximum: 65535,
            defaultValue: 443,
        },
        {
            path: 'aibi.dnsPort',
            label: 'DNS port',
            description: 'Devices ask on 53. Change only for testing.',
            kind: 'integer',
            minimum: 1,
            maximum: 65535,
            defaultValue: 53,
        },
    ]),
    ...group('policy', 'abilities', 'live', [
        {
            path: 'aibi.actions',
            label: 'Actions',
            description:
                'Native AIBI behaviors the voice and your assistant may use. All of them by default; uncheck one to switch it off.',
            kind: 'list',
            choices: [...usableActions],
            maxItems: 200,
            defaultValue: [...usableActions],
        },
        {
            path: 'aibi.animations',
            label: 'Animations',
            description:
                'Firmware animations the voice may play with interact_answer_with_animation. All of them by default; uncheck one to switch it off.',
            kind: 'list',
            choices: animations,
            maxItems: 600,
            defaultValue: [...animations],
        },
        {
            path: 'scopes',
            label: 'What connected apps may do',
            description:
                'aibi.read: status, history and activity. aibi.speak: make AIBI say things. aibi.act: make AIBI move. memory.write: erase conversation memory. Answering requests with aibi_reply is always allowed.',
            kind: 'list',
            choices: scopeNames,
            defaultValue: [...scopeNames],
        },
    ]),
];
