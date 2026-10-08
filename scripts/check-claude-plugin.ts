import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installPlugin, pluginState, uninstallPlugin } from '../src/operator/claude-plugin.js';
import { failingRunner, fakeRunner, withEnv, writeFiles, type Call } from './host-fixture.js';

const pluginId = 'aibinator@aibinator-local';

interface Claude {
    marketplace: boolean;
    installed: boolean;
    enabled: boolean;
    sticky: boolean;
}

function claudeCli(state: Claude) {
    const actions: Record<string, () => void> = {
        'marketplace add': () => (state.marketplace = true),
        install: () => Object.assign(state, { installed: !state.sticky, enabled: !state.sticky }),
        enable: () => (state.enabled = true),
        uninstall: () => (state.installed = state.sticky),
    };
    return fakeRunner((call: Call) => {
        const verb = call.args.slice(1, call.args[1] === 'marketplace' ? 3 : 2).join(' ');
        if (verb === 'marketplace list') return `${JSON.stringify(state.marketplace ? [{ name: 'aibinator-local' }] : [], null, 2)}\n`;
        if (verb === 'list')
            return `Checking plugins…\n${JSON.stringify(state.installed ? [{ id: pluginId, enabled: state.enabled }, { id: 'other@x' }] : [])}\n`;
        actions[verb]?.();
        return '';
    });
}

const verbs = (calls: Call[]) =>
    calls.filter((call) => call.args[0] === 'plugin' && !call.args.includes('--json')).map((call) => call.args.join(' '));

async function checkInstall(home: string): Promise<void> {
    const root = join(home, '.data', 'claude-plugin');
    const state: Claude = { marketplace: false, installed: false, enabled: false, sticky: false };
    const first = claudeCli(state);
    assert.match(await installPlugin(home, first.run), /plugin installed in Claude Code/);
    assert.deepEqual(verbs(first.calls), [`plugin marketplace add ${root} --scope user`, `plugin install ${pluginId} --scope user`]);
    assert.ok(first.calls.filter((call) => call.args.includes('--json')).length >= 4, 'state is read through the JSON CLI');
    const server = JSON.parse(await readFile(join(root, 'aibinator', '.mcp.json'), 'utf8')) as {
        mcpServers: { aibinator: { command: string; args: string[]; env: Record<string, string> } };
    };
    assert.deepEqual(server.mcpServers.aibinator, {
        command: process.execPath,
        args: [join(home, 'dist/src/channel/bridge.js')],
        env: { AIBINATOR_HOME: home },
    });
    const market = JSON.parse(await readFile(join(root, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
        plugins: { source: string }[];
    };
    assert.deepEqual(
        market.plugins.map((item) => item.source),
        ['./aibinator'],
    );

    state.enabled = false;
    const again = claudeCli(state);
    await installPlugin(home, again.run);
    assert.deepEqual(verbs(again.calls), [`plugin enable ${pluginId}`], 'unchanged files only re-enable the plugin');

    await writeFile(join(root, 'aibinator', '.claude-plugin', 'plugin.json'), '{}\n');
    const changed = claudeCli(state);
    await installPlugin(home, changed.run);
    assert.deepEqual(verbs(changed.calls), ['plugin marketplace update aibinator-local', `plugin update ${pluginId}`]);
}

async function checkFailures(home: string): Promise<void> {
    assert.deepEqual(await pluginState(failingRunner), { cli: false, marketplace: false, installed: false, enabled: false });
    await assert.rejects(
        installPlugin(
            home,
            fakeRunner((call) => {
                if (call.args[0] === 'plugin') throw new Error('claude: command failed');
                return '';
            }).run,
        ),
        /Claude Code is not installed or not signed in/,
    );
    const sticky: Claude = { marketplace: true, installed: false, enabled: false, sticky: true };
    await assert.rejects(installPlugin(home, claudeCli(sticky).run), /did not report the AiBinator plugin/);
    await assert.rejects(installPlugin(join(home, 'missing'), claudeCli(sticky).run));
}

async function checkUninstall(): Promise<void> {
    const state: Claude = { marketplace: true, installed: true, enabled: true, sticky: false };
    const cli = claudeCli(state);
    assert.deepEqual(await pluginState(cli.run), { cli: true, marketplace: true, installed: true, enabled: true });
    assert.equal(await uninstallPlugin(cli.run), 'AiBinator removed from Claude Code.');
    assert.deepEqual(verbs(cli.calls), [`plugin uninstall ${pluginId}`]);
    const absent = claudeCli(state);
    await uninstallPlugin(absent.run);
    assert.deepEqual(verbs(absent.calls), [], 'nothing is removed when the plugin is absent');
    const stuck = claudeCli({ marketplace: true, installed: true, enabled: true, sticky: true });
    await assert.rejects(uninstallPlugin(stuck.run), /still lists the AiBinator plugin/);
}

export async function checkClaudePlugin(directory: string): Promise<void> {
    const home = resolve(directory, 'plugin-home');
    await writeFiles(home, { 'dist/src/channel/bridge.js': '', 'bin/claude': '', 'bin/claude.exe': '' });
    await withEnv({ PATH: join(home, 'bin') }, async () => {
        await checkInstall(home);
        await checkFailures(home);
        await checkUninstall();
    });
}
