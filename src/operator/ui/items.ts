import { settings, settingValue, type SettingDefinition } from '../settings-registry.js';
import { publicDomain } from '../connection-domain.js';
import type { Documents } from '../panel-store.js';
import { between, blank, box, fit, line, span, truncate, width, wrap, type Line, type Span } from './canvas.js';
import { color, glyph, tone, type Tone } from './theme.js';
import type { Intent, Item, View } from './model.js';
import { toggleable } from './edit.js';
import { scalar } from '../../core/text.js';

export const setting = (id: string): SettingDefinition => {
    const found = settings.find((item) => item.id === id);
    if (!found) throw new Error(`Unknown setting ${id}`);
    return found;
};
const choiceLabels: Record<string, string> = {
    bearer: 'Access key',
    oauth: 'Sign-in (OAuth)',
    bundled: 'Built in',
    external: 'External provider',
    local: 'Local (AiBinator answers)',
    passthrough: 'Pass-through (AIBI cloud)',
};
const megabytes = (bytes: number) => `${Number((bytes / 1_048_576).toFixed(1))} MB`;
const isSwitch = (field: SettingDefinition, value: unknown) => field.kind === 'boolean' || ['true', 'false'].includes(String(value));

function display(field: SettingDefinition, documents: Documents): { text: string; muted: boolean } {
    const raw = settingValue(documents[field.source], field);
    const value = field.id === 'environment.AIBINATOR_RESOURCE_URL' ? publicDomain(raw) : raw;
    if (field.credential) return secret(value);
    if (isSwitch(field, value)) {
        const on = String(value) === 'true';
        return { text: on ? `${glyph.on} On` : `${glyph.off} Off`, muted: !on };
    }
    if (Array.isArray(value)) return value.length ? { text: listText(field, value), muted: false } : { text: 'None', muted: true };
    if (field.path.endsWith('Bytes') && typeof value === 'number') return { text: megabytes(value), muted: false };
    return plain(value);
}
const secret = (value: unknown) => (value ? { text: '••••••••', muted: false } : { text: 'Not set', muted: true });
const plain = (value: unknown) =>
    value === undefined || value === ''
        ? { text: 'Default', muted: true }
        : { text: choiceLabels[scalar(value)] ?? scalar(value), muted: false };
function listText(field: SettingDefinition, value: unknown[]): string {
    if (field.choices?.length)
        return value.length === field.choices.length ? `All ${value.length}` : `${value.length} of ${field.choices.length}`;
    if (field.sensitive || value.length > 3) return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
    return value.join(', ');
}
const changed = (field: SettingDefinition, view: View) =>
    JSON.stringify(settingValue(view.drafts[field.source], field)) !==
    JSON.stringify(settingValue(view.snapshot.documents[field.source], field));

function row(size: number, selected: boolean, left: Span[], right: Span[], target: string): Line {
    const bg = selected ? color.raised : color.base;
    const marker = span(selected ? glyph.bar : ' ', color.violet, { bg });
    return {
        ...between([marker, span(' '), ...left], [...right, span(selected ? ` ${glyph.arrow} ` : '   ', color.violet)], size, bg),
        target,
    };
}

export function settingItem(id: string, label?: string): Item {
    const field = setting(id);
    const intent: Intent = toggleable(field) ? { type: 'toggle', setting: id } : { type: 'edit', setting: id };
    return {
        id,
        intent,
        lines: (size, selected, view) => {
            const value = display(field, view.drafts);
            const dirty = changed(field, view);
            const fg = dirty ? color.amber : value.muted ? color.muted : color.soft;
            const title = label ?? field.label;
            const room = Math.max(8, size - width(title) - 8);
            return [
                row(
                    size,
                    selected,
                    [span(title, selected ? color.text : color.soft, { bold: selected })],
                    [span(truncate(`${dirty ? `${glyph.on} ` : ''}${value.text}`, room), fg)],
                    id,
                ),
            ];
        },
    };
}

