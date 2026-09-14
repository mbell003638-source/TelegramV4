# Requirements Traceability

Every request made in this session, traced to what is actually implemented and
verified. Status is deliberately strict:

- **Done** — implemented and exercised end to end (booted, called, asserted).
- **Already there** — existed before this session; I verified it rather than built it.
- **Partial** — works, but a named part of the request is not met. The shortfall is stated.
- **Not done** — not built. No hedging.

---

## 1. Audit and fix

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 1.1 | Audit the repo, find issues, fix them | **Done** | [AUDIT.md](AUDIT.md) — 12 findings; see commits `03c1952`…`064ec02` |
| 1.2 | Keep looping audit → fix → re-audit | **Done** | 3 rounds. Round 2 found the unreachable modules and route shadowing; Round 3 found the scheduler facade, the `Number(null)` bug, and the missing network ADB |

Bugs found and fixed that were not visible from the UI:

- Dashboard token hardcoded to a value the backend never defaults to → every WebUI→bridge call was a 401.
- `tick()` computed `now = 0` because `Number(null)` is `0` and `0` is finite → **no scheduled task would ever have fired in production.**
- `MissionControl` called `db.getScheduledTasks()`, a method that did not exist, behind a `?:` guard → `/api/tasks` silently returned `[]` forever.
- `/api/memories/search` was shadowed by a `startsWith('/api/memories')` catch-all → returned 200 with the wrong body.
- War Room voices and meeting sessions were instance fields → silently lost on every restart.
- `core/WarRoom.js` returned hardcoded prose as if it were real agent output → deleted.
- `store/*.json` was committable and will hold plaintext provider keys → gitignored.

---

## 2. The router — "one API key, many providers"

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 2.1 | One key in front of many providers | **Done** | `core/ProviderRouter.js`; 9 providers seeded |
| 2.2 | Best of OpenRouter / OmniRoute / 9router | **Done** | Catalog + cost accounting (OpenRouter), failover + circuit breaker (OmniRoute), key-pool rotation with 4 strategies (9router) |
| 2.3 | It is opencodex, not OpenRouter | **Done** | Studied `lidge-jun/opencodex`. Its research notes corrected two real bugs — see 2.4 |
| 2.4 | Reconfigure an agent to use the router's key | **Done** | `core/AgentOverrides.js`. opencodex's notes showed `ANTHROPIC_API_KEY` maps to `X-Api-Key` while the router needs `Authorization: Bearer`, so the key must go in `ANTHROPIC_AUTH_TOKEN` — and setting both is an auth conflict. Also sets `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` so Claude Code lists every routed model in its own `/model` picker |
| 2.5 | Toggle off restores the default | **Done** | Snapshot-based. Verified: `ANTHROPIC_BASE_URL` was restored to its real prior value, and vars that were unset return to **unset**, not empty string |
| 2.6 | Individual toggle per agent, **not** one switch for all | **Done** | `POST /api/agents/override` per `agentKey`. A master switch was built when asked for, then **removed** when you said you did not want it — verified returning 404 |
| 2.7 | External tools can use the one key | **Done** | OpenAI-compatible `/v1/chat/completions`, `/v1/models`, `/v1/usage`. Verified 401 without the key, 200 with it |

---

