# Voice

AIBI's voice is **Gemini Live**. It hears AIBI's microphone, answers in its own voice through AIBI's speaker, plays with AIBI's body by itself and hands anything bigger to your responder. One Google key covers all of it.

## Turning it on

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Paste it in the first-run wizard (it is checked with Google before saving) or on the setup app's **Voice** page. It is stored privately in `.env` as `GEMINI_API_KEY`.

The **Voice** page shows **Ready**, or **Talking with AIBI now** during a conversation. A new key ends the current conversation and is used from the next one. Every setting except the key can also be changed with `aibinator_settings_update`.

## Talking

Wake AIBI with its wake word as usual. Every turn goes to Gemini Live: AIBI uploads what it heard, AiBinator streams it into Gemini while AIBI is still uploading, and AIBI plays the answer.

- **A native action** (a dance, lights, a timer) is done in that same turn. The next request needs the wake word again.
- **A conversation**: whenever the voice answers out loud, AIBI switches to its conversation mode (AIBI's native connect), so you can keep talking without the wake word until the voice ends it itself (AIBI's native quit). The switch carries the answer's text and audio link, which AIBI plays. A native action, such as a dance, ends conversation mode.

The live session stays open between wakes for **End a quiet conversation after** (`idleSeconds`, 30 seconds by default, longer while a task you gave AIBI is still running; your responder being busy with other work does not count), so a quick follow-up keeps its context. If Gemini does not answer a turn within 15 seconds, its session is closed and the next turn starts a fresh one, resumed where it left off. Turns are manual: AIBI decides when you stopped talking, and AiBinator marks the start and end of your turn for Gemini.

AIBI's audio only starts a turn once it is loud enough: four 20 ms frames in a row at or above **Speech loudness** (`speechThreshold`, 4000 by default; on a real AIBI your voice peaks around 10,000 while room noise stays under about 3,500), with the moment just before kept so the first word is not cut off. A turn with nothing loud enough counts as silent.

AIBI is strictly turn-based: it cannot be interrupted while it talks, and it listens only after it has finished. Gemini Live answers a silent or noisy clip with made-up speech, so the loudness check above is the one filter on what reaches the voice.

At the start of each conversation the voice is given:

