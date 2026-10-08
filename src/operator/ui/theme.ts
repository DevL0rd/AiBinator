export const color = {
    base: '#0D1020',
    panel: '#13172B',
    raised: '#1B2140',
    lift: '#252C52',
    line: '#2C3460',
    text: '#E9E7FF',
    soft: '#B7BCDC',
    muted: '#7D84AC',
    dim: '#545B85',
    violet: '#A99AFF',
    violetDeep: '#7967D8',
    mint: '#7BECD9',
    amber: '#F7C873',
    rose: '#FF8FA8',
    ink: '#0D1020',
} as const;

export type Tone = 'good' | 'warn' | 'bad' | 'idle' | 'info';
export const tone: Record<Tone, string> = {
    good: color.mint,
    warn: color.amber,
    bad: color.rose,
    idle: color.muted,
    info: color.violet,
};

export const glyph = {
    brand: '◆',
    on: '●',
    off: '○',
    pending: '◌',
    warn: '▲',
    check: '✓',
    cross: '✕',
    bar: '▌',
    arrow: '›',
    flow: '━',
    pulse: '•',
    radioOn: '◉',
    radioOff: '○',
    boxOn: '■',
    boxOff: '□',
    spinner: ['◜', '◠', '◝', '◞', '◡', '◟'],
} as const;
