// =============================================================================
//  process_guard.js — modular process manager for Telegram Bridge v4
//
//  Handles:
//    1. Single instance enforcement via PID file + process validation
//    2. Stale PID cleanup (crash recovery)
//    3. Auto-restart with exponential backoff
//    4. Clean shutdown signal handling  
//    5. Windows console disconnect ignoring (SIGHUP)
// =============================================================================
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const PID_FILE = path.join(SCRIPT_DIR, 'bridge.pid');
const LOG_FILE = path.join(SCRIPT_DIR, 'guard.log');
const TARGET_SCRIPT = path.join(SCRIPT_DIR, 'index.js');

const MAX_RESTART_DELAY = 60000;   // 60 seconds max backoff
const INITIAL_RESTART_DELAY = 3000; // 3 seconds initial
const RESTART_RESET_WINDOW = 120000; // Reset backoff after 2 min of stable running

let child = null;
let shuttingDown = false;
let restartCount = 0;
let lastStartTime = 0;

function log(msg) {
    const entry = `[${new Date().toISOString()}] [GUARD] ${msg}`;
    console.log(entry);
    try { fs.appendFileSync(LOG_FILE, entry + '\n'); } catch(e) {}
}

function isProcessAlive(pid) {
    try {
        // Use tasklist to check if the PID is alive and is actually a node process
        const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { 
            encoding: 'utf8', timeout: 5000, windowsHide: true 
        });
        const lower = output.toLowerCase();
        return lower.includes('node') && lower.includes(pid.toString());
    } catch {
        return false;
    }
}

function acquireLock() {
    if (fs.existsSync(PID_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
            const { pid, guardPid, startedAt } = data;
            
            if (guardPid && isProcessAlive(guardPid) && guardPid !== process.pid) {
                log(`Another guard is already running (PID ${guardPid}, started ${startedAt}). Exiting.`);
                process.exit(2);
            }
            
            if (pid && isProcessAlive(pid)) {
                log(`Found orphan mediator process (PID ${pid}). Killing it.`);
                try { process.kill(pid, 'SIGTERM'); } catch(e) {}
                try { execSync('timeout /t 2 /nobreak > nul', { windowsHide: true }); } catch(e) {}
            }
            
            log(`Stale PID file found (guard PID ${guardPid} is dead). Cleaning up.`);
        } catch (e) {
            log(`Corrupt PID file. Cleaning up. (${e.message})`);
        }
        try { fs.unlinkSync(PID_FILE); } catch(e) {}
    }

    writePidFile(null);
    log(`Lock acquired (guard PID: ${process.pid}).`);
    return true;
}

function writePidFile(childPid) {
    const data = {
        guardPid: process.pid,
        pid: childPid,
        startedAt: new Date().toISOString(),
        script: TARGET_SCRIPT
    };
    fs.writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
}

function releaseLock() {
    try { fs.unlinkSync(PID_FILE); } catch(e) {}
    log('Lock released.');
}

function startChild() {
    if (shuttingDown) return;
    
    lastStartTime = Date.now();
    log(`Starting index.js (attempt #${restartCount + 1})...`);
    
    const logFile = path.join(SCRIPT_DIR, 'bot.log');
    const logStream = fs.openSync(logFile, 'a');
    child = spawn('node', [TARGET_SCRIPT], {
        cwd: SCRIPT_DIR,
        stdio: ['ignore', logStream, logStream],
        env: process.env,
        windowsHide: true
    });
    
    writePidFile(child.pid);
    log(`Mediator started (PID: ${child.pid}).`);
    
    child.on('exit', (code, signal) => {
        child = null;
        
        if (shuttingDown) {
            log(`Mediator exited (code: ${code}) — guard is shutting down.`);
            return;
        }
        
        if (code === 2) {
            log('Mediator reported duplicate instance (port lock). Guard exiting.');
            releaseLock();
            process.exit(2);
        }
        
        const uptime = Date.now() - lastStartTime;
        if (uptime > RESTART_RESET_WINDOW) {
            restartCount = 0;
        } else {
            restartCount++;
        }
        
        const delay = Math.min(INITIAL_RESTART_DELAY * Math.pow(1.5, restartCount), MAX_RESTART_DELAY);
        log(`Mediator exited (code: ${code}, signal: ${signal}). Restarting in ${Math.round(delay/1000)}s...`);
        
        setTimeout(startChild, delay);
    });
    
    child.on('error', (err) => {
        log(`Failed to start mediator: ${err.message}`);
        child = null;
        const delay = Math.min(INITIAL_RESTART_DELAY * Math.pow(1.5, restartCount), MAX_RESTART_DELAY);
        restartCount++;
        setTimeout(startChild, delay);
    });
}

function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Guard shutting down (${reason})...`);
    
    if (child) {
        log(`Sending SIGTERM to mediator (PID: ${child.pid})...`);
        try { child.kill('SIGTERM'); } catch(e) {}
        
        setTimeout(() => {
            if (child) {
                log('Force-killing mediator...');
                try { child.kill('SIGKILL'); } catch(e) {}
            }
            releaseLock();
            process.exit(0);
        }, 5000);
    } else {
        releaseLock();
        process.exit(0);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    log(`GUARD UNCAUGHT: ${err.message}`);
    shutdown('uncaught exception');
});
process.on('unhandledRejection', (reason) => {
    log(`GUARD UNHANDLED: ${reason}`);
});

if (process.platform === 'win32') {
    process.on('SIGHUP', () => log('SIGHUP received (console disconnect) — ignoring, staying alive.'));
}

log('=== Process Guard starting ===');
acquireLock();
startChild();
