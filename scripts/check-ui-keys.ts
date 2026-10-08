import assert from 'node:assert/strict';
import { handleKey, typed, type Key } from '../src/operator/ui/keys.js';
import { itemsOf, selectedIndex, viewOf, type UiState } from '../src/operator/ui/state.js';
import { homeItems } from '../src/operator/ui/pages/home.js';
import { setting } from '../src/operator/ui/items.js';
import type { Sheet } from '../src/operator/ui/sheets.js';
import { dispatch } from '../src/operator/ui/intents.js';
import { io } from '../src/operator/ui/effects.js';
import { actions } from '../src/aibi/capabilities.js';
import { called, fakeServices, key, observed, settle, sheetOf, uiStore, type Calls, type TestStore } from './ui-fixtures.js';

const stops = (state: UiState) => itemsOf(state).flatMap((item, index) => (item.intent ? [index] : []));
const position = (state: UiState, id: string) => itemsOf(state).findIndex((item) => item.id === id);
const multiField = { ...setting('policy.scopes'), choices: ['aibi.read', 'aibi.speak', 'aibi.act'] };

function checkNavigation(): void {
    const ui = uiStore();
    handleKey(ui, '2', key());
    assert.equal(ui.state.page, 'assistant', 'number keys jump to pages');
    const stop = stops(ui.state);
    assert.equal(selectedIndex(ui.state), stop[0], 'the first setting is selected by default');
    const moves: [string, Partial<Key>, number][] = [
        ['j', {}, stop[1]!],
        ['', { downArrow: true }, stop[2]!],
        ['k', {}, stop[1]!],
        ['', { upArrow: true }, stop[0]!],
        ['', { upArrow: true }, stop[0]!],
        ['', { pageDown: true }, stop[5]!],
        ['', { pageDown: true }, stop[10]!],
        ['', { pageUp: true }, stop[5]!],
    ];
    for (const [input, patch, expected] of moves) {
        handleKey(ui, input, key(patch));
        assert.equal(selectedIndex(ui.state), expected, `${input || Object.keys(patch).join()} moves the cursor to ${expected}`);
    }
    handleKey(ui, '', key({ leftArrow: true }));
    assert.equal(ui.state.focus, 'nav', 'left arrow focuses the page list');
    handleKey(ui, 'j', key());
    assert.equal(ui.state.page, 'aibi', 'moving down in the page list changes page');
    handleKey(ui, 'k', key());
    handleKey(ui, 'k', key());
    assert.equal(ui.state.page, 'home');
    handleKey(ui, '', key({ pageUp: true }));
    assert.equal(ui.state.page, 'system', 'page list wraps around');
    handleKey(ui, '', key({ downArrow: true }));
    assert.equal(ui.state.page, 'home');
    handleKey(ui, '', key({ upArrow: true }));
    assert.equal(ui.state.page, 'system');
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.focus, 'content', 'Enter in the page list moves into the page');
    handleKey(ui, '', key({ tab: true }));
    assert.equal(ui.state.focus, 'nav', 'Tab switches to the page list');
    handleKey(ui, '', key({ tab: true }));
    assert.equal(ui.state.focus, 'content', 'Tab switches back to the page');
    handleKey(ui, '', key({ leftArrow: true }));
    handleKey(ui, '', key({ rightArrow: true }));
    assert.equal(ui.state.focus, 'content', 'right arrow focuses the page');
    const before = ui.state;
    handleKey(ui, 'x', key());
    handleKey(ui, 's', key({ ctrl: true }));
    assert.equal(ui.state, before, 'unbound keys change nothing');
}

function checkActivation(): void {
    const ui = uiStore(undefined, { page: 'aibi' });
    ui.state = { ...ui.state, cursor: { aibi: position(ui.state, 'policy.aibi.dns') } };
    handleKey(ui, ' ', key());
    assert.equal((ui.state.drafts.policy.aibi as { dns: boolean }).dns, false, 'Space toggles a switch');
    handleKey(ui, 'j', key());
    handleKey(ui, '', key({ return: true }));
    const edit = sheetOf(ui, 'edit');
    assert.equal(edit.field.id, 'policy.aibi.dnsUpstream', 'Enter opens the editor for the selected setting');
    const busy = uiStore(undefined, { page: 'aibi', busy: 'Saving…' });
    handleKey(busy, '2', key());
    assert.equal(busy.state.page, 'aibi', 'keys are ignored while busy');
}

