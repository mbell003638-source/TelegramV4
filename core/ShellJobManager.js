const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function parseSystemdProperties(text) {
    const result = {};
    for (const line of String(text || '').split('\n')) {
        const index = line.indexOf('=');
        if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
    }
    return result;
}

class ShellJobManager {
    constructor(sessionsDir, options = {}) {
        this.dir = path.join(sessionsDir, 'shell-jobs');
        this.stateFile = path.join(this.dir, 'jobs.json');
        this.pollMs = options.pollMs || 5000;
        this.jobs = new Map();
        this.notifier = null;
        this.scanInProgress = false;
        this.saveChain = Promise.resolve();
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this._load();
        this.monitor = setInterval(() => this._scan().catch(err => {
            console.warn(`[ShellJobs] Monitor failed: ${err.message}`);
        }), this.pollMs);
        if (this.monitor.unref) this.monitor.unref();
    }

    _load() {
        try {
            const rows = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            for (const job of Array.isArray(rows) ? rows : []) {
                // A restarted bridge no longer has an attached Telegram request.
                job.attachedUntil = 0;
                this.jobs.set(job.id, job);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.warn(`[ShellJobs] State load failed: ${error.message}`);
        }
    }

    _save() {
        const rows = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-100);
        const temp = `${this.stateFile}.${process.pid}.tmp`;
        this.saveChain = this.saveChain.then(async () => {
            await fs.promises.writeFile(temp, JSON.stringify(rows, null, 2), { mode: 0o600 });
            await fs.promises.rename(temp, this.stateFile);
        }).catch(error => console.warn(`[ShellJobs] State save failed: ${error.message}`));
        return this.saveChain;
    }

    setNotifier(notifier) {
        this.notifier = notifier;
        this._scan().catch(err => console.warn(`[ShellJobs] Initial scan failed: ${err.message}`));
    }

    async _systemctl(args) {
        return execFileAsync('sudo', ['-n', '/bin/systemctl', ...args], {
            encoding: 'utf8', maxBuffer: 1024 * 1024,
        });
    }

