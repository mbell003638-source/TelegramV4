# Meetings — rooms, notes, and putting an agent in the call

Two separate layers. Mixing them up is how "the agent joined" gets claimed
when it did not.

1. **Rooms** — Mission Control creates (or accepts) a meeting URL and persists
   the session. Notes can be written to Obsidian. No media stack is involved.
2. **A bot IN the call** — `core/MeetingBot.js` drives [Recall.ai](https://www.recall.ai/)
   so a named participant actually walks into Zoom / Google Meet / Teams / etc.,
   transcribes, and can speak TTS audio. This is the only path that puts
   anything in the call audio.

A plain Node process cannot join a WebRTC call on its own. MeetingBot does not
pretend otherwise.

---

## 1. Rooms (no Recall.ai key needed)

`POST /api/meetings/dispatch` (`core/MissionControl.js`) creates a session and
returns a URL. Gated by the `WARROOM_VOICE_ENABLED` kill switch.

| Provider | What you get |
|---|---|
| **Daily.co** (`provider: "daily"`) | A real room via `DAILY_API_KEY` (`POST https://api.daily.co/v1/rooms`). Without that key, falls back to MiroTalk. |
| **Google Meet** (`provider: "google"` / `"meet"`) | Uses the URL you paste, or `https://meet.google.com/new`. |
| **MiroTalk fallback** | `https://p2p.mirotalk.com/join/ClaudeClaw-<agent>-<id>` — no account, human-only. Used when Daily.co has no key, and for any other provider that did not supply a URL. |

Sessions persist in SQLite (`live_meetings`) and survive a restart.
`GET /api/meetings` lists them; `DELETE /api/meetings/:id` (or `DELETE /api/meetings`)
clears them.

The vanilla dashboard (`core/dashboardHtml.js`) and the Next.js WebUI both
call this dispatch endpoint. Opening the URL in a browser is still a
**human** joining the room.

---

## 2. Putting an agent IN the call

`core/MeetingBot.js` + Recall.ai. Recall runs the browser/media plumbing;
this repo only dispatches the bot and consumes the transcript.

```js
const MeetingBot = require('../core/MeetingBot');
const bot = MeetingBot.fromEnv({ database, memorySearch });

const result = await bot.join({
  meetUrl: 'https://meet.google.com/abc-defg-hij',
  sessionId,          // optional live_meetings row to attach the bot id to
  botName: 'ClaudeClaw Agent',
  transcription: true,
});
```

A successful join is explicit about what it bought:

```js
result.capabilities // { joinsCall: true, transcribes: true, speaks: true }
```

`speaks: true` only when `RECALL_API_KEY` is set (join never succeeds without
it). Create Bot always includes a hardcoded silent mp3 on
`automatic_audio_output.in_call_recording.data` so Recall will accept later
`POST /bot/{id}/output_audio`. Then:

```js
await bot.speak(botId, 'Hello everyone', { lang: 'en' });
// { ok: true, spoken: true, botId, chars: 15 }
```

TTS is Google Translate TTS (`google-tts-api` `getAllAudioBase64`). Pass an
injectable `tts: async (text, lang) => [{ b64, kind: 'mp3' }]` in tests so
Google is never hit. Without a key, `speak()` returns `{ ok:false, spoken:false,
code:'not_configured' }` and does not call the provider.

`index.js` constructs MeetingBot at boot and logs
`Meeting bot: configured` / `not configured (set RECALL_API_KEY)`.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RECALL_API_KEY` | **yes, to join or speak** | (empty) | Recall.ai API token. Without it, `join()` / `speak()` refuse. |
| `RECALL_API_BASE` | no | `https://us-west-2.recall.ai/api/v1` | Region / API base. |
| `RECALL_WEBHOOK_SECRET` | no | (empty) | HMAC-SHA256 of the raw webhook body. Unset → unsigned payloads are accepted and a warning is logged once. |
| `RECALL_BOT_NAME` | no | `ClaudeClaw Agent` | Display name shown in the call. |

`RECALL_API_KEY` is the only value `missingConfig()` / `join()` treat as
required. The others are optional.

### Capabilities

| | |
|---|---|
| **joinsCall** | yes — Zoom, Google Meet, Microsoft Teams, Webex, GoTo Meeting, Slack huddles, Amazon Chime, Daily.co, Whereby. |
| **transcribes** | yes — live (webhook) and pull (`transcript(botId)`). Never fabricated: no data yet means an empty array plus a status, not placeholder text. |
| **speaks** | **yes, when `RECALL_API_KEY` is set.** `speak(botId, text)` synthesizes mp3 with Google Translate TTS (`google-tts-api`) and plays it via Recall `POST /bot/{id}/output_audio`. Still needs the Recall key; TTS is not a paid voice vendor. |

`saveTranscriptToMemory(botId)` writes the real transcript into shared memory
so other agents can recall it. Empty transcripts are not written.

### Unsupported

- **MiroTalk P2P** (`p2p.mirotalk.com`) — human-only. Recall does not join it,
  so there is no bot to transcribe or speak.
- **Arbitrary WebRTC** — Recall supports a fixed host list. A hostname that
  is not on that list is not a silent success.

### No key = explicit refusal, never a fake success

With `RECALL_API_KEY` unset, `join()` returns (and does not throw):

```js
{
  ok: false,
  joined: false,
  configured: false,
  missing: ['RECALL_API_KEY'],
  code: 'not_configured',
  error: 'Cannot put an agent in the call: RECALL_API_KEY is not configured.',
  hint: '… See docs/MEETINGS.md.'
}
```

It never returns `joined: true` and never silently no-ops. The same
`not_configured` code is used by `leave()`, `status()`, `transcript()`, and
`speak()` when the key is missing. `speak()` also refuses empty text
(`code: 'empty_text'`) and maps TTS / Recall failures to `tts_error` /
`provider_error` without throwing.

---

## 3. Notes still sync to Obsidian without a bot

`POST /api/meetings/save-notes` writes a markdown file into the Obsidian
vault (`Meeting-<agentId>-<date>.md`) from whatever notes the HUD collected.
That path does not call Recall, does not need `RECALL_API_KEY`, and does not
wait for a bot transcript.

Room creation, session persistence, and note sync all work with no paid
meeting-bot service. Putting a participant **inside** the call is the part
that needs Recall.ai.