async function checkUpdateKey(calls: Calls): Promise<void> {
    const current = uiStore(fakeServices(calls));
    handleKey(current, 'u', key());
    await settle();
    assert.equal(called(calls, 'applyUpdate').length, 0, 'U does nothing without an update');
    const update = { behind: 2, current: 'aaa1111', latest: 'bbb2222' };
    const behind = uiStore(fakeServices(calls), { extras: { apps: {}, update } });
    const button = homeItems(viewOf(behind.state)).find((item) => item.id === 'update');
    assert.ok(button, 'the Overview offers the update');
    assert.match(
        button
            .lines(80, false, viewOf(behind.state))
            .map((row) => row.spans.map((part) => part.text).join(''))
            .join('\n'),
        /2 new commits, aaa1111 → bbb2222 · press U/,
    );
    handleKey(behind, 'u', key());
    await settle();
    assert.equal(called(calls, 'applyUpdate').length, 1, 'U updates and restarts');
    const blocked = uiStore(fakeServices(calls), { extras: { apps: {}, update: { ...update, blocker: 'It has local changes.' } } });
    const items = homeItems(viewOf(blocked.state)).map((item) => item.id);
    assert.ok(items.includes('update-blocked') && !items.includes('update'), 'a blocked update is explained instead of offered');
}

async function checkShortcuts(): Promise<void> {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    handleKey(ui, '?', key());
    assert.equal(ui.state.sheet?.kind, 'help');
    handleKey(ui, 'z', key());
    assert.equal(ui.state.sheet, undefined, 'any key closes help');
    handleKey(ui, 'r', key());
    await settle();
    assert.equal(called(calls, 'readPanel').length, 1, 'R reloads the files');
    assert.equal(ui.state.toast?.text, 'Settings and status reloaded.');
    handleKey(ui, 'p', key());
    await settle();
    assert.deepEqual(called(calls, 'startSaved').at(-1)?.[2], false, 'P pauses a running assistant');
    const offline = uiStore(fakeServices(calls), { observed: { ...observed, live: null } });
    handleKey(offline, 'p', key());
    await settle();
    assert.deepEqual(called(calls, 'startSaved').at(-1)?.[2], true, 'P starts an assistant that is not running');
    const paused = uiStore(fakeServices(calls), {
        observed: { ...observed, live: { ...observed.live!, operator: { mode: 'disabled', appliedConfigAt: null } } },
    });
    handleKey(paused, 'p', key());
    await settle();
    assert.deepEqual(called(calls, 'startSaved').at(-1)?.[2], true, 'P starts a paused assistant');
    await checkUpdateKey(calls);
    handleKey(ui, 'q', key());
    assert.equal(ui.exited, true, 'Q quits when nothing is unsaved');
    const ctrl = uiStore(fakeServices(calls));
    handleKey(ctrl, 'c', key({ ctrl: true }));
    assert.equal(ctrl.exited, true, 'Ctrl+C quits');
}

function editSheet(ui: TestStore, id: string, options: string[] = []): Extract<Sheet, { kind: 'edit' }> {
    const sheet: Sheet = { kind: 'edit', field: setting(id), label: id, input: '', options, labels: {} };
    ui.state = { ...ui.state, sheet };
    return sheet;
}

