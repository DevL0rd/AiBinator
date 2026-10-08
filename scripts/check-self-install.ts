import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appHome, installRecord, launcherScript } from '../src/operator/app-home.js';
import {
    applyUpdate,
    checkForUpdate,
    httpsRemote,
    installApp,
    uninstallApp,
    updateBlocker,
    type Shell,
} from '../src/operator/self-install.js';
import { hookFile, updaterScript } from '../src/operator/update-hooks.js';
import type { ServiceHost } from '../src/operator/install.js';
import { policySchema } from '../src/core/config.js';
import { lowPortsAllowed, portsFile } from '../src/aibi/ports.js';
import { fakeConfig } from './fixtures.js';
import { fakeRunner, inDirectory, withEnv, writeFiles } from './host-fixture.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const present = (path: string) =>
    access(path).then(
        () => true,
        () => false,
    );

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkPaths(): void {
    assert.equal(appHome('linux', {}, '/home/a'), '/home/a/.local/share/aibinator');
    assert.equal(appHome('linux', { XDG_DATA_HOME: '/data' }, '/home/a'), '/data/aibinator');
    assert.equal(appHome('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/AiBinator');
    assert.equal(
        appHome('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'),
        'C:\\Users\\a\\AppData\\Local\\AiBinator',
    );
    assert.throws(() => appHome('win32', {}, 'C:\\Users\\a'), /LOCALAPPDATA is not set/);
    assert.equal(
        launcherScript('linux', "/x/it's", '/usr/bin/node').text,
        `#!/bin/sh\ncd '/x/it'\\''s' || exit 1\nexec '/usr/bin/node' dist/src/cli.js "$@"\n`,
    );
    assert.match(
        launcherScript('win32', 'C:\\D', 'C:\\node.exe').text,
        /^@echo off\r\nsetlocal\r\ncd \/d "C:\\D"[\s\S]*dist\\src\\cli\.js %\*/,
    );
    assert.equal(httpsRemote('git@github.com:DevL0rd/AiBinator.git'), 'https://github.com/DevL0rd/AiBinator.git');
    assert.equal(httpsRemote('ssh://git@github.com/a/b.git'), 'https://github.com/a/b.git');
    assert.match(hookFile('pacman', true), /Exec = \/usr\/lib\/aibinator\/aibinator-update\nDepends = git\nNetworkAccess = allowed/);
    assert.doesNotMatch(hookFile('pacman'), /NetworkAccess/);
    assert.match(hookFile('apt-get'), /DPkg::Post-Invoke/);
    assert.match(
        updaterScript(),
        /runuser -u "\$owner"[\s\S]*dist\/src\/cli\.js update[\s\S]*exit 0\n$/,
        'a failed update never fails the system update',
    );
}

async function prepareSource(root: string): Promise<{ source: string; origin: string }> {
    const origin = join(root, 'origin.git');
    const source = join(root, 'source');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
    const policy = policySchema.parse({ ownerName: 'Owner', aibi: { personality: 'Cheerful' } });
    await writeFiles(source, {
        '.gitignore': '.env\npolicy.json\n.data/\nnode_modules/\ndist/\n',
        'README.md': 'one\n',
        'policy.json': JSON.stringify(policy),
        '.env': `AIBINATOR_AUTH_MODE=bearer\nAIBINATOR_MCP_TOKEN=${fakeConfig().AIBINATOR_MCP_TOKEN}\nAIBINATOR_POLICY_FILE=policy.json\n`,
    });
    await writeFiles(source, { '.data/aibi/memory.json': '[]' });
    for (const args of [
        ['add', '.'],
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'one'],
        ['remote', 'add', 'origin', origin],
        ['push', '--quiet', '-u', 'origin', 'main'],
    ])
        git(source, ...args);
    return { source, origin };
}

function fakeShell(npm: string[][], sudo: string[][]): Shell {
    return {
        interactive: true,
        git: (cwd, args) => Promise.resolve(git(cwd, ...args)),
        npm: (_cwd, args) => Promise.resolve(void npm.push(args)),
        sudo: (args) => Promise.resolve(void sudo.push(args)),
    };
}

