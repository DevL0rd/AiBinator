import { searchSettings, settings, type SettingDefinition } from '../settings-registry.js';
import { blank, box, line, span, truncate, wrap, type Line, type Span } from './canvas.js';
import { color, glyph, tone, type Tone } from './theme.js';
import { editHint } from './edit.js';

export interface Button {
    label: string;
    tone: Tone;
    run: () => void | Promise<void>;
}
export type Sheet =
    | {
          kind: 'edit';
          field: SettingDefinition;
          label: string;
          input: string;
          options: string[];
          labels: Record<string, string>;
          error?: string;
      }
    | { kind: 'multi'; field: SettingDefinition; label: string; chosen: string[]; index: number; labels?: Record<string, string> }
    | { kind: 'confirm'; title: string; body: string[]; buttons: Button[]; index: number }
    | { kind: 'search'; input: string; index: number; reachable: readonly string[] }
    | { kind: 'help' };

const optionLabel = (value: string) => value || 'Default';
export const searchResults = (sheet: Extract<Sheet, { kind: 'search' }>) =>
    searchSettings(
        sheet.input,
        settings.filter((setting) => sheet.reachable.includes(setting.id)),
    ).slice(0, 8);

function buttons(items: { label: string; tone: Tone }[], index: number): Line {
    return line(
        items.flatMap((item, position) => [
            span(` ${item.label} `, position === index ? color.ink : tone[item.tone], {
                bg: position === index ? tone[item.tone] : color.lift,
                bold: true,
                target: `sheet:button:${position}`,
            }),
            span('  '),
        ]),
    );
}

function field(input: string, masked: boolean, size: number): Line {
    const shown = masked ? '•'.repeat(input.length) : input;
    return line(
        [span(' › ', color.violet, { bg: color.lift }), span(`${truncate(shown, size - 6)}▏`, color.text, { bg: color.lift })],
        color.lift,
    );
}

function list(
    values: string[],
    active: (value: string, index: number) => boolean,
    mark: (value: string) => string,
    size: number,
    labels: Record<string, string> = {},
): Line[] {
    const start = Math.max(0, values.findIndex(active) - 7);
    return values.slice(start, start + 8).map((value, offset) => {
        const index = start + offset;
        const on = active(value, index);
        return {
            ...line(
                [
                    span(` ${mark(value)} `, on ? color.violet : color.dim),
                    span(truncate(labels[value] ?? optionLabel(value), size - 8), on ? color.text : color.soft, { bold: on }),
                ],
                on ? color.raised : undefined,
            ),
            target: `sheet:option:${index}`,
        };
    });
}

function editBody(sheet: Extract<Sheet, { kind: 'edit' }>, size: number): Line[] {
    const hint = editHint(sheet.field);
    return [
        ...wrap(sheet.field.description, size).map((value) => line([span(value, color.muted)])),
        blank(),
        ...(sheet.options.length
            ? list(
                  sheet.options,
                  (value) => value === sheet.input,
                  (value) => (value === sheet.input ? glyph.radioOn : glyph.radioOff),
                  size,
                  sheet.labels,
              )
            : [field(sheet.input, Boolean(sheet.field.credential), size)]),
        ...(hint && !sheet.options.length ? [line([span(hint, color.dim)])] : []),
        ...(sheet.error ? [blank(), ...wrap(sheet.error, size).map((value) => line([span(value, color.rose)]))] : []),
        blank(),
        buttons(
            [
                { label: 'Done', tone: 'info' },
                { label: 'Cancel', tone: 'idle' },
            ],
            -1,
        ),
    ];
}

function multiBody(sheet: Extract<Sheet, { kind: 'multi' }>, size: number): Line[] {
    const choices = [...(sheet.field.choices ?? [])];
    return [
        line([span(`${sheet.chosen.length} of ${choices.length} selected · Space toggles · A selects all`, color.muted)]),
        blank(),
        ...list(
            choices,
            (_value, index) => index === sheet.index,
            (value) => (sheet.chosen.includes(value) ? glyph.boxOn : glyph.boxOff),
            size,
            sheet.labels,
        ),
        blank(),
        buttons(
            [
                { label: 'Done', tone: 'info' },
                { label: 'Cancel', tone: 'idle' },
            ],
            -1,
        ),
    ];
}

function searchBody(sheet: Extract<Sheet, { kind: 'search' }>, size: number): Line[] {
    const results = searchResults(sheet);
    return [
        field(sheet.input, false, size),
        blank(),
        ...(results.length
            ? list(
                  results.map((item) => item.label),
                  (_value, index) => index === sheet.index,
                  () => glyph.arrow,
                  size,
              )
            : [line([span(sheet.input ? 'No matching settings.' : 'Type to search every setting.', color.muted)])]),
    ];
}

const helpRows: [string, string][] = [
    ['↑ ↓  j k', 'Move'],
    ['← → Tab', 'Switch between menu and page'],
    ['Enter Space', 'Open, toggle or choose'],
    ['1 – 8', 'Jump to a page'],
    ['s', 'Review and save changes'],
    ['/', 'Find any setting'],
    ['p', 'Start or pause the assistant'],
    ['r', 'Reload settings and status'],
    ['Esc', 'Close this panel'],
    ['q', 'Quit (AiBinator keeps running)'],
];

export function sheetLines(sheet: Sheet, screen: number): Line[] {
    const size = Math.min(78, screen - 8);
    const inner = size - 4;
    const titles: Record<Sheet['kind'], string> = { edit: '', multi: '', confirm: '', search: 'Find a setting', help: 'Keys' };
    const title =
        sheet.kind === 'edit' || sheet.kind === 'multi' ? sheet.label : sheet.kind === 'confirm' ? sheet.title : titles[sheet.kind];
    const body: Line[] =
        sheet.kind === 'edit'
            ? editBody(sheet, inner)
            : sheet.kind === 'multi'
              ? multiBody(sheet, inner)
              : sheet.kind === 'search'
                ? searchBody(sheet, inner)
                : sheet.kind === 'help'
                  ? helpRows.map(([key, label]) => line([span(key.padEnd(14), color.violet, { bold: true }), span(label, color.soft)]))
                  : [
                        ...sheet.body.flatMap((value) => wrap(value, inner).map((row) => line([span(row, color.soft)]))),
                        blank(),
                        buttons(sheet.buttons, sheet.index),
                    ];
    const heading: Span[] = [span(` ${title} `, color.text, { bold: true })];
    return box([blank(), ...body, blank()], size, { border: color.violet, bg: color.panel, title: heading });
}
