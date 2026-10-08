import React from 'react';
import { Box, Text } from 'ink';
import type { Line } from './canvas.js';

export const h = React.createElement;

const Row = React.memo(
    function Row({ value }: { value: Line; signature: string }) {
        return h(
            Text,
            { wrap: 'truncate' },
            ...value.spans.map((item, index) =>
                h(Text, { key: index, color: item.fg, backgroundColor: item.bg, bold: item.bold }, item.text),
            ),
        );
    },
    (before, after) => before.signature === after.signature,
);

export function Frame({ lines }: { lines: Line[] }) {
    return h(
        Box,
        { flexDirection: 'column' },
        ...lines.map((value, row) => h(Row, { key: row, value, signature: JSON.stringify(value.spans) })),
    );
}
