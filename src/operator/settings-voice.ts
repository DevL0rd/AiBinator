import { group } from './settings-types.js';

export const voiceSettings = [
    ...group('environment', 'voice', 'live', [
        {
            path: 'GEMINI_API_KEY',
            label: 'Google Gemini API key',
            description:
                'Key from aistudio.google.com/apikey. AIBI’s voice is Gemini Live: it hears AIBI’s microphone and answers in its own voice. Saved privately in .env and never shown again; a new key is used from the next conversation.',
            credential: true,
            kind: 'text',
            sensitive: true,
        },
    ]),
    ...group('policy', 'voice', 'live', [
        {
            path: 'voice.liveModel',
            label: 'Live voice model',
            description: 'Gemini Live model that talks through AIBI. About $0.023 per minute while talking; nothing while AIBI is idle.',
            kind: 'text',
            defaultValue: 'gemini-3.8-live',
        },
        {
            path: 'voice.liveVoice',
            label: 'Voice',
            description: 'Gemini voice name, such as Puck, Kore, Charon, Aoede or Zephyr. Empty uses the default voice of the model.',
            kind: 'text',
            defaultValue: '',
        },
        {
            path: 'voice.idleSeconds',
            label: 'End a quiet conversation after (seconds)',
            description:
                'The voice ends a conversation by itself when you are done. This is the backstop: after this long without anyone speaking (and no task you gave AIBI still running), AIBI stops listening.',
            kind: 'integer',
            minimum: 10,
            maximum: 600,
            defaultValue: 30,
        },
        {
            path: 'voice.speechThreshold',
            label: 'Speech loudness',
            description:
                'How loud AIBI’s microphone must be before it counts as someone talking. Raise it if background noise starts turns; lower it if quiet speech is missed.',
            kind: 'integer',
            minimum: 100,
            maximum: 8000,
            defaultValue: 4000,
        },
        {
            path: 'voice.memoryLines',
            label: 'Remembered lines',
            description: 'How many recent lines of your conversations the voice is given at the start of each conversation.',
            kind: 'integer',
            minimum: 0,
            maximum: 200,
            defaultValue: 40,
        },
    ]),
];
