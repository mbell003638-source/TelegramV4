// =============================================================================
//  agents/AntigravityAgent.js — Antigravity CLI Agent (agy)
//
//  Google Antigravity CLI agent using --output-format stream-json.
//  Supports:
//    - Real-time NDJSON event streaming (text_delta)
//    - Multi-turn conversation resumption (--conversation <id>)
//    - Dynamic model selection (--model <model>)
//    - Token metrics reporting
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('../core/config');
const { terminateChild } = require('../core/processUtils');
const { EFFORT_LEVELS, withEffortCapabilities, activeEffort } = require('../core/ModelCapabilities');

class AntigravityAgent extends BaseAgent {
    constructor(sessionStore) {
        super('antigravity', 'Antigravity', '🚀');
        this.sessionStore = sessionStore;
        this.agyPath = null;
        this.discoveredModels = null;
        this.lastModelDiscoveryAt = 0;
        this.modelDiscoveryPromise = null;
        this.modelControl = { discovery: 'live', effort: true, flag: '--effort' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
            path.join(homeDir, '.local', 'bin', 'agy.exe'),
            path.join(process.env.APPDATA || '', 'npm', 'agy.cmd')
        ] : [
            path.join(homeDir, '.local', 'bin', 'agy'),
            '/usr/local/bin/agy',
            '/usr/bin/agy'
        ];

        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                this.agyPath = candidate;
                break;
            }
        }

        if (!this.agyPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} agy`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.agyPath = found;
            } catch { /* not on path */ }
        }

        if (!this.agyPath) {
            console.warn('[AntigravityAgent] agy CLI binary not found at default location');
        } else {
            console.log(`[AntigravityAgent] Located agy at: ${this.agyPath}`);
        }
    }

    async discoverModels({ force = false } = {}) {
        if (!this.agyPath) return null;
        if (!force && this.discoveredModels && Date.now() - this.lastModelDiscoveryAt < config.modelCacheTtlMs) {
            return this.discoveredModels;
        }
        if (this.modelDiscoveryPromise) return this.modelDiscoveryPromise;

        this.modelDiscoveryPromise = (async () => {
          try {
            const output = await new Promise((resolve, reject) => {
                const child = spawn(this.agyPath, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => {
                    try { child.kill('SIGKILL'); } catch { /* already exited */ }
                    reject(new Error(`model discovery timed out after ${config.modelDiscoveryTimeoutMs} ms`));
                }, config.modelDiscoveryTimeoutMs);
                timer.unref();
                child.stdout.setEncoding('utf8');
                child.stderr.setEncoding('utf8');
                child.stdout.on('data', chunk => { stdout += chunk; });
                child.stderr.on('data', chunk => { stderr += chunk; });
                child.once('error', err => { clearTimeout(timer); reject(err); });
                child.once('close', (code, signal) => {
                    clearTimeout(timer);
                    if (code === 0) resolve(stdout);
                    else reject(new Error(`agy models exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
                });
            });
            const dynamicModels = [withEffortCapabilities(
                { id: 'default', name: 'Auto / Default (Recommended)' }, EFFORT_LEVELS.antigravity
            )];
            output.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('Usage') || trimmed.startsWith('Fetching')) return;
                const parts = trimmed.split('\t');
                const id = parts[0].trim();
                const name = (parts[1] || id).trim();
                if (id) dynamicModels.push(withEffortCapabilities({ id, name }, EFFORT_LEVELS.antigravity));
            });
            if (dynamicModels.length > 1) {
                this.sessionStore.setAvailableModels('antigravity', dynamicModels);
                this.discoveredModels = dynamicModels;
                this.lastModelDiscoveryAt = Date.now();
                console.log(`[AntigravityAgent] Discovered ${dynamicModels.length} models dynamically from agy CLI.`);
                return dynamicModels;
            }
          } catch (e) {
            console.warn(`[AntigravityAgent] Dynamic model query: ${e.message}`);
          } finally {
            this.modelDiscoveryPromise = null;
          }
          return this.discoveredModels;
        })();
        return this.modelDiscoveryPromise;
    }

    async onStart() {
        // agy runs per request in print mode or via ACP
    }

    async onStop() {
        const child = this.process;
        await terminateChild(child);
        if (this.process === child) this.process = null;
    }

    attachSession(chatId, sessionId, extra = {}) {
        if (chatId && sessionId) this.sessionStore.setSession('antigravity', sessionId, chatId, extra);
    }

    async listSessions(limit = 12) {
        const { listAgySessions } = require('../core/sessionCatalog');
        return listAgySessions(os.homedir(), limit);
    }

    async sendMessage(unifiedMessage) {
        if (!this.agyPath) {
            throw new Error('Antigravity CLI (agy) is not installed or not found.');
        }

        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const sessionId = this.sessionStore.getSession('antigravity', chatId);
        const model = this.sessionStore.getActiveModel('antigravity', chatId);
        const effort = activeEffort(this.sessionStore, 'antigravity', model, this.sessionStore.getAvailableModels('antigravity'), chatId);

        this.emitStatus('⏳ Thinking...');

        const args = [
            '--output-format', 'stream-json',
            '--print', prompt,
            '--dangerously-skip-permissions'
        ];

        if (model && model !== 'default' && model !== 'auto') {
            args.push('--model', model);
        }
        if (effort) args.push('--effort', effort);

        if (sessionId) {
            args.push('--conversation', sessionId);
        }

        const workspaceRoot = this.sessionStore.getWorkspaceCwd('antigravity', chatId);
        const env = { ...process.env, CI: 'true' };

        return new Promise((resolve) => {
            this.process = spawn(this.agyPath, args, { cwd: workspaceRoot, env });

            let buffer = '';
            let fullResponse = '';

            const processEvent = (event) => {
                if (!event || typeof event !== 'object') return;

                // 1. Initial event
                if (event.event === 'init' && event.conversation_id) {
                    this.sessionStore.setSession('antigravity', event.conversation_id, chatId);
                }

                // 2. Incremental step update
                if (event.event === 'step_update' && event.step_update) {
                    const step = event.step_update;
                    if (step.conversation_id) {
                        this.sessionStore.setSession('antigravity', step.conversation_id, chatId);
                    }

                    // Delta streaming text
                    if (step.text_delta) {
                        fullResponse += step.text_delta;
                        this.emitText(step.text_delta);
                    }

                    // Tool calling updates
                    if (step.step_type === 'tool_use' || step.step_type === 'tool_call') {
                        this.emitToolCall(step.tool_name || 'tool');
                    }
                }

                // 3. Final turn result
                if (event.event === 'result' && event.result) {
                    const res = event.result;
                    if (res.conversation_id) {
                        this.sessionStore.setSession('antigravity', res.conversation_id, chatId);
                    }
                    if (res.status === 'ERROR' || res.error) {
                        fullResponse = `❌ <b>Antigravity Error:</b>\n${res.error || 'Execution failed'}`;
                        this.emitText(fullResponse);
                    } else if (res.response && !fullResponse) {
                        fullResponse = res.response;
                        this.emitText(res.response);
                    }
                    if (res.usage) {
                        const { total_tokens, input_tokens, output_tokens } = res.usage;
                        this.sessionStore.recordUsage('antigravity', total_tokens, input_tokens, output_tokens);
                    }
                }
            };

            this.process.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep partial trailing line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let parsed = null;
                    try {
                        parsed = JSON.parse(trimmed);
                    } catch {
                        // Plain text fallback if non-JSON output occurs (ignore raw JSON fragments)
                        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                            fullResponse += trimmed + '\n';
                            this.emitText(trimmed + '\n');
                        }
                    }
                    if (parsed) {
                        try {
                            processEvent(parsed);
                        } catch (err) {
                            console.error('[AntigravityAgent] processEvent error:', err.message);
                        }
                    }
                }
            });

            this.process.stderr.on('data', (chunk) => {
                const errStr = chunk.toString().trim();
                if (errStr && !errStr.includes('ExperimentalWarning')) {
                    console.error(`[AntigravityAgent STDERR] ${errStr}`);
                }
            });

            this.process.on('close', (code) => {
                if (buffer.trim()) {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(buffer.trim());
                    } catch {
                        if (!buffer.trim().startsWith('{') && !buffer.trim().startsWith('[')) {
                            fullResponse += buffer.trim();
                            this.emitText(buffer.trim());
                        }
                    }
                    if (parsed) {
                        try {
                            processEvent(parsed);
                        } catch (err) {
                            console.error('[AntigravityAgent] close processEvent error:', err.message);
                        }
                    }
                }

                this.process = null;
                this.emitFinished(fullResponse);
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[AntigravityAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

module.exports = AntigravityAgent;
