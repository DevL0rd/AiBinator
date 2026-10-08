import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type Runner = (file: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string }>;

export const runFile: Runner = promisify(execFile);
