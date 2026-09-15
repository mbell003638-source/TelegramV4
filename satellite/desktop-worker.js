// =============================================================================
//  satellite/desktop-worker.js — Lightweight Windows Satellite Worker Daemon
//
//  Runs on the local Windows machine (~35MB RAM footprint).
//  Connects outbound to the Cloud VPS Mission Control Server.
//
//  Capabilities:
//    - Desktop Screenshots (/screen)
//    - Workstation Lock (/lock)
//    - Windows Shell Execution (/win <cmd>)
//    - Native Toast Notifications (on task completion)
//    - Local hardware telemetry (CPU, RAM, Uptime)
//
//  NAT/Firewall-Proof: Outbound HTTP long-polling (zero port forwards needed).
// =============================================================================

const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 1. Load configuration from file, env, or CLI flags
function loadConfig() {
    let fileConfig = {};
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.warn(`[Worker] Warning: could not parse config.json: ${e.message}`);
        }
    }

    // CLI args: --url <vps_url> --key <key> --id <id>
    const args = process.argv.slice(2);
    const cliArgs = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) cliArgs.vpsUrl = args[++i];
        if (args[i] === '--key' && args[i + 1]) cliArgs.satelliteKey = args[++i];
        if (args[i] === '--id' && args[i + 1]) cliArgs.satelliteId = args[++i];
    }

    return {
        vpsUrl: cliArgs.vpsUrl || process.env.VPS_URL || fileConfig.vpsUrl || 'http://127.0.0.1:3141',
        satelliteKey: cliArgs.satelliteKey || process.env.SATELLITE_KEY || fileConfig.satelliteKey || 'admin',
        satelliteId: cliArgs.satelliteId || process.env.SATELLITE_ID || fileConfig.satelliteId || `win-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        pollTimeoutMs: 30000,
        reconnectDelayMs: 3000,
        maxReconnectDelayMs: 30000,
    };
}

const config = loadConfig();

console.log('====================================================');
console.log('🤖 ClaudeClaw Windows Satellite Worker Online');
console.log(`   Satellite ID : ${config.satelliteId}`);
console.log(`   Host Machine : ${os.hostname()} (${os.platform()} ${os.arch()})`);
console.log(`   Master VPS   : ${config.vpsUrl}`);
console.log('====================================================');

/**
 * Gather local system hardware metrics.
 */
function getSystemMetrics() {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpuCores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        totalMemMb: totalMem,
        freeMemMb: freeMem,
        usedMemMb: totalMem - freeMem,
        uptimeSeconds: Math.floor(os.uptime()),
    };
}

/**
 * Execute command locally via PowerShell.
 */
function execLocalCommand(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { shell: 'powershell.exe', timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                hostname: os.hostname(),
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: err ? (err.code || 1) : 0,
                error: err ? err.message : null,
            });
        });
    });
}

/**
 * Lock the Windows workstation.
 */
function lockWorkstation() {
    return new Promise((resolve, reject) => {
        try {
            // First attempt tsdiscon for session disconnect, then fallback to LockWorkStation
            exec('rundll32.exe user32.dll,LockWorkStation', (err) => {
                if (err) return reject(err);
                resolve({ success: true, hostname: os.hostname() });
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Capture physical desktop screenshot.
 */
async function captureScreenshot() {
    // 1. Try screenshot-desktop if available
    try {
        const screenshot = require('screenshot-desktop');
        const imgBuffer = await screenshot({ format: 'png' });
        return {
            hostname: os.hostname(),
            format: 'png',
            base64: imgBuffer.toString('base64'),
        };
    } catch (nodeErr) {
        // 2. Fallback to PowerShell CopyFromScreen
        return new Promise((resolve, reject) => {
            const psScript = `
                Add-Type -AssemblyName System.Windows.Forms;
                Add-Type -AssemblyName System.Drawing;
                $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
                $b = New-Object System.Drawing.Bitmap($s.Width, $s.Height);
                $g = [System.Drawing.Graphics]::FromImage($b);
                $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size);
                $ms = New-Object System.IO.MemoryStream;
                $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
                $b.Dispose();
                $g.Dispose();
                [System.Convert]::ToBase64String($ms.ToArray());
                $ms.Dispose();
            `;
            exec(`powershell -NoProfile -Command "${psScript.replace(/\r?\n/g, ' ')}"`, { maxBuffer: 30 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(`PowerShell screenshot failed: ${err.message}`));
                const base64 = stdout.trim();
                if (!base64) return reject(new Error('Empty screenshot buffer'));
                resolve({
                    hostname: os.hostname(),
                    format: 'png',
                    base64,
                });
            });
        });
    }
}

/**
 * Display native Windows toast notification.
 */
function showToastNotification(title, message) {
    const safeTitle = (title || 'ClaudeClaw Alert').replace(/"/g, '`"');
    const safeMsg = (message || '').replace(/"/g, '`"');
    const psCmd = `powershell -Command "[reflection.assembly]::loadwithpartialname('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('${safeMsg}', '${safeTitle}')"`;
    exec(psCmd);
    return { success: true };
}