async function pushUpstream(root: string, origin: string): Promise<string> {
    const other = join(root, 'other');
    execFileSync('git', ['clone', '--quiet', origin, other]);
    await writeFile(join(other, 'README.md'), 'two\n');
    git(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-am', 'two');
    git(other, 'push', '--quiet');
    return git(other, 'rev-parse', '--short', 'HEAD');
}

async function checkInstallUpdateUninstall(root: string): Promise<void> {
    const { source, origin } = await prepareSource(root);
    const target = join(root, 'app');
    const home = join(root, 'home');
    const npm: string[][] = [];
    const sudo: string[][] = [];
    const shell = fakeShell(npm, sudo);
    const fake = fakeRunner((call) => (call.args.includes('show') ? 'LoadState=loaded\nActiveState=inactive\n' : ''));
    const host: ServiceHost = { platform: 'linux', home, run: fake.run };
    await withEnv({ AIBINATOR_APP_HOME: target }, () =>
        inDirectory(source, async () => {
            const notes = await installApp(shell, host);
            assert.match(notes[0]!, /installed in .*app\. Run aibinator/);
            assert.ok(
                notes.some((note) => /settings were copied/.test(note)),
                'the settings move with the install',
            );
            assert.equal(process.cwd(), target, 'the settings app keeps working on the installed copy');
            assert.equal(
                git(target, 'rev-parse', 'HEAD'),
                git(source, 'rev-parse', 'HEAD'),
                'the installed copy runs the checked out commit',
            );
            assert.equal(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main', 'it follows the GitHub branch');
            assert.equal(await readFile(join(target, '.env'), 'utf8'), await readFile(join(source, '.env'), 'utf8'));
            assert.ok(await present(join(target, '.data', 'aibi', 'memory.json')), 'AIBI’s memory moves with the install');
            assert.deepEqual(npm, [['ci', '--no-audit', '--no-fund']]);
            const unit = await readFile(join(home, '.config/systemd/user/aibinator.service'), 'utf8');
            assert.match(unit, new RegExp(`^WorkingDirectory=${literal(target)}$`, 'm'), 'the service runs from the installed copy');
            assert.match(await readFile(join(home, '.local/bin/aibinator'), 'utf8'), new RegExp(`cd '${literal(target)}'`));
            assert.ok(
                sudo.some((args) => args.join(' ') === 'tee /usr/share/libalpm/hooks/aibinator-update.hook'),
                'system updates are hooked',
            );
            assert.equal(
                sudo.some((args) => args.join(' ') === `tee ${portsFile}`),
                !(await lowPortsAllowed(53)),
                'AIBI’s low ports are allowed when the computer does not allow them yet',
            );
            assert.equal((await installRecord(target))?.branch, 'main');
            const latest = await pushUpstream(root, origin);
            const state = await checkForUpdate(shell, target);
            assert.equal(state.behind, 1, 'a new commit on GitHub is an update');
            assert.equal(updateBlocker(state), undefined);
            assert.match(await applyUpdate(shell, host), new RegExp(`Updated AiBinator from \\w+ to ${latest}\\.$`));
            assert.deepEqual(npm.at(-1), ['run', 'build'], 'an update rebuilds');
            assert.equal(npm.filter((args) => args[0] === 'ci').length, 1, 'dependencies are only reinstalled when they change');
            assert.match(await applyUpdate(shell, host), /is up to date/);
            process.chdir(root);
            await rm(source, { recursive: true, force: true });
            assert.equal((await checkForUpdate(shell, target)).behind, 0, 'deleting the repo does not break the install or its updates');
            await writeFile(join(target, 'README.md'), 'edited\n');
            assert.match(updateBlocker(await checkForUpdate(shell, target)) ?? '', /local changes/);
            const removed = await uninstallApp(shell, false, host);
            assert.match(removed.join(' '), /settings stay in/);
            assert.deepEqual((await readdir(target)).sort(), ['.data', '.env', 'policy.json'], 'only your settings are kept');
            assert.ok(!(await present(join(home, '.local/bin/aibinator'))), 'the command is removed');
            assert.ok(!(await present(join(home, '.config/systemd/user/aibinator.service'))), 'the service is removed');
            await uninstallApp(shell, true, host);
            assert.ok(!(await present(target)), '--purge deletes everything');
        }),
    );
}

export async function checkSelfInstall(directory: string): Promise<void> {
    checkPaths();
    await checkInstallUpdateUninstall(resolve(directory, 'self-install'));
}
