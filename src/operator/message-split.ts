const fenceLine = /^\s*```/;
const fenceClose = '\n```';
const separators = ['\n\n', '\n', ' '];

function fenceAfter(open: string | undefined, text: string): string | undefined {
    let fence = open;
    for (const line of text.split('\n')) if (fenceLine.test(line)) fence = fence === undefined ? line.trim() : undefined;
    return fence;
}

function cutAt(text: string, budget: number): { end: number; skip: number } {
    const window = text.slice(0, budget + 1);
    for (const separator of separators) {
        const index = window.lastIndexOf(separator);
        if (index > 0 && index >= budget * 0.3) return { end: index, skip: separator.length };
    }
    const code = text.charCodeAt(budget - 1);
    return { end: budget > 1 && code >= 0xd800 && code <= 0xdbff ? budget - 1 : budget, skip: 0 };
}

function nextPiece(text: string, fence: string | undefined, room: number): { piece: string; skip: number; open?: string } {
    const whole = cutAt(text, room);
    const open = fenceAfter(fence, text.slice(0, whole.end));
    if (open === undefined) return { piece: text.slice(0, whole.end), skip: whole.skip };
    const budget = room - fenceClose.length;
    if (budget < 1) throw new Error('Message limit is too small for its code fence');
    const fenced = cutAt(text, budget);
    const piece = text.slice(0, fenced.end);
    return { piece, skip: fenced.skip, ...withFence(fenceAfter(fence, piece)) };
}

const withFence = (open: string | undefined) => (open === undefined ? {} : { open });

export function splitMessage(text: string, limit = 2000): string[] {
    const chunks: string[] = [];
    let rest = text;
    let fence: string | undefined;
    while (rest) {
        const prefix = fence === undefined ? '' : `${fence}\n`;
        if (prefix.length + rest.length <= limit) {
            chunks.push(prefix + rest);
            break;
        }
        const { piece, skip, open } = nextPiece(rest, fence, limit - prefix.length);
        fence = open;
        chunks.push(`${prefix}${piece}${fence === undefined ? '' : fenceClose}`);
        rest = rest.slice(piece.length + skip);
    }
    return chunks;
}
