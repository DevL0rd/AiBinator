import { blank, box, fit, line, span, wrap, width, type Line, type Span } from './ui/canvas.js';
import { color, glyph, tone, type Tone } from './ui/theme.js';

export interface StepView {
    stage: number;
    title: string;
    body: string[];
    input?: { value: string; masked: boolean };
    options?: string[];
    tags?: ({ text: string; tone: Tone } | undefined)[];
    buttons?: string[];
    selected: number;
    notice?: string;
    error?: string;
    busy?: string;
    tick: number;
}

const stages = ['Voice', 'Assistant', 'Install', 'AIBI'];
const center = (value: Line, size: number): Line => {
    const used = value.spans.reduce((total, item) => total + width(item.text), 0);
    return fit(line([span(' '.repeat(Math.max(0, Math.floor((size - used) / 2)))), ...value.spans]), size);
};

function rail(stage: number): Line[] {
    const dots: Span[] = stages.flatMap((_label, index) => [
        span(index < stage ? glyph.check : index === stage ? glyph.on : glyph.off, index <= stage ? color.violet : color.dim, {
            bold: index === stage,
        }),
        ...(index < stages.length - 1 ? [span(` ${glyph.flow.repeat(9)} `, index < stage ? color.violetDeep : color.line)] : []),
    ]);
    const labels = stages.map((label, index) =>
        span(label.padEnd(12), index === stage ? color.text : color.muted, { bold: index === stage }),
    );
    return [line(dots), line(labels)];
}

function choices(step: StepView, size: number): Line[] {
    return (step.options ?? []).map((label, index) => {
        const on = index === step.selected;
        const bg = on ? color.raised : color.panel;
        const mark = span(` ${on ? glyph.radioOn : glyph.radioOff} `, on ? color.violet : color.dim);
        const tag = step.tags?.[index];
        const badge = tag ? [span('  '), span(` ${tag.text} `, color.ink, { bg: tone[tag.tone], bold: true })] : [];
        return fit(
            { ...line([mark, span(label, on ? color.text : color.soft, { bold: on }), ...badge], bg), target: `opt:${index}` },
            size,
            bg,
        );
    });
}

function buttons(step: StepView): Line {
    const offset = step.options?.length ?? 0;
    return line(
        (step.buttons ?? []).flatMap((label, index) => {
            const on = offset + index === step.selected || (!step.options?.length && index === step.selected);
            return [
                span(` ${label} `, on ? color.ink : color.violet, {
                    bg: on ? color.violet : color.lift,
                    bold: true,
                    target: `btn:${index}`,
                }),
                span('  '),
            ];
        }),
    );
}

function inputLine(step: StepView): Line[] {
    if (!step.input) return [];
    const shown = step.input.masked ? '•'.repeat(step.input.value.length) : step.input.value;
    return [line([span(' › ', color.violet, { bg: color.lift }), span(`${shown}▏`, color.text, { bg: color.lift })], color.lift)];
}

function statusLines(step: StepView, inner: number): Line[] {
    if (step.busy) return [line([span(`${glyph.spinner[step.tick % glyph.spinner.length]} `, color.violet), span(step.busy, color.soft)])];
    const tinted = (value: string | undefined, fg: string) => (value ? wrap(value, inner).map((row) => line([span(row, fg)])) : []);
    return [...tinted(step.notice, color.mint), ...tinted(step.error, color.rose)];
}

function card(step: StepView, size: number): Line[] {
    const inner = size - 4;
    const input = inputLine(step);
    const status = statusLines(step, inner);
    const rows = [
        blank(),
        ...step.body.flatMap((value) => (value ? wrap(value, inner).map((row) => line([span(row, color.soft)])) : [blank()])),
        ...(input.length || step.options?.length ? [blank()] : []),
        ...input,
        ...choices(step, inner),
        ...(status.length ? [blank(), ...status] : []),
        ...(step.buttons?.length && !step.busy ? [blank(), buttons(step)] : []),
        blank(),
    ];
    return box(rows, size, { border: color.violetDeep, bg: color.panel, title: [span(` ${step.title} `, color.text, { bold: true })] });
}

export function wizardFrame(step: StepView, size: number, height: number): Line[] {
    const body = [
        blank(),
        line([span(` ${glyph.brand} AiBinator `, color.ink, { bg: color.violet, bold: true }), span('  first-time setup', color.muted)]),
        blank(),
        ...rail(step.stage),
        blank(),
        ...card(step, Math.min(76, size - 6)),
        blank(),
        line([span('↑↓ choose   Enter continue   Esc back   Ctrl+C quit', color.dim)]),
    ];
    const top = Math.max(0, Math.floor((height - body.length) / 2));
    return Array.from({ length: height }, (_, row) => {
        const value = body[row - top];
        return value ? center(value, size) : blank();
    }).map((value) => fit(value, size));
}
