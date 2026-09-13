// =============================================================================
//  agents/ClaudeAgent.js — Native Claude Code Agent
//
//  Uses the official Claude Code CLI (`claude -p --output-format stream-json`)
//  for real-time streaming, multi-turn session persistence, and model selection.
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { terminateChild } = require('../core/processUtils');
const { EFFORT_LEVELS, withEffortCapabilities, activeEffort } = require('../core/ModelCapabilities');

class ClaudeAgent extends BaseAgent {
    constructor(sessionStore) {
        super('claude', 'Claude Code', '🎭');
        this.sessionStore = sessionStore;
        this.claudePath = null;
        this.modelControl = { discovery: 'static', effort: true, flag: '--effort' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
            path.join(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd')
        ] : [
            '/usr/local/bin/claude',
            '/usr/bin/claude',
            path.join(homeDir, '.npm-global', 'bin', 'claude'),
            path.join(homeDir, '.local', 'bin', 'claude')
        ];

        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                this.claudePath = candidate;
                break;
            }
        }

        if (!this.claudePath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} claude`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.claudePath = found;
            } catch { /* not found */ }
        }

        if (this.claudePath) {
            console.log(`[ClaudeAgent] Located claude CLI at: ${this.claudePath}`);
            await this.discoverModels();
        } else {
            console.warn('[ClaudeAgent] claude CLI not found.');
        }
    }

    async discoverModels() {
        const dynamicModels = [
            { id: 'default', name: 'Default (Opus 5)' },
            { id: 'claude-opus-5', name: 'Claude Opus 5 (Flagship)' },
            { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
            { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' }
        ].map(model => withEffortCapabilities(model, EFFORT_LEVELS.claude));
        this.sessionStore.setAvailableModels('claude', dynamicModels);
        return dynamicModels;
    }

    async onStart() {
        // Runs per request
    }

    async onStop() {
        const child = this.process || this.stdinProc;
        await terminateChild(child);
        if (this.process === child) this.process = null;
        if (this.stdinProc === child) this.stdinProc = null;
    }

    attachSession(chatId, sessionId, extra = {}) {
        if (chatId && sessionId) this.sessionStore.setSession('claude', sessionId, chatId, extra);
        this.warmKey = null;
    }

    async listSessions(limit = 12) {
        const { listClaudeSessions } = require('../core/sessionCatalog');
        return listClaudeSessions(os.homedir(), limit);
    }

    async _ensureWarmStdin(sessionId, model, chatId, effort) {
        const cwd = this.sessionStore.getWorkspaceCwd('claude', chatId);
        const key = `${sessionId || 'new'}|${model || 'default'}|${effort || 'auto'}|${cwd}`;
        if (this.stdinProc && this.stdinProc.exitCode === null && this.warmKey === key) {
            return this.stdinProc;
        }
        await terminateChild(this.stdinProc);
        this.stdinProc = null;
        this.stdinBuffer = '';
        const bin = this.claudePath || 'claude';
        const args = [
            '-p',
            '--output-format', 'stream-json',
            '--input-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'bypassPermissions',
        ];
        if (model && model !== 'default' && model !== 'auto') args.push('--model', model);
        if (effort) args.push('--effort', effort);
        if (sessionId) args.push('--resume', sessionId);
        this.stdinProc = spawn(bin, args, {
            cwd,
            env: { ...process.env, CI: 'true' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.process = this.stdinProc;
        this.child = this.stdinProc;
        this.warmKey = key;
        this.stdinProc.stderr.on('data', (chunk) => {
            const msg = chunk.toString().trim();
            if (msg && !msg.includes('stdin data received')) console.log(`[ClaudeAgent STDERR] ${msg}`);
        });
        this.stdinProc.on('close', () => {
            if (this.stdinProc && this.stdinProc.exitCode !== null) {
                this.stdinProc = null;
                this.warmKey = null;
                if (this.process === this.child) this.process = null;
                this.child = null;
            }
        });
        return this.stdinProc;
    }

    _sendWarm(prompt, chatId, sessionId, model, effort) {
        return new Promise(async (resolve, reject) => {
            let proc;
            try {
                proc = await this._ensureWarmStdin(sessionId, model, chatId, effort);
            } catch (err) {
                reject(err);
                return;
            }
            if (!proc || !proc.stdin || !proc.stdout) {
                resolve(false);
                return;
            }
            const payload = JSON.stringify({
                type: 'user',
                message: { role: 'user', content: [{ type: 'text', text: prompt }] },
            }) + '\n';

            let fullText = '';
            const onData = (chunk) => {
                this.stdinBuffer = (this.stdinBuffer || '') + chunk.toString();
                const lines = this.stdinBuffer.split('\n');
                this.stdinBuffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let ev = null;
                    try { ev = JSON.parse(trimmed); } catch { continue; }
                    if (ev.session_id) this.sessionStore.setSession('claude', ev.session_id, chatId);
                    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.text) {
                        fullText += ev.event.delta.text;
                        this.emitText(ev.event.delta.text);
                    }
                    if (ev.type === 'assistant' && ev.message?.content && !fullText) {
                        for (const block of ev.message.content) {
                            if (block.type === 'text' && block.text) {
                                fullText += block.text;
                                this.emitText(block.text);
                            }
                        }
                    }
                    if (ev.type === 'result') {
                        if (ev.session_id) this.sessionStore.setSession('claude', ev.session_id, chatId);
                        if (ev.result && !fullText) {
                            fullText = ev.result;
                            this.emitText(ev.result);
                        }
                        cleanup();
                        this.emitFinished(fullText);
                        resolve(true);
                    }
                }
            };
            const onClose = () => {
                cleanup();
                resolve(false);
            };
            const cleanup = () => {
                proc.stdout.off('data', onData);
                proc.off('close', onClose);
            };
            proc.stdout.on('data', onData);
            proc.once('close', onClose);
            if (!proc.stdin.write(payload)) {
                proc.stdin.once('drain', () => {});
            }
        });
    }

    async sendMessage(unifiedMessage) {
        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const sessionId = this.sessionStore.getSession('claude', chatId);
        const model = this.sessionStore.getActiveModel('claude', chatId);
        const effort = activeEffort(this.sessionStore, 'claude', model, this.sessionStore.getAvailableModels('claude'), chatId);

        this.emitStatus('⏳ Thinking...');

        try {
            const handled = await this._sendWarm(prompt, chatId, sessionId, model, effort);
            if (handled) return;
        } catch (err) {
            console.warn(`[ClaudeAgent] Warm stdin failed (${err.message}); using one-shot spawn.`);
            await terminateChild(this.stdinProc);
            this.stdinProc = null;
            this.warmKey = null;
        }

        const isWin = process.platform === 'win32';
        const bin = this.claudePath || (isWin ? 'claude.cmd' : 'claude');

        const args = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'bypassPermissions'
        ];

        if (model && model !== 'default' && model !== 'auto') {
            args.push('--model', model);
        }
        if (effort) args.push('--effort', effort);

        if (sessionId) {
            args.push('--resume', sessionId);
        }

        const workspaceRoot = this.sessionStore.getWorkspaceCwd('claude', chatId);
        const env = { ...process.env, CI: 'true' };

        return new Promise((resolve) => {
            const spawnCmd = isWin ? 'cmd.exe' : bin;
            const spawnArgs = isWin ? ['/c', bin, ...args] : args;

            this.process = spawn(spawnCmd, spawnArgs, {
                cwd: workspaceRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let buffer = '';
            let fullText = '';

            const processEvent = (event) => {
                if (!event || typeof event !== 'object') return;

                // 1. Session tracking
                if (event.session_id) {
                    this.sessionStore.setSession('claude', event.session_id, chatId);
                }

                // 2. Stream event delta
                if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
                    const text = event.event?.delta?.text;
                    if (text) {
                        fullText += text;
                        this.emitText(text);
                    }
                }

                // 3. Assistant turn complete
                if (event.type === 'assistant' && event.message?.content) {
                    for (const block of event.message.content) {
                        if (block.type === 'text' && block.text && !fullText) {
                            fullText = block.text;
                            this.emitText(block.text);
                        }
                    }
                }

                // 4. Result & Token metrics
                if (event.type === 'result') {
                    if (event.result && !fullText) {
                        fullText = event.result;
                        this.emitText(event.result);
                    }
                    if (event.usage) {
                        const { input_tokens, output_tokens } = event.usage;
                        const total = (input_tokens || 0) + (output_tokens || 0);
                        this.sessionStore.recordUsage('claude', total, input_tokens || 0, output_tokens || 0);
                    }
                }
            };

            this.process.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let ev = null;
                    try {
                        ev = JSON.parse(trimmed);
                    } catch {
                        // ignore non-JSON
                    }
                    if (ev) {
                        try {
                            processEvent(ev);
                        } catch (err) {
                            console.error('[ClaudeAgent] processEvent error:', err.message);
                        }
                    }
                }
            });

            let stderrText = '';
            this.process.stderr.on('data', (chunk) => {
                const msg = chunk.toString().trim();
                if (msg && !msg.includes('stdin data received')) {
                    console.log(`[ClaudeAgent STDERR] ${msg}`);
                    stderrText += msg + '\n';
                }
            });

            this.process.on('close', () => {
                this.process = null;
                if (!fullText && stderrText) {
                    const firstLine = stderrText.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.trim()).shift() || 'Unknown error';
                    fullText = `⚠️ <b>Claude Error:</b>\n<code>${firstLine}</code>`;
                }
                this.emitFinished(fullText);
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[ClaudeAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

module.exports = ClaudeAgent;
