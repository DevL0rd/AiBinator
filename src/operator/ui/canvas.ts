import stringWidth from 'string-width';
import { color } from './theme.js';

export interface Span {
    text: string;
    fg?: string;
    bg?: string;
    bold?: boolean;
    target?: string;
}
export interface Line {
    spans: Span[];
    bg?: string;
    target?: string;
}
export interface Hit {
    y: number;
    x0: number;
    x1: number;
    target: string;
}

const control = (character: string) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code < 160);
};
const clean = (text: string) => [...text].map((character) => (control(character) ? ' ' : character)).join('');
export const width = (text: string): number => stringWidth(text);
export const span = (text: string, fg?: string, extra: Omit<Span, 'text' | 'fg'> = {}): Span => ({
    text: clean(text),
    ...(fg ? { fg } : {}),
    ...extra,
});
export const line = (spans: Span[], bg?: string): Line => ({ spans, ...(bg ? { bg } : {}) });
export const blank = (bg?: string): Line => line([], bg);
export const lineWidth = (value: Line): number => value.spans.reduce((total, item) => total + width(item.text), 0);

function cut(value: string, limit: number): string {
    let result = '';
    let used = 0;
    for (const character of value) {
        const size = width(character);
        if (used + size > limit) break;
        result += character;
        used += size;
    }
    return result;
}

export function truncate(value: string, limit: number): string {
    if (width(value) <= limit) return value;
    return limit <= 1 ? cut(value, limit) : `${cut(value, limit - 1)}…`;
}

const withTarget = (target?: string) => (target ? { target } : {});

export function fit(value: Line, size: number, fallback: string = color.base): Line {
    const bg = value.bg ?? fallback;
    const spans: Span[] = [];
    let used = 0;
    for (const item of value.spans) {
        if (used >= size) break;
        const content = truncate(item.text, size - used);
        spans.push({ ...item, text: content, bg: item.bg ?? bg, ...withTarget(item.target ?? value.target) });
        used += width(content);
    }
    if (used < size) spans.push({ text: ' '.repeat(size - used), bg, ...withTarget(value.target) });
    return { spans, bg };
}

export function between(left: Span[], right: Span[], size: number, bg?: string): Line {
    const gap = Math.max(
        1,
        size - left.reduce((total, item) => total + width(item.text), 0) - right.reduce((t, i) => t + width(i.text), 0),
    );
    return fit(line([...left, span(' '.repeat(gap)), ...right], bg), size, bg);
}

export function hstack(columns: { lines: Line[]; size: number; bg: string }[], height: number): Line[] {
    return Array.from({ length: height }, (_, row) =>
        line(columns.flatMap((column) => fit(column.lines[row] ?? blank(column.bg), column.size, column.bg).spans)),
    );
}

export function wrap(value: string, size: number): string[] {
    const words = clean(value).split(/\s+/).filter(Boolean);
    const rows: string[] = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (width(next) <= size) current = next;
        else {
            if (current) rows.push(current);
            current = word;
            while (width(current) > size) {
                const head = cut(current, size);
                rows.push(head);
                current = current.slice(head.length);
            }
        }
    }
    if (current) rows.push(current);
    return rows.length ? rows : [''];
}

export function box(inner: Line[], size: number, options: { border?: string; bg?: string; title?: Span[]; outer?: string } = {}): Line[] {
    const border = options.border ?? color.line;
    const bg = options.bg ?? color.panel;
    const outer = options.outer ?? color.base;
    const titleWidth = (options.title ?? []).reduce((total, item) => total + width(item.text), 0);
    const top = line([
        span('╭─', border, { bg: outer }),
        ...(options.title ?? []).map((item) => ({ ...item, bg: item.bg ?? outer })),
        span(`${'─'.repeat(Math.max(0, size - 3 - titleWidth))}╮`, border, { bg: outer }),
    ]);
    const body = inner.map((row) =>
        line([
            span('│', border, { bg: outer }),
            span(' ', undefined, { bg }),
            ...fit(row, size - 4, row.bg ?? bg).spans,
            span(' ', undefined, { bg }),
            span('│', border, { bg: outer }),
        ]),
    );
    return [top, ...body, line([span(`╰${'─'.repeat(size - 2)}╯`, border, { bg: outer })])];
}

export function hits(frame: Line[]): Hit[] {
    const result: Hit[] = [];
    frame.forEach((row, y) => {
        let x = 0;
        for (const item of row.spans) {
            const size = width(item.text);
            if (item.target) result.push({ y: y + 1, x0: x + 1, x1: x + size, target: item.target });
            x += size;
        }
    });
    return result;
}

export const targetAt = (map: Hit[], x: number, y: number): string | undefined =>
    map.find((item) => item.y === y && x >= item.x0 && x <= item.x1)?.target;

function sliceSpans(spans: Span[], from: number, to: number): Span[] {
    const result: Span[] = [];
    let x = 0;
    for (const item of spans) {
        for (const character of item.text) {
            const size = width(character);
            if (x >= from && x + size <= to) {
                const last = result.at(-1);
                if (last && last.fg === item.fg && last.bg === item.bg && last.bold === item.bold && last.target === item.target)
                    last.text += character;
                else result.push({ ...item, text: character });
            }
            x += size;
        }
    }
    return result;
}

export function overlay(base: Line, top: Line, x: number, size: number): Line {
    const full = fit(base, size);
    const topWidth = lineWidth(top);
    return line([...sliceSpans(full.spans, 0, x), ...top.spans, ...sliceSpans(full.spans, x + topWidth, size)], full.bg);
}
