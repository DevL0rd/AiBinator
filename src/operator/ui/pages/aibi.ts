import { actionItem, note, section, settingItem, statusItem } from '../items.js';
import type { Item, View } from '../model.js';
import type { Tone } from '../theme.js';

type Part = { state: string; error?: string };
const partTones: Record<string, Tone> = { running: 'good', starting: 'info', failed: 'bad' };
const partTone = (part?: Part): Tone => partTones[part?.state ?? ''] ?? 'idle';
const partText = (part: Part | undefined, running: string): string => {
    if (!part) return 'Unknown';
    if (part.state === 'running') return running;
    if (part.state === 'failed') return part.error ?? 'Did not start';
    return part.state === 'starting' ? 'Starting…' : 'Off';
};

function contact(view: View): Item {
    const last = view.observed.live?.aibi.lastContact;
    if (!last) return statusItem('aibi-contact', 'AIBI', 'Has not called yet', view.observed.live ? 'warn' : 'idle');
    return statusItem('aibi-contact', 'AIBI', `Last seen ${last.at.slice(0, 16).replace('T', ' ')} UTC from ${last.remote}`, 'good');
}

function servers(view: View): Item[] {
    const aibi = view.observed.live?.aibi;
    if (!aibi) return [statusItem('aibi-server', 'AIBI server', 'AiBinator is not running', 'idle')];
    return [
        statusItem(
            'aibi-server',
            'AIBI server',
            partText(aibi.proxy, `Listening on ${aibi.ports.http} and ${aibi.ports.https}`),
            partTone(aibi.proxy),
        ),
        statusItem('aibi-dns', 'DNS server', partText(aibi.dns, `Answering on ${aibi.address}`), partTone(aibi.dns)),
        statusItem('aibi-address', 'This computer', aibi.address || 'Not detected yet', aibi.address ? 'good' : 'idle'),
    ];
}

function connection(view: View): Item[] {
    const address = view.observed.live?.aibi.address || 'this computer’s address';
    const ports = view.extras.ports;
    return [
        contact(view),
        ...servers(view),
        ...(ports === false
            ? [
                  actionItem(
                      'allow-ports',
                      'Allow ports 53, 80 and 443',
                      { type: 'run', action: 'allow-ports' },
                      'Needs your password once',
                      'warn',
                  ),
              ]
            : []),
        note(
            'aibi-steps',
            `To connect AIBI, make ${address} its DNS server: in your router’s DHCP settings, give AIBI (or your whole network) ${address} as DNS, then restart AIBI. Keep this computer’s address fixed (a DHCP reservation) so AIBI keeps finding it. AiBinator then answers api.aibipocket.com for AIBI and forwards every other name, so the rest of your network works as before.`,
        ),
    ];
}

function calls(view: View): Item[] {
    const seen = view.observed.live?.aibi.calls ?? [];
    if (!seen.length)
        return [note('aibi-calls-empty', 'Nothing yet. Every kind of request AIBI makes shows up here with how often it came.')];
    return seen.map((call) =>
        statusItem(`aibi-call-${call.path}`, call.path, `${call.count}× · last ${call.last.slice(11, 16)} UTC`, 'info'),
    );
}

export function aibiItems(view: View): Item[] {
    return [
        ...section('aibi-connection', 'Connection', 'How AIBI reaches this computer', connection(view)),
        ...section('aibi-calls', 'Calls from AIBI', 'What it asks for and how often', calls(view)),
        ...section('aibi-self', 'AIBI', 'Who it is', [
            settingItem('policy.ownerName', 'Your name'),
            settingItem('policy.aibi.mode', 'Mode'),
            settingItem('policy.aibi.personality', 'Personality'),
            note(
                'aibi-modes',
                'Local: AiBinator is AIBI’s brain, with Gemini Live as its voice and your responder for real work. Pass-through: AIBI uses its own cloud as before while AiBinator watches, logs anything new and captures firmware updates.',
            ),
        ]),
        ...section('aibi-network', 'Network', 'Most people never need these', [
            settingItem('policy.aibi.lanAddress', 'This computer’s address'),
            settingItem('policy.aibi.dns', 'Built-in DNS server'),
            settingItem('policy.aibi.dnsUpstream', 'Forward other names to'),
            settingItem('policy.aibi.httpPort', 'HTTP port'),
            settingItem('policy.aibi.httpsPort', 'HTTPS port'),
            settingItem('policy.aibi.dnsPort', 'DNS port'),
        ]),
        ...section('aibi-capture', 'Traffic capture', 'Every request and reply, saved raw', [
            settingItem('policy.aibi.capture', 'Capture raw traffic'),
            note(
                'aibi-capture-note',
                'Saved in .data/aibi/traffic in the installed copy: one JSON file per request with headers and text bodies, audio and photos as .bin files, the latest 1,000 kept. It includes everything AIBI hears, so keep it off when you are not investigating.',
            ),
        ]),
        ...section('aibi-firmware', 'Firmware', 'Updates stay under your control', [
            note(
                'aibi-firmware-note',
                'AIBI never installs a cloud update behind your back: in both modes, update offers are captured into .data/firmware and hidden from AIBI. Run aibinator firmware to find, unpack, patch and rebuild a firmware; a patched package in .data/firmware/patched is then offered to AIBI.',
            ),
        ]),
    ];
}
