# AIBI

AIBI talks to its cloud at `api.aibipocket.com` over HTTP and HTTPS. AiBinator takes that name over on your network, so AIBI talks to your computer instead, and AiBinator decides what to answer.

## How AIBI reaches AiBinator

AiBinator runs three small servers for AIBI:

| Server | Port | What it does |
| :-- | :-- | :-- |
| HTTPS | 443 | AIBI's requests. Uses AiBinator's own self-signed certificate for `api.aibipocket.com`, created in `.data/aibi` (`tls.key`, `tls.crt`) the first time and recreated if it goes missing. AIBI accepted an expired self-signed certificate before, so it does not validate certificates. |
| HTTP | 80 | The same routes over plain HTTP. AIBI downloads its speech MP3s here. |
| DNS | 53 | Bound to this computer's network address. Answers `api.aibipocket.com` (and names under it) with this computer's address and forwards every other name to the upstream server, `1.1.1.1` by default. |

The HTTP and HTTPS servers listen on every network interface. The address AIBI is given is picked automatically (the one your computer uses to reach the internet, preferring Wi-Fi and Ethernet over virtual adapters), or set it yourself under **AIBI → Network → This computer's address**.

When AiBinator forwards a request to the real cloud, it looks up `api.aibipocket.com` through the upstream DNS server directly, never through the system resolver. So pointing this computer's own DNS at AiBinator never makes it loop back to itself.

## Connect AIBI

1. **Point AIBI's DNS here.** In your router's DHCP settings, give AIBI (or your whole network) this computer's address as its DNS server. The **AIBI** page shows the address to use.
2. **Keep this computer's address fixed**, with a DHCP reservation in the router, so AIBI keeps finding it.
3. **Restart AIBI.** The **AIBI** page shows "Last seen" as soon as it calls, and the activity log says "AIBI connected".

Every other name is forwarded, so the rest of your network works as before. If your router or another DNS server already points `api.aibipocket.com` at this computer, turn off **Built-in DNS server**.

### Ports on Linux

Linux only lets programs use ports below 1024 when allowed. Run this once (it asks for your password):

```sh
aibinator ports
```

It writes `/etc/sysctl.d/50-aibinator.conf` with `net.ipv4.ip_unprivileged_port_start=53` and applies it right away. This lets **any** program on this computer use ports 53 and up, not only AiBinator.

If the ufw firewall is on, it also adds two rules, tagged `AiBinator`, that let your local network (for example `192.168.50.0/24`) reach TCP ports 53, 80 and 443 and UDP port 53. Without them AIBI's DNS lookups are silently dropped and it stops answering. Ports count as ready only when both are in place.

`aibinator uninstall` removes the file, sets the value back to 1024 and deletes the rules. `aibinator install` on Linux asks for it too; from the setup app, which cannot ask for a password, it tells you to run `aibinator ports` instead. **AIBI → Allow ports 53, 80 and 443** does the same when ports are not allowed yet.

If a server cannot start, the **AIBI** page says why: permission denied (run `aibinator ports`), the port is already used by another program, or the configured address does not belong to this computer. Changing any network setting or the mode restarts the servers right away.

## Modes

| Mode | Who answers AIBI |
| :-- | :-- |
| **Local** (default) | AiBinator. The [Gemini Live voice](voice.md) talks with you and plays with AIBI's body, and hands real work to your responder. |
| **Pass-through** | AIBI's own cloud, as before. AiBinator forwards everything, logs what the cloud answered, reports new requests and behaviors, and captures firmware updates. |

## What AiBinator answers in Local mode

