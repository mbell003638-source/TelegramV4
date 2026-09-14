// =============================================================================
//  agents/GrokAgent.js — Native Grok Agent Driver
//
//  Uses the official Grok CLI (`grok -p <prompt> --output-format streaming-json`)
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

function parseGrokModels(stdout) {
    const list = [withEffortCapabilities({ id: 'default', name: 'Default (grok-4.6)' }, EFFORT_LEVELS.grok)];
    if (!stdout || typeof stdout !== 'string') return list;
    const lines = stdout.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        const defaultMatch = trimmed.match(/^Default model:\s*(\S+)/i);
        if (defaultMatch) {
            list[0].name = `Default (${defaultMatch[1]})`;
            continue;
        }
        if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
            const rawId = trimmed.replace(/^[\*\-]\s*/, '').replace(/\s*\(default\)/i, '').trim();
            if (rawId && !list.some(m => m.id === rawId)) {
                list.push(withEffortCapabilities({ id: rawId, name: rawId }, EFFORT_LEVELS.grok));
            }
        }
    }
    return list;
}

function parseGrokModelsCache(data) {
    const list = [{ id: 'default', name: 'Default (grok-4.6)' }];
    if (!data || !data.models || typeof data.models !== 'object') return list;
    for (const [id, entry] of Object.entries(data.models)) {
        if (entry?.info?.hidden) continue;
        const name = entry?.info?.name || id;
        list.push({ id, name });
    }
    return list;
}

function mergeGrokModels(listA, listB) {
    const map = new Map();
    for (const item of (listA || [])) {
        if (item?.id) map.set(item.id, { ...item });
    }
    for (const item of (listB || [])) {
        if (item?.id) {
            const prev = map.get(item.id) || {};
            map.set(item.id, { ...prev, ...item });
        }
    }
    return Array.from(map.values());
}

function extractGrokToolName(event) {
    return event?.toolName || event?.title || 'tool';
}

class GrokAgent extends BaseAgent {
    constructor(sessionStore) {
        super('grok', 'Grok', '🛸');
        this.sessionStore = sessionStore;
        this.cliArgs = ['agent', '--always-approve', '--no-leader', 'stdio'];
        this.grokPath = null;
        this.process = null;
        this.discoveredModels = [];
        this.lastModelDiscoveryAt = 0;
        this.modelDiscoveryPromise = null;
        this.modelControl = { discovery: 'live', effort: true, flag: '--reasoning-effort' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(homeDir, '.grok', 'bin', 'grok.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'grok', 'grok.exe'),
            path.join(homeDir, 'AppData', 'Local', 'Programs', 'grok', 'grok.exe'),
            path.join(process.env.APPDATA || '', 'npm', 'grok.cmd'),
            path.join(homeDir, 'AppData', 'Roaming', 'npm', 'grok.cmd')
        ] : [
            path.join(homeDir, '.local', 'bin', 'grok'),
            '/usr/local/bin/grok',
            '/usr/bin/grok',
            path.join(homeDir, '.npm-global', 'bin', 'grok')
        ];

        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                this.grokPath = candidate;
                break;
            }
        }

