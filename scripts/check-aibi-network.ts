import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DnsServer, localAnswer, question } from '../src/aibi/dns.js';
import { closeFirewall, firewallOpen, openFirewall } from '../src/aibi/firewall.js';
import { firmwareUrls, olderVersionRequest, patchedOffer, rewriteOffer, type Patched } from '../src/aibi/firmware.js';
import { sharedConversation } from '../src/operator/discordinator.js';

function query(name: string, id = 0x1234): Buffer {
    const labels = name.split('.').flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
    const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

function ask(port: number, message: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const timer = setTimeout(() => (socket.close(), reject(new Error('no DNS answer'))), 3000);
        socket.once('message', (answer) => {
            clearTimeout(timer);
            socket.close();
            resolve(answer);
        });
        socket.send(message, port, '127.0.0.1');
    });
}

async function checkDns(): Promise<void> {
    assert.equal(question(query('api.aibipocket.com'))?.name, 'api.aibipocket.com');
    const answer = localAnswer(query('API.aibipocket.com'), '192.168.1.20')!;
    assert.deepEqual([...answer.subarray(-4)], [192, 168, 1, 20], 'AIBI’s cloud name points at this computer');
    assert.equal(localAnswer(query('example.com'), '192.168.1.20'), undefined);
    const upstream = dgram.createSocket('udp4');
    upstream.on('message', (message, remote) =>
        upstream.send(Buffer.concat([message.subarray(0, 2), Buffer.from('forwarded')]), remote.port, remote.address),
    );
    await new Promise<void>((resolve) => upstream.bind(0, '127.0.0.1', resolve));
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    const answered: string[] = [];
    const server = new DnsServer(
        { address: '127.0.0.1', port, upstream: `127.0.0.1:${upstream.address().port}` },
        { answered: (remote) => answered.push(remote), warning: () => undefined },
    );
    await server.start();
    try {
        const local = await ask(port, query('api.aibipocket.com'));
        assert.deepEqual([...local.subarray(-4)], [127, 0, 0, 1]);
        assert.deepEqual(answered, ['127.0.0.1'], 'the first answer to AIBI is reported');
        const other = await ask(port, query('example.com', 0x4321));
        assert.equal(other.subarray(2).toString(), 'forwarded', 'other names go to the upstream server');
    } finally {
        await server.stop();
        upstream.close();
    }
}

function checkFirmware(): void {
    assert.equal(
        olderVersionRequest('GET /aibi/ota/version?type=1&version_num=9&current_name=1.6.0 HTTP/1.1'),
        'GET /aibi/ota/version?type=1&version_num=8&current_name=1.5.0 HTTP/1.1',
    );
    assert.equal(olderVersionRequest('GET /time HTTP/1.1'), undefined);
    const offer = {
        updates: { host: 'res-us-east-1.living.ai', firmware: '/aibi/version/public/9/1.6.0.zip', md5: 'x' },
        link: 'https://res.example/ota/1.6.0.zip',
    };
    assert.deepEqual(firmwareUrls(offer), ['https://res.example/ota/1.6.0.zip']);
    assert.match(String(rewriteOffer(offer).link), /^http:\/\/api\.aibipocket\.com\/ota-blocked\//);
    const patched: Patched = {
        file: 'p.zip',
        name: '1.6.0-patched.zip',
        urlPath: '/aibi/version/public/9/1.6.0-patched.zip',
        versionNum: '9',
        versionName: '1.6.0',
        responseTag: 'otares',
        md5: 'abc',
        bytes: Buffer.alloc(0),
    };
    const replaced = rewriteOffer(offer, patched) as { updates: Record<string, string>; link: string; 'version-num': string };
    assert.deepEqual(replaced.updates, { host: 'api.aibipocket.com', firmware: patched.urlPath, md5: 'abc' });
    assert.equal(replaced['version-num'], '9');
    assert.equal(patchedOffer(patched).responsetag, 'otares');
}

async function discordinator(directory: string, files: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(directory, 'discordinator-'));
    await mkdir(join(root, '.data'));
    for (const [name, value] of Object.entries(files)) await writeFile(join(root, '.data', name), JSON.stringify(value));
    return root;
}

