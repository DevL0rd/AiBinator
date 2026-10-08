import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, readFile, rm } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { policySchema } from '../src/core/config.js';
import { installService, restartService, serviceUnit, type ServiceHost } from '../src/operator/install.js';
import { handlesScheme, openUrl } from '../src/operator/open-url.js';
import { managedServiceStatus } from '../src/operator/service-status.js';
import { launcherScript, supervisorPidFile, windowsServiceInstalled } from '../src/operator/windows-service.js';
import { fakeConfig } from './fixtures.js';
import { checkMacHost } from './check-mac-host.js';
import { failingRunner, fakeRunner, freePort, inDirectory, listen, withEnv, writeFiles, type Call } from './host-fixture.js';

const tsc = (call: Call) => call.file === process.execPath && call.args[0] === 'node_modules/typescript/bin/tsc';
const systemctl = (state: string) => (call: Call) => (call.args.includes('show') ? `LoadState=loaded\nActiveState=${state}\n` : '');
const commands = (calls: Call[]) => calls.filter((call) => !tsc(call)).map((call) => [call.file, ...call.args].join(' '));

function checkUnitText(): void {
    const unit = serviceUnit('/srv/a"b%c\\d', '/usr/bin/node', '/usr/bin');
    assert.match(unit, /^WorkingDirectory=\/srv\/a"b%c\\d$/m, 'the working directory is written as is');
    assert.match(unit, /^Environment="PATH=\/usr\/bin"$/m, 'PATH is quoted');
    assert.match(
        unit,
        /^ExecStart="\/usr\/bin\/node" --env-file=".*a\\"b%%c\\\\d.*\.env" ".*main\.js"$/m,
        'quotes, percents and backslashes are escaped',
    );
    assert.match(unit, /^Environment=AIBINATOR_SERVICE=1$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.throws(() => serviceUnit('/srv/a\nb', '/usr/bin/node', '/usr/bin'), /cannot contain line breaks/);
    assert.throws(() => serviceUnit('/srv', '/usr/bin/node', '/usr/bin\r'), /cannot contain line breaks/);
}

async function prepareRoot(root: string): Promise<void> {
    const policy = policySchema.parse({ ownerName: 'Owner', aibi: { personality: 'Cheerful' } });
    await writeFiles(root, {
        'policy.json': JSON.stringify(policy),
        '.env': [
            'AIBINATOR_AUTH_MODE=bearer',
            `AIBINATOR_MCP_TOKEN=${fakeConfig().AIBINATOR_MCP_TOKEN}`,
            'AIBINATOR_POLICY_FILE=policy.json',
            'AIBINATOR_RESOURCE_URL=',
            'AIBINATOR_OAUTH_ISSUER=',
            'AIBINATOR_OAUTH_JWKS_URL=',
            '',
        ].join('\n'),
    });
}

async function checkLinuxInstall(root: string): Promise<void> {
    const home = join(root, 'home');
    const bins = [join(root, 'bin-a'), join(root, 'bin-b')];
    const path = [bins[0], join(root, 'node_modules', '.bin'), bins[0], '', bins[1]].join(delimiter);
    const fake = fakeRunner(systemctl('inactive'));
    const linux: ServiceHost = { platform: 'linux', home, run: fake.run };
    await withEnv({ PATH: path }, async () => assert.equal(await installService(linux), 'Service installed, enabled and running.'));
    assert.ok(fake.calls.some(tsc), 'the install builds AiBinator first');
    assert.deepEqual(commands(fake.calls), [
        'systemctl --user daemon-reload',
        'systemctl --user enable aibinator.service',
        'systemctl --user show aibinator.service --property=LoadState --property=ActiveState',
        'systemctl --user start aibinator.service',
        'systemctl --user is-active --quiet aibinator.service',
    ]);
    const unit = await readFile(join(home, '.config', 'systemd', 'user', 'aibinator.service'), 'utf8');
    assert.equal(
        unit,
        serviceUnit(process.cwd(), process.execPath, bins.join(delimiter)),
        'node_modules and duplicate PATH entries are dropped',
    );
    await access(join('.data', 'operator.json'));

    const active = fakeRunner(systemctl('active'));
    assert.match(await installService({ ...linux, run: active.run }), /existing managed runtime left running/);
    assert.ok(!commands(active.calls).some((command) => command.includes(' start ')), 'an active service is not started twice');

    const { server, port } = await listen();
    try {
        const listening = fakeRunner(systemctl('inactive'));
        await withEnv({ AIBINATOR_PORT: String(port) }, async () =>
            assert.match(await installService({ ...linux, run: listening.run }), /NOT started: existing manual runtime or listener/),
        );
    } finally {
        await new Promise((done) => server.close(done));
    }
    await assert.rejects(installService({ ...linux, platform: 'freebsd' }), /supports Linux \(systemd\), macOS \(launchd\) and Windows/);
}

async function checkLinuxRestart(): Promise<void> {
    const active = fakeRunner(systemctl('active'));
    assert.match(await restartService({ platform: 'linux', home: '', run: active.run }), /Service restarted/);
    assert.deepEqual(commands(active.calls).slice(1), [
        'systemctl --user restart aibinator.service',
        'systemctl --user is-active --quiet aibinator.service',
    ]);
    const stopped = fakeRunner(systemctl('inactive'));
    await assert.rejects(restartService({ platform: 'linux', home: '', run: stopped.run }), /No active managed service/);
    await assert.rejects(restartService({ platform: 'linux', home: '', run: failingRunner }), /No active managed service/);
    assert.deepEqual(await managedServiceStatus('linux', failingRunner), { available: false, installed: false, active: false });
    assert.deepEqual(await managedServiceStatus('linux', fakeRunner(() => 'LoadState=not-found\nActiveState=inactive').run), {
        available: true,
        installed: false,
        active: false,
    });
}

function windowsRunner(pid: number) {
    return fakeRunner((call) => {
        if (call.file === 'wscript.exe') setTimeout(() => writeFileSync(supervisorPidFile, String(pid)), 100);
        return '';
    });
}

async function checkWindowsInstall(): Promise<void> {
    const fake = windowsRunner(process.pid);
    const windows: ServiceHost = { platform: 'win32', home: '', run: fake.run };
    await rm(supervisorPidFile, { force: true });
    assert.equal(await installService(windows), 'Service installed, enabled and running.');
    const launcher = join(process.cwd(), '.data', 'service-launch.js');
    assert.equal(await readFile(launcher, 'utf8'), launcherScript(process.cwd(), process.execPath));
    assert.deepEqual(commands(fake.calls), [
        `reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v AiBinator /t REG_SZ /d wscript.exe //B //Nologo "${launcher}" /f`,
        'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v AiBinator',
        `wscript.exe //B //Nologo ${launcher}`,
    ]);
    assert.match(await installService(windows), /existing managed runtime left running/, 'a running supervisor is left alone');
    assert.match(await restartService(windows), /Restart requested/);
    await access(join('.data', 'service-restart'));

    await rm(supervisorPidFile, { force: true });
    await assert.rejects(installService({ ...windows, run: windowsRunner(2_147_483_646).run }), /did not start/);
    await rm(supervisorPidFile, { force: true });
    await assert.rejects(restartService(windows), /No active managed service/);
    assert.equal(await windowsServiceInstalled(failingRunner), false);
    assert.deepEqual(await managedServiceStatus('win32', failingRunner), { available: true, installed: false, active: false });
}

async function checkOpenUrl(): Promise<void> {
    const fake = fakeRunner((call) => (call.file === 'xdg-mime' && call.args[2] === 'x-scheme-handler/claude' ? 'claude.desktop\n' : ''));
    await openUrl('https://example.test/a?b=1', 'win32', fake.run);
    await openUrl('https://example.test/a?b=1', 'linux', fake.run);
    assert.equal(await handlesScheme('claude', 'win32', fake.run), true);
    assert.equal(await handlesScheme('claude', 'linux', fake.run), true);
    assert.equal(await handlesScheme('other', 'linux', fake.run), false);
    assert.equal(await handlesScheme('claude', 'win32', failingRunner), false);
    assert.equal(await handlesScheme('claude', 'linux', failingRunner), false);
    assert.deepEqual(commands(fake.calls), [
        'rundll32 url.dll,FileProtocolHandler https://example.test/a?b=1',
        'xdg-open https://example.test/a?b=1',
        'reg query HKCR\\claude /v URL Protocol',
        'xdg-mime query default x-scheme-handler/claude',
        'xdg-mime query default x-scheme-handler/other',
    ]);
}

export async function checkServiceHost(directory: string): Promise<void> {
    checkUnitText();
    await checkOpenUrl();
    const root = resolve(directory, 'service-host');
    const port = await freePort();
    await withEnv({ AIBINATOR_PORT: String(port) }, () =>
        inDirectory(root, async () => {
            await prepareRoot(root);
            await checkLinuxInstall(root);
            await checkLinuxRestart();
            await checkWindowsInstall();
            await checkMacHost(root);
        }),
    );
}