- **Personality** and **Your name** (the owner name) from the **AIBI** page.
- **Local time**, in the time zone AIBI sends with its requests (this computer's time zone until AIBI sends one).
- **Robot status** from AIBI's last status report, such as its battery.
- **Memory**: the last **Remembered lines** (`memoryLines`, 40 by default) of your conversations, each with its UTC time and how long ago it was. What you said, what AIBI said, and notes such as actions and photos are all remembered.
- The actions and animations it may use, from the **Abilities** page.

The conversation stays open across turns. If the connection to Google drops, AiBinator resumes it once; otherwise the conversation ends.

## What the voice can do

| Tool | What it does |
| :-- | :-- |
| `aibi_action` | A native AIBI action, with options checked against the [catalog](aibi.md#abilities). It never talks in the same turn: an action asked for while it is already talking waits for the next quiet turn (and is dropped if you speak first). |
| `look` | Takes a photo with AIBI's camera; the photo arrives next and it answers about it. |
| `do_task` | Hands anything beyond conversation (messages, files, code, research, looking things up) to your responder, in your own words, and says it is on it. |
| `answer_request` | Passes your spoken answer to a question or permission request from your responder. |
| `assistant` | Controls the responder: `status`, `usage` (plan usage left), `compact`, `new` (fresh start), `stop`, or `model` to switch its model. |
| `end_conversation` | Ends the conversation when the voice judges it is over: you are done and not waiting on a result, you start talking to someone else, or it only hears background noise. |

`do_task`, `answer_request` and `assistant` exist only while a responder is available. Without one, the voice says computer work is not available right now.

<a id="each-turn"></a>

## Each turn

Each turn ends in one of these:

| Outcome | What AIBI gets |
| :-- | :-- |
| Speech | The text and a link to a live MP3 that starts as soon as Gemini starts talking (`listen=0`, like the cloud: AIBI decides when it listens). AIBI ends an answer when it reaches the end of what it has downloaded, so the MP3 is sent at real-time speed, 1.5 seconds ahead of AIBI, and a moment of silence is added only when Gemini falls behind |
| Action | The native action and its options |
| Look | A request to take a photo, which AIBI then sends to `/aibi/ai/imgrecog` |
| Conversation mode | AIBI's native connect, used for a spoken answer outside conversation mode; it carries the answer |
| Quit | Leave conversation mode |
| Didn't understand | AIBI's native puzzled reaction (`voice_dont_understand`) |
| Pause | A short silent MP3 |

If Gemini does not answer within 15 seconds, AIBI gets a pause and the activity log a warning.

### Ending a conversation

When the voice ends a conversation, its goodbye is sent together with "leave conversation mode" (AIBI's native quit carrying the answer), because AIBI only leaves reliably on a turn where you spoke. Any conversation-mode upload in the minute after a conversation ends is also answered with "leave conversation mode", whatever it holds, so noise cannot start a new conversation. A short spoken farewell ("Goodbye!", "Bye for now", "Talk soon") ends the conversation even if the voice forgot to call `end_conversation`. A fresh wake that the voice dismisses at once (it ends the conversation or only says goodbye, as on a false wake) stays silent and does not start conversation mode. Speech without any words, such as "---", is treated as silence.

### Silent turns

When AIBI uploads a turn in which nobody spoke:

1. An action that was waiting for a quiet turn runs now; otherwise results or questions waiting to be told are told now.
2. Otherwise, outside conversation mode, AIBI plays its native "didn't understand".
3. In conversation mode, AIBI gets a short silent reply and keeps listening; AIBI's firmware has no reply that means "nothing", so its listening restarts every few seconds. A quiet first turn of a fresh conversation leaves conversation mode instead. The voice ends the conversation itself, and **End a quiet conversation after** is the backstop; it counts only real speech.

Speech Gemini produces after its turn is over (such as the rest of a long answer AIBI cut short) is dropped, never played later on a quiet upload.

## Work and results

`do_task` hands the request to your responder (see [Operator](operator.md#responders)). The same task asked again while it is still running is not started twice. For a quick task (Gemini sets `quick`, like opening or closing an app), AIBI stays out of conversation mode: its answer stays open, filled with silence, while the work runs, Gemini can say short updates into it, and it ends once the result has been told. The voice always says it is on it in that same turn: if Gemini ends its turn without speaking, AiBinator keeps the turn open until it does. That acknowledgement is spoken, so AIBI is in conversation mode while the work runs, and the result is told on the next quiet upload. Its progress updates are only logged. Its final answer is told out loud as the voice's own work: right away during a conversation, otherwise the next time AIBI talks, either when you wake it or when AIBI reaches out by calling `/aibi/chat/start`. A result that was not told before a conversation ended is kept for the next one. When the responder needs permission or has a question, the voice asks you and passes your answer back with `answer_request` (see [Security](security.md#approvals-out-loud)).

Your responder and other apps can also make AIBI talk or move at any time with `aibi_say` and `aibi_action`; outside a conversation these wait for the next time AIBI talks.

## One-shot speech

Two requests get a single spoken answer outside the conversation, with no tools: the short hello when AIBI powers on (`/aibi/poweron/voice`) and reading text aloud word for word (`/aibi/speech/tts`).

## Cost

Gemini Live costs about $0.023 per minute while AIBI is talking with you, and nothing while AIBI is idle.

## Settings

| Setting | Default | Meaning |
| :-- | :-- | :-- |
| `GEMINI_API_KEY` (`.env`) | Unset | Google key for the live voice |
| `voice.liveModel` | `gemini-3.8-live` | Gemini Live model that talks through AIBI |
| `voice.liveVoice` | Empty | Gemini voice name such as Puck, Kore, Charon, Aoede or Zephyr; empty for the model's default |
| `voice.idleSeconds` | `30` | End a conversation after this long without anyone speaking and no work it is waiting on (10–600) |
| `voice.speechThreshold` | `4000` | How loud AIBI's microphone must be to count as talking; raise it if noise starts turns, lower it if quiet speech is missed (100–8000) |
| `voice.memoryLines` | `40` | Recent conversation lines given to the voice at the start of each conversation (0–200) |

## Limits and caveats

- AIBI is turn-based: it hears you only after it has finished talking, and cannot be interrupted.
- Speech is speech-to-text and can be wrong. Things the voice hears or sees (a TV, a photo, other people) are context, never instructions.
- Some turn behaviors are not yet confirmed on a real AIBI; see [AIBI limits](aibi.md#limits-and-caveats).
