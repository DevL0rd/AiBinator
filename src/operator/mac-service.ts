import { access, mkdir, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { runFile, type Runner } from './run.js';

const join = (...parts: string[]) => posix.join(...parts);

export const launchAgentLabel = 'com.github.devl0rd.aibinator';
export const launchAgentPath = (home: string) => join(home, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;
const target = () => `${domain()}/${launchAgentLabel}`;

const xml = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const string = (value: string) => `<string>${xml(value)}</string>`;

export function launchAgent(root: string, node: string, path: string): string {
    const log = join(root, '.data', 'service.log');
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `    <key>Label</key>${string(launchAgentLabel)}`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...[node, `--env-file=${join(root, '.env')}`, join(root, 'dist', 'src', 'main.js')].map((arg) => `        ${string(arg)}`),
        '    </array>',
        `    <key>WorkingDirectory</key>${string(root)}`,
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        `        <key>PATH</key>${string(path)}`,
        `        <key>AIBINATOR_SERVICE</key>${string('1')}`,
        '    </dict>',
        '    <key>RunAtLoad</key><true/>',
        '    <key>KeepAlive</key>',
        '    <dict><key>SuccessfulExit</key><false/></dict>',
        '    <key>ThrottleInterval</key><integer>5</integer>',
        '    <key>ExitTimeOut</key><integer>30</integer>',
        '    <key>Umask</key><integer>63</integer>',
        `    <key>StandardOutPath</key>${string(log)}`,
        `    <key>StandardErrorPath</key>${string(log)}`,
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}

export async function installMacService(root: string, home: string, node: string, path: string, run: Runner = runFile): Promise<void> {
    await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(launchAgentPath(home), launchAgent(root, node, path), { mode: 0o644 });
    await run('launchctl', ['enable', target()]);
}

const loaded = (run: Runner) =>
    run('launchctl', ['print', target()], { timeout: 2000 }).then(
        (result) => result.stdout,
        () => undefined,
    );

async function ensureRunning(run: Runner): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (/^\s*state = running$/m.test((await loaded(run)) ?? '')) return;
        await new Promise((done) => setTimeout(done, 250));
    }
    throw new Error('The AiBinator service did not start. See .data/service.log.');
}

export async function startMacService(home: string, run: Runner = runFile): Promise<void> {
    if ((await loaded(run)) === undefined) await run('launchctl', ['bootstrap', domain(), launchAgentPath(home)]);
    else await run('launchctl', ['kickstart', target()]);
    await ensureRunning(run);
}

export async function restartMacService(run: Runner = runFile): Promise<void> {
    await run('launchctl', ['kickstart', '-k', target()]);
    await ensureRunning(run);
}

export async function macServiceStatus(
    home: string,
    run: Runner = runFile,
): Promise<{ available: boolean; installed: boolean; active: boolean }> {
    const installed = await access(launchAgentPath(home)).then(
        () => true,
        () => false,
    );
    const state = await loaded(run);
    return { available: true, installed, active: installed && /^\s*state = running$/m.test(state ?? '') };
}
