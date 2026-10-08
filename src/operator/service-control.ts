import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launchAgentLabel, launchAgentPath } from './mac-service.js';
import type { ServiceHost } from './install.js';

const unitPath = (home: string) => join(home, '.config/systemd/user/aibinator.service');
const macTarget = () => `gui/${process.getuid?.() ?? 0}/${launchAgentLabel}`;

export async function stopService({ platform, run }: ServiceHost, root: string): Promise<void> {
    if (platform === 'darwin') {
        await run('launchctl', ['bootout', macTarget()]).catch(() => undefined);
        return;
    }
    if (platform === 'win32') {
        const pid = Number(await readFile(join(root, '.data', 'service.pid'), 'utf8').catch(() => ''));
        if (pid) await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined);
        return;
    }
    await run('systemctl', ['--user', 'stop', 'aibinator.service']);
}

export async function unregisterService(host: ServiceHost, root: string): Promise<void> {
    await stopService(host, root);
    if (host.platform === 'darwin') {
        await rm(launchAgentPath(host.home), { force: true });
        return;
    }
    if (host.platform === 'win32') {
        await host
            .run('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'AiBinator', '/f'])
            .catch(() => undefined);
        return;
    }
    await host.run('systemctl', ['--user', 'disable', 'aibinator.service']).catch(() => undefined);
    await rm(unitPath(host.home), { force: true });
    await host.run('systemctl', ['--user', 'daemon-reload']);
}
