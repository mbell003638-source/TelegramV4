// =============================================================================
//  agents/PiAgent.js — Native Pi Coding Agent Driver
//
//  Uses the official Pi Coding Agent CLI (`pi --mode json -p <prompt>`)
//  for real-time streaming, multi-turn session persistence, and model selection.
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { terminateChild } = require('../core/processUtils');
const config = require('../core/config');
const { EFFORT_LEVELS, withEffortCapabilities, activeEffort, runCli } = require('../core/ModelCapabilities');

function parsePiModels(stdout) {
    const list = [withEffortCapabilities({ id: 'default', name: 'Default Model' }, EFFORT_LEVELS.pi)];
    if (!stdout || typeof stdout !== 'string') return list;
    const lines = stdout.split('\n');
    const header = lines.find(line => line.trim().startsWith('provider'));
    const thinkingIndex = header ? header.trim().split(/\s+/).indexOf('thinking') : -1;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('provider') || trimmed.startsWith('---')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
            const provider = parts[0];
            const model = parts[1];
            const entry = { id: `${provider}/${model}`, name: `${model} (${provider})` };
            list.push(thinkingIndex >= 0 && parts[thinkingIndex] === 'yes'
                ? withEffortCapabilities(entry, EFFORT_LEVELS.pi)
                : entry);
        }
    }
    return list;
}

