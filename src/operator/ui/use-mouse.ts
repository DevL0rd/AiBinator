import { useEffect, useRef } from 'react';
import { useStdin, useStdout } from 'ink';
import { sgrMouse } from './mouse.js';

export function useSgrMouse(handle: (code: number, x: number, y: number) => void): void {
    const { stdout } = useStdout();
    const { stdin } = useStdin();
    const latest = useRef(handle);
    latest.current = handle;
    useEffect(() => {
        if (!stdin.isTTY) return;
        stdout.write('\x1b[?1000h\x1b[?1006h');
        const read = (data: Buffer | string) => {
            for (const match of String(data).matchAll(sgrMouse)) latest.current(Number(match[1]), Number(match[2]), Number(match[3]));
        };
        stdin.on('data', read);
        return () => {
            stdin.off('data', read);
            stdout.write('\x1b[?1000l\x1b[?1006l');
        };
    }, [stdin, stdout]);
}