    async start(command, { chatId, cwd, attachedForMs = 0 } = {}) {
        const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
        const unit = `telegram-shell-${id}.service`;
        const logFile = path.join(this.dir, `${id}.log`);
        await fs.promises.writeFile(logFile, '', { mode: 0o600 });
        const job = {
            id, unit, logFile, command, cwd, chatId: String(chatId),
            startedAt: Date.now(), finishedAt: null, attachedUntil: Date.now() + attachedForMs,
            state: 'starting', activeState: 'activating', result: '', exitCode: null,
            notifiedAt: null, stoppedByUser: false,
        };
        this.jobs.set(id, job);
        await this._save();

        const envPath = process.env.PATH || '/home/open/.npm-global/bin:/home/open/.local/bin:/usr/local/bin:/usr/bin:/bin';
        const args = [
            '-n', '/usr/bin/systemd-run', `--unit=${unit.replace(/\.service$/, '')}`,
            `--uid=${process.env.USER || 'open'}`, `--working-directory=${cwd}`,
            `--setenv=HOME=${os.homedir()}`, `--setenv=PATH=${envPath}`,
            `--setenv=WORKSPACE_ROOT=${process.env.WORKSPACE_ROOT || os.homedir()}`,
            '--property=KillMode=control-group', `--property=StandardOutput=append:${logFile}`,
            `--property=StandardError=append:${logFile}`,
            '/bin/bash', '-lc', command,
        ];
        try {
            await execFileAsync('sudo', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            job.state = 'running';
            job.activeState = 'active';
            await this._save();
            return job;
        } catch (error) {
            job.state = 'failed';
            job.activeState = 'failed';
            job.result = 'start-failed';
            job.finishedAt = Date.now();
            job.exitCode = null;
            await fs.promises.appendFile(logFile, `Failed to start systemd job: ${error.stderr || error.message}\n`);
            await this._save();
            throw error;
        }
    }

    async refresh(jobOrId) {
        const job = typeof jobOrId === 'string' ? this.jobs.get(jobOrId) : jobOrId;
        if (!job) return null;
        try {
            const { stdout } = await this._systemctl([
                'show', job.unit, '--no-pager', '--property=ActiveState', '--property=SubState',
                '--property=Result', '--property=ExecMainStatus', '--property=ExecMainCode',
            ]);
            const props = parseSystemdProperties(stdout);
            job.activeState = props.ActiveState || 'unknown';
            job.result = props.Result || '';
            job.exitCode = /^\d+$/.test(props.ExecMainStatus || '') ? Number(props.ExecMainStatus) : null;
            const running = ['active', 'activating', 'reloading'].includes(job.activeState);
            job.state = running ? 'running' : (job.stoppedByUser ? 'stopped' : (job.exitCode === 0 && job.result === 'success' ? 'completed' : 'failed'));
            if (!running && !job.finishedAt) job.finishedAt = Date.now();
        } catch (error) {
            job.activeState = 'unknown';
            if (job.state === 'starting') job.state = 'unknown';
        }
        await this._save();
        return job;
    }

    async wait(jobId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const job = await this.refresh(jobId);
            if (!job || !['running', 'starting'].includes(job.state)) return job;
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(1, deadline - Date.now()))));
        }
        const job = await this.refresh(jobId);
        if (job) {
            job.attachedUntil = 0;
            await this._save();
        }
        return job;
    }

    get(id, chatId) {
        const job = this.jobs.get(String(id || ''));
        return job && String(job.chatId) === String(chatId) ? job : null;
    }

    latest(chatId) {
        return this.list(chatId, 1)[0] || null;
    }

    list(chatId, limit = 10) {
        return [...this.jobs.values()]
            .filter(job => String(job.chatId) === String(chatId))
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, limit);
    }

    async tail(jobOrId, maxBytes = 65536) {
        const job = typeof jobOrId === 'string' ? this.jobs.get(jobOrId) : jobOrId;
        if (!job) return '';
        try {
            const stat = await fs.promises.stat(job.logFile);
            const length = Math.min(stat.size, maxBytes);
            const handle = await fs.promises.open(job.logFile, 'r');
            try {
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
                return buffer.toString('utf8');
            } finally {
                await handle.close();
            }
        } catch (_) {
            return '';
        }
    }

    async stopJob(jobOrId) {
        const job = typeof jobOrId === 'string' ? this.jobs.get(jobOrId) : jobOrId;
        if (!job) return null;
        job.stoppedByUser = true;
        await this._systemctl(['stop', job.unit]);
        return this.refresh(job);
    }

    async markNotified(jobOrId) {
        const job = typeof jobOrId === 'string' ? this.jobs.get(jobOrId) : jobOrId;
        if (job) {
            job.notifiedAt = Date.now();
            job.attachedUntil = 0;
            await this._save();
        }
    }

    async _scan() {
        if (this.scanInProgress) return;
        this.scanInProgress = true;
        try {
            const candidates = [...this.jobs.values()].filter(job =>
                !job.notifiedAt && job.attachedUntil <= Date.now() && ['running', 'starting'].includes(job.state)
            );
            for (const job of candidates) {
                await this.refresh(job);
                if (!['running', 'starting'].includes(job.state) && this.notifier && !job.notifiedAt) {
                    try {
                        await this.notifier(job);
                        await this.markNotified(job);
                    } catch (error) {
                        console.warn(`[ShellJobs] Completion notification failed for ${job.id}: ${error.message}`);
                    }
                }
            }
        } finally {
            this.scanInProgress = false;
        }
    }

    async close() {
        clearInterval(this.monitor);
        await this.saveChain;
    }
}

module.exports = ShellJobManager;
module.exports.parseSystemdProperties = parseSystemdProperties;
