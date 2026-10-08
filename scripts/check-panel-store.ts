import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applyDraft, persistentWorkBlock, readPanel, startSaved, type Documents, type PanelSnapshot } from '../src/operator/panel-store.js';
import { readOperatorConfig, writeOperatorConfig } from '../src/operator/config.js';
import { editPublicDomain } from '../src/operator/connection-domain.js';
import { aibiStatus } from './fixtures.js';
import { inScratch, liveFake, withLocal, type LiveFake } from './onboarding-fakes.js';

const noReconnect = () => Promise.resolve(() => Promise.resolve(''));
const environment = [
    'GEMINI_API_KEY=fixture-gemini-key',
    'AIBINATOR_MCP_TOKEN=fixture-credential-at-least-32-characters',
    'AIBINATOR_AUTH_MODE=bearer',
    'AIBINATOR_POLICY_FILE=policy.json',
    'AIBINATOR_PORT=not-a-port',
].join('\n');

function edited(snapshot: PanelSnapshot, patch: Partial<Record<keyof Documents, Record<string, unknown>>>): Documents {
    const documents = structuredClone(snapshot.documents);
    for (const [source, values] of Object.entries(patch)) Object.assign(documents[source as keyof Documents], values);
    return documents;
}

async function checkReading(): Promise<void> {
    await writeFile('.env', `${environment}\n`);
    const fresh = await readPanel();
    assert.equal(fresh.documents.environment.AIBINATOR_PORT, 'not-a-port', 'invalid values are kept for the editor to show');
    assert.equal(fresh.originals.policy, '', 'a missing policy file reads as empty');
    assert.equal((fresh.documents.policy.aibi as { mode: string }).mode, 'local', 'and as the default policy');
    assert.equal(fresh.documents.environment.GEMINI_API_KEY, 'fixture-gemini-key');
    await mkdir('policy.json');
    await assert.rejects(readPanel(), 'an unreadable policy file is an error');
    await rm('policy.json', { recursive: true });
    await writeFile('.env', `${environment.replace('not-a-port', '8789')}\n`);
    await writeFile('policy.json', '{}\n');
    const snapshot = await readPanel();
    assert.deepEqual(await applyDraft(snapshot, structuredClone(snapshot.documents), noReconnect), {
        snapshot,
        message: 'No changes to save.',
    });
}

async function checkRefusals(): Promise<void> {
    await writeFile('policy.json', '{}\n');
    const snapshot = await readPanel();
    const refuse = (patch: Parameters<typeof edited>[1], error: RegExp) =>
        assert.rejects(applyDraft(snapshot, edited(snapshot, patch), noReconnect), error);
    const aibi = snapshot.documents.policy.aibi as Record<string, unknown>;
    await refuse({ policy: { aibi: { ...aibi, lanAddress: 'not-an-address' } } }, /Enter an IPv4 address/);
    await refuse({ environment: { GEMINI_API_KEY: 'short' } }, /GEMINI_API_KEY/);
    await writeFile('not-a-folder', '');
    await refuse({ operator: { mode: 'codex-local', workspace: resolve('not-a-folder') } }, /Workspace must be an existing directory/);
    const signIn = {
        ...editPublicDomain(snapshot.documents.environment, 'bot.example.com'),
        AIBINATOR_OAUTH_DATA_DIR: '.data/oauth-check',
    };
    await refuse({ environment: signIn }, /Set a sign-in password first/);
    assert.equal(await readFile('policy.json', 'utf8'), '{}\n', 'refused drafts write nothing');
}

async function checkRollback(): Promise<void> {
    const snapshot = await readPanel();
    const before = await readFile(snapshot.paths.operator, 'utf8').catch(() => '');
    const drafts = edited(snapshot, {
        operator: { mode: 'manual-mcp', instructions: 'Rolled back' },
        environment: { bad_key: 'x', AIBINATOR_PORT: 9000 },
    });
    await assert.rejects(applyDraft(snapshot, drafts, noReconnect), /Invalid environment key/);
    assert.equal(await readFile(snapshot.paths.operator, 'utf8'), before, 'files already written are put back');
    assert.doesNotMatch(await readFile('.env', 'utf8'), /9000/, 'the failing file is untouched');
}

