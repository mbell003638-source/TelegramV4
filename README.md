# Agent OS

One control plane for every AI agent you already pay for — reachable from a
browser, Telegram, or WhatsApp, with one shared memory behind all of them.

Eight coding agents run as local CLI subprocesses on your existing
subscriptions: antigravity, opencode, codex, claude, openclaw, hermes, pi,
and grok. Hermes is the agent — there is no separate Harness. A unified
router puts a single API key in front of nine model providers. DeepSeek,
Kimi, Groq and Gemini are those router providers, not extra CLI adapters.
Each agent has its own switch to move it onto that router and back.

```
                    Telegram   WhatsApp   WebUI :3000   Android
                         \         |        |            /
                          \        |        |           /
                        Mission Control API (:3141)
                        GET /  →  WebUI    /legacy → vanilla HUD
                                   |
        ┌──────────────┬───────────┼───────────┬──────────────┐
        │              │           │           │              │
   8 CLI agents   OmniRouter   Shared      Scheduler     Devices
   claude          9 providers  memory     cron tasks    ADB / TV
   codex           1 master key  + FTS5     sweeps       satellites
   grok            failover      Obsidian
   hermes          key pools     vault
   opencode
   openclaw
   pi
   antigravity
```

## Quick start

Two processes, one UI: the bridge API on `:3141` and the WebUI (canonical
Mission Control) on `:3000`. The old vanilla HUD is at `/legacy`.

```bash
npm install
cd webui && npm install && cd ..
cp .env.example .env     # every setting is optional; see below

# macOS / Linux
chmod +x start.sh start.command   # once
./start.sh

# Windows
.\start.ps1
```

Open `http://127.0.0.1:3000`. The bridge prints the same pair of URLs. Set
`DASHBOARD_TOKEN` to something real before exposing it. `DASHBOARD_UI=legacy`
keeps the vanilla HUD at `GET /` instead of redirecting to the WebUI.

Nothing is required in `.env` to start. With no configuration you get Mission
Control and whichever agent CLIs are installed on the machine. Telegram,
WhatsApp, provider keys and sync are each additive.

`npm start` / `npm run start:all` boot only the bridge. `./start.sh` and
`.\start.ps1` are the dual launcher. `npm run start:ui` is the WebUI alone
(needs `webui/.next`, otherwise `cd webui && npm run dev`).

## The two features worth knowing

### One key, nine providers

The OmniRouter is the opencodex-style local proxy: one key in front of every
provider you have configured. The HTTP surface is OpenAI `/v1/chat/completions`
plus `/v1/models` and `/v1/usage`, Anthropic `/v1/messages` (Claude Code), and
OpenAI `/v1/responses` (Codex). `stream: true` on the translated routes is
token-by-token SSE (Anthropic `text_delta` / Responses `output_text.delta`).
Auth is `Authorization: Bearer` or `x-api-key`:

```bash
curl http://localhost:3141/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTER_KEY" \
  -d '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

Behind that one key: a model catalogue with cost accounting, failover across
providers with a circuit breaker (OmniRoute), and key-pool rotation (`priority`,
`round-robin`, `least-used`, `weighted` — 9router). OpenRouter is an optional
*upstream provider* (`OPENROUTER_API_KEY`), not the git this gateway was copied
from — that is [opencodex](https://github.com/lidge-jun/opencodex) (CLI/env
gateway, Anthropic Bearer vs X-Api-Key, model discovery). Claude Code and Codex
sit behind the same key via those env overlays.

Get the key with `GET /api/router/key`. One is generated at boot if you did not
set `OMNIROUTER_KEY`.

### A switch per agent

Each agent has its own toggle (WebUI Settings, and the Mission Control
OmniRouter card). Flipping it on re-points that agent at the router; flipping
it off restores exactly what was there before — a variable that was unset goes
back to *unset*, not to an empty string. For Claude, `ANTHROPIC_API_KEY` is
removed from the spawn env so it cannot fight `ANTHROPIC_AUTH_TOKEN`.

```bash
# Move only Grok onto the router, on a DeepSeek model
curl -X POST "http://localhost:3141/api/agents/override?token=$DASHBOARD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"grok","enabled":true,"model":"deepseek/deepseek-chat"}'

# Put it back
curl -X POST "http://localhost:3141/api/agents/override?token=$DASHBOARD_TOKEN" \
  -H 'Content-Type: application/json' -d '{"agentKey":"grok","enabled":false}'
```

It works by overlaying environment variables onto that agent's subprocess at
spawn time, so nothing global is mutated and one agent's override cannot leak
into another. For Claude the key is delivered as `ANTHROPIC_AUTH_TOKEN`
(`Authorization: Bearer`) rather than `ANTHROPIC_API_KEY` (`X-Api-Key`), because
the two together are an auth conflict — and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`
is set so every routed model appears in Claude Code's own `/model` picker.

## What else is in here

