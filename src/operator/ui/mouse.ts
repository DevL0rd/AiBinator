import { targetAt, type Hit } from './canvas.js';
import { navWidth } from './frame.js';
import { pages, type PageId } from './model.js';
import { review, type Store } from './effects.js';
import { activateSelected, commitEdit, commitMulti, toggleChoice } from './keys.js';
import { jumpTo } from './intents.js';
import { searchResults, type Sheet } from './sheets.js';
import { goPage, itemsOf, moveCursor, stepPage } from './state.js';

function sheetButton(store: Store, sheet: Sheet, index: number): void {
    if (sheet.kind === 'confirm') return void sheet.buttons[index]?.run();
    if (index === 1 || sheet.kind === 'help' || sheet.kind === 'search') return store.set((state) => ({ ...state, sheet: undefined }));
    if (sheet.kind === 'edit') commitEdit(store, sheet);
    else commitMulti(store, sheet);
}

function sheetOption(store: Store, sheet: Sheet, index: number): void {
    if (sheet.kind === 'edit' && sheet.options[index] !== undefined)
        return store.set((state) => ({ ...state, sheet: { ...sheet, input: sheet.options[index]!, error: undefined } }));
    if (sheet.kind === 'multi') return store.set((state) => ({ ...state, sheet: toggleChoice(sheet, index) }));
    if (sheet.kind === 'search') {
        const chosen = searchResults(sheet)[index];
        if (chosen) jumpTo(store, chosen.id);
    }
}

function clickSheet(store: Store, sheet: Sheet, target: string): void {
    const [kind, value, index] = target.split(':');
    if (kind !== 'sheet') return;
    if (value === 'button') sheetButton(store, sheet, Number(index));
    if (value === 'option') sheetOption(store, sheet, Number(index));
}

function click(store: Store, target: string): void {
    const state = store.get();
    if (state.sheet) return clickSheet(store, state.sheet, target);
    const [kind, value] = target.split(':');
    if (kind === 'page' && pages.some((page) => page.id === value)) return store.set((current) => goPage(current, value as PageId, 'nav'));
    if (target === 'save') return review(store);
    if (target === 'help') return store.set((current) => ({ ...current, sheet: { kind: 'help' } }));
    const position = itemsOf(state).findIndex((item) => item.id === target && item.intent);
    if (position < 0) return;
    store.set((current) => ({ ...current, focus: 'content', cursor: { ...current.cursor, [current.page]: position } }));
    activateSelected(store);
}

function wheel(store: Store, delta: number, x: number): void {
    const state = store.get();
    const sheet = state.sheet;
    if (sheet?.kind === 'multi') {
        const index = Math.max(0, Math.min((sheet.field.choices?.length ?? 1) - 1, sheet.index + delta));
        return store.set((current) => ({ ...current, sheet: { ...sheet, index } }));
    }
    if (sheet) return;
    store.set((current) => (x <= navWidth ? stepPage(current, delta) : moveCursor(current, delta)));
}

export function handleMouse(store: Store, map: Hit[], code: number, x: number, y: number): void {
    if (store.get().busy) return;
    if (code === 64 || code === 65) return wheel(store, code === 64 ? -1 : 1, x);
    if ((code & 3) !== 0 || code >= 32) return;
    const target = targetAt(map, x, y);
    if (target) click(store, target);
}

export const sgrMouse = new RegExp(`${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)M`, 'g');