async function checkSharing(directory: string): Promise<void> {
    const missing = await sharedConversation('claude-session', join(directory, 'nowhere'));
    assert.match(missing.state === 'unavailable' ? missing.reason : '', /not set up/);
    const session = '88073862-4d48-4c17-8ffb-1ae5e9ce9454';
    const claude = await discordinator(directory, {
        'operator-settings.json': { mode: 'claude-session', backgroundOnly: false },
        'claude-session.json': { sessionId: session, workspace: '/home/owner' },
    });
    assert.deepEqual(await sharedConversation('claude-session', claude), {
        state: 'shared',
        shared: { sessionId: session, workspace: '/home/owner' },
    });
    const other = await sharedConversation('codex-local', claude);
    assert.match(other.state === 'unavailable' ? other.reason : '', /different responder/);
    const background = await discordinator(directory, { 'operator-settings.json': { mode: 'codex-local', backgroundOnly: true } });
    assert.match((await sharedConversation('codex-local', background)).state, /unavailable/);
    const codex = await discordinator(directory, {
        'operator-settings.json': { mode: 'codex-local' },
        'controller-codex-local.json': { conversations: [{ key: 'discordinator', sessionId: 'thread-1' }] },
    });
    assert.deepEqual(await sharedConversation('codex-local', codex), { state: 'shared', shared: { sessionId: 'thread-1' } });
    const fresh = await discordinator(directory, { 'operator-settings.json': { mode: 'claude-session' } });
    const waiting = await sharedConversation('claude-session', fresh);
    assert.match(waiting.state === 'unavailable' ? waiting.reason : '', /has not started the Coordinator/);
}

async function checkFirewall(directory: string): Promise<void> {
    const files = { config: join(directory, 'ufw.conf'), rules: join(directory, 'user.rules') };
    const sudo: string[][] = [];
    const elevated = { sudo: (args: string[]) => Promise.resolve(void sudo.push(args)) };
    await writeFile(files.config, 'ENABLED=no\n');
    assert.ok(await firewallOpen('linux', files), 'a switched-off ufw blocks nothing');
    assert.ok(await firewallOpen('darwin', files), 'only Linux firewalls are handled');
    await writeFile(files.config, 'ENABLED=yes\n');
    await writeFile(files.rules, '*filter\n');
    assert.equal(await firewallOpen('linux', files), false, 'ufw without AiBinator’s rules blocks AIBI');
    assert.match((await openFirewall(elevated, files)) ?? '', /ports 53, 80 and 443/);
    assert.deepEqual(
        sudo.map((args) => [args[0], args[1], args.slice(-5).join(' ')]),
        [
            ['ufw', 'allow', '53,80,443 proto tcp comment AiBinator'],
            ['ufw', 'allow', '53 proto udp comment AiBinator'],
        ],
        'the firewall is opened for TCP and UDP',
    );
    const hex = Buffer.from('AiBinator').toString('hex');
    await writeFile(
        files.rules,
        [
            `### tuple ### allow tcp 53,80,443 0.0.0.0/0 any 192.168.50.0/24 in comment=${hex}`,
            `### tuple ### allow udp 53 0.0.0.0/0 any 192.168.50.0/24 in comment=${hex}`,
            '### tuple ### allow tcp 22 0.0.0.0/0 any 192.168.50.0/24 in',
        ].join('\n'),
    );
    assert.ok(await firewallOpen('linux', files), 'AiBinator’s rules open the firewall');
    assert.equal(await openFirewall(elevated, files), undefined, 'an open firewall is left alone');
    sudo.length = 0;
    await closeFirewall(elevated, files);
    assert.deepEqual(
        sudo.map((args) => args.join(' ')),
        [
            'ufw delete allow from 192.168.50.0/24 to any port 53,80,443 proto tcp',
            'ufw delete allow from 192.168.50.0/24 to any port 53 proto udp',
        ],
        'only AiBinator’s rules are removed',
    );
}

export async function checkAibiNetwork(directory: string): Promise<void> {
    await checkDns();
    await checkFirewall(directory);
    checkFirmware();
    await checkSharing(directory);
}
