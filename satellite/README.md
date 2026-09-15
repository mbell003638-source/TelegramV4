# ClaudeClaw Windows Satellite Worker

A lightweight (~35MB RAM) daemon that runs on a second PC and **polls out** to
the Mission Control master on your VPS. That is how a headless Linux VPS
screenshots, locks, or shells a Windows box behind NAT.

## Honest networking

The VPS **cannot magically reach a NAT'd PC**. There is no inbound hole to
punch, no UPnP, no agent the master "discovers" on the LAN.

1. You start this worker on the second machine.
2. The worker makes **outbound** HTTPS/HTTP long-polls to
   `http(s)://YOUR_VPS:3141/api/satellite/*`.
3. When Mission Control has work (Telegram `/screen`, `/lock`, `/win`, or the
   Satellites page), the next poll returns a command. The worker runs it
   locally and POSTs the result back.

If the worker is not running, the VPS has nothing to talk to. Firewalls on
the PC only need to allow **outbound** TCP to the VPS port (default 3141).
Nothing is listening on the PC.

The Next.js UI uses `NEXT_PUBLIC_BRIDGE_URL` to reach the same master. The
worker does **not** read that variable — it uses `vpsUrl` / `VPS_URL` / `--url`.

## Token

`satelliteKey` must match `SATELLITE_KEY` in the VPS `.env`. If `SATELLITE_KEY`
is unset on the VPS, it falls back to `DASHBOARD_TOKEN`. Do not leave either
at the example value `admin` on a public host.

A dedicated `SATELLITE_KEY` is stronger than reusing the dashboard token: a
leaked Mission Control URL cannot impersonate this worker and steal queued
commands (screenshots, shell output).

## Quick setup (second PC)

1. Copy this `satellite/` folder (or the whole repo) onto the Windows machine.
2. Copy `config.example.json` to `config.json` and point it at the VPS:

   ```json
   {
     "vpsUrl": "http://YOUR_VPS_IP:3141",
     "satelliteKey": "YOUR_SATELLITE_KEY",
     "satelliteId": "windows-desktop"
   }
   ```

   `vpsUrl` is the public origin of Mission Control — the same host you open
   in a browser as `http://YOUR_VPS_IP:3141/?token=...`. Use `https://` if
   you terminate TLS in front of port 3141.

3. Start the worker (it must keep running):

   - **Foreground / Debug**: double-click `start_satellite.bat` (Windows) or `./start_satellite.sh` (macOS/Linux)
   - **Silent background**: double-click `start_satellite.vbs`
   - **CLI**:

     ```bash
     node desktop-worker.js --url http://YOUR_VPS_IP:3141 --key YOUR_SATELLITE_KEY --id windows-desktop
     ```

   Environment variables work too: `VPS_URL`, `SATELLITE_KEY`, `SATELLITE_ID`.
   CLI flags override env, which overrides `config.json`.

4. On the VPS you should see `[SatelliteHub] Registered new satellite: ...`.
   Telegram `/satellite` and the web UI at `/satellites` list it as online.

5. Dispatch work from the master (Telegram `/screen`, `/lock`, `/win dir`,
   or the Satellites page). The worker logs `Executing command: ...`.

## Routes the worker calls

All of these require `Authorization: Bearer <satelliteKey>`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/satellite/register` | Enroll / heartbeat (id, hostname, metrics) |
| POST | `/api/satellite/poll` | Long-poll for the next command |
| POST | `/api/satellite/response` | Return command result (may include a large screenshot) |

The master (dashboard token) additionally exposes:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/satellite/status` | List registered workers |
| POST | `/api/satellite/dispatch` | Queue a command for a worker |

## What it can run

`screen.capture`, `pc.lock`, `cmd.exec`, `notify.toast`, `sys.info`. Anything
else is rejected by both the hub and the worker.

## VPS side (already deployed)

`scripts/deploy-vps.sh` opens TCP 3141 and prints the worker command. After
deploy:

```bash
# on the VPS
nano /opt/claudeclaw/.env   # set SATELLITE_KEY and DASHBOARD_TOKEN
systemctl start claudeclaw

# on the Windows PC
node desktop-worker.js --url http://YOUR_VPS_IP:3141 --key YOUR_SATELLITE_KEY
```

If the worker prints `Cannot reach VPS Master`, the URL is wrong, port 3141
is firewalled inbound on the VPS, or Mission Control is not running. If it
prints `Master rejected authentication token`, the key does not match.