function checkEditKeys(): void {
    const ui = uiStore();
    editSheet(ui, 'policy.aibi.mode', ['local', 'passthrough']);
    handleKey(ui, 'x', key());
    assert.equal(sheetOf(ui, 'edit').input, '', 'typing does nothing in a choice');
    handleKey(ui, '', key({ downArrow: true }));
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough', 'an unknown value steps from the first option');
    handleKey(ui, 'j', key());
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough', 'j types instead of moving in a choice editor');
    handleKey(ui, '', key({ downArrow: true }));
    assert.equal(sheetOf(ui, 'edit').input, 'local', 'options wrap around');
    handleKey(ui, '', key({ upArrow: true }));
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough');
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.sheet, undefined);
    assert.equal((ui.state.drafts.policy.aibi as { mode: string }).mode, 'passthrough', 'Enter stages the choice');
    editSheet(ui, 'operator.instructions');
    for (const character of ['B', 'e', ' ', 'b', 'r', 'i', 'e', 'f', '\r\n']) handleKey(ui, character, key());
    assert.equal(sheetOf(ui, 'edit').input, 'Be brief', 'typed text is collected without line breaks');
    handleKey(ui, '', key({ upArrow: true }));
    assert.equal(sheetOf(ui, 'edit').input, 'Be brief', 'arrows do nothing without options');
    handleKey(ui, '', key({ backspace: true }));
    assert.equal(sheetOf(ui, 'edit').input, 'Be brie');
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.drafts.operator.instructions, 'Be brie');
    editSheet(ui, 'policy.voice.idleSeconds');
    for (const character of 'lots') handleKey(ui, character, key());
    handleKey(ui, '', key({ return: true }));
    assert.equal(sheetOf(ui, 'edit').error, 'Enter a whole number.', 'invalid input keeps the editor open with an error');
    handleKey(ui, 'u', key({ ctrl: true }));
    assert.deepEqual([sheetOf(ui, 'edit').input, sheetOf(ui, 'edit').error], ['', undefined], 'Ctrl+U clears the input and the error');
    handleKey(ui, '', key({ escape: true }));
    assert.equal(ui.state.sheet, undefined, 'Esc closes the editor');
}

function checkTyping(): void {
    assert.equal(typed('abc', '', key({ delete: true })), 'ab', 'Delete removes the last character');
    assert.equal(typed('abc', 'x', key({ meta: true })), 'abc', 'Alt combinations are not typed');
    assert.equal(typed('abc', 'x', key({ ctrl: true })), 'abc', 'Ctrl combinations are not typed');
    assert.equal(typed('abc', '', key()), 'abc');
}

function checkMultiKeys(): void {
    const ui = uiStore();
    ui.state = { ...ui.state, sheet: { kind: 'multi', field: multiField, label: 'Scopes', chosen: ['aibi.speak'], index: 0 } };
    handleKey(ui, '', key({ upArrow: true }));
    assert.equal(sheetOf(ui, 'multi').index, 0, 'the cursor stops at the top');
    handleKey(ui, '', key({ pageDown: true }));
    assert.equal(sheetOf(ui, 'multi').index, 2, 'the cursor stops at the bottom');
    handleKey(ui, ' ', key());
    assert.deepEqual(sheetOf(ui, 'multi').chosen, ['aibi.speak', 'aibi.act'], 'Space selects');
    handleKey(ui, 'k', key());
    handleKey(ui, ' ', key());
    assert.deepEqual(sheetOf(ui, 'multi').chosen, ['aibi.act'], 'Space deselects');
    handleKey(ui, 'a', key());
    assert.equal(sheetOf(ui, 'multi').chosen.length, 3, 'A selects everything');
    handleKey(ui, 'a', key());
    assert.deepEqual(sheetOf(ui, 'multi').chosen, [], 'A again clears everything');
    handleKey(ui, 'z', key());
    assert.deepEqual(sheetOf(ui, 'multi').chosen, []);
    handleKey(ui, ' ', key());
    handleKey(ui, 'j', key());
    handleKey(ui, ' ', key());
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.sheet, undefined);
    assert.deepEqual(ui.state.drafts.policy.scopes, ['aibi.speak', 'aibi.act'], 'Enter stages choices in catalog order');
}

