// =============================================================================
//  core/KillSwitches.js — ClaudeClaw V3 Hot-Reloadable Kill Switches
//
//  Gates dangerous boundaries (LLM API calls, war room, dashboard mutations,
//  scheduler, auto-assign). Reloads automatically when .env changes.
// =============================================================================
const fs = require('fs');
const path = require('path');

const DEFAULT_SWITCHES = {
    LLM_SPAWN_ENABLED: true,
    WARROOM_TEXT_ENABLED: true,
    WARROOM_VOICE_ENABLED: true,
    DASHBOARD_MUTATIONS_ENABLED: true,
    MISSION_AUTO_ASSIGN_ENABLED: true,
    SCHEDULER_ENABLED: true,
};

class KillSwitches {
    constructor(baseDir = process.cwd()) {
        this.baseDir = baseDir;
        this.envPath = path.join(this.baseDir, '.env');
        this.lastMtime = 0;
        this.switches = { ...DEFAULT_SWITCHES };
        this._loadFromEnv();
    }

    _loadFromEnv() {
        try {
            if (fs.existsSync(this.envPath)) {
                const stat = fs.statSync(this.envPath);
                this.lastMtime = stat.mtimeMs;
                const content = fs.readFileSync(this.envPath, 'utf8');
                const lines = content.split(/\r?\n/);
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx === -1) continue;
                    const key = trimmed.slice(0, eqIdx).trim();
                    const val = trimmed.slice(eqIdx + 1).trim();
                    if (key in DEFAULT_SWITCHES) {
                        this.switches[key] = val.toLowerCase() !== 'false' && val !== '0';
                    }
                }
            } else {
                // Fallback to process.env
                for (const key of Object.keys(DEFAULT_SWITCHES)) {
                    if (key in process.env) {
                        const val = process.env[key];
                        this.switches[key] = val.toLowerCase() !== 'false' && val !== '0';
                    }
                }
            }
        } catch (err) {
            console.warn('[KillSwitches] Failed to read .env:', err.message);
        }
    }

    _checkReload() {
        try {
            if (fs.existsSync(this.envPath)) {
                const stat = fs.statSync(this.envPath);
                if (stat.mtimeMs !== this.lastMtime) {
                    this._loadFromEnv();
                }
            }
        } catch (e) {}
    }

    isEnabled(switchName) {
        this._checkReload();
        if (switchName in this.switches) {
            return this.switches[switchName];
        }
        return true;
    }

    getAll() {
        this._checkReload();
        return { ...this.switches };
    }

    set(switchName, boolValue) {
        if (!(switchName in DEFAULT_SWITCHES)) {
            throw new Error(`Unknown kill switch: ${switchName}`);
        }
        const val = Boolean(boolValue);
        this.switches[switchName] = val;

        // Persist to .env if it exists
        try {
            let content = '';
            if (fs.existsSync(this.envPath)) {
                content = fs.readFileSync(this.envPath, 'utf8');
            }
            const regex = new RegExp(`^${switchName}=.*$`, 'm');
            const newLine = `${switchName}=${val}`;
            if (regex.test(content)) {
                content = content.replace(regex, newLine);
            } else {
                content = content ? `${content.trim()}\n${newLine}\n` : `${newLine}\n`;
            }
            fs.writeFileSync(this.envPath, content, 'utf8');
            const stat = fs.statSync(this.envPath);
            this.lastMtime = stat.mtimeMs;
        } catch (err) {
            console.warn('[KillSwitches] Failed to persist switch to .env:', err.message);
        }
        return { [switchName]: val };
    }
}

module.exports = KillSwitches;
