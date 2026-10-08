import type { BotEvent } from '../core/queue.js';

export function requestText(event: BotEvent): string {
    const kind =
        event.kind === 'voice'
            ? 'AIBI · spoken request, handed to you by AIBI’s voice (your final reply is told to them out loud; keep it short and speakable)'
            : 'AIBI · note';
    return `${kind}\n${event.text}`;
}
