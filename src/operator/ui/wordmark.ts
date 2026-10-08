import { line, span, type Line } from './canvas.js';

const glyphs: Record<string, [string, string]> = {
    B: ['█▀▄', '█▀█'],
    I: ['█', '█'],
    O: ['█▀█', '█▄█'],
    R: ['█▀█', '█▀▄'],
    N: ['█▀▄', '█ █'],
    A: ['█▀█', '█▀█'],
    T: ['▀█▀', ' █ '],
};
const word = [...'AIBINATOR'].map((letter) => glyphs[letter]!);
const rows = [0, 1].map((row) => word.map((letter) => letter[row]).join(' '));
const start = [0xa9, 0x9a, 0xff];
const end = [0x7b, 0xec, 0xd9];

function shade(position: number): string {
    return `#${start
        .map((value, index) =>
            Math.round(value + (end[index]! - value) * position)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}

export function wordmark(): Line[] {
    return rows.map((row) => line([...row].map((character, index) => span(character, shade(index / (row.length - 1)), { bold: true }))));
}
