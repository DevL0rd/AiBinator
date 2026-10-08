import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import argon2 from 'argon2';
import { readPrivate, writePrivate } from './storage.js';

export type KeyMaterial = { jwks: { keys: JWK[] }; cookies: string[] };
export type Owner = { identifier: string; subject: string; passwordHash: string };

const exists = (path: string) =>
    access(path).then(
        () => true,
        () => false,
    );
export const pendingOwnerFile = (directory: string) => join(directory, 'owner-password.json');
export const ownerPending = (directory: string) => exists(pendingOwnerFile(directory));

export async function ensureKeys(directory: string): Promise<void> {
    if (await exists(join(directory, 'keys.json'))) return;
    const { privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 3072 });
    const key = { ...(await exportJWK(privateKey)), kid: randomUUID(), alg: 'RS256', use: 'sig' };
    await writePrivate(join(directory, 'keys.json'), { jwks: { keys: [key] }, cookies: [randomBytes(48).toString('base64url')] }, true);
}

export function passwordError(password: string): string | undefined {
    if (password.length < 12) return 'Use at least 12 characters.';
    if (Buffer.byteLength(password) > 1024) return 'Use at most 1024 bytes.';
}

export async function requestOwnerPassword(directory: string, password: string): Promise<void> {
    const error = passwordError(password);
    if (error) throw new Error(error);
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writePrivate(pendingOwnerFile(directory), { passwordHash });
}

export async function applyPendingOwner(directory: string): Promise<Owner | undefined> {
    if (!(await ownerPending(directory))) return undefined;
    const { passwordHash } = await readPrivate<{ passwordHash: string }>(pendingOwnerFile(directory));
    if (!passwordHash.startsWith('$argon2id$')) throw new Error('Pending owner password is not an Argon2id hash');
    const file = join(directory, 'owner.json');
    const existing = (await exists(file)) ? await readPrivate<Owner>(file) : undefined;
    const owner = { identifier: existing?.identifier ?? 'owner', subject: existing?.subject ?? randomUUID(), passwordHash };
    await writePrivate(file, owner, !existing);
    await unlink(pendingOwnerFile(directory));
    return owner;
}

export async function ownerReady(directory: string): Promise<boolean> {
    return (await exists(join(directory, 'owner.json'))) || ownerPending(directory);
}
