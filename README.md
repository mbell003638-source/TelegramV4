# Agent OS

One control plane for every AI agent you already pay for — reachable from a
browser, Telegram, or WhatsApp, with one shared memory behind all of them.

Eight coding agents run as local CLI subprocesses on your existing
subscriptions. A unified router puts a single API key in front of nine model
providers. Each agent has its own switch to move it onto that router and back.

```
                    Telegram   WhatsApp   Web UI   Android
                         \         |        |        /
                          \        |        |       /
                        Mission Control (:3141)
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

```bash
npm install
cp .env.example .env     # every setting is optional; see below
node index.js
```

Then open the URL the startup banner prints — `http://localhost:3141/?token=admin`
by default. Set `DASHBOARD_TOKEN` to something real before exposing it.

Nothing is required in `.env` to start. With no configuration you get the web
Mission Control and whichever agent CLIs are installed on the machine. Telegram,
WhatsApp, provider keys and sync are each additive.

The Next.js UI (3D memory globe, gesture control, voice assistant) is separate:

```bash
cd webui && npm install && npm run dev
```

## The two features worth knowing

### One key, nine providers

The OmniRouter serves an OpenAI-compatible API at `/v1`, so **any** tool that
speaks OpenAI can point at it with one key and reach every provider you have
configured:

```bash
curl http://localhost:3141/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTER_KEY" \
  -d '{"model":"anthropic/claude-sonnet-5","messages":[{"role":"user","content":"hi"}]}'
```

Behind that one key: a model catalogue with cost accounting, failover across
providers with a circuit breaker, and key-pool rotation (`priority`,
`round-robin`, `least-used`, `weighted`). It also speaks the **Anthropic**
Messages API at `/v1/messages`, so Claude Code itself can be pointed at it.

Get the key with `GET /api/router/key`. One is generated at boot if you did not
set `OMNIROUTER_KEY`.

### A switch per agent

Each agent has its own toggle. Flipping it on re-points that agent at the
router; flipping it off restores exactly what was there before — a variable
that was unset goes back to *unset*, not to an empty string.

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

## Where the ideas come from

This is a Node/CommonJS application. The projects below are separate
applications in other languages — OpenClaw is ~43k files of TypeScript, Hermes
~13k files of Python — so their **capabilities** were reimplemented here
natively. Their code is not vendored in.

| Project | What was taken |
|---|---|
| [OpenRouter](https://github.com/OpenRouterTeam) | Unified API surface, model catalogue, cost accounting |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Provider failover chains |
| [9router](https://github.com/decolua/9router) | Key-pool rotation |
| [opencodex](https://github.com/lidge-jun/opencodex) | Pointing CLI agents at a gateway via env, and the auth details that makes work |
| [OpenClaw](https://github.com/openclaw/openclaw) | Gateway as control plane, swappable model plugins, many channels |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Self-improvement loop, FTS5 cross-session recall, cron delivery |
| [JARVIS / HuggingGPT](https://github.com/microsoft/JARVIS) | Plan → select model → execute → synthesise |
| [fullstack-agent](https://github.com/jaredrhod/fullstack-agent) | Memory vault, voice, visualiser, hand gestures |

`GET /api/upstream` reports what has changed in each of them since you last
looked. It only ever reports — merging an upstream change stays your decision.

## Honest limitations

- **An agent does not join a meeting as a participant.** Rooms are created and
  notes sync to Obsidian, but nothing joins the call audio; that needs a media
  bot.
- **macOS and Linux are unverified.** Paths and `adb` discovery cover all three,
  but the agent adapters and launcher scripts are Windows-first.
- **Two front ends.** `core/dashboardHtml.js` (vanilla) and `webui/` (Next.js)
  are separate UIs over the same backend.
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
