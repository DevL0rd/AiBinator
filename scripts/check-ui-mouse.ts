import assert from 'node:assert/strict';
import { handleMouse, sgrMouse } from '../src/operator/ui/mouse.js';
import { navWidth } from '../src/operator/ui/frame.js';
import { setting } from '../src/operator/ui/items.js';
import { itemsOf, selectedIndex } from '../src/operator/ui/state.js';
import type { Hit } from '../src/operator/ui/canvas.js';
import type { Sheet } from '../src/operator/ui/sheets.js';
import { sheetOf, uiStore, type TestStore } from './ui-fixtures.js';

const at = (target: string): Hit[] => [{ y: 3, x0: 30, x1: 40, target }];
const click = (ui: TestStore, target: string, code = 0) => handleMouse(ui, at(target), code, 35, 3);
const choices = ['aibi.read', 'aibi.speak', 'aibi.act'];
const multi = (): Sheet => ({ kind: 'multi', field: { ...setting('policy.scopes'), choices }, label: 'Scopes', chosen: [], index: 1 });
const edit = (options: string[] = ['local', 'passthrough']): Sheet => ({
    kind: 'edit',
    field: setting('policy.aibi.mode'),
    label: 'Mode',
    input: 'local',
    options,
    labels: {},
});

function checkWheel(): void {
    const ui = uiStore(undefined, { page: 'aibi' });
    const [first, second] = itemsOf(ui.state).flatMap((item, index) => (item.intent ? [index] : []));
    handleMouse(ui, [], 65, navWidth + 1, 5);
    assert.equal(selectedIndex(ui.state), second, 'scrolling down over the page moves the cursor');
    handleMouse(ui, [], 64, navWidth + 1, 5);
    assert.equal(selectedIndex(ui.state), first, 'scrolling up moves it back');
    handleMouse(ui, [], 65, navWidth, 5);
    assert.equal(ui.state.page, 'abilities', 'scrolling over the page list changes page');
    handleMouse(ui, [], 64, 1, 5);
    assert.equal(ui.state.page, 'aibi');
    ui.state = { ...ui.state, sheet: multi() };
    handleMouse(ui, [], 65, 50, 5);
    handleMouse(ui, [], 65, 50, 5);
    assert.equal(sheetOf(ui, 'multi').index, 2, 'scrolling a checklist stops at the last choice');
    for (let step = 0; step < 4; step++) handleMouse(ui, [], 64, 50, 5);
    assert.equal(sheetOf(ui, 'multi').index, 0, 'and at the first');
    ui.state = { ...ui.state, sheet: edit() };
    const before = ui.state;
    handleMouse(ui, [], 65, 50, 5);
    assert.equal(ui.state, before, 'other sheets ignore the wheel');
}

function checkIgnored(): void {
    const ui = uiStore();
    const before = ui.state;
    click(ui, 'help', 2);
    click(ui, 'help', 32);
    click(ui, 'help', 1);
    handleMouse(ui, at('help'), 0, 10, 3);
    click(ui, 'page:nowhere');
    click(ui, 'brand');
    assert.equal(ui.state, before, 'other buttons, drags, misses and plain text do nothing');
    const busy = uiStore(undefined, { busy: 'Saving…' });
    click(busy, 'help');
    handleMouse(busy, [], 65, 50, 5);
    assert.equal(busy.state.sheet, undefined, 'the mouse is ignored while busy');
    assert.equal(busy.state.scroll, 0);
}

