# Capability reference

The MCP server exposes 12 tools. Tool discovery returns their exact schemas, defaults and bounds, and unknown input fields are rejected. Which scope each tool needs is set on the **Abilities** page; see [Security](security.md#what-apps-may-do).

## Answering requests

| Tool | Scope | Contract |
| :-- | :-- | :-- |
| `aibi_reply` | Always allowed | Answer a request handed over by AIBI's voice, by its `eventId`. `text` up to 4,000 characters. Without `progress` it is told out loud by the voice, right away during a conversation or the next time AIBI talks; with `progress: true` it is only logged. Optional `idempotencyKey` for retries. |
| `events_poll` | Always allowed | For apps that are not the responder, such as **Another MCP app**: up to 25 requests after a cursor, waiting at most 20 seconds. Returns `epoch`, `events`, `nextCursor`, `latestCursor`, `gap`, `discardedThrough` and `droppedOnDedupeLimit`. |

## Making AIBI talk and move

| Tool | Scope | Contract |
| :-- | :-- | :-- |
| `aibi_say` | `aibi.speak` | The voice says this in its own words (up to 2,000 characters): right away during a conversation, otherwise the next time AIBI talks or reaches out. Returns whether it was delivered `now` or `later`. Several messages waiting at once are told as one short message that keeps every important detail. |
| `aibi_action` | `aibi.act` | Play a switched-on native action (see `aibi_actions`) with its `options`, checked against the catalog. Only during a conversation: otherwise it returns `delivered: false` and nothing is saved for later. |

## Reading

| Tool | Scope | Contract |
| :-- | :-- | :-- |
| `aibinator_status` | `aibi.read` | Mode, address, server and DNS state, ports, when AIBI last called, its last status report, the voice (conversation open, results waiting, tasks running), memory size, recent conversation and activity, and the responder |
| `aibi_actions` | `aibi.read` | The switched-on actions with descriptions and options, and the allowed animations |
| `aibi_history` | `aibi.read` | The conversation, oldest first, up to 200 lines per page; page back with `before` (the id of the oldest line you have) |
| `aibi_activity` | `aibi.read` | Recent activity, up to 200 entries, optionally one `kind`: `heard`, `said`, `action`, `chat`, `task`, `status`, `request`, `unknown`, `firmware`, `network` or `warning` |

## Memory

| Tool | Scope | Contract |
| :-- | :-- | :-- |
| `aibi_history_delete` | `memory.write` | Forget one line by id, with its photo |
| `aibi_history_clear` | `memory.write` | Forget the whole conversation and its photos |

## Settings

| Tool | Access | Contract |
| :-- | :-- | :-- |
| `aibinator_settings` | Authenticated owner | Every setting with its id, meaning, allowed values and current value; secrets show only whether they are set |
| `aibinator_settings_update` | Authenticated owner | Change up to 25 settings by id, validated and applied exactly like the setup app. Changing `operator.mode` switches the responder. Secrets cannot be changed here. |

## The voice's own tools

The Gemini Live voice has its own tools, which are not MCP tools: `aibi_action`, `look`, `do_task`, `answer_request`, `assistant` and `end_conversation`. See [Voice](voice.md#what-the-voice-can-do).

## Native actions

The action catalog is fixed in `src/aibi/capabilities.json`: 47 actions and 533 animations. Options are only accepted from the catalog's lists, numbers where a number is expected, `HH:mm` for alarm times and allowed animation names for `interact_answer_with_animation`. `ability_chatgpt` and `interact_recognize` are used by AiBinator itself and are never available as actions. See [Abilities](aibi.md#abilities).
