# Configuration reference

Start with [Get started](getting-started.md). The setup app (`aibinator`) edits all of these for you, and every setting can be found with `/`. Authentication is mandatory: a bearer key for local clients, or your public HTTPS domain with sign-in for cloud apps.

## Files

| File | What it holds |
| :-- | :-- |
| `.env` | `GEMINI_API_KEY` and the `AIBINATOR_*` settings below |
| `policy.json` | `ownerName`, `scopes`, `aibi` and `voice` (see [Policy](#policy)) |
| `.data/operator-settings.json` | Responder settings saved in the setup app |
| `.data/operator.json` | The responder settings AiBinator is running with |
| `.data/aibi/` | `tls.key` and `tls.crt` (AIBI's certificate), `memory.json` (the conversation, last 2,000 lines), `media/` (camera photos), `activity.json` (last 500 activity entries) |
| `.data/firmware/` | Captured firmware, `ota-metadata.json`, `aibi-identity.json`, the firmware tools' output and `patched/` |
| `.data/status.json` | Live status written by the running AiBinator for the setup app |
| `.data/local.key` | Key for local tools on this computer |
| `.data/claude-session.json`, `.data/controller-*.json` | The responder conversation and its work |
| `.data/oauth/` | Sign-in keys, password hash and sessions, when a public domain is set |
| `.data/setup-backups/` | A private copy of each file before every save |

Files containing keys, IDs or conversations are ignored by git and created private to your user.

## Environment

| Variable | Default | Purpose |
| :-- | :-- | :-- |
| `GEMINI_API_KEY` | Unset | Google Gemini key for AIBI's [voice](voice.md) |
| `AIBINATOR_POLICY_FILE` | `policy.json` | Policy path relative to the AiBinator folder |
| `AIBINATOR_PORT` | `8789` | MCP listener port, 1024–65535 (Discordinator uses 8788 on this machine) |
| `AIBINATOR_BIND_HOST` | `127.0.0.1` | Only this value is accepted; the MCP listener always stays on IPv4 loopback |
| `AIBINATOR_AUTH_MODE` | `bearer` | `bearer`, or `oauth` for a public domain |
| `AIBINATOR_MCP_TOKEN` | Unset | Bearer mode: secret of at least 32 characters; the wizard creates one |
| `AIBINATOR_RESOURCE_URL` | `http://127.0.0.1:PORT/mcp` | Set from the **Public domain**; OAuth needs the HTTPS `/mcp` URL |
| `AIBINATOR_OAUTH_SERVER` | `bundled` | The [bundled sign-in](oauth.md) or an `external` provider |
| `AIBINATOR_OAUTH_DATA_DIR` | `.data/oauth` | Private sign-in state |
| `AIBINATOR_TRUSTED_PROXIES` | Empty | Exact proxy IP addresses allowed to establish HTTPS; set to `127.0.0.1,::1` with a public domain |
| `AIBINATOR_OAUTH_REDIRECT_URIS` | ChatGPT's callback | Up to four exact ChatGPT or Claude callback URLs |
| `AIBINATOR_ALLOWED_HOSTS` | Empty | Extra exact Host headers; the public domain is always allowed |
| `AIBINATOR_ALLOWED_ORIGINS` | Empty | Extra exact Origins; the public domain is always allowed |
| `AIBINATOR_OAUTH_ISSUER` | Derived | External providers only; the bundled sign-in uses the public domain |
| `AIBINATOR_OAUTH_JWKS_URL` | Derived | External providers only; the bundled sign-in uses `/oauth/jwks` |
| `AIBINATOR_OAUTH_SUBJECTS` | Empty | External providers only: allowed owner subjects |

Node's `--env-file=.env` loads the file; existing process environment takes precedence. A running AiBinator applies `.env` changes without restarting: a new Gemini key ends the current conversation and is used from the next one, port and sign-in settings restart only the MCP listener, and a new policy file path is loaded at once. An invalid edit is reported and ignored, and a change that fails to apply (such as a port already in use) is rolled back.

Other environment variables: `AIBINATOR_APP_HOME` overrides where AiBinator is installed, `DISCORDINATOR_APP_HOME` where Discordinator's installed copy is read for [sharing](operator.md#share-the-coordinator-with-discordinator), and `AIBINATOR_CHROME` the Chrome used by `npm run validate:banner`.

<a id="policy"></a>

## Policy

The [policy example](../policy.example.json) shows every field. Unknown fields are rejected. Changes apply as soon as the file is saved; network fields restart AIBI's servers.

| Field | Default | Purpose |
| :-- | :-- | :-- |
| `ownerName` | Empty | What AIBI and your responder call you (up to 60 characters) |
| `scopes` | All four | What connected apps may do: `aibi.read`, `aibi.speak`, `aibi.act`, `memory.write`. See [Security](security.md#what-apps-may-do) |
| `aibi.mode` | `local` | `local` or `passthrough`. See [Modes](aibi.md#modes) |
| `aibi.personality` | Warm, curious, playful and concise | How AIBI talks and behaves (up to 2,000 characters) |
| `aibi.actions` | Every action | Native actions the voice and your apps may use |
| `aibi.animations` | Every animation | Animations allowed for `interact_answer_with_animation` |
| `aibi.lanAddress` | Empty | This computer's IPv4 address for AIBI; empty picks it automatically |
| `aibi.dns` | `true` | Run the built-in DNS server |
| `aibi.dnsUpstream` | `1.1.1.1` | DNS server for every other name, with an optional `:port` |
| `aibi.capture` | `false` | Save every request and reply raw in `.data/aibi/traffic` (latest 1,000) |
| `aibi.httpPort` | `80` | AIBI uses 80; change only for testing |
| `aibi.httpsPort` | `443` | AIBI uses 443; change only for testing |
| `aibi.dnsPort` | `53` | Devices ask on 53; change only for testing |
| `voice.*` | | Live model, voice, idle backstop, speech loudness and remembered lines; every field is in [Voice](voice.md#settings) |

## Responder settings

Saved in `.data/operator-settings.json` from the **Responder** page.

| Setting | Default | Purpose |
| :-- | :-- | :-- |
| `mode` | `claude-session` | `claude-session`, `codex-local` or `manual-mcp`. See [Responders](operator.md#responders) |
| `workspace` | Your home folder | Working folder for Claude Code and Codex; must exist |
| `shareConversation` | `true` | Share the Coordinator with Discordinator |
| `backgroundOnly` | `false` | Always run in the background, even with Claude Desktop or the shared Codex service |
| `claudeModel`, `claudeEffort` | Default | Model and thinking effort when the Coordinator conversation is created |
| `codexModel`, `codexEffort` | Default | Codex model and reasoning |
| `workerClaudeModel`, `workerClaudeEffort` | Default | Claude chats and workers started for big work |
| `workerCodexModel`, `workerCodexEffort` | Default | Codex workers started for big work |
| `instructions` | Empty | Extra instructions for your responder (up to 8,000 characters) |
| `progressSeconds` | `60` | Background responders: progress update interval, 15–600 seconds |
| `timeoutSeconds` | `0` | Background responders: time limit, 0 for none or 30–1800 seconds |
| `activityVisibility` | `true` | Log what the responder is doing in AIBI's activity |

Models and efforts are offered from what your installed Claude Code or Codex account reports, and an effort the chosen model does not offer is refused.
