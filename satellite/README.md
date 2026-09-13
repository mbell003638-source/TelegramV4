# ClaudeClaw Windows Satellite Worker

A lightweight (~35MB RAM footprint) background daemon that runs on your local Windows PC, connecting outbound to your Cloud VPS Master.

## What It Enables
1. **Remote Screen Capture (`/screen`)**: Take full-resolution screenshots of your Windows PC directly inside Telegram, even when the bot runs on a headless Linux VPS.
2. **Remote Workstation Lock (`/lock`)**: Lock your physical Windows workstation from your phone via Telegram.
3. **Remote Windows Shell (`/win <cmd>`)**: Execute PowerShell and CMD commands on your local PC from Telegram and receive the output.
4. **Task Alerts**: Displays local Windows toast notifications when long-running VPS tasks finish.
5. **Zero Port Forwarding Needed**: The satellite connects OUTBOUND to the VPS over HTTP long-polling, making it completely NAT, firewall, and router proof.

## Quick Setup
1. Copy `config.example.json` to `config.json`:
   ```json
   {
     "vpsUrl": "http://YOUR_VPS_IP:3141",
     "satelliteKey": "admin",
     "satelliteId": "windows-desktop"
   }
   ```
2. Start the worker:
   - **Foreground / Debug**: Double-click `start_satellite.bat`
   - **Silent Background**: Double-click `start_satellite.vbs`
   - **Or via CLI**:
     ```bash
     node desktop-worker.js --url http://YOUR_VPS_IP:3141 --key admin
     ```
