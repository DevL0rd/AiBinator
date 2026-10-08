# Security and trust

## Who can make AIBI do things

AIBI has no idea who is talking. **Anyone who can talk to AIBI can make it do work**: the voice hands their requests to your responder, which runs on your computer with your responder's own permissions. Anyone near AIBI can also answer your responder's permission prompts out loud. Keep that in mind when you choose a responder, its working folder and what it may do without asking.

Things to know:

- **Speech is speech-to-text.** What AIBI heard can be wrong. The voice and your responder are both told so.
- **Heard and seen things are context, not instructions.** The voice is told that a TV, a photo or other people are context only, and the responder is told that what people say to AIBI never overrides its rules.
- **Secrets are never asked out loud.** A permission request that needs secret input, or a form, is refused instead of being asked.
- **Your name is display only.** `ownerName` tells the voice and the responder who AIBI lives with; it grants nothing.

<a id="approvals-out-loud"></a>

## Approvals out loud

With Claude Code in the background or Codex, the responder's permission requests and questions are asked by AIBI. The voice asks you whether to allow it once, deny it or cancel the task, and passes your answer back with `answer_request`. "Yes", "allow", "okay" or "go ahead" allows once; "no" or "deny" denies; "cancel" or "stop the task" cancels. Anything unclear is asked again. Questions with options take the option you name or its number. A question is only valid while the request is still waiting.

With Claude Code in Claude Desktop, permission prompts are Claude Desktop's own and are answered there, not out loud.

<a id="what-apps-may-do"></a>

## What apps may do

Connected apps, including your responder, use the AIBI tools. **Abilities → Allowed** (`scopes`) decides what they may do:

| Scope | Allows |
| :-- | :-- |
| `aibi.read` | `aibinator_status`, `aibi_actions`, `aibi_history`, `aibi_activity` |
| `aibi.speak` | `aibi_say` |
| `aibi.act` | `aibi_action`, limited to switched-on actions |
| `memory.write` | `aibi_history_delete`, `aibi_history_clear` |

All four are on by default. `aibi_reply` and `events_poll` are always allowed, since they are how requests are answered. `aibinator_settings` and `aibinator_settings_update` need an authenticated owner and cannot read or change secrets. Actions switched off on the Abilities page are refused for the voice and for apps alike. See [Capabilities](capabilities.md).

## MCP access boundary

Every MCP request needs authentication, even on loopback: the local key in `.data/local.key` (accepted only with a `127.0.0.1` or `localhost` Host header), the bearer key `AIBINATOR_MCP_TOKEN`, or, with a public domain, a sign-in access token. Keys are compared in constant time. OAuth access tokens are checked for signature, issuer, audience, expiry, subject and the `aibinator:control` scope. See [Connection](connection.md) and [OAuth](oauth.md).

Host and Origin are checked in every mode: a missing Origin is allowed, an unlisted one is denied. Forwarding and identity headers never grant access. The MCP listener stays on IPv4 loopback; put an HTTPS proxy or tunnel in front of it for cloud apps.

## AIBI's network

AIBI's HTTP and HTTPS servers listen on every network interface, and the DNS server on this computer's network address, so devices on your network can reach them. They answer only AIBI's protocol and forward everything else to the real cloud. The DNS server answers only `api.aibipocket.com` itself and forwards every other name. AIBI's certificate is self-signed and private to this computer in `.data/aibi`.

`aibinator ports` lets **every** program on this computer use ports 53 and up, not only AiBinator. If ufw is on, it also lets your local network (only) reach ports 53, 80 and 443. `aibinator uninstall` takes both back.

Firmware offers from the cloud are hidden from AIBI in Pass-through mode, and only a firmware you put in `.data/firmware/patched` is ever offered. See [Firmware](aibi.md#firmware).

## Credentials and local state

Keep `.env`, `policy.json` and `.data/` private; they are ignored by git. `.data/aibi/memory.json` and `media/` hold everything said with AIBI and its photos; **Memory → Forget everything** erases both. Never put keys in URLs, chat or committed client configuration. The Gemini key is used only for Google; MCP credentials are never forwarded anywhere.

Settings are picked up live, without restarting. Use [Configuration](configuration.md) for every field and [Architecture](architecture.md#idempotency-and-recovery) for uncertain replies.
