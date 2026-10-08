import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { installService, restartService, type ServiceHost } from '../src/operator/install.js';
import { launchAgent, launchAgentLabel, launchAgentPath } from '../src/operator/mac-service.js';
import { handlesScheme, macSchemeHandler, openUrl } from '../src/operator/open-url.js';
import { managedServiceStatus } from '../src/operator/service-status.js';
import { watchFile } from '../src/operator/file-watch.js';
import { failingRunner, fakeRunner, withEnv, type Call } from './host-fixture.js';

const target = `gui/${process.getuid?.() ?? 0}/${launchAgentLabel}`;
const commands = (calls: Call[]) =>
    calls.filter((call) => call.file !== process.execPath).map((call) => [call.file, ...call.args].join(' '));

function launchctl(running: () => boolean, onBootstrap = () => undefined as void) {
    return fakeRunner((call) => {
        if (call.file !== 'launchctl') return '';
        if (call.args[0] === 'bootstrap') onBootstrap();
        if (call.args[0] !== 'print') return '';
        if (!running()) throw new Error('Could not find service');
        return `${target} = {\n\tstate = running\n\tpid = 42\n}\n`;
    });
}

function checkAgentText(): void {
    const agent = launchAgent('/Users/a&b/<d>', '/opt/node', '/usr/bin:/opt/bin');
    assert.match(agent, /<key>Label<\/key><string>com\.github\.devl0rd\.aibinator<\/string>/);
    assert.match(agent, /<string>\/Users\/a&amp;b\/&lt;d&gt;\/dist\/src\/main\.js<\/string>/, 'paths are XML escaped');
    assert.match(agent, /<string>--env-file=\/Users\/a&amp;b\/&lt;d&gt;\/\.env<\/string>/);
    assert.match(agent, /<key>PATH<\/key><string>\/usr\/bin:\/opt\/bin<\/string>/);
    assert.match(agent, /<key>AIBINATOR_SERVICE<\/key><string>1<\/string>/);
    assert.match(agent, /<key>SuccessfulExit<\/key><false\/>/, 'restarts only after a failure, like Restart=on-failure');
    assert.match(agent, /<key>Umask<\/key><integer>63<\/integer>/, 'files stay private (0077)');
}

async function checkOpen(): Promise<void> {
    const fake = fakeRunner((call) => (call.file === 'osascript' && call.args.at(-1) === 'claude' ? '/Applications/Claude.app\n' : ''));
    await openUrl('https://example.test/a?b=1', 'darwin', fake.run);
    assert.equal(await handlesScheme('claude', 'darwin', fake.run), true);
    assert.equal(await handlesScheme('other', 'darwin', fake.run), false);
    assert.equal(await handlesScheme('claude', 'darwin', failingRunner), false);
    assert.deepEqual(
        fake.calls.map((call) => [call.file, ...call.args]),
        [
            ['open', 'https://example.test/a?b=1'],
            ['osascript', '-l', 'JavaScript', '-e', macSchemeHandler, 'claude'],
            ['osascript', '-l', 'JavaScript', '-e', macSchemeHandler, 'other'],
        ],
        'the scheme is passed as an argument, never spliced into the script',
    );
}

async function checkInstall(root: string): Promise<void> {
    const home = join(root, 'mac-home');
    const bins = [join(root, 'bin-a'), join(root, 'bin-b')];
    let running = false;
    const fake = launchctl(
        () => running,
        () => (running = true),
    );
    const mac: ServiceHost = { platform: 'darwin', home, run: fake.run };
    await withEnv({ PATH: [bins[0], join(root, 'node_modules', '.bin'), bins[1]].join(delimiter) }, async () =>
        assert.equal(await installService(mac), 'Service installed, enabled and running.'),
    );
    assert.deepEqual(commands(fake.calls), [
        `launchctl enable ${target}`,
        `launchctl print ${target}`,
        `launchctl print ${target}`,
        `launchctl bootstrap gui/${process.getuid?.() ?? 0} ${launchAgentPath(home)}`,
        `launchctl print ${target}`,
    ]);
    assert.equal(await readFile(launchAgentPath(home), 'utf8'), launchAgent(process.cwd(), process.execPath, bins.join(delimiter)));
    assert.deepEqual(await managedServiceStatus('darwin', fake.run, home), { available: true, installed: true, active: true });

    assert.match(await installService(mac), /existing managed runtime left running/, 'a running agent is not started twice');
    assert.match(await restartService(mac), /Service restarted/);
    assert.ok(commands(fake.calls).includes(`launchctl kickstart -k ${target}`));

    running = false;
    await assert.rejects(restartService(mac), /No active managed service/);
    assert.deepEqual(await managedServiceStatus('darwin', fake.run, home), { available: true, installed: true, active: false });
    await rm(launchAgentPath(home));
    assert.deepEqual(await managedServiceStatus('darwin', failingRunner, home), { available: true, installed: false, active: false });
}

async function checkPolledWatch(root: string): Promise<void> {
    const file = join(root, 'watched.json');
    writeFileSync(file, '1');
    for (const platform of ['darwin', 'linux'] as const) {
        let changes = 0;
        const stop = watchFile(file, () => changes++, 50, platform);
        await new Promise((done) => setTimeout(done, 700));
        changes = 0;
        writeFileSync(`${file}.tmp`, `${platform}-changed`);
        renameSync(`${file}.tmp`, file);
        await new Promise((done) => setTimeout(done, 1200));
        stop();
        assert.equal(changes, 1, `${platform}: an atomic replace is reported exactly once`);
    }
}

export async function checkMacHost(root: string): Promise<void> {
    checkAgentText();
    await checkOpen();
    await checkInstall(root);
    await checkPolledWatch(root);
}
