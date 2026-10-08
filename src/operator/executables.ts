import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface Program {
    command: string;
    args: string[];
}

const extensions = (platform: NodeJS.Platform) => (platform === 'win32' ? ['.exe', '.cmd'] : ['']);

async function forcesCodexHome(path: string): Promise<boolean> {
    const info = await stat(path);
    if (!info.isFile() || info.size > 65_536) return false;
    return /^\s*(export\s+)?CODEX_HOME=/m.test(await readFile(path, 'utf8'));
}

const runnable = (path: string) =>
    access(path, constants.X_OK).then(
        () => true,
        () => false,
    );

async function findExecutable(
    name: string,
    platform: NodeJS.Platform,
    skip: (path: string) => Promise<boolean> = () => Promise.resolve(false),
): Promise<string> {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
        for (const extension of extensions(platform)) {
            const candidate = join(directory, `${name}${extension}`);
            if ((await runnable(candidate)) && !(await skip(candidate))) return candidate;
        }
    throw new Error(`${name === 'claude' ? 'Claude Code' : 'Codex'} is not installed or not on PATH`);
}

export async function shimTarget(path: string): Promise<string> {
    const match = /"%dp0%\\([^"]+\.[cm]?js)"\s+%\*/i.exec(await readFile(path, 'utf8'));
    if (!match) throw new Error(`${path} is not an npm command shim AiBinator can run`);
    return join(dirname(path), ...match[1]!.split('\\'));
}

async function program(path: string): Promise<Program> {
    if (!/\.cmd$/i.test(path)) return { command: path, args: [] };
    return { command: process.execPath, args: [await shimTarget(path)] };
}

export const claudeProgram = async (platform = process.platform): Promise<Program> => program(await findExecutable('claude', platform));
export const codexProgram = async (platform = process.platform): Promise<Program> =>
    program(await findExecutable('codex', platform, forcesCodexHome));

export async function claudeExecutable(): Promise<string> {
    const found = await claudeProgram();
    return found.args[0] ?? found.command;
}
