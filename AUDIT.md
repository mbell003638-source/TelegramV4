# TelegramV4 — Audit Report

Audit of the Agent OS at commit `ced973a`, covering code health, wiring
correctness, and gaps against the intended "one place for every AI agent"
product goal.

Baseline on arrival: **50/50 tests passing**, all JS files syntactically valid,
`node_modules` not installed.

---

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | WebUI ships a hardcoded dashboard token that does not match the backend default | Critical | Fixed |
| 2 | Bridge host hardcoded to `localhost:3141` in 13 files — blocks VPS/remote use | Critical | Fixed |
| 3 | War Room voice assignments lost on every restart (in-memory only) | High | Fixed |
| 4 | Live meeting sessions lost on every restart (in-memory only) | High | Fixed |
| 5 | 1,446 lines of dead, superseded modules never imported anywhere | High | Fixed |
| 6 | `core/WarRoom.js` returned **fabricated** agent statements as if real | High | Fixed |
| 7 | Another person's Windows profile (`C:\Users\just2`) hardcoded in 15 places | Medium | Fixed |
| 8 | WebUI bypasses the backend and re-implements agent spawning | High | Documented |
| 9 | No provider router — "one key, many providers" did not exist | Critical gap | Built |
| 10 | No per-agent provider toggle | Critical gap | Built |
| 11 | No WhatsApp channel | Gap | Built |

---

## Findings in detail

### 1. Dashboard token mismatch (Critical)

Every WebUI → bridge call hardcoded `?token=earlyaidopters` across 14 call
sites, while the backend default (`.env.example`, `MissionControl`) is `admin`.
Unless the operator happened to set that exact string, **every** cross-process
call returned 401. This is the most likely root cause of the "some features
still don't look polished" symptom: the UI renders, but its data calls fail.

### 2. Hardcoded `localhost:3141` (Critical)

The bridge origin was inlined in 13 files. The stated goal is to run this on a
VPS and reach it from a phone, Android TV, and other devices — impossible while
every call points at loopback. Now driven by `NEXT_PUBLIC_BRIDGE_URL`.

### 3 & 4. State lost on restart (High)

`MissionControl._warRoomVoices` and `MissionControl._meetingSessions` were
plain instance fields. Assigning agent voices in Settings, or dispatching a
meeting, worked until the process restarted — then silently reverted. Both are
now persisted in SQLite (`agent_voices`, `live_meetings` tables) and verified
to survive a restart.

### 5 & 6. Dead code, including fabricated output (High)

Three modules were never imported by anything:

| Module | Lines | Superseded by |
|---|---|---|
| `core/DashboardServer.js` | 664 | `core/MissionControl.js` |
| `core/HiveMind.js` | 616 | `core/Database.js` |
| `core/WarRoom.js` | 166 | `MissionControl._queryCouncilDeliberation()` |

`HiveMind.js` opened a *second* SQLite handle against a different file
(`store/bridge.db`) while the live database is `store/assistant.db`, duplicating
7 of its 9 tables.

`WarRoom.js` is the one worth calling out: `getStandupUpdate()` and
`getDiscussPerspective()` returned **hardcoded prose** — invented agent
statements like "All bridge health checks nominal" — presented as genuine agent
output. Its council roster (`main`/`comms`/`content`/`ops`/`research`) did not
even match the real agent keys. Had it ever been wired up, the War Room would
have displayed fiction as real telemetry. Removed.

Two tables that only existed in the dead `HiveMind.js` (`agent_voices`,
`live_meetings`) were genuinely useful — they are the fix for findings 3 and 4
and were ported into `core/Database.js`.

### 7. Foreign user profile hardcoded (Medium)

`C:\Users\just2` appeared in 15 places. Two flavours: `process.env.USERPROFILE
|| 'C:\Users\just2'` fallbacks (mostly harmless, now `os.homedir()`), and
hardcoded `binaryPath` display strings in `Sidebar.tsx` and
`agents/[agentId]/page.tsx` that showed a stranger's filesystem paths in the UI
as though they had been detected. Now derived from the real agent scan.

### 8. Two divergent agent layers (High — later collapsed onto the bridge)

`webui/app/api/chat/route.ts` used to spawn CLI agents itself, bypassing
`AgentPool`, `SessionStore`, `LoopGuard`, `KillSwitches`, `ExfiltrationGuard`,
the audit log, and shared memory. That path is gone: the route now POSTs to
Mission Control `/api/chat/send` and polls `/api/chat/history` for a real
assistant turn. It does not invent a reply. See commit `206023a`.

---

## Next

1. Consolidate the two UIs — `core/dashboardHtml.js` (4,634 lines of vanilla
   HTML) and the Next.js `webui/` are separate front ends over the same backend.
2. `package.json` has no `start` script and `"description"`/`"author"` are
   empty; `test` runs `node --test test/*.test.js`.
3. Meeting bot still cannot speak in a call (`core/MeetingBot.js` listens and
   transcribes via Recall.ai only). macOS/Linux remain unverified.
