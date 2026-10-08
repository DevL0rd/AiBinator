import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], { encoding: 'utf8' }).split('\0'));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.ts', '*.js'], {
    encoding: 'utf8',
})
    .split('\0')
    .filter((file) => file && !deleted.has(file));
let failed = false;
for (const file of new Set(files)) {
    const content = await readFile(file, 'utf8');
    const lines = content.split('\n').length - 1;
    if (lines > 400) {
        console.error(`${file}: ${lines} lines exceeds 400`);
        failed = true;
    }
}
if (failed) process.exitCode = 1;
else console.log(`File length passed: ${files.length} JavaScript/TypeScript files, at most 400 lines each.`);
