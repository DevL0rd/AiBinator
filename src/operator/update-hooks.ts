import { access, readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import type { Runner } from './run.js';

const updaterDirectory = '/usr/lib/aibinator';
const updaterPath = `${updaterDirectory}/aibinator-update`;
const ownerPath = `${updaterDirectory}/owner`;
const managers = ['pacman', 'dnf', 'zypper', 'apt-get'] as const;
type Manager = (typeof managers)[number];

const hookTargets: Record<Manager, { path: string; mode: string }> = {
    pacman: { path: '/usr/share/libalpm/hooks/aibinator-update.hook', mode: '644' },
    dnf: { path: '/etc/dnf/libdnf5-plugins/actions.d/aibinator-update.actions', mode: '644' },
    zypper: { path: '/usr/lib/zypp/plugins/commit/aibinator-update', mode: '755' },
    'apt-get': { path: '/etc/apt/apt.conf.d/99aibinator-update', mode: '644' },
};

export function updaterScript(): string {
    return `#!/bin/sh
exec 1>&2
state=${ownerPath}
[ -r "$state" ] || exit 0
owner=$(sed -n 1p "$state")
app=$(sed -n 2p "$state")
node=$(sed -n 3p "$state")
uid=$(id -u "$owner" 2>/dev/null) || exit 0
home=$(getent passwd "$owner" | cut -d: -f6)
if [ ! -f "$app/dist/src/cli.js" ]; then
    echo "aibinator: $app is gone, skipping the update"
    exit 0
fi
cd "$app" || exit 0
runuser -u "$owner" -- env -i HOME="$home" USER="$owner" LOGNAME="$owner" \\
    PATH="$home/.local/bin:/usr/local/bin:/usr/bin:/bin" LANG="\${LANG:-C.UTF-8}" \\
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \\
    "$node" dist/src/cli.js update || echo "aibinator: the update did not finish, see above"
exit 0
`;
}

export function hookFile(manager: Manager, networkAccess = false): string {
    if (manager === 'dnf') return `post_transaction:::enabled=host-only raise_error=0:${updaterPath}\n`;
    if (manager === 'apt-get') return `DPkg::Post-Invoke { "if [ -x ${updaterPath} ]; then ${updaterPath} || true; fi"; };\n`;
    if (manager === 'zypper')
        return `#!/bin/bash
exec 3>&1 1>&2
while IFS= read -r -d '' frame; do
    command=\${frame%%$'\\n'*}
    if [[ $command == COMMITEND && -x ${updaterPath} ]]; then
        systemd-run --no-block --collect --unit=aibinator-update ${updaterPath}
    fi
    printf 'ACK\\n\\n\\0' >&3
    [[ $command == _DISCONNECT ]] && exit 0
done
`;
    return `[Trigger]
Operation = Install
Operation = Upgrade
Type = Package
Target = *

[Action]
Description = Updating AiBinator...
When = PostTransaction
Exec = ${updaterPath}
Depends = git
${networkAccess ? 'NetworkAccess = allowed\n' : ''}`;
}

async function packageManager(run: Runner): Promise<Manager | undefined> {
    for (const manager of managers)
        if (
            await run('sh', ['-c', `command -v ${manager}`]).then(
                () => true,
                () => false,
            )
        )
            return manager;
    return undefined;
}

async function pacmanSandboxed(): Promise<boolean> {
    const libraries = (await readdir('/usr/lib').catch(() => [])).filter((name) => name.startsWith('libalpm.so'));
    for (const library of libraries) if ((await readFile(`/usr/lib/${library}`, 'latin1')).includes('NetworkAccess')) return true;
    return false;
}

export interface Elevated {
    sudo(args: string[], input?: string): Promise<void>;
}

export async function registerUpdateHook(run: Runner, elevated: Elevated, root: string, node: string): Promise<string> {
    const manager = await packageManager(run);
    if (!manager)
        return 'No supported package manager (pacman, dnf, zypper or apt) was found, so system updates do not update AiBinator. Update it from the Home page.';
    const target = hookTargets[manager];
    const write = async (path: string, mode: string, text: string) => {
        await elevated.sudo(['install', '-d', '-m755', dirname(path)]);
        await elevated.sudo(['tee', path], text);
        await elevated.sudo(['chmod', mode, path]);
    };
    await write(updaterPath, '755', updaterScript());
    await write(ownerPath, '644', `${userInfo().username}\n${root}\n${node}\n`);
    await write(target.path, target.mode, hookFile(manager, manager === 'pacman' && (await pacmanSandboxed())));
    return `System updates with ${manager} now update AiBinator.`;
}

async function updateHookInstalled(): Promise<boolean> {
    return access(updaterPath).then(
        () => true,
        () => false,
    );
}

export async function removeUpdateHook(elevated: Elevated): Promise<void> {
    if (!(await updateHookInstalled())) return;
    await elevated.sudo(['rm', '-rf', updaterDirectory, ...Object.values(hookTargets).map((target) => target.path)]);
}