        if (!this.grokPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} grok`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.grokPath = found;
            } catch { /* not found */ }
        }

        if (this.grokPath) {
            console.log(`[GrokAgent] Located grok CLI at: ${this.grokPath}`);
            await this.discoverModels();
        } else {
            console.warn('[GrokAgent] grok CLI not found.');
        }
    }

    async discoverModels({ force = false } = {}) {
        if (!this.grokPath) return [];
        if (this.modelDiscoveryPromise) return this.modelDiscoveryPromise;

        const now = Date.now();
        if (!force && this.discoveredModels.length > 0 && (now - this.lastModelDiscoveryAt) < config.modelCacheTtlMs) {
            return this.discoveredModels;
        }

        this.modelDiscoveryPromise = (async () => {
            try {
                const stdout = await runCli(this.grokPath, ['models'], {
                    timeout: config.modelDiscoveryTimeoutMs,
                });
                const models = parseGrokModels(stdout);
                if (models.length > 1) {
                    this.sessionStore.setAvailableModels('grok', models);
                    this.discoveredModels = models;
                    this.lastModelDiscoveryAt = Date.now();
                    console.log(`[GrokAgent] Discovered ${models.length} models dynamically from grok CLI.`);
                    return models;
                }
            } catch (e) {
                console.warn(`[GrokAgent] Model discovery failed: ${e.message}`);
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
        if (!this.grokPath) {
            throw new Error('Grok CLI (grok) is not installed or not found.');
        }

        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const sessionId = this.sessionStore.getSession('grok', chatId);
        const model = this.sessionStore.getActiveModel('grok', chatId);
        const effort = activeEffort(this.sessionStore, 'grok', model, this.sessionStore.getAvailableModels('grok'), chatId);

        this.emitStatus('⏳ Thinking...');

        const args = [
            '-p', prompt,
            '--output-format', 'streaming-json',
            '--permission-mode', 'bypassPermissions'
        ];

        if (model && model !== 'default' && model !== 'auto') {
            args.push('-m', model);
        }
        if (effort) args.push('--reasoning-effort', effort);

        if (sessionId) {
            args.push('-r', sessionId);
        }

        const isWin = process.platform === 'win32';
        const workspaceRoot = (this.sessionStore && typeof this.sessionStore.getWorkspaceCwd === 'function')
            ? this.sessionStore.getWorkspaceCwd('grok', chatId)
            : ((process.env.WORKSPACE_ROOT && fs.existsSync(process.env.WORKSPACE_ROOT)) ? process.env.WORKSPACE_ROOT : process.cwd());

        const pathSep = path.delimiter;
        const currentPath = process.env.PATH || process.env.Path || '';
        const extraDirs = [
            path.join(os.homedir(), '.local', 'bin'),
            path.join(os.homedir(), '.grok', 'bin'),
            path.join(os.homedir(), '.npm-global', 'bin'),
        ];
        const env = this.getSpawnEnv({
            CI: 'true',
            PATH: [...extraDirs, currentPath].join(pathSep)
        });

        const useShell = isWin && (this.grokPath.endsWith('.cmd') || this.grokPath.endsWith('.bat'));

        return new Promise((resolve) => {
            this.process = spawn(this.grokPath, args, {
                cwd: workspaceRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: useShell
            });

            let buffer = '';
            let fullResponse = '';

            const processEvent = (event) => {
                if (!event || typeof event !== 'object') return;

                if (event.type === 'text' && typeof event.data === 'string') {
                    fullResponse += event.data;
                    this.emitText(event.data);
                } else if (event.type === 'thought' && typeof event.data === 'string') {
                    this.emitStatus(`🤔 ${event.data.substring(0, 40).replace(/\n/g, '')}...`);
                } else if (event.type === 'tool_call') {
                    const toolName = event.name || 'tool';
                    this.emitToolCall(toolName);
                } else if (event.type === 'usage' && event.usage) {
                    const { total_tokens, input_tokens, output_tokens } = event.usage;
                    this.sessionStore.recordUsage('grok', total_tokens, input_tokens, output_tokens);
                } else if (event.type === 'end') {
                    if (event.sessionId) {
                        this.sessionStore.setSession('grok', event.sessionId, chatId);
                    }
                    if (event.usage) {
                        const { total_tokens, input_tokens, output_tokens } = event.usage;
                        this.sessionStore.recordUsage('grok', total_tokens, input_tokens, output_tokens);
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
                    console.error(`[GrokAgent STDERR] ${str}`);
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
                console.error(`[GrokAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }

    _buildArgs({ promptFile, model, sessionId } = {}) {
        const args = [
            '--prompt-file', promptFile,
            '--output-format', 'streaming-json',
            '--permission-mode', 'bypassPermissions',
            '--always-approve',
            '--no-auto-update',
        ];
        if (model && model !== 'default') {
            args.push('-m', model);
        }
        if (sessionId) {
            args.push('-r', sessionId);
        }
        return args;
    }

    async connectAcp() {
        return true;
    }

    async cancelTurn() {
        return true;
    }

    async ensureSession() {
        return true;
    }
}

module.exports = GrokAgent;
module.exports.parseGrokModels = parseGrokModels;
module.exports.parseGrokModelsCache = parseGrokModelsCache;
module.exports.mergeGrokModels = mergeGrokModels;
module.exports.extractGrokToolName = extractGrokToolName;