| Area | What it does |
|---|---|
| **Channels** | Telegram (`core/Gateway.js`) and WhatsApp Cloud API (`core/WhatsAppGateway.js`) with webhook signature verification, an allow-list and retry de-duplication |
| **Shared memory** | One store every agent reads and writes, searchable across sessions via SQLite FTS5 with a LIKE fallback (`core/MemorySearch.js`), mirrored into an Obsidian vault with a 3D graph view |
| **Task planner** | Decomposes a request into a dependency graph, picks a model per subtask, runs it topologically with capped concurrency and cycle detection, then synthesises one answer (`core/TaskPlanner.js`) |
| **Scheduler** | Real cron with a hand-written 5-field parser — no dependency — including standard day-of-month OR day-of-week semantics, an overlap guard and per-task error isolation (`core/Scheduler.js`) |
| **Self-improvement** | A sweep that learns from recent turns and reports what landed upstream in the seven projects this borrows from. Run it on demand or arm it daily (`POST /api/improve`) |
| **Devices** | Android over USB *and* over the network, so Android TV and Google TV are reachable — `adb connect`, wireless pairing, and 30 named remote keys (`core/DeviceAutomation.js`) |
| **Multi-machine** | Satellite workers (`core/SatelliteHub.js`) and Syncthing replication of the vault and memory store (`core/SyncthingBridge.js`) |
| **Voice** | Always-listening mode with a configurable wake word; ambient speech is never dispatched anywhere until the wake word is heard |
| **Safety** | Hot-reloadable kill switches, a DLP exfiltration guard, an approval gate, a loop guard, concurrency limits, and an audit log |

## Deploying to a VPS

The bridge binds `DASHBOARD_PORT` (3141). For phones and other devices to reach
it, set the WebUI's origin to the public one — it is inlined into the browser
bundle at build time, so `localhost` will not do:

```
NEXT_PUBLIC_BRIDGE_URL=https://your-host
NEXT_PUBLIC_BRIDGE_TOKEN=<matches DASHBOARD_TOKEN>
```

`scripts/deploy-vps.sh` and `scripts/claudeclaw.service` cover the systemd path.
Put TLS in front of it: WhatsApp's webhook requires HTTPS, and the dashboard
token travels as a query parameter.

## Android APK

A thin Compose client lives in `android/` (package `com.agentos.client`). See
[`android/README.md`](android/README.md).

- **CI** builds a debug APK on changes under `android/` (and on manual
  dispatch) via [`.github/workflows/android-apk.yml`](.github/workflows/android-apk.yml)
  and uploads it as the `app-debug-apk` artifact.
- **Local SDK** setup is documented in [`android/tools/SDK_SETUP.md`](android/tools/SDK_SETUP.md)
  (`android/tools/setup-android-sdk.ps1` on Windows).
- **Release signing** is documented in [`android/signing/RELEASE.md`](android/signing/RELEASE.md).

## Where the ideas come from

This is a Node/CommonJS application. The projects below are separate
applications in other languages — OpenClaw is ~43k files of TypeScript, Hermes
~13k files of Python — so their **capabilities** were reimplemented here
natively. Their code is not vendored in.

| Project | What was taken |
|---|---|
| [opencodex](https://github.com/lidge-jun/opencodex) | CLI/env gateway, Anthropic Bearer vs X-Api-Key, model discovery |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Provider failover chains |
| [9router](https://github.com/decolua/9router) | Key-pool rotation |
| [OpenClaw](https://github.com/openclaw/openclaw) | Gateway as control plane, swappable model plugins, many channels |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Self-improvement loop, FTS5 cross-session recall, cron delivery |
| [JARVIS / HuggingGPT](https://github.com/microsoft/JARVIS) | Plan → select model → execute → synthesise |
| [fullstack-agent](https://github.com/jaredrhod/fullstack-agent) | Memory vault, voice, visualiser, hand gestures |

OpenRouter is an optional *upstream provider* (`OPENROUTER_API_KEY`), not one
of these source repos.

`GET /api/upstream` reports what has changed in each of them since you last
looked. It only ever reports — merging an upstream change stays your decision.

## Honest limitations

- **MeetingBot speech uses Recall.ai + Google Translate TTS.** With
  `RECALL_API_KEY` set, `core/MeetingBot.js` joins Zoom / Meet / Teams / etc.,
  transcribes, and `speak()` plays mp3 into the call via Recall
  `output_audio`. MiroTalk P2P rooms stay human-only. See
  [docs/MEETINGS.md](docs/MEETINGS.md).
- **Unix launchers are syntax-checked, not booted on Mac hardware here.**
  `./start.sh`, `start.command`, and `satellite/start_satellite.sh` exist;
  `bash -n` passes. This environment is Windows.
- The Android client under `android/` is a thin gateway client; see
  `android/README.md` for its status.

Known issues and their fixes are tracked in [AUDIT.md](AUDIT.md);
[REQUIREMENTS.md](REQUIREMENTS.md) traces each requested feature to its actual
status. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers runtime problems.

## Tests

```bash
npm test          # node --test test/*.test.js
```

No test touches the network or the real `store/`.