| Request | Answer |
| :-- | :-- |
| `POST /aibi/voice/detectintent` | Your voice turn. The audio is streamed into Gemini Live while AIBI is still uploading it, and the reply is speech, a native action, a photo request, the end of the conversation or a short pause. See [Voice](voice.md#each-turn). |
| `GET /tts/dl/…`, `GET /poweron/dl/…` | The voice's speech as a live MP3 stream (32 kHz mono, 64 kbps), sent as plain bytes while Gemini is still talking, and closed when the speech ends. Each stream is kept for two minutes. |
| `GET /aibi/permission` | Always allowed. |
| `POST /aibi/report/status` | Logged, and the summary (such as battery level) is given to the voice as AIBI's current status. |
| `POST /aibi/messages/send`, `GET /aibi/messages/receive`, `GET /aibi/messages/confirm` | Friend messages: a sent message is logged; there are never messages to receive. |
| `GET /aibi/poweron/voice` | A very short hello when AIBI powers on. |
| `GET /aibi/speech/tts` | Reads the given text aloud, word for word (up to 1,000 characters). |
| `GET /aibi/chat/start` | AIBI reaching out on its own, which it does a few seconds after some turns end: the voice tells any results or messages that are waiting, and otherwise AIBI is told there is nothing to say. |
| `POST /aibi/ai/imgrecog` | A camera photo. It is saved with the conversation and the voice answers about it. |

Known cloud requests (`/time`, `/token/…`, `/aibi/ota/res/…`, `/aibi/ota/allres/…` and `/aibi/ai/rockpaper`) are forwarded to the real cloud. Anything else is forwarded too, and logged as **New request** with its query and a summary of its body, at most once an hour per method and path. If the cloud cannot be reached, AIBI gets an error and the activity log a warning.

In Pass-through mode every request is forwarded. Cloud replies that carry a behavior or speech are logged with what AIBI heard and said, and any behavior that is not in the [action catalog](#abilities) is logged as **New behavior seen**, with its options.

Everything lands in the activity log (**Memory** page, `aibi_activity`, `.data/aibi/activity.json`, the last 500 entries).

## Traffic capture

Turn on **Capture raw traffic** (AIBI page, `aibi.capture`) to save every exchange with AIBI in `.data/aibi/traffic`: one JSON file per request with when it started and finished, the request line, headers and text bodies, the reply AiBinator or the cloud gave, and binary bodies (microphone audio, photos, firmware) as `.bin` files next to it. Speech downloads are noted rather than copied. Only the latest 1,000 exchanges are kept. It works in both modes, which makes it the way to study new AIBI behavior; it holds everything AIBI hears, so leave it off otherwise.

## Firmware

AiBinator never lets a cloud update install behind your back.

- **Trapping offers (both modes).** When AIBI asks `/aibi/ota/version`, AiBinator asks the cloud as an older version (1.5.0) so the cloud reveals its latest firmware. The offer is saved to `.data/firmware/ota-metadata.json`, every firmware link in it is downloaded into `.data/firmware`, and the links AIBI receives point at a blocked address that refuses the download.
- **Your patched firmware (both modes).** When `.data/firmware/patched` holds a `*-patched.zip` (the last one by name is used), AiBinator answers `/aibi/ota/version` itself with an offer for it, with its MD5, and serves the file to AIBI. The version comes from `.data/firmware/latest-firmware.json` or `.data/firmware/patched/metadata.json`.
- **AIBI's identity.** From AIBI's auth token AiBinator saves its device ID and firmware version, with its user agent, to `.data/firmware/aibi-identity.json` for the firmware tools.

In either mode, AIBI never receives a working link to a cloud firmware: without a patched package it only ever sees the blocked links.

### Firmware tools

`aibinator firmware <tool>` runs the original AiBi firmware tools from `tools/firmware` in the installed copy, with `.data` as their working folder, so everything they write ends up under `.data/firmware`. Pass `--help` after a tool for its options.

| Tool | What it does |
| :-- | :-- |
| `latest` | Finds the latest firmware, using AIBI's saved identity and the latest captured offer |
| `decompile` | Unpacks and analyzes a firmware |
| `patch` | Patches the unpacked firmware into `.data/firmware/patched` |
| `rebuild` | Rebuilds a firmware package |
| `toolchain` | Downloads the ESP32-S3 analysis tools |

The toolchain installer downloads the Windows ESP32-S3 toolchain only. On Linux and macOS install the `xtensa-esp32s3-elf` tools yourself. `decompile` works without them; it skips disassembly and says so.

<a id="abilities"></a>

## Abilities

AIBI's native actions come from a fixed catalog, `src/aibi/capabilities.json`: 47 actions (dancing, singing, games, slot machines, lights, turning, moods, timers, alarms, photos, volume, sleep and more) and 533 firmware animations. Every option is checked against the catalog before AIBI is asked to do anything.

On the **Abilities** page:

- **Actions**: the actions the voice and your apps may use. All of them are on by default; uncheck one to switch it off. `ability_chatgpt` and `interact_recognize` are used by AiBinator itself and are never offered as actions.
- **Animations**: the animations the voice may play with `interact_answer_with_animation`. All of them are on by default. The voice's instructions only name the ones that stand alone, not the `_start`, `_loop` and `_end` parts of a sequence.

Settings saved before actions became a list of enabled ones (`aibi.disabledActions`) are dropped once, which switches every action back on.
- **Allowed** (scopes): what connected apps may do. See [Security](security.md#what-apps-may-do).

## Limits and caveats

These parts are designed from AIBI's protocol but **not yet confirmed on a real AIBI**:

- How often AIBI calls `/aibi/chat/start` on its own. This is the only way AIBI can be reached first, so a result that finishes while no conversation is open waits for the next wake or reach-out.

Known limits:

- AIBI is turn-based: it hears you only after it has finished talking, and cannot be interrupted.
- One conversation at a time.
- The firmware tools are the original AiBi tools, run as they are.
