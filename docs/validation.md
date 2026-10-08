# Practical validation

`npm run quality` runs the static checks described in [Quality](quality.md). `npm run validate` runs the offline suite, `npm run coverage` runs it with coverage, and `npm run validate:banner` checks the README banners in headless Chrome.

Run everything from the project root:

```sh
npm ci --ignore-scripts
npm run setup:spelling
npm run quality
npm run build
npm run validate
npm run validate:banner
npm audit --omit=dev
```

`npm run validate:connection` runs only the HTTP, auth and connection checks, and `npm run validate:oauth` only the sign-in checks.

The suite uses Node assertions, fake AIBI and Gemini sessions and temporary loopback servers. Its temporary folder inside the ignored `.data/` is removed afterwards. It needs no AIBI, no Gemini key and no network, and changes nothing outside this folder.

## Current state

`scripts/validate.ts` still imports Discordinator-era check scripts that no longer exist in `scripts/` (such as `check-policy`, `check-events`, `check-media` and the voice-call checks), so `npm run validate`, `npm run coverage`, `npm run validate:connection` and `npm run validate:oauth` currently stop before running anything. The AIBI checks below exist but are not yet called from `validate.ts`.

## AIBI checks

| Script | What it checks |
| :-- | :-- |
| `check-aibi-wire.ts` | HTTP parsing in any split, chunked and close-delimited bodies, compressed bodies, AIBI's big-endian audio, 32 kHz MP3 output and the speech gate |
| `check-aibi-network.ts` | DNS answers for `api.aibipocket.com`, forwarding of other names, the older-version firmware request, firmware link capture and the patched offer |
| `check-aibi-proxy.ts` | The HTTPS and HTTP servers end to end: permission, speech served as MP3 over HTTP, missing speech, blocked firmware downloads, forwarded known requests, new requests reported once, status reports |
| `check-aibi-voice.ts` | A voice turn: turn start and end around the audio, switching to conversation mode with the answer, time zone and robot status in the voice's instructions, finished speech streams, ending a conversation |
| `check-aibi-tasks.ts` | Handing work to the responder, progress only logged, results told on the next silent turn, waiting briefly for running work, the quiet pause |

## What is not covered

Offline checks do not establish how a real AIBI behaves. In particular, whether AIBI plays the answer that comes with the switch to conversation mode and how often AIBI reaches out on its own are not yet confirmed on a real AIBI; see [AIBI limits](aibi.md#limits-and-caveats). Live Gemini Live sessions, real responders, public HTTPS sign-in and Windows or macOS services also need testing on the real thing.

## CI

The **Quality** workflow runs the static checks on Ubuntu, and the tests job runs the build, `npm run coverage` (on Ubuntu and Windows) and the banner check (on Ubuntu). Coverage must stay at or above 88% of lines, statements and functions and 80% of branches.
