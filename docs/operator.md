# Operator guide

`aibinator` opens the AiBinator setup app, a full-screen terminal app that works with keyboard and mouse. Before AiBinator is installed, run `npm run aibinator` from the folder you cloned. The first run is a guided wizard (see [Get started](getting-started.md)); after that it opens straight to the dashboard.

## Pages

| Page | What it is for |
| :-- | :-- |
| Home | Live pipeline (AIBI → AiBinator → your responder), start or pause, updates, tasks in progress, questions waiting for you, results waiting to be told, and recent activity |
| Responder | Choose the primary responder and edit its settings |
| AIBI | Connection status and steps, your name, mode, personality, network settings and firmware |
| Abilities | Enabled actions and animations, and what connected apps may do |
| Voice | Gemini key, live model and voice, and conversation settings |
| Memory | Everything AIBI remembers, **Forget everything**, and the activity log |
| Apps | Web connectors for claude.ai and ChatGPT, your public address and sign-in password |
| System | Background service, advanced settings and backups |

## Keys

| Key | Action |
| :-- | :-- |
| Arrows, `j` / `k` | Move |
| `←` / `→`, Tab | Switch between the menu and the page |
| Enter, Space | Open or toggle |
| `1`–`7` | Jump to a page (Home to Apps; System has no number key) |
| `s` | Review and save |
| `/` | Find any setting |
| `p` | Start or pause the responder |
| `u` | Update and restart, when an update is shown |
| `r` | Reload settings and status |
| `?` | Help |
| `q` | Quit the setup app (AiBinator keeps running) |

## Saving

Every save shows a review of the exact before → after values, with secrets redacted. Settings are validated first, and a private backup of the previous file is written to `.data/setup-backups`. If the files are written but a later step fails, such as connecting an app, the save is kept and the problem is shown as a warning.

When a settings file changes outside the setup app, the app reloads it and keeps your unsaved edits on top. Press `r` to reload by hand.

The running AiBinator applies saved settings without restarting. Policy changes (name, mode, personality, abilities, voice) apply at once, and network settings restart only AIBI's servers. In `.env`, a new Gemini key ends the current conversation, and port or sign-in changes restart only the MCP listener. Saving a different responder makes it the primary one, connects its app if needed and starts it; the switch waits for any work in progress to finish. Saving other changes keeps a paused responder paused.

## Responders

Exactly one responder does the work AIBI's voice hands over. There is one conversation for everyone: every request from AIBI goes to the same responder conversation.

| Responder | Mode ID | How it works |
| :-- | :-- | :-- |
| Claude Code | `claude-session` | One ongoing Claude conversation, named Coordinator when AiBinator creates it. Prefers Claude Desktop; see below. The default. |
| Codex | `codex-local` | One ongoing Codex conversation; see below. |
| Another MCP app | `manual-mcp` | Any compatible MCP client; you run it yourself. It polls with `events_poll` and answers with `aibi_reply`. Its card shows the addresses to connect to. |

Each request carries what was said with AIBI since the responder last heard from it (up to 60 lines, marked as speech-to-text), then the spoken request itself. The responder answers with `aibi_reply`: progress updates are only logged, and its one final reply is told out loud by the voice, so it is told to keep it short and speakable. If a request cannot be handed over after three tries, the voice is told the responder is unavailable and why.

### Claude Code

With Claude Desktop installed (and **Always run in the background** off), AiBinator pushes each request into the Coordinator conversation through the live session's local socket: into the live session if it is open in Claude Desktop or a terminal, otherwise it opens the conversation in Claude Desktop first, starting the app if needed. The first time, it creates the conversation in your **Working folder** with `claude -p --session-id … --name Coordinator`. If the conversation has not picked a request up after eight seconds while idle, AiBinator nudges it once. **Open in Claude Desktop** opens the conversation at any time. Permission prompts in this mode are Claude Desktop's own; answer them there.

