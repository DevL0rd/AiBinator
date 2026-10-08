import { pickerFor } from './pickers.js';
import type { OperatingMode } from '../config.js';
import { settings } from '../settings-registry.js';
import { pages, type Intent, type PageId } from './model.js';
import { pageItems } from './pages/index.js';
import { editOptions, initialInput, optionLabels, multiSelect, toggled } from './edit.js';
import { setting } from './items.js';
import { confirm, review, run, type Store } from './effects.js';
import { goPage, logged, viewOf, type UiState } from './state.js';
import { assistantName } from './status.js';
import { settingValue } from '../settings-registry.js';

function openEditor(store: Store, id: string, label?: string): void {
    const field = setting(id);
    const state = store.get();
    if (field.readOnly)
        return store.set((current) => logged(current, `${field.label} is fixed for safety and cannot be changed here.`, 'idle'));
    const picker = pickerFor(field, state);
    if (picker)
        return store.set((current) => ({
            ...current,
            sheet: {
                kind: 'multi',
                field: picker.field,
                label: label ?? field.label,
                chosen: picker.chosen,
                index: 0,
                labels: picker.labels,
            },
        }));
    if (multiSelect(field)) {
        const chosen = (settingValue(state.drafts[field.source], field) as string[] | undefined) ?? [];
        return store.set((current) => ({
            ...current,
            sheet: { kind: 'multi', field, label: label ?? field.label, chosen: [...chosen], index: 0 },
        }));
    }
    const options = editOptions(field, state.drafts, state.observed);
    const labels = optionLabels(field, state.observed);
    store.set((current) => ({
        ...current,
        sheet: { kind: 'edit', field, label: label ?? field.label, input: initialInput(field, current.drafts), options, labels },
    }));
}

function chooseMode(state: UiState, mode: OperatingMode): UiState {
    if (state.drafts.operator.mode === mode) return state;
    const drafts = { ...state.drafts, operator: { ...state.drafts.operator, mode } };
    return logged({ ...state, drafts }, `${assistantName(mode)} selected. Press S to save it.`, 'info');
}

export function dispatch(store: Store, intent: Intent): void {
    switch (intent.type) {
        case 'page':
            return store.set((state) => goPage(state, intent.page));
        case 'edit':
            return openEditor(store, intent.setting);
        case 'toggle':
            return store.set((state) => ({ ...state, drafts: toggled(state.drafts, setting(intent.setting)) }));
        case 'mode':
            return store.set((state) => chooseMode(state, intent.mode));
        case 'run':
            return run(store, intent.action);
        case 'save':
            return review(store);
        case 'discard':
            return store.set((state) =>
                logged({ ...state, drafts: structuredClone(state.snapshot.documents) }, 'Changes discarded.', 'idle'),
            );
        case 'info':
            return confirm(
                store,
                intent.title,
                [intent.body],
                [{ label: 'OK', tone: 'info', run: () => store.set((state) => ({ ...state, sheet: undefined })) }],
            );
    }
}

function locate(state: UiState, id: string): { page: PageId; index: number } | undefined {
    const view = viewOf(state);
    for (const page of pages) {
        const index = pageItems(page.id, view).findIndex((item) => item.id === id);
        if (index >= 0) return { page: page.id, index };
    }
}

export function jumpTo(store: Store, id: string): void {
    const found = locate(store.get(), id);
    store.set((state) => {
        const closed = { ...state, sheet: undefined };
        return found ? { ...goPage(closed, found.page, 'content'), cursor: { ...state.cursor, [found.page]: found.index } } : closed;
    });
    if (settings.some((item) => item.id === id)) openEditor(store, id);
}
