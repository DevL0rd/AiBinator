import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shimTarget } from '../src/operator/executables.js';
import { launcherScript } from '../src/operator/windows-service.js';

const npmShim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    '',
].join('\r\n');

export async function checkWindows(directory: string): Promise<void> {
    const bin = join(directory, 'npm-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex.cmd'), npmShim);
    assert.equal(
        await shimTarget(join(bin, 'codex.cmd')),
        join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        'npm command shims run their script with node',
    );
    await writeFile(join(bin, 'other.cmd'), '@echo off\r\nsomething.exe %*\r\n');
    await assert.rejects(shimTarget(join(bin, 'other.cmd')), /not an npm command shim/);
    const script = launcherScript('C:\\Users\\Dev "Q"\\AiBinator', 'C:\\Program Files\\nodejs\\node.exe');
    assert.match(script, /shell\.CurrentDirectory = "C:\\\\Users\\\\Dev \\"Q\\"\\\\AiBinator";/, 'paths are escaped for JScript');
    assert.match(script, /shell\.Run\(".+node\.exe\\" \\".+service\.js\\"", 0, false\);/, 'the service starts hidden');
}
