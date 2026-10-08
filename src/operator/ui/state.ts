import { draftChanges, type Documents, type PanelSnapshot } from '../panel-store.js';
import { focusable, pages, type Activity, type Extras, type Item, type Observations, type PageId, type View } from './model.js';
import { pageItems } from './pages/index.js';
import type { Sheet } from './sheets.js';
import type { Tone } from './theme.js';

export interface UiState {
    page: PageId;
    focus: 'nav' | 'content';
    cursor: Partial<Record<PageId, number>>;
    scroll: number;
    sheet?: Sheet;
    toast?: { text: string; tone: Tone };
    busy?: string;
    tick: number;
    snapshot: PanelSnapshot;
    drafts: Documents;
    observed: Observations;
    extras: Extras;
    activity: Activity[];
}

export function initialState(snapshot: PanelSnapshot, observed: Observations): UiState {
    return {
        page: 'home',
        focus: 'content',
        cursor: {},
        scroll: 0,
        tick: 0,
        snapshot,
        drafts: structuredClone(snapshot.documents),
        observed,
        extras: { apps: {} },
        activity: [],
    };
}

export const viewOf = (state: UiState): View => ({
    snapshot: state.snapshot,
    drafts: state.drafts,
    observed: state.observed,
    extras: state.extras,
    changes: draftChanges(state.snapshot, state.drafts),
    activity: state.activity,
    tick: state.tick,
    ...(state.busy ? { busy: state.busy } : {}),
});

export const itemsOf = (state: UiState): Item[] => pageItems(state.page, viewOf(state));

export function selectedIndex(state: UiState, items = itemsOf(state)): number {
    const stored = state.cursor[state.page];
    if (stored !== undefined && items[stored] && focusable(items[stored])) return stored;
    return Math.max(0, items.findIndex(focusable));
}

export function moveCursor(state: UiState, delta: number): UiState {
    const items = itemsOf(state);
    const indexes = items.map((item, index) => (focusable(item) ? index : -1)).filter((index) => index >= 0);
    if (!indexes.length) return { ...state, scroll: Math.max(0, state.scroll + delta * 3) };
    const position = Math.max(0, indexes.indexOf(selectedIndex(state, items)));
    const next = indexes[Math.max(0, Math.min(indexes.length - 1, position + delta))]!;
    return { ...state, cursor: { ...state.cursor, [state.page]: next } };
}

export function goPage(state: UiState, page: PageId, focus: UiState['focus'] = state.focus): UiState {
    return { ...state, page, focus, scroll: 0 };
}

export function stepPage(state: UiState, delta: number): UiState {
    const index = pages.findIndex((page) => page.id === state.page);
    return goPage(state, pages[(index + delta + pages.length) % pages.length]!.id);
}

export function logged(state: UiState, text: string, tone: Tone): UiState {
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { ...state, toast: { text, tone }, activity: [{ at, text, tone }, ...state.activity].slice(0, 100) };
}