class PiAgent extends BaseAgent {
    constructor(sessionStore) {
        super('pi', 'Pi Agent', '🥧');
        this.sessionStore = sessionStore;
        this.piPath = null;
        this.process = null;
        this.discoveredModels = [];
        this.lastModelDiscoveryAt = 0;
        this.modelDiscoveryPromise = null;
        this.modelControl = { discovery: 'live', effort: true, flag: '--thinking' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(process.env.APPDATA || '', 'npm', 'pi.cmd'),
            path.join(homeDir, 'AppData', 'Roaming', 'npm', 'pi.cmd')
        ] : [
            '/usr/local/bin/pi',
            '/usr/bin/pi',
            path.join(homeDir, '.npm-global', 'bin', 'pi'),
            path.join(homeDir, '.local', 'bin', 'pi')
        ];

        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                this.piPath = candidate;
                break;
            }
        }

        if (!this.piPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} pi`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.piPath = found;
            } catch { /* not found */ }
        }

        if (this.piPath) {
            console.log(`[PiAgent] Located pi CLI at: ${this.piPath}`);
            await this.discoverModels();
        } else {
            console.warn('[PiAgent] pi CLI not found.');
        }
    }

    async discoverModels({ force = false } = {}) {
        if (!this.piPath) return [];
        if (this.modelDiscoveryPromise) return this.modelDiscoveryPromise;

        const now = Date.now();
        if (!force && this.discoveredModels.length > 0 && (now - this.lastModelDiscoveryAt) < config.modelCacheTtlMs) {
            return this.discoveredModels;
        }

        this.modelDiscoveryPromise = (async () => {
            try {
                const stdout = await runCli(this.piPath, ['--list-models'], {
                    timeout: config.modelDiscoveryTimeoutMs,
                });
                const models = parsePiModels(stdout);
                if (models.length > 1) {
                    this.sessionStore.setAvailableModels('pi', models);
                    this.discoveredModels = models;
                    this.lastModelDiscoveryAt = Date.now();
                    console.log(`[PiAgent] Discovered ${models.length} models dynamically from pi CLI.`);
                    return models;
                }
            } catch (e) {
                console.warn(`[PiAgent] Model discovery failed: ${e.message}`);
            } finally {
                this.modelDiscoveryPromise = null;
            }
            return this.discoveredModels;
        })();

        return this.modelDiscoveryPromise;
    }

    async onStart() {
        // Runs per turn
    }

    async onStop() {
        const child = this.process;
        await terminateChild(child);
        if (this.process === child) this.process = null;
    }

    clearSession(chatId) {
        // Multi-turn continuity managed by sessionStore
    }

    async sendMessage(unifiedMessage) {
        if (!this.piPath) {
            throw new Error('Pi CLI (pi) is not installed or not found.');
        }

        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const sessionId = this.sessionStore.getSession('pi', chatId);
        const model = this.sessionStore.getActiveModel('pi', chatId);
        const effort = activeEffort(this.sessionStore, 'pi', model, this.sessionStore.getAvailableModels('pi'), chatId);

        this.emitStatus('⏳ Thinking...');

        const args = ['--mode', 'json', '-p', prompt];

        if (model && model !== 'default' && model !== 'auto') {
            if (model.includes('/')) {
                const parts = model.split('/');
                const provider = parts[0];
                const modelName = parts.slice(1).join('/');
                args.push('--provider', provider, '--model', modelName);
            } else {
                args.push('--model', model);
            }
        }

        if (sessionId) {
            args.push('--continue');
        }
        if (effort) args.push('--thinking', effort);

        const isWin = process.platform === 'win32';
        const workspaceRoot = this.sessionStore.getWorkspaceCwd('pi', chatId);
        const env = this.getSpawnEnv({
            CI: 'true',
            PATH: (os.homedir() + '/.npm-global/bin:' + os.homedir() + '/.local/bin:' + (process.env.PATH || ''))
        });

        let execBinary = this.piPath;
        let execArgs = args;
        let useShell = false;

        if (isWin && this.piPath && this.piPath.toLowerCase().endsWith('.cmd')) {
            const jsCandidate = path.join(path.dirname(this.piPath), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
            if (fs.existsSync(jsCandidate)) {
                execBinary = process.execPath;
                execArgs = [jsCandidate, ...args];
                useShell = false;
            } else {
                useShell = true;
            }
        }

        return new Promise((resolve) => {
            this.process = spawn(execBinary, execArgs, {
                cwd: workspaceRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: useShell
            });

            let buffer = '';
            let fullResponse = '';

            const processEvent = (event) => {
                if (!event || typeof event !== 'object') return;

                if (event.type === 'session' && event.id) {
                    this.sessionStore.setSession('pi', event.id, chatId);
                }

                if (event.type === 'tool_execution_start' || event.type === 'tool_call') {
                    const toolName = event.tool?.name || event.name || 'tool';
                    this.emitToolCall(toolName);
                }

                if (event.type === 'message_start' && event.message?.role === 'assistant') {
                    this.emitStatus('✍️ Replying...');
                }

                if (event.type === 'message_update') {
                    const assistantEv = event.assistantMessageEvent;
                    if (assistantEv?.type === 'text_delta' && assistantEv.delta) {
                        fullResponse += assistantEv.delta;
                        this.emitText(assistantEv.delta);
                    }
                }

                if (event.type === 'message_end' && event.message?.role === 'assistant') {
                    const msg = event.message;
                    if (Array.isArray(msg.content)) {
                        const text = msg.content
                            .filter(c => c && c.type === 'text' && typeof c.text === 'string')
                            .map(c => c.text)
                            .join('');
                        if (text && !fullResponse) {
                            fullResponse = text;
                            this.emitText(text);
                        }
                    }
                    if (msg.usage) {
                        const { totalTokens, input, output } = msg.usage;
                        this.sessionStore.recordUsage('pi', totalTokens, input, output);
                    }
                    if (msg.errorMessage) {
                        this.emitError(new Error(msg.errorMessage));
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
                    try {
                        const parsed = JSON.parse(trimmed);
                        processEvent(parsed);
                    } catch {
                        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
                            fullResponse += trimmed + '\n';
                            this.emitText(trimmed + '\n');
                        }
                    }
                }
            });

            this.process.stderr.on('data', (chunk) => {
                const str = chunk.toString().trim();
                if (str && !str.includes('ExperimentalWarning') && !str.includes('DeprecationWarning')) {
                    console.error(`[PiAgent STDERR] ${str}`);
                }
            });

            this.process.on('close', () => {
                if (buffer.trim()) {
                    try {
                        const parsed = JSON.parse(buffer.trim());
                        processEvent(parsed);
                    } catch {
                        if (!buffer.trim().startsWith('{') && !buffer.trim().startsWith('[')) {
                            fullResponse += buffer.trim();
                            this.emitText(buffer.trim());
                        }
                    }
                }
                this.process = null;
                this.emitFinished(fullResponse);
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[PiAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

module.exports = PiAgent;
module.exports.parsePiModels = parsePiModels;
