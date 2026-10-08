import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import { replaceFile } from '../core/replace-file.js';
import { aibiHost } from './network.js';

const tlsDirectory = '.data/aibi';
const keyFile = `${tlsDirectory}/tls.key`;
const certificateFile = `${tlsDirectory}/tls.crt`;

export interface TlsPair {
    key: string;
    cert: string;
    created: boolean;
}

async function write(path: string, text: string): Promise<void> {
    await writeFile(`${path}.tmp`, text, { mode: 0o600 });
    await replaceFile(`${path}.tmp`, path);
}

function matches(cert: string): boolean {
    try {
        return new X509Certificate(cert).checkHost(aibiHost) !== undefined;
    } catch {
        return false;
    }
}

export async function tlsPair(): Promise<TlsPair> {
    const [key, cert] = await Promise.all([readFile(keyFile, 'utf8').catch(() => ''), readFile(certificateFile, 'utf8').catch(() => '')]);
    if (key && cert && matches(cert)) return { key, cert, created: false };
    await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
    const now = new Date();
    const pems = await generate([{ name: 'commonName', value: aibiHost }], {
        keySize: 2048,
        algorithm: 'sha256',
        notBeforeDate: new Date(now.getTime() - 86_400_000),
        notAfterDate: new Date(now.getTime() + 3650 * 86_400_000),
        extensions: [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: [{ type: 2, value: aibiHost }] },
        ],
    });
    await write(keyFile, pems.private);
    await write(certificateFile, pems.cert);
    return { key: pems.private, cert: pems.cert, created: true };
}