## 3. Agents, memory, interfaces

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 3.1 | All agents in one place | **Already there** | 8 registered: antigravity, opencode, codex, claude, openclaw, hermes, pi, grok |
| 3.2 | Use existing subscriptions, no third-party API required | **Already there** | Agents are local CLI subprocesses. The router is optional and additive |
| 3.3 | DeepSeek / Kimi / Groq / Gemini etc. available | **Done** | Seeded in the registry; reachable through the router |
| 3.4 | One permanent memory shared by all agents | **Already there** + **Done** | Shared store existed; I added `core/MemorySearch.js` so any agent can *search* what any other learned. FTS5 confirmed available (SQLite 3.51.3) with a LIKE fallback |
| 3.5 | Obsidian memory + 3D graph | **Already there** | `webui/app/globe/page.tsx`, `webui/app/vault/page.tsx`, `webui/lib/obsidian.ts` |
| 3.6 | Web UI mission control | **Already there** | Two front ends over one backend — see Known gaps |
| 3.7 | AMOLED black + blue accent | **Already there** | `#000000` ground, `#2563eb` / `#38bdf8` accents |
| 3.8 | Counsel with all the models | **Already there** + **Done** | War Room council existed; added `core/TaskPlanner.js` (JARVIS/HuggingGPT's plan → select model → execute → synthesize) |
| 3.9 | Self-learning | **Already there** + **Done** | Engine existed but only ran on a manual `/learn`. Now `POST /api/improve` runs it, and it can be armed on a cron |
| 3.10 | Daily improvement toggle | **Done** | `POST /api/improve {enabled:true}`, default `0 3 * * *`. Validates the cron up front; replaces rather than stacks |
| 3.11 | Pull new updates from all the reference repos | **Partial** | `core/UpstreamWatch.js` **reports** what landed across all 7 projects (5 via local git, 2 via GitHub API) — verified: 7 checked, 0 errored. It deliberately does **not** merge. Auto-merging code from 7 upstreams into a working app would break it; adopting a change stays your decision |
| 3.12 | Telegram | **Already there** | `core/Gateway.js` |
| 3.13 | WhatsApp | **Done** | `core/WhatsAppGateway.js` — Cloud API, signature verification, allow-list, retry de-duplication, no new dependencies |
| 3.14 | Hand gestures for UI and 3D globe | **Already there** | `webui/lib/handTracker.ts` + `globe/page.tsx`: MediaPipe pinch-to-orbit, dual-pinch-to-zoom. I initially mis-reported this as orphaned — my own grep filter hid the import. It is wired |

---

## 4. Voice and always-on

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 4.1 | Voice assistant | **Already there** | `JarvisAssistant.tsx`, `VoiceButton.tsx` |
| 4.2 | Always listening, waiting for a hot word | **Done** | Both paths were `continuous = false` (push-to-talk, no wake word). Added an Always Listening toggle with configurable wake word, restart-with-backoff (browsers end recognition every few seconds), and a hard cap so a denied mic cannot spin |
| 4.3 | Do things by voice | **Already there** | Voice commands dispatch to agents |

Privacy note: recognition is the browser's. While armed, ambient speech is shown
but **never dispatched anywhere** until the wake word is heard, and the panel
says so.

---

## 5. Machine and device reach

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 5.1 | Access everything on the computer | **Already there** | `ActionExecutor` shell execution, `ShellJobManager`, gated by `KillSwitches`, `SecurityApprovalGate`, `ExfiltrationGuard` |
| 5.2 | Windows / macOS / Linux | **Partial** | Path resolution and adb discovery cover all three; the agent adapters and launcher scripts are Windows-first (`.cmd`, `.vbs`, `.ps1`). Not verified on macOS or Linux |
| 5.3 | Android devices | **Already there** | `core/DeviceAutomation.js` — screenshot, tap, swipe, text, keys, launch |
| 5.4 | **Android TV / Google TV** | **Done** | These are network devices, so they were previously unreachable at any price. Added `connect` / `disconnect` / `pairWireless` / `enableTcpip`, plus 30 named remote keys (a TV has no touchscreen, so `tap` is useless on one) and TV package names. `adb` is not installed on this machine, so the live dial is unverified here |
| 5.5 | Control other devices from a master | **Already there** | `core/SatelliteHub.js` — register / poll / dispatch / response with auth |
| 5.6 | Run on a VPS | **Done** | Was impossible: the bridge origin was hardcoded to `localhost:3141` in 13 files. Now `NEXT_PUBLIC_BRIDGE_URL`. `scripts/deploy-vps.sh` and a systemd unit exist |
| 5.7 | Syncthing to sync two setups | **Not done** | Not started |

---

## 6. Meetings

| # | Request | Status | Evidence |
|---|---------|--------|----------|
| 6.1 | Meetings work | **Done** | Room creation via Daily.co, Google Meet, or a MiroTalk P2P fallback. Sessions now **persist** — they were in-memory and vanished on restart |
| 6.2 | Notes to Obsidian | **Already there** | `/api/meetings/save-notes` |
| 6.3 | **An agent actually joins the meeting** | **Partial** | The system creates the room, records the session, and syncs notes. No agent joins as a real audio/video participant — that needs a media bot (a Recall.ai key slot exists but nothing drives it). The current HUD is a local voice experience, not a participant in the call |

---

## 7. Parked by your instruction

| # | Request | Status |
|---|---------|--------|
| 7.1 | Android app as the interface, like OpenClaw's | **Parked** — you said "that is later once this project is completely finished" |

---

## Known gaps, stated plainly

1. **Syncthing** (5.7) — not started.
2. **Agent joining a meeting as a participant** (6.3) — needs a media bot.
3. **WebUI bypasses the backend.** `webui/app/api/chat/route.ts` re-implements agent spawning with its own paths and timeouts, bypassing `AgentPool`, `SessionStore`, `LoopGuard`, `KillSwitches`, `ExfiltrationGuard`, the audit log, and shared memory. Two code paths can run the same agent under different safety rules. Left deliberately — collapsing it is a behavioural change that deserves its own reviewed commit.
4. **Two front ends.** `core/dashboardHtml.js` (4,634 lines of vanilla HTML) and the Next.js `webui/` are separate UIs over the same backend.
5. **macOS / Linux unverified** (5.2).
6. **`MemorySearch` has no test file.** The agent writing it was killed by a rate limit. Verified manually (FTS5 mode, ranking, special-character queries) but not covered by an automated test.

## On "merge all the repos"

Worth being exact, because it shapes what is possible: OpenClaw is ~42,900 files
of TypeScript, Hermes ~13,073 files of **Python**, JARVIS is Python research
code, and fullstack-agent is a Claude Code installer wizard. This app is ~14k
lines of CommonJS Node. Those files cannot be literally merged in — doing so
would destroy the working application. What is real, and what was done, is
porting their **capabilities**, reimplemented natively in this stack.

---

*Baseline on arrival: 50 tests. Now: 125, all passing.*
