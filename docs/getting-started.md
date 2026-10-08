# Get started

This guide takes you from a fresh checkout to AIBI answering with its new brain. The setup app does most of the work.

## What you need

- Node.js 22.16 or newer, with npm.
- An AIBI on the same network as this computer, and access to your router's DHCP or DNS settings.
- A Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) for AIBI's voice.
- Claude Code or Codex, installed and signed in, for real work. Any MCP app works too, but then it answers requests itself.
- A public HTTPS domain only if you want the optional web connectors for claude.ai or ChatGPT.

## 1. Install and run setup

```sh
git clone https://github.com/DevL0rd/AiBinator.git aibinator
cd aibinator
npm ci --ignore-scripts
npm run aibinator
```

`npm run aibinator` opens a full-screen terminal setup app that works with keyboard and mouse. On first run it is a short wizard:

| Step | What happens |
| :-- | :-- |
| Welcome | What AiBinator does. |
| Your name | What AIBI calls you. Leave it empty to skip. |
| AIBI's voice | Paste your Gemini key. It is checked with Google before it is saved. |
| Who does the work | Choose the responder: Claude Code, Codex or Another MCP app. See [Operator](operator.md#responders). |
| Password | Only when a public domain is already set: the sign-in password for apps on your domain. |
| Review | Checks that the responder is installed and signed in, then saves it. |
| Connect | For Claude Code or Codex, AiBinator connects it on this computer with nothing to sign in to. |
| Install | Installs AiBinator: its own copy, the `aibinator` command and a background service that starts when you log in. You can skip it. See [Install, update and uninstall](operator.md#install). |
| Ports | On Linux, waits until ports 53, 80 and 443 are allowed and not blocked by ufw: run `aibinator ports` in another terminal (or `npm run aibinator -- ports` from the cloned folder). |
| Point AIBI here | Shows this computer's address. Give it to AIBI as its DNS server in your router, keep the address fixed and restart AIBI. The screen continues by itself as soon as AIBI calls, or choose **Skip for now**. |
| Check | Shows what is still missing. **Finish** starts the responder. "AIBI has called" is optional, so you can finish first and connect AIBI later. |

If you quit part-way, setup resumes where you left off. After the wizard you land on the dashboard; [Operator](operator.md) explains every page and [AIBI](aibi.md) explains the connection in detail.

## 2. Run AiBinator

Install it from the wizard, the setup app's **System** page, or a terminal:

```sh
npm run aibinator -- install
```

From then on AiBinator runs from its own installed copy, so you can delete the folder you cloned, and `aibinator` in any terminal opens the setup app.

To try it without installing, run it in the foreground instead:

```sh
npm run build
npm start
```

Press **p** on the setup app's **Home** page to pause and resume the responder.

## 3. Talk to AIBI

Wake AIBI with its wake word and say hello. The answer comes from Gemini Live in AIBI's voice. Chat with it and it switches AIBI to conversation mode, so you can keep talking without the wake word. Ask it to dance, change its lights or look at something, and it does that by itself. Ask for real work, such as checking a build or looking something up, and it hands that to your responder and tells you the result. [Voice](voice.md) explains how a conversation works.

## Editing files by hand

You normally never need to. If you do, copy the examples once and edit locally:

```sh
cp -n .env.example .env
cp -n policy.example.json policy.json
```

Keep any existing `.env` and `policy.json`. `.env` needs `GEMINI_API_KEY` and, in the default bearer mode, an `AIBINATOR_MCP_TOKEN` of at least 32 characters (the wizard creates one). See [Configuration](configuration.md) for every field.

## Troubleshooting

| Symptom | Check |
| :-- | :-- |
| AiBinator will not start | Valid `.env` and `policy.json`, a bearer token of at least 32 characters, a free MCP port. Process environment overrides `.env`. |
| AIBI server or DNS server did not start | The **AIBI** page says why: run `aibinator ports`, free ports 53, 80 and 443, or fix **This computer's address**. |
| AIBI never calls | AIBI's DNS server is this computer's address, the address has not changed, and AIBI was restarted afterwards. |
| AIBI answers but cannot do real work | The responder is started on **Home** and not blocked; the Home page says why. |
| Nothing is said back | The Gemini key on the **Voice** page, and warnings on **Memory**. |
| A cloud app cannot connect | Public domain, HTTPS proxy and sign-in password. See [Connection](connection.md). |
