import { blank, box, hstack, line, span, truncate, width, type Line } from '../canvas.js';
import { color, glyph, tone, type Tone } from '../theme.js';
import { actionItem, dotFor, heading, note } from '../items.js';
import type { Activity, Item, View } from '../model.js';
import { assistantName, assistants, assistantSignal, aibiSignal, operator, runtimeSignal, savedDiffers, type Signal } from '../status.js';
import type { OperatingMode } from '../../config.js';
import { wordmark } from '../wordmark.js';

function node(title: string, signal: Signal, caption: string, size: number): Line[] {
    return [
        line([span(truncate(title, size), color.muted, { bold: true })]),
        line([span(`${dotFor(signal.tone)} `, tone[signal.tone]), span(truncate(signal.label, size - 2), color.text, { bold: true })]),
        line([span(truncate(caption, size), color.dim)]),
    ];
}

function link(size: number, flowing: boolean, tick: number, offset: number): Line {
    const cells = Array.from({ length: size }, (_, index) =>
        flowing && (index + offset * 3) % size === tick % size ? glyph.pulse : glyph.flow,
    );
    return line([span(cells.join(''), flowing ? color.violetDeep : color.line)]);
}

function pipeline(view: View, size: number): Line[] {
    const live = operator(view);
    const mode = (live.mode && live.mode !== 'disabled' ? live.mode : view.snapshot.documents.operator.mode) as OperatingMode;
    const [aibi, runtime, assistant] = [aibiSignal(view), runtimeSignal(view), assistantSignal(view)];
    const flowing = assistant.tone === 'good' && aibi.tone === 'good';
    const inner = size - 4;
    const nodeSize = Math.min(20, Math.floor((inner - 6) / 3));
    const gap = Math.floor((inner - nodeSize * 3) / 2);
    const cols = [
        { lines: node('AIBI', aibi, aibi.detail, nodeSize), size: nodeSize, bg: color.panel },
        { lines: [blank(), link(gap - 2, flowing, view.tick, 0)], size: gap, bg: color.panel },
        { lines: node('AIBINATOR', runtime, runtime.detail, nodeSize), size: nodeSize, bg: color.panel },
        { lines: [blank(), link(gap - 2, flowing, view.tick, 1)], size: gap, bg: color.panel },
        {
            lines: node(assistants[mode]?.provider.toUpperCase() ?? 'ASSISTANT', assistant, assistant.detail, nodeSize),
            size: nodeSize,
            bg: color.panel,
        },
    ];
    return box([blank(), ...hstack(cols, 3), blank()], size, {
        border: flowing ? color.violetDeep : color.line,
        title: [span(` ${glyph.brand} `, color.violet), span(flowing ? 'Live ' : 'Overview ', color.soft, { bold: true })],
    });
}

function tiles(view: View, size: number): Line[] {
    const controller = operator(view).controller;
    const voice = view.observed.live?.aibi.voice;
    const stats: [string, string, string][] = [
        ['In progress', String(controller?.busy ?? voice?.tasks ?? 0), 'tasks'],
        ['Needs you', String(controller?.approvals ?? 0), 'questions'],
        ['To tell', String(voice?.waiting ?? 0), 'updates'],
    ];
    const tile = Math.floor((size - 2) / 3);
    const cols = stats.map(([title, value, caption], index) => {
        const width = index === 2 ? size - 2 - tile * 2 : tile;
        return {
            lines: box(
                [line([span(title, color.muted)]), line([span(value, color.text, { bold: true }), span(`  ${caption}`, color.dim)])],
                width - (index === 2 ? 0 : 1),
            ),
            size: width,
            bg: color.base,
        };
    });
    return hstack([{ lines: [], size: 2, bg: color.base }, ...cols], 4);
}

const block = (id: string, render: (size: number, view: View) => Line[]): Item => ({
    id,
    lines: (size, _selected, view) => render(size, view),
});

