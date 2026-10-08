import { runFile, type Runner } from './run.js';

// Asks Launch Services which app opens `<scheme>:` URLs and prints its path, or nothing when none does.
export const macSchemeHandler =
    "function run([scheme]) { ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString(scheme + ':')); return app.isNil() ? '' : app.path.js; }";

export async function openUrl(url: string, platform = process.platform, run: Runner = runFile): Promise<void> {
    if (platform === 'win32') await run('rundll32', ['url.dll,FileProtocolHandler', url]);
    else if (platform === 'darwin') await run('open', [url]);
    else await run('xdg-open', [url]);
}

export async function handlesScheme(scheme: string, platform = process.platform, run: Runner = runFile): Promise<boolean> {
    if (platform === 'win32')
        return run('reg', ['query', `HKCR\\${scheme}`, '/v', 'URL Protocol']).then(
            () => true,
            () => false,
        );
    const handler =
        platform === 'darwin'
            ? await run('osascript', ['-l', 'JavaScript', '-e', macSchemeHandler, scheme], { timeout: 5000 }).catch(() => ({ stdout: '' }))
            : await run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`]).catch(() => ({ stdout: '' }));
    return handler.stdout.trim().length > 0;
}