function checkConfirmKeys(): void {
    const ui = uiStore();
    const pressed: string[] = [];
    const buttons = ['One', 'Two', 'Three'].map((label) => ({ label, tone: 'info' as const, run: () => void pressed.push(label) }));
    ui.state = { ...ui.state, sheet: { kind: 'confirm', title: 'Pick', body: [], buttons, index: 0 } };
    const steps: [Partial<Key>, number][] = [
        [{ rightArrow: true }, 1],
        [{ downArrow: true }, 2],
        [{ tab: true }, 0],
        [{ tab: true, shift: true }, 2],
        [{ upArrow: true }, 1],
        [{ leftArrow: true }, 0],
        [{ leftArrow: true }, 2],
        [{ pageDown: true }, 2],
    ];
    for (const [patch, index] of steps) {
        handleKey(ui, '', key(patch));
        assert.equal(sheetOf(ui, 'confirm').index, index, `${Object.keys(patch).join('+')} moves to button ${index}`);
    }
    handleKey(ui, ' ', key());
    handleKey(ui, '', key({ rightArrow: true }));
    handleKey(ui, '', key({ return: true }));
    assert.deepEqual(pressed, ['Three', 'One'], 'Space and Enter press the focused button');
    ui.state = { ...ui.state, sheet: { kind: 'confirm', title: 'Empty', body: [], buttons: [], index: 0 } };
    handleKey(ui, '', key({ return: true }));
    assert.equal(sheetOf(ui, 'confirm').title, 'Empty', 'a sheet without buttons ignores Enter');
}

function checkSearchKeys(): void {
    const ui = uiStore();
    handleKey(ui, '/', key());
    for (const character of 'port') handleKey(ui, character, key());
    const results = () => sheetOf(ui, 'search');
    handleKey(ui, '', key({ downArrow: true }));
    handleKey(ui, '', key({ downArrow: true }));
    assert.equal(results().index, 2, 'arrows move through results');
    handleKey(ui, '', key({ upArrow: true }));
    assert.equal(results().index, 1);
    handleKey(ui, '', key({ backspace: true }));
    assert.deepEqual([results().input, results().index], ['por', 0], 'typing resets the selection');
    handleKey(ui, 'u', key({ ctrl: true }));
    for (const character of 'zzzz') handleKey(ui, character, key());
    handleKey(ui, '', key({ downArrow: true }));
    assert.equal(results().index, 0, 'no results keeps the cursor at the start');
    handleKey(ui, '', key({ return: true }));
    assert.equal(results().input, 'zzzz', 'Enter without a result does nothing');
    handleKey(ui, 'u', key({ ctrl: true }));
    for (const character of 'workspace') handleKey(ui, character, key());
    handleKey(ui, '', key({ return: true }));
    assert.deepEqual([ui.state.page, ui.state.focus], ['assistant', 'content'], 'Enter jumps to the result');
    assert.equal(sheetOf(ui, 'edit').field.id, 'operator.workspace', 'and opens its editor');
}

function checkSheetCommits(): void {
    const calls: Calls = [];
    const ui = uiStore(fakeServices(calls));
    dispatch(ui, { type: 'run', action: 'sign-in-password' });
    handleKey(ui, 'x', key());
    handleKey(ui, '', key({ return: true }));
    assert.match(sheetOf(ui, 'edit').error ?? '', /12/, 'Enter checks a new password before asking to confirm it');
    handleKey(ui, '', key({ escape: true }));
    dispatch(ui, { type: 'edit', setting: 'policy.aibi.actions' });
    const picker = sheetOf(ui, 'multi');
    const first = actions[0]!;
    assert.equal(picker.labels?.[first.id], `${first.id} · ${first.description}`, 'actions are listed with what they do');
    assert.equal(picker.chosen.includes(first.id), true, 'every action starts checked');
    handleKey(ui, ' ', key());
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.sheet, undefined);
    const chosen = picker.chosen.filter((id) => id !== first.id);
    assert.deepEqual(
        (ui.state.drafts.policy.aibi as { actions: string[] }).actions,
        actions.map((action) => action.id).filter((id) => chosen.includes(id)),
        'Enter stages the checked actions in catalog order',
    );
    const real = io(uiStore());
    assert.equal(io(uiStore()), real, 'stores without fakes share the real services');
    assert.equal(typeof real.readPanel, 'function');
}

export async function checkUiKeys(): Promise<void> {
    checkSheetCommits();
    checkNavigation();
    checkActivation();
    await checkShortcuts();
    checkEditKeys();
    checkTyping();
    checkMultiKeys();
    checkConfirmKeys();
    checkSearchKeys();
}