function primary(view: View): Item {
    const mode = operator(view).mode;
    const saved = assistantName(view.snapshot.documents.operator.mode);
    if (mode && mode !== 'disabled' && !savedDiffers(view))
        return actionItem('pause', `${glyph.off} Pause`, { type: 'run', action: 'pause' }, 'Stop taking work from AIBI');
    return actionItem(
        'start',
        `▶ Start ${saved}`,
        { type: 'run', action: 'start' },
        savedDiffers(view) ? 'Waiting for AiBinator to switch' : 'Let AIBI hand work to it',
        'good',
    );
}

function attention(view: View): Item[] {
    const notes: string[] = [];
    if (savedDiffers(view)) notes.push(`You saved ${assistantName(view.observed.active.mode)}, but it is not active yet.`);
    if (!view.observed.live && view.observed.runtime) notes.push('AiBinator is running an older build. Restart it to load this version.');
    if (view.changes.length) notes.push(`${view.changes.length} unsaved change${view.changes.length === 1 ? '' : 's'}. Press S to review.`);
    if (!notes.length) return [];
    return [
        heading('attention', 'Needs attention'),
        ...notes.map((value, index) => note(`attention-${index}`, `${glyph.warn} ${value}`, color.amber)),
    ];
}

function update(view: View): Item[] {
    const state = view.extras.update;
    if (state?.error) return [note('update-error', `${glyph.warn} Could not check for updates: ${state.error}`, color.amber)];
    if (!state?.behind) return [];
    const commits = `${state.behind} new commit${state.behind === 1 ? '' : 's'}`;
    if (state.blocker) return [note('update-blocked', `${glyph.warn} Update available (${commits}). ${state.blocker}`, color.amber)];
    return [
        actionItem(
            'update',
            `⬆ Update and restart`,
            { type: 'run', action: 'update' },
            `${commits}, ${state.current} → ${state.latest} · press U`,
            'good',
        ),
    ];
}

const kindTone: Record<string, Tone> = { warning: 'warn', unknown: 'info', heard: 'idle', said: 'good', action: 'good', task: 'info' };
const labels: Record<string, string> = { heard: 'Heard', said: 'Said', action: 'Did', task: 'Work' };

function recentActivity(view: View): Activity[] {
    const aibi = (view.observed.live?.aibi.activity ?? [])
        .slice(-6)
        .reverse()
        .map((entry) => ({
            at: entry.at.slice(11, 16),
            text: `${labels[entry.kind] ? `${labels[entry.kind]}: ` : ''}${entry.title}${entry.detail && !labels[entry.kind] ? ` · ${entry.detail}` : ''}`,
            tone: kindTone[entry.kind] ?? 'idle',
        }));
    return [...view.activity.slice(0, 2), ...aibi].slice(0, 7);
}

export function homeItems(view: View): Item[] {
    const recent = recentActivity(view);
    return [
        block('brand', () => {
            const [top, bottom] = wordmark();
            return [
                blank(),
                line([span('  '), ...top!.spans]),
                line([span('  '), ...bottom!.spans]),
                line([span('  Your AIBI, powered by your AI', color.muted)]),
            ];
        }),
        block('hero', (size, current) => [blank(), ...pipeline(current, size - 2).map((value) => line([span('  '), ...value.spans]))]),
        block('gap', () => [blank()]),
        primary(view),
        ...update(view),
        block('tiles', (size, current) => [blank(), ...tiles(current, size)]),
        ...attention(view),
        heading('recent', 'Recent activity'),
        ...(recent.length
            ? recent.map((item, index) =>
                  block(`activity-${index}`, (size) => [
                      line([
                          span('  '),
                          span(`${item.at}  `, color.dim),
                          span(`${dotFor(item.tone)} `, tone[item.tone]),
                          span(truncate(item.text, size - width(item.at) - 8), color.soft),
                      ]),
                  ]),
              )
            : [note('quiet', 'Nothing yet. What AIBI hears, says and does appears here.')]),
    ];
}
