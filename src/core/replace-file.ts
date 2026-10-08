import { rename } from 'node:fs/promises';

const sharingErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function replaceFile(from: string, to: string, platform = process.platform, move = rename, attempts = 20): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await move(from, to);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (platform !== 'win32' || attempt >= attempts || !sharingErrors.has(code)) throw error;
            await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        }
    }
}
