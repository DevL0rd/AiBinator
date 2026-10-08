# Bundled owner OAuth

AiBinator can run its own authorization server on the same loopback listener as MCP, so claude.ai and ChatGPT can sign in through your public domain. It uses `oidc-provider` and `argon2`, resolved through `package-lock.json`. Hosting, TLS termination and the public URL are yours to set up.

Setting a public domain in the setup app turns it on. The equivalent `.env` is just:

```dotenv
AIBINATOR_AUTH_MODE=oauth
AIBINATOR_RESOURCE_URL=https://aibi.example.com/mcp
AIBINATOR_TRUSTED_PROXIES=127.0.0.1,::1
```

Everything else is derived from the domain: the issuer is its origin, the signing keys live at `/oauth/jwks`, its Host and Origin are allowed automatically, and ChatGPT's callback is the default redirect. Only the listed proxy socket addresses may establish HTTPS through `X-Forwarded-Proto: https`, and only with the domain's exact Host. Incoming forwarding headers are discarded, and owner forms require the issuer Origin.

## The sign-in password

Set it in the setup app (first-run setup asks for it when a public domain is already set, and **Apps → Sign-in password** changes it), or from a terminal:

```sh
npm run oauth:password
```

There is no username: the sign-in page asks only for the password (at least 12 characters, at most 1024 bytes). Only its Argon2id hash is stored. A new password applies immediately while AiBinator runs, signs out every existing sign-in and keeps the same owner identity. There is no default password or recovery bypass; with a public domain set, AiBinator does not start until a password exists.

Signing and cookie keys are created on first start in `.data/oauth` (mode 700, files mode 600 and owned by you) and are never regenerated. Clients, grants, sessions and rate budgets survive restarts. Keep this folder private and backed up, and run one AiBinator per folder.

## What it allows

| | |
| :-- | :-- |
| Flow | Authorization code with mandatory S256 PKCE, exact `aibinator:control` scope (optionally with `openid`) and the exact resource |
| Consent | Every authorization asks for explicit owner consent |
| Access tokens | RS256 JWTs, `typ=at+jwt`, 300-second lifetime, audience is your `/mcp` URL |
| Refresh tokens | Issued to clients that registered for them, 30 days, rotated on use |
| Codes | Expire after 60 seconds |
| Registration | Dynamic client registration for web clients whose redirect URIs are ChatGPT's or Claude's official callbacks (or listed in `AIBINATOR_OAUTH_REDIRECT_URIS`); at most ten registrations a minute and 200 approved clients; clients never approved expire after 24 hours |
| Login limits | Five failed attempts per sign-in and 100 overall per 15 minutes; a successful login does not count |

Cookies are Secure, HttpOnly and SameSite, and owner forms use single-use CSRF tokens.

## Checks

```sh
timeout -k 2s 30s npm run validate:oauth
```

It uses temporary credentials and in-process HTTP handlers, creates no public listener and talks to nothing outside this computer. See [Validation](validation.md#current-state) for the suite's current state.
