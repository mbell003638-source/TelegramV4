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

    _execCmd(cmd) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr || err.message));
                resolve({ success: true, output: stdout.trim() });
            });
        });
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
