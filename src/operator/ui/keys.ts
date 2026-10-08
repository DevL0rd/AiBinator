import { stage } from './edit.js';
import { commitPassword, isPasswordSheet, quit, review, run, refresh, type Store } from './effects.js';
import { dispatch, jumpTo } from './intents.js';
import { searchResults, type Sheet } from './sheets.js';
import { goPage, itemsOf, logged, moveCursor, selectedIndex, stepPage, viewOf, type UiState } from './state.js';
import { pages } from './model.js';
import { pageItems } from './pages/index.js';
import { operator } from './status.js';

export interface Key {
    ctrl: boolean;
    meta: boolean;
    escape: boolean;
    return: boolean;
    tab: boolean;
    shift: boolean;
    backspace: boolean;
    delete: boolean;
    upArrow: boolean;
    downArrow: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    pageUp: boolean;
    pageDown: boolean;
}

const vertical = (input: string, key: Key): number => {
    if (key.upArrow || input === 'k') return -1;
    if (key.downArrow || input === 'j') return 1;
    if (key.pageUp) return -5;
    return key.pageDown ? 5 : 0;
};
const arrows = (key: Key): number => vertical('', key);
const closeSheet = (state: UiState): UiState => ({ ...state, sheet: undefined });
const reachable = (state: UiState): string[] => pages.flatMap((page) => pageItems(page.id, viewOf(state)).map((item) => item.id));

export function activateSelected(store: Store): void {
    const state = store.get();
    if (state.focus === 'nav') return store.set((current) => ({ ...current, focus: 'content' }));
    const items = itemsOf(state);
    const item = items[selectedIndex(state, items)];
    if (item?.intent) dispatch(store, item.intent);
}

function shortcut(store: Store, input: string, key: Key): boolean {
    const toggleActive = () =>
        run(store, operator(viewOf(store.get())).mode === 'disabled' || !store.get().observed.live ? 'start' : 'pause');
    const actions: Record<string, () => void> = {
        q: () => quit(store),
        '?': () => store.set((state) => ({ ...state, sheet: { kind: 'help' } })),
        '/': () => store.set((state) => ({ ...state, sheet: { kind: 'search', input: '', index: 0, reachable: reachable(state) } })),
        r: () => void refresh(store, true).then(() => store.set((state) => logged(state, 'Settings and status reloaded.', 'idle'))),
        s: () => review(store),
        p: toggleActive,
        u: () => {
            const update = store.get().extras.update;
            if (update?.behind && !update.blocker) run(store, 'update');
        },
    };
    if (key.ctrl && input === 'c') quit(store);
    else if (new RegExp(`^[1-${pages.length}]$`).test(input)) store.set((state) => goPage(state, pages[Number(input) - 1]!.id));
    else if (!key.ctrl && actions[input]) actions[input]();
    else return false;
    return true;
}

function focusFor(key: Key, current: UiState['focus']): UiState['focus'] | undefined {
    if (key.leftArrow) return 'nav';
    if (key.rightArrow) return 'content';
    if (key.tab) return current === 'nav' ? 'content' : 'nav';
}

function mainKey(store: Store, input: string, key: Key): void {
    if (shortcut(store, input, key)) return;
    const focus = focusFor(key, store.get().focus);
    if (focus) return store.set((state) => ({ ...state, focus }));
    const delta = vertical(input, key);
    if (delta) return store.set((state) => (state.focus === 'nav' ? stepPage(state, Math.sign(delta)) : moveCursor(state, delta)));
    if (key.return || input === ' ') activateSelected(store);
}

function editKey(store: Store, sheet: Extract<Sheet, { kind: 'edit' }>, input: string, key: Key): void {
    const update = (patch: Partial<typeof sheet>) => store.set((state) => ({ ...state, sheet: { ...sheet, error: undefined, ...patch } }));
    if (key.return) return commitEdit(store, sheet);
    const delta = arrows(key);
    if (sheet.options.length && delta) {
        const index = Math.max(0, sheet.options.indexOf(sheet.input));
        return update({ input: sheet.options[(index + delta + sheet.options.length) % sheet.options.length]! });
    }
    if (sheet.field.kind !== 'choice') update({ input: typed(sheet.input, input, key) });
}