function checkWorkBlocks(): void {
    const live = (controller: Record<string, unknown> | null, appliedConfigAt: string | null = 'rev') => ({
        aibi: aibiStatus(),
        operator: { mode: 'codex-local', appliedConfigAt, controller },
    });
    assert.equal(persistentWorkBlock(null, 'rev'), undefined, 'nothing running blocks nothing');
    assert.match(persistentWorkBlock(live({ busy: 1 }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ approvals: 2 }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ tasks: [{}, { state: 'queued' }] }), 'rev')!, /controller work/);
    assert.match(persistentWorkBlock(live({ queued: 1 }), 'rev')!, /delivery is pending/);
    assert.match(persistentWorkBlock(live({ pendingDelivery: 1 }), 'rev')!, /delivery is pending/);
    assert.match(persistentWorkBlock(live(null, 'old'), 'rev')!, /still pending application/);
    assert.equal(persistentWorkBlock(live({}, null), 'rev'), undefined);
    assert.equal(persistentWorkBlock(live({ tasks: [{ state: 'done' }] }), 'rev'), undefined);
}

async function checkStarting(live: LiveFake): Promise<void> {
    const snapshot = await readPanel();
    const start = (operator: Record<string, unknown>, enabled: boolean) =>
        startSaved({ ...snapshot, documents: edited(snapshot, { operator }) }, enabled);
    const codex = { mode: 'codex-local', workspace: resolve('.') };
    assert.match(await start({ mode: 'manual-mcp' }, true), /start your assistant in its MCP client/);
    await assert.rejects(start(codex, true), /Live status unavailable/, 'a local responder needs AiBinator running');
    live.online = true;
    assert.equal(await start(codex, true), 'Assistant started.');
    assert.deepEqual([(await readOperatorConfig()).mode, (await readOperatorConfig()).enabled], ['codex-local', true]);
    assert.match(await start(codex, false), /Local assistant paused/);
    assert.equal((await readOperatorConfig()).enabled, false);
    live.controller = { busy: 1 };
    await assert.rejects(start({ mode: 'manual-mcp' }, false), /still working/);
    live.controller = undefined;
    live.activeEventId = 'event';
    await assert.rejects(start(codex, true), /A local request is running/);
    live.activeEventId = undefined;
    live.online = false;
    assert.match(
        await start({ mode: 'manual-mcp' }, false),
        /Request saved. Waiting for AiBinator to respond./,
        'a stopped bridge applies later',
    );
}

async function checkMessages(live: LiveFake): Promise<void> {
    await writeFile('.env', `${environment.replace('not-a-port', '8789')}\nAIBINATOR_RESOURCE_URL=https://bot.example.com/mcp\n`);
    await rm(join('.data', 'operator-settings.json'), { force: true });
    await writeOperatorConfig({ ...(await readOperatorConfig()), mode: 'codex-local', enabled: false });
    await writeFile('policy.json', '{}\n');
    live.online = true;
    const save = async (patch: Parameters<typeof edited>[1], reconnect = noReconnect) => {
        const snapshot = await readPanel();
        return (await applyDraft(snapshot, edited(snapshot, patch), reconnect)).message;
    };
    assert.match(await save({ operator: { mode: 'manual-mcp' } }), /Another MCP app is now the primary responder/);
    assert.equal((await readOperatorConfig()).enabled, true, 'choosing a responder starts it');
    const aibi = (await readPanel()).documents.policy.aibi as Record<string, unknown>;
    assert.equal(await save({ policy: { aibi: { ...aibi, personality: 'Grumpy.' } } }), 'AIBI settings saved and applied.');
    const failed = await save({ operator: { instructions: 'Changed' } }, () =>
        Promise.resolve(() => Promise.reject(new Error('plain failure'))),
    );
    assert.match(failed, /^Saved, but plain failure/);
    const saveKey = async (key: string) => {
        const snapshot = await readPanel();
        const draft = edited(snapshot, { environment: { ...snapshot.documents.environment, GEMINI_API_KEY: key } });
        return applyDraft(snapshot, draft, noReconnect);
    };
    assert.match((await saveKey('gemini-one')).message, /applied them right away/, 'a running AiBinator confirms it applied .env');
    live.settingsError = 'port 9000 is taken';
    const refused = await saveKey('gemini-two');
    assert.equal(refused.warning, true);
    assert.match(
        refused.message,
        /^Saved, but AiBinator could not apply them \(port 9000 is taken\)/,
        'a failed apply is never shown as applied',
    );
    live.settingsError = undefined;
    live.online = false;
    assert.match(
        await save({ operator: { instructions: 'Later' } }),
        /takes over once AiBinator finishes/,
        'a stopped bridge applies later',
    );
}

export async function checkPanelStore(directory: string): Promise<void> {
    await inScratch(directory, async () => {
        const live = liveFake();
        await withLocal(live, async () => {
            await checkReading();
            await checkRefusals();
            await checkRollback();
            checkWorkBlocks();
            await checkStarting(live);
            await checkMessages(live);
        });
        await rm(join('.data', 'runtime.lock'), { force: true });
    });
}