export function actionItem(id: string, label: string, intent: Intent, detail = '', accent: Tone = 'info'): Item {
    return {
        id,
        intent,
        lines: (size, selected) => [
            row(
                size,
                selected,
                [span(` ${label} `, selected ? color.ink : tone[accent], { bg: selected ? tone[accent] : color.lift, bold: true })],
                [span(detail, color.muted)],
                id,
            ),
        ],
    };
}

export function statusItem(id: string, label: string, value: string, state: Tone, intent?: Intent): Item {
    return {
        id,
        ...(intent ? { intent } : {}),
        lines: (size, selected) => [
            row(size, selected, [span(label, color.soft)], [span(`${dotFor(state)} `, tone[state]), span(value, color.text)], id),
        ],
    };
}

export const dotFor = (state: Tone): string =>
    ({ good: glyph.on, warn: glyph.warn, bad: glyph.cross, idle: glyph.off, info: glyph.pending })[state];

export function heading(id: string, title: string, subtitle = ''): Item {
    return {
        id,
        lines: (size) => [
            blank(),
            line([span('  '), span(title, color.violet, { bold: true }), span(`  ${subtitle}`, color.muted)]),
            line([span('  '), span('─'.repeat(Math.max(0, size - 4)), color.line)]),
        ],
    };
}

export function note(id: string, value: string, fg: string = color.muted): Item {
    return { id, lines: (size) => wrap(value, size - 4).map((item) => line([span('  '), span(item, fg)])) };
}

export const pill = (text: string, state: Tone): Span => span(` ${text.toUpperCase()} `, color.ink, { bg: tone[state], bold: true });

function framedLine(row: Line, size: number): Line {
    const inner = fit(row, size - 4, color.panel).spans.map((item) => (item.bg === color.base ? { ...item, bg: color.panel } : item));
    return {
        ...line([
            span('│', color.line, { bg: color.base }),
            span(' ', undefined, { bg: color.panel }),
            ...inner,
            span(' ', undefined, { bg: color.panel }),
            span('│', color.line, { bg: color.base }),
        ]),
        ...(row.target ? { target: row.target } : {}),
    };
}

const padding = (size: number): Line => line([span('  '), ...framedLine(blank(color.panel), size - 2).spans]);

export function section(id: string, title: string, subtitle: string, items: Item[]): Item[] {
    const header: Item = {
        id,
        lines: (size) => {
            const head = [
                span('╭─ ', color.line),
                span(title, color.violet, { bold: true }),
                span(subtitle ? `  ${subtitle} ` : ' ', color.muted),
            ];
            const used = head.reduce((total, item) => total + width(item.text), 0);
            return [blank(), line([span('  '), ...head, span(`${'─'.repeat(Math.max(0, size - 3 - used))}╮`, color.line)]), padding(size)];
        },
    };
    const framed = items.map((item): Item => ({
        ...item,
        lines: (size, selected, view) =>
            item.lines(size - 6, selected, view).map((row) => line([span('  '), ...framedLine(row, size - 2).spans])),
    }));
    const footer: Item = {
        id: `${id}-end`,
        lines: (size) => [padding(size), line([span('  '), span(`╰${'─'.repeat(Math.max(0, size - 4))}╯`, color.line)])],
    };
    return [header, ...framed, footer];
}

export function card(options: { id: string; intent?: Intent; title: string; badge?: Span; body: Line[] }): Item {
    return {
        id: options.id,
        ...(options.intent ? { intent: options.intent } : {}),
        lines: (size, selected) => {
            const inner = size - 8;
            const badge = options.badge ? width(options.badge.text) : 0;
            const title = options.title.slice(0, Math.max(8, inner - badge - 4));
            const rows = [
                line([
                    span(glyph.brand, selected ? color.violet : color.dim),
                    span(` ${title}`, selected ? color.text : color.soft, { bold: true }),
                    span(' '.repeat(Math.max(1, size - 8 - width(title) - badge))),
                    ...(options.badge ? [options.badge] : []),
                ]),
                ...options.body.map((row) => line([span('  '), ...row.spans])),
            ];
            return box(rows, size - 2, { border: selected ? color.violet : color.line, bg: selected ? color.raised : color.panel }).map(
                (value) => ({
                    ...line([span('  '), ...value.spans]),
                    target: options.id,
                }),
            );
        },
    };
}
