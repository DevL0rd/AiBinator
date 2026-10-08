import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function oauthJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
}

export async function boundedBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const data = Buffer.from(chunk as Uint8Array);
        size += data.length;
        if (size > 8192) throw new Error('OAuth body too large');
        chunks.push(data);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function escape(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const style = `:root{--bg:#0b0d17;--card:rgba(22,25,41,.82);--line:rgba(255,255,255,.09);--text:#eef0ff;--muted:#a3a8c7;--accent:#5865f2;--accent2:#8b5cf6;--field:#11131f;--danger:#f0717a;--chip:#a5b0ff}
@media (prefers-color-scheme:light){:root{--bg:#eef0fa;--card:rgba(255,255,255,.9);--line:rgba(20,24,60,.12);--text:#151833;--muted:#5b6087;--field:#f6f7fd;--chip:#4752c4}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(60rem 40rem at 15% -10%,rgba(88,101,242,.35),transparent 60%),radial-gradient(50rem 35rem at 110% 110%,rgba(139,92,246,.28),transparent 60%),var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:36px 30px 28px;box-shadow:0 30px 80px -20px rgba(0,0,0,.55);backdrop-filter:blur(18px)}
.mark{display:flex;align-items:center;gap:10px;margin-bottom:26px}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;font-weight:800;color:#fff;box-shadow:0 8px 24px -6px rgba(88,101,242,.7)}
.name{font-weight:800;letter-spacing:.14em;font-size:13px;color:var(--muted)}
h1{font-size:24px;line-height:1.25;margin:0 0 6px}
p{margin:0 0 20px;color:var(--muted);font-size:14.5px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px}
input[type=password]{width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--line);background:var(--field);color:var(--text);font-size:16px;outline:none;transition:border-color .15s,box-shadow .15s}
input[type=password]:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(88,101,242,.22)}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:22px}
button{appearance:none;border:0;border-radius:12px;padding:13px 16px;font:600 15px system-ui,sans-serif;cursor:pointer;transition:transform .08s,filter .15s}
button:active{transform:translateY(1px)}
.primary{color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 10px 24px -10px rgba(88,101,242,.9)}
.primary:hover{filter:brightness(1.08)}
.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.ghost:hover{color:var(--danger);border-color:var(--danger)}
.app{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--field);margin-bottom:6px;font-size:14px}
.row{display:flex;justify-content:space-between;gap:12px}.row span:first-child{color:var(--muted)}.row span:last-child{text-align:right;word-break:break-all}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;background:rgba(88,101,242,.16);color:var(--chip);font-size:12.5px;font-weight:600}
.note{font-size:12.5px;margin:14px 0 0}`;
const styleHash = createHash('sha256').update(style).digest('base64');

function loginBody(): string {
    return '<h1>Welcome back</h1><p>Enter your AiBinator password to connect this app.</p><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required maxlength="1024" autofocus><div class="actions"><button class="primary" name="action" value="login">Sign in</button><button class="ghost" name="action" value="deny" formnovalidate>Cancel</button></div>';
}

function consentBody(clientName: string | undefined, redirect: string): string {
    return `<h1>Allow access?</h1><p>An app wants to use AiBinator on your behalf.</p><div class="app"><div class="row"><span>App</span><span>${escape(clientName ?? 'Unnamed app')}</span></div><div class="row"><span>Returns to</span><span>${escape(new URL(redirect).host)}</span></div><div class="row"><span>Access</span><span><span class="chip">aibinator:control</span></span></div></div><p class="note">It can read what AIBI heard and did, make AIBI speak and move, and answer requests, within the abilities you allowed.</p><div class="actions"><button class="primary" name="action" value="allow">Allow</button><button class="ghost" name="action" value="deny">Deny</button></div>`;
}

export function interactionPage(
    response: ServerResponse,
    prompt: string,
    csrf: string,
    clientName: string | undefined,
    redirect: string,
): void {
    const callbackOrigin = new URL(redirect).origin;
    response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
    });
    const body = prompt === 'login' ? loginBody() : consentBody(clientName, redirect);
    response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>AiBinator · ${prompt === 'login' ? 'Sign in' : 'Allow access'}</title><style>${style}</style></head><body><main><div class="mark"><div class="logo">D</div><div class="name">AIBINATOR</div></div><form method="post"><input type="hidden" name="csrf" value="${csrf}">${body}</form></main></body></html>`,
    );
}
