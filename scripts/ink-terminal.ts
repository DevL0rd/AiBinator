import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';

interface Terminal {
    frames: string[];
    send(text: string): void;
    shown(): string;
    waitFor(text: string): Promise<void>;
    close(): Promise<void>;
}

export function mountTerminal(element: Parameters<typeof render>[0], columns: number, rows: number): Terminal {
    const frames: string[] = [];
    const input = Object.assign(new PassThrough(), { isTTY: true });
    Object.assign(input, { setRawMode: () => input, ref: () => input, unref: () => input });
    const output = Object.assign(
        new Writable({
            write(chunk: Buffer, _encoding, done) {
                frames.push(stripVTControlCharacters(String(chunk)));
                done();
            },
        }),
        { columns, rows },
    );
    const terminal = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const app = render(element, {
        stdin: input as unknown as NodeJS.ReadStream,
        stdout: output as unknown as NodeJS.WriteStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    const shown = () => frames.findLast((frame) => frame.trim()) ?? '';
    return {
        frames,
        send: (text) => void input.write(text),
        shown,
        async waitFor(text) {
            const deadline = Date.now() + 15_000;
            while (!shown().includes(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
            assert.ok(shown().includes(text), `expected the screen to show “${text}”:\n${shown()}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        },
        async close() {
            app.unmount();
            app.cleanup();
            if (terminal) Object.defineProperty(process.stdin, 'isTTY', terminal);
            else delete (process.stdin as { isTTY?: boolean }).isTTY;
            await app.waitUntilExit();
        },
    };
}
