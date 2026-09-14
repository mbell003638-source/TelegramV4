// =============================================================================
//  core/DeviceAutomation.js — The Hands: Android ADB Device Controller
//
//  Inspired by Sagar Tamang's Project U.L.T.R.O.N. "A Voice with Hands"
//  Enables physical Android phone control, live screen inspection, taps,
//  text entry, gestures, hardware buttons, and app launching.
// =============================================================================
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class DeviceAutomation {
    constructor() {
        this.adbPath = this._locateAdb();
        this.selectedDevice = null;
        this.cachedDevices = [];
        this.lastScanTime = 0;
    }

    _locateAdb() {
        const isWin = process.platform === 'win32';
        const home = os.homedir();

        // 1. Check system PATH
        try {
            const checkCmd = isWin ? 'where adb' : 'which adb';
            const out = execSync(checkCmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 1500 }).toString().trim();
            const first = out.split('\n')[0].trim();
            if (fs.existsSync(first)) return first;
        } catch { /* not in path */ }

        // 2. Check standard Android SDK locations
        const candidatePaths = isWin ? [
            path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
            path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Android', 'Android Studio', 'platform-tools', 'adb.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Android', 'android-sdk', 'platform-tools', 'adb.exe'),
            'C:\\platform-tools\\adb.exe',
            'C:\\Android\\platform-tools\\adb.exe'
        ] : [
            path.join(home, 'Library/Android/sdk/platform-tools/adb'),
            path.join(home, 'Android/Sdk/platform-tools/adb'),
            '/usr/local/bin/adb',
            '/usr/bin/adb'
        ];

        for (const candidate of candidatePaths) {
            if (candidate && fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    isAdbAvailable() {
        if (!this.adbPath) {
            this.adbPath = this._locateAdb();
        }
        return !!this.adbPath;
    }

    async listDevices(force = false) {
        const now = Date.now();
        if (!force && this.cachedDevices.length > 0 && (now - this.lastScanTime < 3000)) {
            return this.cachedDevices;
        }

        if (!this.isAdbAvailable()) {
            return [];
        }

        return new Promise((resolve) => {
            exec(`"${this.adbPath}" devices -l`, { timeout: 4000 }, (err, stdout) => {
                if (err || !stdout) {
                    this.cachedDevices = [];
                    return resolve([]);
                }

                const lines = stdout.split('\n');
                const devices = [];

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        const serial = parts[0];
                        const status = parts[1]; // device, unauthorized, offline

                        // Extract model and product if available
                        let model = 'Android Device';
                        let product = '';
                        for (let j = 2; j < parts.length; j++) {
                            if (parts[j].startsWith('model:')) {
                                model = parts[j].substring(6).replace(/_/g, ' ');
                            } else if (parts[j].startsWith('product:')) {
                                product = parts[j].substring(8);
                            }
                        }

                        devices.push({
                            serial,
                            status,
                            model,
                            product,
                            isOnline: status === 'device'
                        });
                    }
                }

                this.cachedDevices = devices;
                this.lastScanTime = Date.now();
                if (devices.length > 0 && !this.selectedDevice) {
                    this.selectedDevice = devices[0].serial;
                }
                resolve(devices);
            });
        });
    }

    async captureScreenshot(targetSerial = null) {
        if (!this.isAdbAvailable()) {
            throw new Error('ADB is not installed or not in PATH.');
        }

        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';

        return new Promise((resolve, reject) => {
            const cmd = `"${this.adbPath}" ${targetArg} exec-out screencap -p`;
            exec(cmd, { encoding: 'buffer', maxBuffer: 15 * 1024 * 1024, timeout: 6000 }, (err, stdout) => {
                if (err) {
                    return reject(new Error(`Screenshot failed: ${err.message}`));
                }
                if (!stdout || stdout.length < 100) {
                    return reject(new Error('Invalid image buffer received from device.'));
                }
                const base64 = stdout.toString('base64');
                resolve(`data:image/png;base64,${base64}`);
            });
        });
    }

    async tap(x, y, targetSerial = null) {
        if (!this.isAdbAvailable()) throw new Error('ADB not installed');
        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';
        const cmd = `"${this.adbPath}" ${targetArg} shell input tap ${Math.round(x)} ${Math.round(y)}`;
        return this._execCmd(cmd);
    }

    async swipe(x1, y1, x2, y2, durationMs = 300, targetSerial = null) {
        if (!this.isAdbAvailable()) throw new Error('ADB not installed');
        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';
        const cmd = `"${this.adbPath}" ${targetArg} shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${durationMs}`;
        return this._execCmd(cmd);
    }

    async inputText(text, targetSerial = null) {
        if (!this.isAdbAvailable()) throw new Error('ADB not installed');
        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';
        // Sanitize spaces and special chars for adb shell input text
        const sanitized = text.replace(/ /g, '%s').replace(/[&|<>]/g, '');
        const cmd = `"${this.adbPath}" ${targetArg} shell input text "${sanitized}"`;
        return this._execCmd(cmd);
    }

    async pressKey(keyCode, targetSerial = null) {
        if (!this.isAdbAvailable()) throw new Error('ADB not installed');
        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';
        const cmd = `"${this.adbPath}" ${targetArg} shell input keyevent ${keyCode}`;
        return this._execCmd(cmd);
    }

    async launchApp(packageName, targetSerial = null) {
        if (!this.isAdbAvailable()) throw new Error('ADB not installed');
        const serial = targetSerial || this.selectedDevice;
        const targetArg = serial ? `-s "${serial}"` : '';
        const cmd = `"${this.adbPath}" ${targetArg} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;
        return this._execCmd(cmd);
    }

    _execCmd(cmd, timeout = 5000) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve({ success: true, output: stdout.trim() });
            });
        });
    }

    // =========================================================================
    //  NETWORK DEVICES — Android TV, Google TV, and untethered phones
    //
    //  A TV has no USB cable to plug in, so `adb devices` alone never sees one.
    //  It has to be dialled over the network first (Settings > Developer
    //  options > Network debugging on the device). Once connected it behaves
    //  exactly like a USB device, so every method above works against it.
    // =========================================================================

    /** "192.168.1.50" -> "192.168.1.50:5555"; an explicit port is respected. */
    _normalizeTarget(host, port = 5555) {
        const text = String(host || '').trim();
        if (!text) throw new Error('A host or IP address is required');
        if (text.includes(':')) return text;
        return `${text}:${Number(port) || 5555}`;
    }

    /**
     * Connect to a network device (TV, phone on Wi-Fi).
     * adb reports failures on stdout with exit code 0, so the output has to be
     * inspected rather than trusting the exit status.
     */
    async connect(host, port = 5555) {
        if (!this.adbPath) this.adbPath = this._locateAdb();
        if (!this.adbPath) throw new Error('adb not found. Install Android platform-tools.');

        const target = this._normalizeTarget(host, port);
        const result = await this._execCmd(`"${this.adbPath}" connect ${target}`, 15000);
        const out = String(result.output || '');

        if (/^connected to|already connected/i.test(out)) {
            this.lastScanTime = 0; // force a rescan so the new device shows up
            return { success: true, target, output: out };
        }
        // "failed to connect", "unable to connect", "Connection refused"...
        throw new Error(`Could not connect to ${target}: ${out || 'no response from adb'}`);
    }

    async disconnect(host, port = 5555) {
        if (!this.adbPath) throw new Error('adb not found.');
        const target = this._normalizeTarget(host, port);
        const result = await this._execCmd(`"${this.adbPath}" disconnect ${target}`, 10000);
        this.lastScanTime = 0;
        if (this.selectedDevice === target) this.selectedDevice = null;
        return { success: true, target, output: result.output };
    }

    /**
     * Android 11+ wireless debugging pairs with a 6-digit code before it will
     * accept a connection. The pairing port is NOT the connect port — the
     * device shows both, and they differ.
     */
    async pairWireless(host, pairingPort, code) {
        if (!this.adbPath) throw new Error('adb not found.');
        const pairCode = String(code || '').trim();
        if (!/^\d{6}$/.test(pairCode)) {
            throw new Error('A 6-digit pairing code from the device is required');
        }
        const target = this._normalizeTarget(host, pairingPort);
        // The code goes on stdin as well as the argument, depending on version.
        const result = await this._execCmd(`"${this.adbPath}" pair ${target} ${pairCode}`, 30000);
        const out = String(result.output || '');
        if (/successfully paired/i.test(out)) {
            return { success: true, target, output: out };
        }
        throw new Error(`Pairing with ${target} failed: ${out || 'no response from adb'}`);
    }

    /**
     * Ask a USB-attached device to also listen on TCP, so it can be unplugged
     * and still driven. Returns the port to connect on.
     */
    async enableTcpip(port = 5555, targetSerial = null) {
        if (!this.adbPath) throw new Error('adb not found.');
        const targetArg = targetSerial ? `-s ${targetSerial}` : '';
        const result = await this._execCmd(`"${this.adbPath}" ${targetArg} tcpip ${Number(port) || 5555}`, 15000);
        return { success: true, port: Number(port) || 5555, output: result.output };
    }

    // =========================================================================
    //  TV REMOTE — D-pad and media keys
    //
    //  A TV has no touchscreen, so tap()/swipe() are useless on one. These are
    //  the keys an actual remote sends.
    // =========================================================================

    /** Named remote buttons -> Android keycodes. */
    static get REMOTE_KEYS() {
        return {
            up: 19, down: 20, left: 21, right: 22, ok: 23, select: 23, enter: 66,
            back: 4, home: 3, menu: 82, search: 84,
            play_pause: 85, stop: 86, next: 87, previous: 88,
            rewind: 89, fast_forward: 90,
            volume_up: 24, volume_down: 25, mute: 164,
            power: 26, sleep: 223, wakeup: 224,
            channel_up: 166, channel_down: 167,
            tv: 170, guide: 172, info: 165, captions: 175,
            dpad_center: 23, netflix: 0,
        };
    }

    /**
     * Press a named remote button (or a raw numeric keycode).
     * Named keys keep the caller out of the keycode table.
     */
    async remoteKey(name, targetSerial = null) {
        const keys = DeviceAutomation.REMOTE_KEYS;
        const raw = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
        const code = Number.isFinite(Number(name)) && String(name).trim() !== ''
            ? Number(name)
            : keys[raw];
        if (!code) {
            throw new Error(`Unknown remote key "${name}". Known: ${Object.keys(keys).join(', ')}`);
        }
        return this.pressKey(code, targetSerial);
    }

    /** Every named remote button, for building a UI remote. */
    getRemoteKeys() {
        return Object.keys(DeviceAutomation.REMOTE_KEYS).filter((k) => DeviceAutomation.REMOTE_KEYS[k] > 0);
    }

    /** Apps worth one tap on a TV, as opposed to the phone list above. */
    getTvApps() {
        return [
            { id: 'youtube_tv', name: 'YouTube', package: 'com.google.android.youtube.tv', emoji: '▶️' },
            { id: 'netflix', name: 'Netflix', package: 'com.netflix.ninja', emoji: '🎬' },
            { id: 'primevideo', name: 'Prime Video', package: 'com.amazon.amazonvideo.livingroom', emoji: '📺' },
            { id: 'disneyplus', name: 'Disney+', package: 'com.disney.disneyplus', emoji: '🏰' },
            { id: 'spotify', name: 'Spotify', package: 'com.spotify.tv.android', emoji: '🎵' },
            { id: 'plex', name: 'Plex', package: 'com.plexapp.android', emoji: '🎥' },
            { id: 'tv_settings', name: 'TV Settings', package: 'com.android.tv.settings', emoji: '⚙️' },
        ];
    }

    getQuickApps() {
        return [
            { id: 'youtube', name: 'YouTube', package: 'com.google.android.youtube', emoji: '▶️' },
            { id: 'chrome', name: 'Google Chrome', package: 'com.android.chrome', emoji: '🌐' },
            { id: 'settings', name: 'Settings', package: 'com.android.settings', emoji: '⚙️' },
            { id: 'camera', name: 'Camera', package: 'com.android.camera2', emoji: '📷' },
            { id: 'maps', name: 'Google Maps', package: 'com.google.android.apps.maps', emoji: '🗺️' },
            { id: 'calculator', name: 'Calculator', package: 'com.google.android.calculator', emoji: '🧮' },
            { id: 'playstore', name: 'Play Store', package: 'com.android.vending', emoji: '🛍️' },
        ];
    }
}

let instance = null;
function getDeviceAutomation() {
    if (!instance) {
        instance = new DeviceAutomation();
    }
    return instance;
}

module.exports = {
    DeviceAutomation,
    getDeviceAutomation,
};
