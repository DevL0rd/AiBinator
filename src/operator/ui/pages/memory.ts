import { line, span, truncate } from '../canvas.js';
import { actionItem, heading, note, section } from '../items.js';
import type { Item, View } from '../model.js';
import { color, tone, type Tone } from '../theme.js';

const who: Record<string, string> = { user: 'You', aibi: 'AIBI', note: '·' };
const kindTone: Record<string, Tone> = { warning: 'warn', unknown: 'info', said: 'good', action: 'good', task: 'info', network: 'good' };

function row(id: string, time: string, label: string, text: string, fg: string): Item {
    return {
        id,
        lines: (size) => [
            line([
                span('  '),
                span(`${time}  `, color.dim),
                span(`${label.padEnd(6)} `, fg, { bold: true }),
                span(truncate(text, Math.max(10, size - 18)), color.soft),
            ]),
        ],
    };
}

export function memoryItems(view: View): Item[] {
    const aibi = view.observed.live?.aibi;
    const lines = aibi?.conversation ?? [];
    const activity = [...(aibi?.activity ?? [])].reverse();
    return [
        ...section('memory-conversation', 'Conversation', `${aibi?.memory ?? 0} lines remembered`, [
            ...(lines.length
                ? lines.map((entry) =>
                      row(`memory-${entry.id}`, entry.at.slice(11, 16), who[entry.role] ?? entry.role, entry.text, color.violet),
                  )
                : [
                      note(
                          'memory-empty',
                          'Nothing yet. What you and AIBI say is remembered here and given to the voice and your responder.',
                      ),
                  ]),
            actionItem(
                'clear-memory',
                'Forget everything',
                { type: 'run', action: 'clear-memory' },
                'Erases the conversation and its photos',
                'warn',
            ),
        ]),
        heading('activity', 'Activity', 'Everything AIBI and AiBinator did, newest first'),
        ...(activity.length
            ? activity.map((entry) =>
                  row(
                      `activity-${entry.id}`,
                      entry.at.slice(11, 16),
                      entry.kind,
                      entry.detail ? `${entry.title} · ${entry.detail}` : entry.title,
                      tone[kindTone[entry.kind] ?? 'idle'],
                  ),
              )
            : [note('activity-empty', 'No activity yet.')]),
    ];
}
