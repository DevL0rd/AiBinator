import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appHome, installRecordPath } from './operator/app-home.js';
import { applyUpdate, installApp, localShell, uninstallApp } from './operator/self-install.js';
import { allowPorts } from './aibi/ports.js';

const usage = `Usage: aibinator [command]

  (no command)        Open the settings app
  install             Install or reinstall AiBinator from this folder, with its background service
  update              Update the installed copy from GitHub and restart the service
  ports               Let AiBinator use ports 53, 80 and 443 for AIBI and open ufw for them (Linux; asks for your password)
  firmware <tool>     AIBI firmware tools: latest, decompile, patch, rebuild, toolchain (pass --help after a tool)
  uninstall [--purge] Remove AiBinator; --purge also deletes your settings
  help                Show this help
`;

function useInstalledCopy(): void {
    const home = appHome();
    if (resolve(process.cwd()) !== resolve(home) && existsSync(installRecordPath(home))) process.chdir(home);
    if (existsSync('.env')) process.loadEnvFile('.env');
}

const firmwareTools: Record<string, string> = {
    latest: 'find-latest-firmware.mjs',
    decompile: 'decompile-firmware.mjs',
    patch: 'patch-firmware.mjs',
    rebuild: 'rebuild-firmware.mjs',
    toolchain: 'setup-toolchain.mjs',
};

function firmware([tool = '', ...args]: string[]): void {
    const script = firmwareTools[tool];
    if (!script) throw new Error(`Choose a firmware tool: ${Object.keys(firmwareTools).join(', ')}`);
    useInstalledCopy();
    const root = process.cwd();
    mkdirSync(join(root, '.data'), { recursive: true, mode: 0o700 });
    const result = spawnSync(process.execPath, [join(root, 'tools', 'firmware', script), ...args], {
        cwd: join(root, '.data'),
        stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
}

async function main(args: string[]): Promise<void> {
    const [command, ...rest] = args;
    const print = (lines: string[] | string) => console.log([lines].flat().join('\n'));
    if (command === 'install') return print(await installApp(localShell(true)));
    if (command === 'update') return print(await applyUpdate(localShell(true)));
    if (command === 'ports') return print(await allowPorts(localShell(true)));
    if (command === 'firmware') return firmware(rest);
    if (command === 'uninstall') return print(await uninstallApp(localShell(true), rest.includes('--purge')));
    if (command === 'help' || command === '--help' || command === '-h') return print(usage);
    if (command) throw new Error(`Unknown command: ${command}\n\n${usage}`);
    useInstalledCopy();
    const { runSetup } = await import('./operator/setup-app.js');
    await runSetup();
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
