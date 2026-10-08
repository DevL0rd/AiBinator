import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rm, unlink, type FileHandle } from 'node:fs/promises';
import { replaceFile } from '../core/replace-file.js';
import { join } from 'node:path';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { validAppRedirect } from './registration.js';

export function privatelyOwned(
    info: { mode: number; uid: number },
    platform: NodeJS.Platform = process.platform,
    uid: number | undefined = process.getuid?.(),
): boolean {
    return platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === uid);
}

async function privateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || !privatelyOwned(info)) {
        throw new Error('OAuth directory must be owned by this user with mode 700');
    }
}

export async function readPrivate<T>(file: string): Promise<T> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || !privatelyOwned(info)) {
            throw new Error('OAuth files must be owned by this user with mode 600');
        }
        return JSON.parse(await handle.readFile('utf8')) as T;
    } finally {
        await handle.close();
    }
}

async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(directory, constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function writePrivate(file: string, value: unknown, exclusive = false): Promise<void> {
    const target = exclusive ? file : `${file}.pending`;
    if (!exclusive) await rm(target, { force: true });
    const handle = await open(target, 'wx', 0o600);
    try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (!exclusive) await replaceFile(target, file);
    await syncDirectory(join(file, '..'));
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function staleLock(file: string): Promise<boolean> {
    let content: string;
    try {
        content = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
        throw error;
    }
    const pid = Number(content.trim());
    return !Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid);
}

async function createLock(file: string): Promise<FileHandle> {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.sync();
    return handle;
}

async function claimLock(file: string): Promise<FileHandle> {
    try {
        return await createLock(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await staleLock(file))) throw error;
        console.error('Removing stale OAuth operation lock left by a stopped process');
        await rm(file, { force: true });
        return createLock(file);
    }
}

export async function lockDirectory(directory: string): Promise<() => Promise<void>> {
    await privateDirectory(directory);
    const file = join(directory, 'operation.lock');
    const handle = await claimLock(file);
    let released = false;
    return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(file);
    };
}

type RecordValue = { payload: AdapterPayload; expires?: number };
type Records = Record<string, RecordValue>;

const unconsentedClientMs = 24 * 60 * 60_000;
const clientCapacity = 200;
const clientExpiryMigration = 'Migration:client-expiry';
const signInModels = ['Grant', 'RefreshToken', 'Session', 'AuthorizationCode'];
const clientKeys = (records: Records) => Object.keys(records).filter((key) => key.startsWith('Client:'));

function admitClient(records: Records, key: string): number | undefined {
    if (records[key]) return records[key].expires;
    const clients = clientKeys(records);
    if (clients.length >= clientCapacity) {
        const oldest = clients
            .filter((item) => records[item]!.expires !== undefined)
            .sort((a, b) => records[a]!.expires! - records[b]!.expires!)[0];
        if (!oldest) throw new Error('OAuth client capacity exhausted');
        delete records[oldest];
    }
    return Date.now() + unconsentedClientMs;
}

function upsertRecord(records: Records, model: string, id: string, payload: AdapterPayload, expiresIn: number | undefined): void {
    const key = `${model}:${id}`;
    const expires = expiresIn === undefined ? undefined : Date.now() + expiresIn * 1000;
    records[key] = { payload, expires: model === 'Client' ? admitClient(records, key) : expires };
    const client = model === 'Grant' ? records[`Client:${String(payload.clientId)}`] : undefined;
    if (client) delete client.expires;
}

export class OAuthStore {
    private records: Records = {};
    private pending: Promise<void> = Promise.resolve();
    constructor(readonly directory: string) {}

    async load(): Promise<void> {
        try {
            this.records = await readPrivate<Records>(join(this.directory, 'state.json'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }

    private purge(): void {
        for (const [key, record] of Object.entries(this.records)) {
            if (record.expires !== undefined && record.expires <= Date.now()) delete this.records[key];
        }
    }

    mutate(change: (records: Records) => void): Promise<void> {
        const operation = this.pending.then(async () => {
            this.purge();
            const next = structuredClone(this.records);
            change(next);
            if (Object.keys(next).length > 10_000) throw new Error('OAuth state capacity exhausted');
            await writePrivate(join(this.directory, 'state.json'), next);
            this.records = next;
        });
        this.pending = operation.catch(() => {});
        return operation;
    }

    async find(model: string, test: (id: string, payload: AdapterPayload) => boolean): Promise<AdapterPayload | undefined> {
        await this.pending;
        this.purge();
        const prefix = `${model}:`;
        const found = Object.entries(this.records).find(
            ([key, record]) => key.startsWith(prefix) && test(key.slice(prefix.length), record.payload),
        );
        return found ? structuredClone(found[1].payload) : undefined;
    }

    async consentedClientCount(): Promise<number> {
        await this.pending;
        this.purge();
        return clientKeys(this.records).filter((key) => this.records[key]!.expires === undefined).length;
    }

    async expireUnconsentedClients(): Promise<number> {
        let expiring = 0;
        await this.mutate((records) => {
            if (records[clientExpiryMigration]) return;
            records[clientExpiryMigration] = { payload: {} };
            const granted = new Set(
                Object.entries(records)
                    .filter(([key]) => key.startsWith('Grant:'))
                    .map(([, record]) => String(record.payload.clientId)),
            );
            for (const key of clientKeys(records)) {
                if (records[key]!.expires !== undefined || granted.has(key.slice('Client:'.length))) continue;
                records[key]!.expires = Date.now() + unconsentedClientMs;
                expiring++;
            }
        });
        return expiring;
    }

    revokeSignIns(): Promise<void> {
        return this.mutate((records) => {
            for (const key of Object.keys(records)) if (signInModels.includes(key.slice(0, key.indexOf(':')))) delete records[key];
        });
    }

    async migrateChatgptClients(): Promise<number> {
        let migrated = 0;
        await this.mutate((records) => {
            for (const [key, record] of Object.entries(records)) {
                if (!key.startsWith('Client:')) continue;
                const payload = record.payload as Record<string, unknown>;
                const redirects = payload.redirect_uris;
                if (
                    payload.scope !== 'aibinator:control' ||
                    payload.token_endpoint_auth_method !== 'none' ||
                    !Array.isArray(redirects) ||
                    !redirects.length ||
                    !redirects.every((redirect) => typeof redirect === 'string' && validAppRedirect(redirect))
                )
                    continue;
                payload.scope = 'openid aibinator:control';
                payload.grant_types = ['authorization_code', 'refresh_token'];
                migrated++;
            }
        });
        return migrated;
    }

    adapter = (model: string): Adapter => ({
        upsert: (id, payload, expiresIn) => this.mutate((records) => upsertRecord(records, model, id, payload, expiresIn)),
        find: (id) => this.find(model, (key) => key === id),
        findByUid: (uid) => this.find(model, (_key, payload) => payload.uid === uid),
        findByUserCode: (code) => this.find(model, (_key, payload) => payload.userCode === code),
        consume: (id) =>
            this.mutate((records) => {
                const entry = records[`${model}:${id}`];
                if (entry) entry.payload.consumed = Math.floor(Date.now() / 1000);
            }),
        destroy: (id) =>
            this.mutate((records) => {
                delete records[`${model}:${id}`];
            }),
        revokeByGrantId: (grantId) =>
            this.mutate((records) => {
                for (const [key, entry] of Object.entries(records)) {
                    if (entry.payload.grantId === grantId) delete records[key];
                }
            }),
    });
}
