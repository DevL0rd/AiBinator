import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useInput, useStdout } from 'ink';
import type { PanelSnapshot } from '../panel-store.js';
import { operatorPath } from '../config.js';
import { presenceFile } from '../presence.js';
import { runtimeLockFile } from '../status.js';
import { watchFile } from '../file-watch.js';
import { blank, hits, line, span, type Hit, type Line } from './canvas.js';
import { color } from './theme.js';
import { frame } from './frame.js';
import { h, Frame } from './render.js';
import { sheetLines } from './sheets.js';
import { refresh, refreshLive, refreshStatus, reloadPanel, type Services, type Store } from './effects.js';
import { statusFile } from '../status-file.js';
import { handleKey } from './keys.js';
import { handleMouse } from './mouse.js';
import { useSgrMouse } from './use-mouse.js';
import { pageItems } from './pages/index.js';
import { initialState, selectedIndex, viewOf, type UiState } from './state.js';
import { assistantSignal } from './status.js';
import type { Observations } from './model.js';

function useStore(snapshot: PanelSnapshot, observed: Observations, exit: () => void, services?: Services): [UiState, Store] {
    const [state, setState] = useState(() => initialState(snapshot, observed));
    const current = useRef(state);
    const store = useMemo<Store>(
        () => ({
            get: () => current.current,
            set: (update) => {
                current.current = update(current.current);
                setState(current.current);
            },
            exit,
            ...(services ? { services } : {}),
        }),
        [exit, services],
    );
    return [state, store];
}

function useSize(): { width: number; height: number } {
    const { stdout } = useStdout();
    const read = () => ({ width: stdout.columns || 80, height: (stdout.rows || 24) - 1 });
    const [size, setSize] = useState(read);
    useEffect(() => {
        const resize = () => setSize(read());
        stdout.on('resize', resize);
        return () => void stdout.off('resize', resize);
    }, [stdout]);
    return size;
}

function useLive(store: Store): void {
    useEffect(() => {
        void refresh(store, true);
        const settingsFiles = ['.data/operator-settings.json', process.env.AIBINATOR_POLICY_FILE ?? 'policy.json', '.env'];
        const stops = [
            ...settingsFiles.map((path) => watchFile(path, () => void reloadPanel(store))),
            ...[operatorPath, presenceFile, runtimeLockFile].map((path) => watchFile(path, () => void refreshLive(store))),
            watchFile(statusFile, () => void refreshStatus(store)),
        ];
        return () => {
            for (const stop of stops) stop();
        };
    }, [store]);
}

function useMotion(store: Store, state: UiState): void {
    const moving = Boolean(state.busy) || (state.page === 'home' && assistantSignal(viewOf(state)).tone === 'good');
    useEffect(() => {
        if (!moving) return;
        const timer = setInterval(() => store.set((current) => ({ ...current, tick: current.tick + 1 })), 140);
        return () => clearInterval(timer);
    }, [moving, store]);
    useEffect(() => {
        if (!state.toast) return;
        const timer = setTimeout(() => store.set((current) => ({ ...current, toast: undefined })), 6000);
        return () => clearTimeout(timer);
    }, [state.toast, store]);
}

const tooSmall = (width: number, height: number): Line[] =>
    Array.from({ length: height }, (_, row) =>
        row === Math.floor(height / 2) ? line([span('  Make the window at least 80 × 24 to use AiBinator setup.', color.soft)]) : blank(),
    );

export function Dashboard({ initial, observed, services }: { initial: PanelSnapshot; observed: Observations; services?: Services }) {
    const { exit } = useApp();
    const size = useSize();
    const [state, store] = useStore(initial, observed, exit, services);
    const map = useRef<Hit[]>([]);
    useLive(store);
    useMotion(store, state);
    useSgrMouse((code, x, y) => handleMouse(store, map.current, code, x, y));
    useInput((input, key) => {
        if (!input.includes('[<')) handleKey(store, input, key);
    });
    const view = viewOf(state);
    const items = pageItems(state.page, view);
    const layout =
        size.width < 80 || size.height < 22
            ? { lines: tooSmall(size.width, size.height), scroll: state.scroll }
            : frame({
                  view,
                  page: state.page,
                  focus: state.focus,
                  items,
                  selected: selectedIndex(state, items),
                  scroll: state.scroll,
                  ...(state.sheet ? { overlay: sheetLines(state.sheet, size.width) } : {}),
                  ...(state.toast ? { toast: state.toast } : {}),
                  width: size.width,
                  height: size.height,
              });
    map.current = hits(layout.lines);
    useEffect(() => {
        if (layout.scroll !== state.scroll) store.set((current) => ({ ...current, scroll: layout.scroll }));
    }, [layout.scroll, state.scroll, store]);
    return h(Frame, { lines: layout.lines });
}
