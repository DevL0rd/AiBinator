import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import { Dashboard } from '../src/operator/ui/app.js';
import { Frame, h } from '../src/operator/ui/render.js';
import { line, span } from '../src/operator/ui/canvas.js';
import { called, fakeServices, observed, snapshot, type Calls } from './ui-fixtures.js';

class Screen extends EventEmitter {
    columns = 120;
    rows = 40;
    writes: string[] = [];
    write(chunk: string): boolean {
        this.writes.push(chunk);
        return true;
    }
    latest(): string {
        return this.writes.map((chunk) => stripVTControlCharacters(chunk)).findLast((chunk) => chunk.trim()) ?? '';
    }
    resize(columns: number): void {
        this.columns = columns;
        this.emit('resize');
    }
}

class Keyboard extends EventEmitter {
    isTTY = true;
    private queue: string[] = [];
    setRawMode(): this {
        return this;
    }
    setEncoding(): this {
        return this;
    }
    ref(): this {
        return this;
    }
    unref(): this {
        return this;
    }
    read(): string | null {
        return this.queue.shift() ?? null;
    }
    type(value: string): void {
        this.queue.push(value);
        this.emit('readable');
        this.emit('data', value);
    }
}

async function until(check: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function mount(element: Parameters<typeof render>[0]) {
    const screen = new Screen();
    const keyboard = new Keyboard();
    const app = render(element, {
        stdout: screen as unknown as NodeJS.WriteStream,
        stderr: screen as unknown as NodeJS.WriteStream,
        stdin: keyboard as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
    });
    return { screen, keyboard, app };
}

async function checkFrame(): Promise<void> {
    const rows = (word: string) => [line([span(word, '#ffffff', { bold: true })]), line([span('second row')])];
    const { screen, app } = mount(h(Frame, { lines: rows('first') }));
    await until(() => screen.latest().includes('first'), 'the frame draws its lines');
    assert.ok(screen.latest().includes('second row'));
    app.rerender(h(Frame, { lines: rows('changed') }));
    await until(() => screen.latest().includes('changed'), 'changed rows are redrawn');
    assert.ok(screen.latest().includes('second row'), 'unchanged rows stay');
    app.unmount();
    await app.waitUntilExit();
}

export async function checkDashboard(): Promise<void> {
    await checkFrame();
    const calls: Calls = [];
    const live = { ...observed.live!, operator: { ...observed.live!.operator, controller: { connected: true } } };
    const services = fakeServices(calls, { observations: () => Promise.resolve({ ...observed, live }) });
    const { screen, keyboard, app } = mount(h(Dashboard, { initial: snapshot, observed, services }));
    await until(() => called(calls, 'readPanel').length > 0, 'opening the dashboard loads everything');
    await until(() => screen.latest().includes('Responder'), 'the dashboard draws its menu');
    assert.ok(screen.writes.includes('\x1b[?1000h\x1b[?1006h'), 'mouse reporting is turned on');
    await until(() => called(calls, 'portsAllowed').length > 0, 'the first load is a deep refresh');
    const frames = screen.writes.length;
    await until(() => screen.writes.length > frames + 2, 'a healthy responder animates the home page');
    keyboard.type('2');
    await until(() => screen.latest().includes('Primary responder'), 'number keys switch pages');
    keyboard.type('\x1b[<65;3;6M');
    await until(() => screen.latest().includes('How AIBI reaches this computer'), 'scrolling over the menu moves to the next page');
    screen.resize(60);
    await until(() => screen.latest().includes('Make the window at least 80 × 24'), 'small windows ask for more room');
    screen.resize(120);
    await until(() => screen.latest().includes('How AIBI reaches this computer'), 'the dashboard returns after resizing');
    keyboard.type('r');
    await until(() => screen.latest().includes('Settings and status reloaded.'), 'reloading confirms with a toast');
    keyboard.type('q');
    await app.waitUntilExit();
    assert.ok(screen.writes.includes('\x1b[?1000l\x1b[?1006l'), 'quitting turns mouse reporting off');
}