function checkPageClicks(): void {
    const ui = uiStore();
    click(ui, 'help');
    assert.equal(ui.state.sheet?.kind, 'help', 'the ? button opens help');
    click(ui, 'nothing:here');
    assert.equal(ui.state.sheet?.kind, 'help', 'clicks outside a sheet target are ignored');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'any help button closes it');
    click(ui, 'page:aibi');
    assert.deepEqual([ui.state.page, ui.state.focus], ['aibi', 'nav']);
    click(ui, 'policy.aibi.mode');
    const row = itemsOf(ui.state).findIndex((item) => item.id === 'policy.aibi.mode');
    assert.deepEqual([ui.state.focus, ui.state.cursor.aibi], ['content', row], 'clicking a row selects it');
    assert.equal(sheetOf(ui, 'edit').field.id, 'policy.aibi.mode', 'and opens it');
    click(ui, 'sheet:button:1');
    click(ui, 'save');
    assert.deepEqual(ui.state.toast, { text: 'Nothing to save.', tone: 'idle' }, 'the unsaved badge opens the review');
}

function checkEditClicks(): void {
    const ui = uiStore(undefined, { sheet: edit() });
    click(ui, 'sheet:option:1');
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough', 'clicking an option picks it');
    click(ui, 'sheet:option:7');
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough', 'a missing option is ignored');
    click(ui, 'sheet:other:0');
    assert.equal(sheetOf(ui, 'edit').input, 'passthrough');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'Done commits the edit');
    assert.equal((ui.state.drafts.policy.aibi as { mode: string }).mode, 'passthrough');
    ui.state = { ...ui.state, sheet: edit([]) };
    click(ui, 'sheet:button:1');
    assert.equal(ui.state.sheet, undefined, 'Cancel closes the editor');
}

function checkMultiClicks(): void {
    const ui = uiStore(undefined, { sheet: multi() });
    click(ui, 'sheet:option:2');
    assert.deepEqual([sheetOf(ui, 'multi').chosen, sheetOf(ui, 'multi').index], [['aibi.act'], 2], 'clicking a choice toggles it');
    click(ui, 'sheet:option:9');
    assert.deepEqual(sheetOf(ui, 'multi').chosen, ['aibi.act'], 'a missing choice is ignored');
    click(ui, 'sheet:option:0');
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined);
    assert.deepEqual(ui.state.drafts.policy.scopes, ['aibi.read', 'aibi.act'], 'Done stages the choices');
}

function checkSearchClicks(): void {
    const ui = uiStore();
    const search = (input: string): Sheet => ({
        kind: 'search',
        input,
        index: 0,
        reachable: ['policy.aibi.dnsUpstream', 'operator.workspace'],
    });
    ui.state = { ...ui.state, sheet: search('forward') };
    click(ui, 'sheet:option:4');
    assert.equal(sheetOf(ui, 'search').input, 'forward', 'a missing result is ignored');
    click(ui, 'sheet:option:0');
    assert.equal(ui.state.page, 'aibi', 'clicking a result jumps to it');
    ui.state = { ...ui.state, sheet: search('') };
    click(ui, 'sheet:button:0');
    assert.equal(ui.state.sheet, undefined, 'search buttons close it');
}

function checkConfirmClicks(): void {
    const ui = uiStore();
    const pressed: number[] = [];
    const buttons = [0, 1, 2].map((index) => ({ label: `B${index}`, tone: 'info' as const, run: () => void pressed.push(index) }));
    ui.state = { ...ui.state, sheet: { kind: 'confirm', title: 'Pick', body: [], buttons, index: 0 } };
    click(ui, 'sheet:button:2');
    click(ui, 'sheet:button:1');
    click(ui, 'sheet:button:5');
    assert.deepEqual(pressed, [2, 1], 'confirm buttons run their action');
}

function checkSequence(): void {
    const escape = String.fromCharCode(27);
    const found = [...`${escape}[<0;12;7M${escape}[<64;3;4Mjunk${escape}[<0;1;1m`.matchAll(sgrMouse)].map((match) => match.slice(1, 4));
    assert.deepEqual(
        found,
        [
            ['0', '12', '7'],
            ['64', '3', '4'],
        ],
        'mouse presses are parsed and releases skipped',
    );
}

export function checkUiMouse(): void {
    checkWheel();
    checkIgnored();
    checkPageClicks();
    checkEditClicks();
    checkMultiClicks();
    checkSearchClicks();
    checkConfirmClicks();
    checkSequence();
}