Without Claude Desktop, or with **Always run in the background** on, AiBinator runs Claude Code in the background through the Claude Agent SDK, in one conversation. Its permission requests and questions are asked out loud by AIBI.

### Codex

AiBinator connects to the shared Codex app-server service that the Codex command line manages (`codex app-server daemon`), starting it if needed, and keeps one conversation there, so other Codex clients attached to the service can follow it. With **Always run in the background** on, it runs a private Codex app-server instead. Permission requests and questions are asked out loud by AIBI in both cases.

## Share the Coordinator with Discordinator

With **Share the Coordinator with Discordinator** on (`operator.shareConversation`, the default), AiBinator uses the same Coordinator conversation as [Discordinator](https://github.com/DevL0rd/Discordinator), so one assistant with one memory handles Discord and AIBI.

| Responder | What it joins |
| :-- | :-- |
| Claude Code in Claude Desktop | The session ID in Discordinator's `.data/claude-session.json` |
| Codex through the shared Codex service | The `discordinator` thread in Discordinator's `.data/controller-codex-local.json` |

AiBinator only reads Discordinator's files, from Discordinator's installed copy (`~/.local/share/discordinator` on Linux). Sharing needs both to use the same responder, and never applies to the background-only modes: Claude Code through the Agent SDK, Codex's private app-server, or a Discordinator that runs its responder in the background. If Discordinator has no Coordinator yet, or sharing is not possible, nothing else answers in its place: the request is not delivered and AiBinator gives a clear reason, such as "Discordinator has not started the Coordinator conversation yet. Send it a Discord message first." With Claude Desktop the reason shows on the Home page and, after three tries, the voice tells you; with Codex the request stays queued and is tried again.

AiBinator's instructions are scoped to AIBI requests and never replace Discordinator's. In Claude Desktop they are sent as an update that replaces earlier AiBinator instructions only; in the shared Codex thread AiBinator sends no thread instructions and adds its AIBI rules to each request instead.

## The responder as the manager

A local responder is told to manage the work on your computer, not just chat. Quick things (questions, lookups, small edits) it does itself. Big or long work it hands to a separate conversation with a title and a full brief, and that conversation reports back to the responder, which tells you the result through AIBI in its own words.

| Responder | How it manages work |
| :-- | :-- |
| Claude Code in Claude Desktop | New Claude chats it starts where you can see them: in Claude Desktop with its session tools, or with `claude --remote-control` in a terminal, never as background agents. They report to the Coordinator by message. **Model for new chats** and **Thinking for new chats** set how they run. |
| Claude Code in the background, or Codex | Its built-in `start_task`, `list_tasks`, `steer_task` and `cancel_task`: each worker is its own conversation, up to two at a time, and its result arrives back in the responder's conversation as a report. The model and effort **for new chats** or **for workers** set how they run. |

## Local responders

Choosing Claude Code or Codex as the responder connects it on this computer, with nothing to sign in to. Its **AIBI tools** row on the Responder page shows the status and can repair or disconnect it.

| Responder | What connecting does |
| :-- | :-- |
| Claude Code | Installs a local plugin (`aibinator@aibinator-local`) that gives every Claude Code session, including Claude Desktop, the AIBI tools. |
| Codex | Adds an `aibinator` entry to the config of the Codex home your `codex` command uses, pointing at AiBinator on this computer with its local key. |

Connecting only touches the entry named `aibinator`. Your other servers, including Discordinator, stay exactly as they are.

## Web connectors

The Apps page holds the connectors that give Claude and ChatGPT on the web and phone the AIBI tools through your public address. They are separate from the responder and are not handed requests.

| Connector | How to add it |
| :-- | :-- |
| Claude (web) | Add `https://YOUR-DOMAIN/mcp` as a custom connector in claude.ai and sign in with your AiBinator password. **Open claude.ai** fills it in for you. |
| ChatGPT (web) | Create a connector with `https://YOUR-DOMAIN/mcp` in ChatGPT's Apps & Connectors with Developer mode on, and sign in with your AiBinator password. |

## Domain and local access

Enter the **Public domain** on the Apps page as a bare domain such as `aibi.example.com` (no `https://`, no path). AiBinator derives the HTTPS MCP and OAuth URLs from it and switches to its built-in sign-in. Clear it to go back to local-only access; the web connectors then stop working. Point the domain (a Cloudflare Tunnel or a reverse proxy) at `http://127.0.0.1:8789`.

Another MCP app connects to `http://127.0.0.1:8789/mcp` (your port) with `Authorization: Bearer` and the key in `.data/local.key`, or, with a public domain, to `https://YOUR-DOMAIN/mcp` and signs in with your AiBinator password. Discordinator uses port 8788 on this machine, so the two never clash.

The local key in `.data/local.key` is created automatically and kept private. It only works for requests with a `127.0.0.1` or `localhost` Host header, so traffic arriving through a tunnel can never use it.

<a id="install"></a>

## Install, update and uninstall

Installing from the wizard, the **System** page or `npm run aibinator -- install` gives AiBinator its own copy, like a normal program:

| | Linux | macOS | Windows |
| :-- | :-- | :-- | :-- |
| Installed copy and settings | `~/.local/share/aibinator` | `~/Library/Application Support/AiBinator` | `%LOCALAPPDATA%\AiBinator` |
| `aibinator` command | `~/.local/bin` | the first of `/opt/homebrew/bin`, `/usr/local/bin` or `~/.local/bin` on your PATH | `%LOCALAPPDATA%\Microsoft\WindowsApps` |
| Background service | systemd user service `aibinator.service` | launchd agent `com.github.devl0rd.aibinator` | hidden startup entry, no admin rights |
| Updates | every system update, plus the Home page | the Home page | the Home page |

The installed copy is a git checkout of the branch you installed from, following GitHub. Nothing runs from the folder you cloned, so you can move or delete it. The first install copies your settings (`.env`, `policy.json` and `.data`) into the installed copy. Only committed work is installed. Installing again, from any checkout, replaces the installed code and keeps your settings.

| Command | What it does |
| :-- | :-- |
| `aibinator` | Open the setup app on the installed copy, from any folder. |
| `aibinator install` | Install or reinstall from the current folder. |
| `aibinator update` | Pull the latest commits from GitHub, rebuild and restart the service. |
| `aibinator ports` | Linux: let programs use ports 53 and up, and open ufw to your network, for AIBI. See [AIBI](aibi.md#ports-on-linux). |
| `aibinator firmware <tool>` | AIBI firmware tools: `latest`, `decompile`, `patch`, `rebuild`, `toolchain`. See [Firmware](aibi.md#firmware-tools). |
| `aibinator uninstall` | Remove the service, the command, the update hook, the port permission and the code. Your settings stay, so installing again picks them up. |
| `aibinator uninstall --purge` | Also delete your settings. |

**Updates.** The **Home** page shows when GitHub has new commits; press <kbd>U</kbd> (or choose **Update and restart**) to pull them, rebuild and restart the service. On Linux, AiBinator also hooks into your package manager: after every pacman, dnf, zypper or apt transaction, `/usr/lib/aibinator/aibinator-update` updates it as you and restarts the service. Adding that hook asks for your password once; installing from the setup app skips it and tells you to run `aibinator install` in a terminal. When Node.js itself is upgraded, the next update reinstalls dependencies for the new version. An installed copy with local changes or commits that are not on GitHub is never overwritten; the update says why it stopped.

The service runs `dist/src/main.js` from the installed copy. On macOS and Windows it logs to `.data/service.log` there. Installing never leaves two copies running: a service that is already running is stopped, moved and started again. **Restart AiBinator** on the **System** page restarts it.
