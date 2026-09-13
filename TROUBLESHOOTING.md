# Genie (Telegram Bridge v4) — Troubleshooting & Architecture Reference

## 1. Core Architecture
* **Name:** Genie (Telegram Bot)
* **Location:** `C:\Ai\telegram-bridge-v4`
* **Orchestration:** Scheduled task named `TelegramBridgeV4` that runs at system startup (via boot trigger).
* **Launch Mechanism:** Starts `wscript.exe` to run `start_hidden.vbs`, which spawns `node.exe index.js` in a hidden window.

## 2. Shared Token Conflict
* **CRITICAL RULE:** Telegram only allows **one active long-polling connection** per bot token. 
* **The Conflict:** If another bot instance or external service is running using the same token, it will steal polling updates, preventing this bridge from receiving messages.
* **Troubleshooting Action:** Ensure no other bot instances are polling with the same bot token.

## 3. Reboot & Boot-Time Startup Issues
* **The Symptom:** After a system reboot, the bot may not be running.
* **Why it Happens:** The scheduled task triggers at boot before the network interface is online. The bot attempts to connect, fails all retries, and exits.
* **The Silent Exit:** Because `start_hidden.vbs` launches Node asynchronously and exits immediately, the Task Scheduler registers a successful run and does not monitor or restart the crashed Node process.
* **Immediate Fix:** Run `Start-ScheduledTask -TaskName "TelegramBridgeV4"` to manually bring the bot back online once the network is connected.

## 4. Production Hardening Notes

### Codex Model-Cache Sync
If logs contain `unknown variant max` or `unknown variant ultra`, the installed Codex CLI is older than the model-cache schema it is downloading. The bridge detects and reports this condition and falls back to its static model list. Upgrade the Codex CLI to resolve the underlying cache/schema mismatch.