/**
 * Dispatch an incoming command to the appropriate handler.
 */
async function handleCommand(action, params) {
    console.log(`[Worker] Executing command: ${action}`);
    switch (action) {
        case 'screen.capture':
            return await captureScreenshot();
        case 'pc.lock':
            return await lockWorkstation();
        case 'cmd.exec':
            return await execLocalCommand(params.command || params.cmd);
        case 'notify.toast':
            return showToastNotification(params.title, params.message);
        case 'sys.info':
            return getSystemMetrics();
        default:
            throw new Error(`Unsupported satellite action: ${action}`);
    }
}

/**
 * Make an HTTP/HTTPS request to the VPS Master.
 */
function requestMaster(pathName, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(pathName, config.vpsUrl);
        const transport = parsed.protocol === 'https:' ? https : http;

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.satelliteKey}`,
        };

        let bodyStr = null;
        if (data) {
            bodyStr = JSON.stringify(data);
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = transport.request(parsed, { method, headers, timeout: 45000 }, (res) => {
            let resBody = '';
            res.on('data', (chunk) => resBody += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(resBody);
                    resolve({ statusCode: res.statusCode, data: json });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, raw: resBody });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Master request timed out'));
        });

        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

/**
 * Main loop: enroll with the master, then long-poll for work.
 *
 * The VPS cannot open a connection to this machine. We have to dial out.
 */
async function startPollingLoop() {
    let currentDelay = config.reconnectDelayMs;
    let registered = false;

    while (true) {
        try {
            const payload = {
                satelliteId: config.satelliteId,
                hostname: os.hostname(),
                platform: os.platform(),
                systemInfo: getSystemMetrics(),
            };

            if (!registered) {
                const reg = await requestMaster('/api/satellite/register', 'POST', payload);
                if (reg.statusCode === 401) {
                    console.error('❌ [Worker] Master rejected authentication token. Check satelliteKey in config.json or SATELLITE_KEY env.');
                    await new Promise(r => setTimeout(r, 10000));
                    continue;
                }
                if (reg.statusCode >= 200 && reg.statusCode < 300) {
                    registered = true;
                    console.log(`✅ [Worker] Registered with master as ${config.satelliteId}`);
                } else if (reg.statusCode === 404) {
                    // Older master without /register — poll still enrolls.
                    registered = true;
                }
            }

            const res = await requestMaster('/api/satellite/poll', 'POST', payload);

            if (res.statusCode === 401) {
                console.error('❌ [Worker] Master rejected authentication token. Check satelliteKey in config.json or SATELLITE_KEY env.');
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }

            // Connection succeeded; reset backoff delay
            currentDelay = config.reconnectDelayMs;

            const body = res.data;
            if (body && body.command) {
                const { commandId, action, params } = body.command;
                let success = true;
                let result = null;
                let error = null;

                try {
                    result = await handleCommand(action, params || {});
                } catch (cmdErr) {
                    success = false;
                    error = cmdErr.message;
                    console.error(`[Worker] Command failed (${action}):`, cmdErr);
                }

                // Send back response to Master
                await requestMaster('/api/satellite/response', 'POST', {
                    satelliteId: config.satelliteId,
                    commandId,
                    success,
                    result,
                    error,
                }).catch(err => {
                    console.error('[Worker] Failed delivering response to master:', err.message);
                });
            }

        } catch (err) {
            console.warn(`⚠️ [Worker] Cannot reach VPS Master at ${config.vpsUrl}: ${err.message}. Retrying in ${Math.round(currentDelay / 1000)}s...`);
            await new Promise(r => setTimeout(r, currentDelay));
            currentDelay = Math.min(currentDelay * 1.5, config.maxReconnectDelayMs);
        }
    }
}

// Start
startPollingLoop().catch(err => {
    console.error('Fatal satellite worker error:', err);
});