export function typed(value: string, input: string, key: Key): string {
    if (key.ctrl && input === 'u') return '';
    if (key.backspace || key.delete) return value.slice(0, -1);
    return !key.ctrl && !key.meta && input ? value + input.replace(/[\r\n]/g, '') : value;
}

export function commitEdit(store: Store, sheet: Extract<Sheet, { kind: 'edit' }>): void {
    if (isPasswordSheet(sheet)) return commitPassword(store, sheet);
    try {
        const drafts = stage(store.get().drafts, sheet.field, sheet.input);
        store.set((state) => ({ ...closeSheet(state), drafts }));
    } catch (error) {
        store.set((state) => ({
            ...state,
            sheet: { ...sheet, error: error instanceof Error ? error.message : 'That value is not valid.' },
        }));
    }
}

export function commitMulti(store: Store, sheet: Extract<Sheet, { kind: 'multi' }>): void {
    const order = [...(sheet.field.choices ?? [])];
    const drafts = stage(
        store.get().drafts,
        sheet.field,
        order.filter((value) => sheet.chosen.includes(value)),
    );
    store.set((state) => ({ ...closeSheet(state), drafts }));
}

export function toggleChoice(sheet: Extract<Sheet, { kind: 'multi' }>, index: number): Sheet {
    const value = sheet.field.choices?.[index];
    if (!value) return sheet;
    const chosen = sheet.chosen.includes(value) ? sheet.chosen.filter((item) => item !== value) : [...sheet.chosen, value];
    return { ...sheet, chosen, index };
}

function multiKey(store: Store, sheet: Extract<Sheet, { kind: 'multi' }>, input: string, key: Key): void {
    const count = sheet.field.choices?.length ?? 0;
    const delta = vertical(input, key);
    if (key.return) return commitMulti(store, sheet);
    if (delta)
        return store.set((state) => ({ ...state, sheet: { ...sheet, index: Math.max(0, Math.min(count - 1, sheet.index + delta)) } }));
    if (input === ' ') return store.set((state) => ({ ...state, sheet: toggleChoice(sheet, sheet.index) }));
    if (input === 'a') {
        const chosen = sheet.chosen.length === count ? [] : [...(sheet.field.choices ?? [])];
        store.set((state) => ({ ...state, sheet: { ...sheet, chosen } }));
    }
}

function stepDelta(key: Key): number {
    if (key.leftArrow || key.upArrow || (key.tab && key.shift)) return -1;
    return Number(key.rightArrow || key.downArrow || key.tab);
}

function confirmKey(store: Store, sheet: Extract<Sheet, { kind: 'confirm' }>, input: string, key: Key): void {
    if (key.return || input === ' ') return void sheet.buttons[sheet.index]?.run();
    const delta = stepDelta(key);
    if (delta)
        store.set((state) => ({
            ...state,
            sheet: { ...sheet, index: (sheet.index + delta + sheet.buttons.length) % sheet.buttons.length },
        }));
}

function searchKey(store: Store, sheet: Extract<Sheet, { kind: 'search' }>, input: string, key: Key): void {
    const results = searchResults(sheet);
    if (key.return) {
        const chosen = results[sheet.index];
        if (chosen) jumpTo(store, chosen.id);
        return;
    }
    const delta = arrows(key);
    if (delta)
        return store.set((state) => ({
            ...state,
            sheet: { ...sheet, index: Math.max(0, Math.min(results.length - 1, sheet.index + delta)) },
        }));
    const text = typed(sheet.input, input, key);
    store.set((state) => ({ ...state, sheet: { ...sheet, input: text, index: 0 } }));
}

function sheetKey(store: Store, sheet: Sheet, input: string, key: Key): void {
    if (key.escape || sheet.kind === 'help') return store.set(closeSheet);
    if (sheet.kind === 'edit') return editKey(store, sheet, input, key);
    if (sheet.kind === 'multi') return multiKey(store, sheet, input, key);
    if (sheet.kind === 'confirm') return confirmKey(store, sheet, input, key);
    searchKey(store, sheet, input, key);
}

export function handleKey(store: Store, input: string, key: Key): void {
    const state = store.get();
    if (state.busy) return;
    if (state.sheet) return sheetKey(store, state.sheet, input, key);
    mainKey(store, input, key);
}
