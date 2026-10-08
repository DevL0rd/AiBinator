import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { aibiHost } from './network.js';

const firmwareDirectory = '.data/firmware';
const patchedDirectory = join(firmwareDirectory, 'patched');

export interface Patched {
    file: string;
    name: string;
    urlPath: string;
    versionNum: string;
    versionName: string;
    responseTag: string;
    md5: string;
    bytes: Buffer;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json | undefined> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as Json;
    } catch {
        return undefined;
    }
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' || typeof value === 'number' ? String(value) : fallback);

export async function patchedFirmware(): Promise<Patched | undefined> {
    const name = (await readdir(patchedDirectory).catch(() => [] as string[]))
        .filter((file) => file.endsWith('-patched.zip'))
        .sort()
        .at(-1);
    if (!name) return undefined;
    const latest = await readJson(join(firmwareDirectory, 'latest-firmware.json'));
    const update = (latest?.update as Json | undefined) ?? (await readJson(join(patchedDirectory, 'metadata.json'))) ?? {};
    const original =
        text(update.firmware) || new URL(text(update.url, 'https://local/aibi/version/public/0/unknown/unknown/firmware.zip')).pathname;
    const file = join(patchedDirectory, name);
    const bytes = await readFile(file);
    return {
        file,
        name,
        urlPath: posix.join(dirname(original.startsWith('/') ? original : `/${original}`), name),
        versionNum: text(update.versionNum),
        versionName: text(update.versionName, name.replace(/-patched\.zip$/, '')),
        responseTag: text(update.responseTag, 'otares'),
        md5: createHash('md5').update(bytes).digest('hex'),
        bytes,
    };
}

export function patchedOffer(firmware: Patched): Json {
    return {
        'version-num': firmware.versionNum,
        'version-name': firmware.versionName,
        updates: { host: aibiHost, firmware: firmware.urlPath, md5: firmware.md5 },
        responsetag: firmware.responseTag,
    };
}

export function olderVersionRequest(startLine: string): string | undefined {
    const [method, target = '', protocol = 'HTTP/1.1'] = startLine.split(' ');
    if (method !== 'GET' || !target.startsWith('/aibi/ota/version')) return undefined;
    const url = new URL(`http://local${target}`);
    url.searchParams.set('version_num', '8');
    url.searchParams.set('current_name', '1.5.0');
    return `${method} ${url.pathname}?${url.searchParams.toString()} ${protocol}`;
}

const firmwareLike = (value: string) =>
    /^https?:\/\//i.test(value) && /(?:ota|firmware|fw|update|\.bin|\.zip|\.img|\.ota)(?:[/?#]|$)/i.test(value);

export function firmwareUrls(value: unknown, found = new Set<string>()): string[] {
    if (typeof value === 'string' && firmwareLike(value)) found.add(value);
    if (value && typeof value === 'object') for (const item of Object.values(value)) firmwareUrls(item, found);
    return [...found];
}

function rewriteUrls(value: unknown, rewrite: (url: string) => string): unknown {
    if (typeof value === 'string') return firmwareLike(value) ? rewrite(value) : value;
    if (Array.isArray(value)) return value.map((item) => rewriteUrls(item, rewrite));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteUrls(item, rewrite)]));
    return value;
}

export function rewriteOffer(json: Json, firmware?: Patched): Json {
    if (!firmware) return rewriteUrls(json, (url) => `http://${aibiHost}/ota-blocked/${Buffer.from(url).toString('base64url')}`) as Json;
    const rewritten = rewriteUrls(json, () => `http://${aibiHost}${firmware.urlPath}`) as Json;
    const updates = rewritten.updates && typeof rewritten.updates === 'object' ? (rewritten.updates as Json) : undefined;
    return {
        ...rewritten,
        ...(updates ? { updates: { ...updates, host: aibiHost, firmware: firmware.urlPath, md5: firmware.md5 } } : {}),
        ...(firmware.versionNum ? { 'version-num': firmware.versionNum } : {}),
        ...(firmware.versionName ? { 'version-name': firmware.versionName } : {}),
        responsetag: firmware.responseTag,
    };
}

export async function downloadFirmware(url: string, headers: Record<string, string>): Promise<{ file: string; bytes: number }> {
    const target = new URL(url);
    const forwarded =
        target.hostname === aibiHost
            ? Object.fromEntries(
                  ['authorization', 'secret', 'user-agent'].filter((name) => headers[name]).map((name) => [name, headers[name]!]),
              )
            : {};
    const response = await fetch(url, { headers: forwarded, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Firmware download failed (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const safe =
        basename(target.pathname)
            .replace(/[^\w.-]/g, '_')
            .slice(0, 80) || 'firmware';
    const type = response.headers.get('content-type') ?? '';
    const suffix = extname(safe) ? '' : type.includes('zip') ? '.zip' : '.bin';
    const file = join(firmwareDirectory, `${Date.now()}-${safe}${suffix}`);
    await mkdir(firmwareDirectory, { recursive: true });
    await writeFile(file, bytes);
    return { file, bytes: bytes.length };
}

const identityFile = join(firmwareDirectory, 'aibi-identity.json');
let knownIdentity = '';

function claims(token: string): Json | undefined {
    try {
        return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Json;
    } catch {
        return undefined;
    }
}

export async function rememberIdentity(headers: Record<string, string>): Promise<boolean> {
    const token = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
    const found = token ? claims(token) : undefined;
    if (!found?.sub) return false;
    const identity = {
        deviceId: text(found.sub),
        versionNum: text(found.ver),
        currentName: text(found.name),
        userAgent: headers['user-agent'] ?? '',
    };
    const encoded = JSON.stringify(identity);
    if (encoded === knownIdentity) return false;
    knownIdentity = encoded;
    await mkdir(firmwareDirectory, { recursive: true });
    await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    return true;
}

export async function rememberOffer(json: Json): Promise<void> {
    await mkdir(firmwareDirectory, { recursive: true });
    await writeFile(join(firmwareDirectory, 'ota-metadata.json'), `${JSON.stringify(json, null, 2)}\n`);
}
