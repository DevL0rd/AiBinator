import { note, section, settingItem, statusItem } from '../items.js';
import type { Item, View } from '../model.js';

function readiness(view: View): { text: string; state: 'good' | 'warn' | 'idle' } {
    if (!view.drafts.environment.GEMINI_API_KEY) return { text: 'Needs a Google Gemini key', state: 'warn' };
    if (view.observed.live?.aibi.voice.conversation) return { text: 'Talking with AIBI now', state: 'good' };
    return { text: 'Ready', state: 'good' };
}

export function voiceItems(view: View): Item[] {
    const ready = readiness(view);
    return [
        ...section('voice-live', 'Live voice', 'Gemini Live talks through AIBI', [
            statusItem('voice-ready', 'Voice', ready.text, ready.state),
            settingItem('environment.GEMINI_API_KEY', 'Google Gemini API key'),
            settingItem('policy.voice.liveModel', 'Live voice model'),
            settingItem('policy.voice.liveVoice', 'Voice'),
            note(
                'voice-how',
                'Wake AIBI as usual. From then on every turn goes to Gemini Live with your recent conversations as memory, until it decides you are done. It plays with AIBI’s body by itself and hands anything bigger to your responder. Get a key at aistudio.google.com/apikey.',
            ),
        ]),
        ...section('voice-turns', 'Conversation', 'When it listens and how much it remembers', [
            settingItem('policy.voice.idleSeconds', 'End a quiet conversation after (s)'),
            settingItem('policy.voice.speechThreshold', 'Speech loudness'),
            settingItem('policy.voice.memoryLines', 'Remembered lines'),
        ]),
    ];
}
