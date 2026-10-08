import assert from 'node:assert/strict';
import { hits, lineWidth } from '../src/operator/ui/canvas.js';
import { frame } from '../src/operator/ui/frame.js';
import { pages } from '../src/operator/ui/model.js';
import { pageItems } from '../src/operator/ui/pages/index.js';
import { searchResults, sheetLines } from '../src/operator/ui/sheets.js';
import { savedDiffers } from '../src/operator/ui/status.js';
import { handleKey } from '../src/operator/ui/keys.js';
import { handleMouse } from '../src/operator/ui/mouse.js';
import { selectedIndex, viewOf, type UiState } from '../src/operator/ui/state.js';
import { wizardFrame } from '../src/operator/onboarding-view.js';
import { key, observed, uiStore } from './ui-fixtures.js';

function render(state: UiState, width: number, height: number) {
    const view = viewOf(state);
    const items = pageItems(state.page, view);
    return frame({
        view,
        page: state.page,
        focus: state.focus,
        items,
        selected: selectedIndex(state, items),
        scroll: state.scroll,
        ...(state.sheet ? { overlay: sheetLines(state.sheet, width) } : {}),
        width,
        height,
    }).lines;
}

function checkFrames(): void {
    const ui = uiStore();
    for (const [width, height] of [
        [80, 23],
        [120, 39],
    ] as const)
        for (const page of pages) {
            ui.state = { ...ui.state, page: page.id };
            const lines = render(ui.state, width, height);
            assert.equal(lines.length, height, `${page.id} height`);
            for (const value of lines) assert.equal(lineWidth(value), width, `${page.id} line width at ${width}`);
        }
    const wizard = wizardFrame({ stage: 1, title: 'Who answers', body: ['x'], options: ['a', 'b'], selected: 0, tick: 0 }, 80, 23);
    assert.ok(wizard.every((value) => lineWidth(value) === 80));
}

function checkKeyboard(): void {
    const ui = uiStore();
    handleKey(ui, '2', key());
    assert.equal(ui.state.page, 'assistant');
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.drafts.operator.mode, 'claude-session', 'Enter on the first card selects it');
    assert.equal(viewOf(ui.state).changes.length, 1);
    handleKey(ui, 's', key());
    assert.equal(ui.state.sheet?.kind, 'confirm', 'S opens the review');
    handleKey(ui, '', key({ escape: true }));
    assert.equal(ui.state.sheet, undefined);
    handleKey(ui, '/', key());
    for (const character of 'public domain') handleKey(ui, character, key());
    handleKey(ui, '', key({ return: true }));
    assert.equal(ui.state.page, 'apps', 'search jumps to the page that owns the setting');
    const editor = () => (ui.state.sheet?.kind === 'edit' ? ui.state.sheet : undefined);
    assert.equal(editor()?.input, 'bot.example.com', 'domain is edited without protocol');
    const type = (value: string) => {
        ui.state = { ...ui.state, sheet: { ...editor()!, input: '' } };
        for (const character of value) handleKey(ui, character, key());
        handleKey(ui, '', key({ return: true }));
    };
    type('https://new.example.com');
    assert.match(editor()?.error ?? '', /just the domain/, 'protocol is rejected with a visible error');
    type('new.example.com');
    assert.equal(editor(), undefined);
    assert.equal(ui.state.drafts.environment.AIBINATOR_RESOURCE_URL, 'https://new.example.com/mcp');
    handleKey(ui, '/', key());
    const search = () => (ui.state.sheet?.kind === 'search' ? ui.state.sheet : undefined);
    assert.equal(search()?.reachable.includes('environment.AIBINATOR_AUTH_MODE'), false);
    for (const character of 'mcp authentication') handleKey(ui, character, key());
    assert.equal(searchResults(search()!).length, 0, 'search only offers settings on a page');
    handleKey(ui, '', key({ escape: true }));
}

const text = (state: UiState) =>
    render(state, 120, 200)
        .map((value) => value.spans.map((item) => item.text).join(''))
        .join('\n');

function checkResponderPage(): void {
    const ui = uiStore();
    const drafted = (operator: Record<string, unknown>): UiState => ({
        ...ui.state,
        page: 'assistant',
        drafts: { ...ui.state.drafts, operator: { ...ui.state.drafts.operator, ...operator } },
    });
    const codex = text(drafted({ mode: 'codex-local' }));
    for (const row of ['Codex settings', 'AIBI tools connected', 'Working folder', 'Model for workers', 'Reasoning for workers'])
        assert.ok(codex.includes(row), `Codex shows ${row}`);
    const claude = text(drafted({ mode: 'claude-session' }));
    for (const row of ['Claude Code settings', 'Open in Claude Desktop', 'Model for new chats'])
        assert.ok(claude.includes(row), `Claude Code shows ${row}`);
    const manual = text(drafted({ mode: 'manual-mcp' }));
    assert.ok(
        manual.includes('http://127.0.0.1:8789/mcp') && manual.includes('https://bot.example.com/mcp'),
        'Another MCP app shows its addresses',
    );
    assert.ok(text(drafted({ mode: 'claude-session' })).includes('Opens in Claude Desktop when needed'));
    assert.ok(
        !text(drafted({ mode: 'claude-session', backgroundOnly: true })).includes('Claude Desktop when needed'),
        'hidden in the background',
    );
    const live = (appliedConfigAt: string | null) =>
        viewOf({ ...ui.state, observed: { ...observed, live: { ...observed.live!, operator: { mode: 'codex-local', appliedConfigAt } } } });
    assert.equal(savedDiffers(live(null)), true, 'a saved responder that is not applied yet is flagged');
    assert.equal(savedDiffers(live(observed.active.updatedAt)), false);
}

function checkMouse(): void {
    const ui = uiStore();
    const click = (target: string) => {
        const map = hits(render(ui.state, 120, 39));
        const spot = map.find((item) => item.target === target);
        assert.ok(spot, `target ${target} is clickable`);
        handleMouse(ui, map, 0, spot.x0, spot.y);
    };
    click('page:aibi');
    assert.equal(ui.state.page, 'aibi');
    click('page:assistant');
    click('mode:manual-mcp');
    assert.equal(ui.state.drafts.operator.mode, 'manual-mcp', 'clicking a card selects it like Enter');
    click('save');
    assert.equal(ui.state.sheet?.kind, 'confirm');
    click('sheet:button:1');
    assert.equal(ui.state.sheet, undefined, 'Keep editing closes the review');
}

export function checkUi(): void {
    checkFrames();
    checkKeyboard();
    checkMouse();
    checkResponderPage();
}
