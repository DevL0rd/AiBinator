import { between, blank, fit, hstack, line, lineWidth, overlay, span, truncate, type Line, type Span } from './canvas.js';
import { color, glyph, tone, type Tone } from './theme.js';
import { pages, type Item, type PageId, type View } from './model.js';
import { aibiSignal, assistantName, assistantSignal, operator, runtimeSignal, type Signal } from './status.js';
import { dotFor } from './items.js';
import { publicDomain } from '../connection-domain.js';

export const navWidth = 24;
export interface Layout {
    view: View;
    page: PageId;
    focus: 'nav' | 'content';
    items: Item[];
    selected: number;
    scroll: number;
    overlay?: Line[];
    toast?: { text: string; tone: Tone };
    width: number;
    height: number;
}

function header(layout: Layout): Line {
    const { view, width } = layout;
    const signal = assistantSignal(view);
    const mode = operator(view).mode;
    const who = mode && mode !== 'disabled' ? assistantName(mode) : 'No assistant active';
    const domain = publicDomain(view.drafts.environment.AIBINATOR_RESOURCE_URL);
    const dirty: Span[] = view.changes.length
        ? [span(` ${glyph.on} ${view.changes.length} unsaved `, color.ink, { bg: color.amber, bold: true, target: 'save' }), span(' ')]
        : [];
    return between(
        [
            span(` ${glyph.brand} AiBinator `, color.ink, { bg: color.violet, bold: true }),
            span('  '),
            span(`${dotFor(signal.tone)} ${signal.label}`, tone[signal.tone], { bold: true }),
            span(`  ${who}`, color.soft),
        ],
        [
            ...dirty,
            span(domain ? `${domain}  ` : '', color.muted),
            span(' ? ', color.violet, { bg: color.lift, target: 'help' }),
            span(' '),
        ],
        width,
        color.panel,
    );
}

function health(label: string, signal: Signal): Line {
    return line([
        span(`  ${dotFor(signal.tone)} `, tone[signal.tone]),
        span(label.padEnd(10), color.muted),
        span(signal.label, color.soft),
    ]);
}

function nav(layout: Layout, height: number): Line[] {
    const rows = pages.flatMap((page, index) => {
        const active = page.id === layout.page;
        const bg = active ? (layout.focus === 'nav' ? color.lift : color.raised) : color.panel;
        const fg = active ? color.text : color.muted;
        return [
            fit(
                {
                    spans: [
                        span(active ? glyph.bar : ' ', color.violet, { bg }),
                        span(` ${page.icon}  `, active ? color.violet : color.dim, { bg }),
                        span(page.label, fg, { bg, bold: active }),
                        span(`  ${index + 1}`, color.dim, { bg }),
                    ],
                    bg,
                    target: `page:${page.id}`,
                },
                navWidth,
                bg,
            ),
            blank(color.panel),
        ];
    });
    const status = [
        health('AIBI', aibiSignal(layout.view)),
        health('Service', runtimeSignal(layout.view)),
        health('Responder', assistantSignal(layout.view)),
    ];
    const spacer = Math.max(1, height - rows.length - status.length - 2);
    return [blank(color.panel), ...rows, ...Array.from({ length: spacer }, () => blank(color.panel)), ...status, blank(color.panel)];
}

function content(layout: Layout, size: number, height: number): { lines: Line[]; scroll: number } {
    const all: Line[] = [];
    let start = 0;
    let end = 0;
    layout.items.forEach((item, index) => {
        const chosen = index === layout.selected && layout.focus === 'content';
        if (index === layout.selected) start = all.length;
        all.push(...item.lines(size - 1, chosen, layout.view));
        if (index === layout.selected) end = all.length;
    });
    let scroll = Math.min(layout.scroll, Math.max(0, all.length - height));
    if (start < scroll) scroll = Math.max(0, start - 3);
    if (end > scroll + height) scroll = end - height;
    const visible = all.slice(scroll, scroll + height);
    const thumb = all.length > height ? Math.floor((scroll / Math.max(1, all.length - height)) * (height - 1)) : -1;
    const lines = Array.from({ length: height }, (_, row) =>
        line([
            ...fit(visible[row] ?? blank(), size - 1).spans,
            span(row === thumb ? '┃' : all.length > height ? '│' : ' ', row === thumb ? color.violetDeep : color.line),
        ]),
    );
    return { lines, scroll };
}

const keys: [string, string][] = [
    ['↑↓', 'move'],
    ['⏎', 'open'],
    ['Tab', 'switch'],
    ['S', 'save'],
    ['/', 'find'],
    ['?', 'help'],
    ['q', 'quit'],
];

function footer(layout: Layout): Line[] {
    const status = layout.view.busy
        ? line([span(`  ${glyph.spinner[layout.view.tick % glyph.spinner.length]} `, color.violet), span(layout.view.busy, color.soft)])
        : layout.toast
          ? line([
                span(`  ${dotFor(layout.toast.tone)} `, tone[layout.toast.tone]),
                span(truncate(layout.toast.text, layout.width - 6), color.soft),
            ])
          : blank();
    const hints = line(
        keys.flatMap(([key, label]) => [span(` ${key} `, color.violet, { bg: color.lift }), span(` ${label}   `, color.muted)]),
    );
    return [status, { ...hints, spans: [span(' '), ...hints.spans] }];
}

export function frame(layout: Layout): { lines: Line[]; scroll: number } {
    const bodyHeight = layout.height - 4;
    const body = content(layout, layout.width - navWidth - 2, bodyHeight);
    const rows = hstack(
        [
            { lines: nav(layout, bodyHeight), size: navWidth, bg: color.panel },
            { lines: [], size: 2, bg: color.base },
            { lines: body.lines, size: layout.width - navWidth - 2, bg: color.base },
        ],
        bodyHeight,
    );
    const lines = [header(layout), blank(), ...rows, ...footer(layout)].map((value) => fit(value, layout.width));
    if (!layout.overlay) return { lines, scroll: body.scroll };
    const top = Math.max(1, Math.floor((layout.height - layout.overlay.length) / 2));
    const left = Math.max(0, Math.floor((layout.width - Math.max(...layout.overlay.map(lineWidth))) / 2));
    layout.overlay.forEach((value, index) => {
        if (lines[top + index]) lines[top + index] = overlay(lines[top + index]!, value, left, layout.width);
    });
    return { lines, scroll: body.scroll };
}
