// =============================================================================
//  agents/CodexAgent.js — Native Codex CLI Agent
//
//  Uses the official codex CLI (`codex exec --json`) for direct JSONL streaming.
//  Supports:
//    - Multi-turn threads (resume <thread_id>)
//    - Model override via -m or -c model=...
//    - Token tracking and streaming responses
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { activeEffort } = require('../core/ModelCapabilities');

function configuredCodexModel(homeDir = os.homedir()) {
    try {
        const content = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
        return content.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || null;
    } catch (_) {
        return null;
    }
}

function configuredCodexReasoningEffort(homeDir = os.homedir()) {
    try {
        const content = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
        return content.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1] || null;
    } catch (_) {
        return null;
    }
}

function normalizeCodexModels(models, source = 'app-server', homeDir = os.homedir()) {
    const configured = configuredCodexModel(homeDir);
    const configuredEffort = configuredCodexReasoningEffort(homeDir);
    const rawModels = Array.isArray(models) ? models : [];
    const configuredEntry = rawModels.find(model =>
        (source === 'cache' ? model.slug : (model.id || model.model)) === configured
    );
    const reasoningMetadata = (model) => {
        const rawLevels = source === 'cache'
            ? model?.supported_reasoning_levels
            : model?.supportedReasoningEfforts;
        const reasoningEfforts = (Array.isArray(rawLevels) ? rawLevels : [])
            .map(level => source === 'cache' ? level.effort : level.reasoningEffort)
            .filter(Boolean);
        const defaultReasoningEffort = source === 'cache'
            ? model?.default_reasoning_level
            : model?.defaultReasoningEffort;
        return {
            ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            ...((configuredEffort || defaultReasoningEffort) ? { autoReasoningEffort: configuredEffort || defaultReasoningEffort } : {}),
        };
    };
    const result = [{
        id: 'default',
        name: configured ? `Default (CLI: ${configured})` : 'Default (Codex CLI)',
        ...(configuredEntry ? reasoningMetadata(configuredEntry) : {}),
    }];
    const seen = new Set(['default']);
    for (const model of Array.isArray(models) ? models : []) {
        const id = source === 'cache' ? model.slug : (model.id || model.model);
        const hidden = source === 'cache' ? model.visibility !== 'list' : model.hidden === true;
        if (!id || hidden || seen.has(id)) continue;
        seen.add(id);
        result.push({
            id,
            name: (source === 'cache' ? model.display_name : model.displayName) || id,
            ...reasoningMetadata(model),
        });
    }
    return result;
}

function queryCodexAppServer(codexPath, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const child = spawn(codexPath, ['app-server', '--stdio'], {
            cwd: os.homedir(), env: this.getSpawnEnv({ CI: 'true' }), stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '';
        let stderr = '';
        let settled = false;
        const finish = (error, models) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGTERM'); } catch (_) {}
            if (error) reject(error);
            else resolve(models);
        };
        const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
        child.stdout.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                let message;
                try { message = JSON.parse(line); } catch (_) { continue; }
                if (message.id === 1 && message.result) {
                    send({ method: 'initialized', params: {} });
                    send({ id: 2, method: 'model/list', params: { includeHidden: false, limit: 100 } });
                } else if (message.id === 1 && message.error) {
                    finish(new Error(message.error.message || 'Codex initialize failed'));
                } else if (message.id === 2 && message.result) {
                    finish(null, message.result.data || []);
                } else if (message.id === 2 && message.error) {
                    finish(new Error(message.error.message || 'Codex model/list failed'));
                }
            }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', finish);
        child.once('close', code => {
            if (!settled) finish(new Error(stderr.trim() || `Codex app-server exited ${code}`));
        });
        const timer = setTimeout(() => finish(new Error('Codex model discovery timed out')), timeoutMs);
        if (timer.unref) timer.unref();
        send({
            id: 1, method: 'initialize',
            params: { clientInfo: { name: 'telegram-bridge', version: '1.0.0' } },
        });
    });
}

class CodexAgent extends BaseAgent {
    constructor(sessionStore) {
        super('codex', 'Codex', '🧠');
        this.sessionStore = sessionStore;
        this.codexPath = null;
        this.modelControl = { discovery: 'live', effort: true, config: 'model_reasoning_effort' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();
        
        // Priority 1: Check ~/.codex/config.toml CODEX_CLI_PATH
        const configTomlPath = path.join(homeDir, '.codex', 'config.toml');
        if (fs.existsSync(configTomlPath)) {
            try {
                const content = fs.readFileSync(configTomlPath, 'utf8');
                const match = content.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/);
                if (match && fs.existsSync(match[1])) {
                    this.codexPath = match[1];
                }
            } catch (e) {}
        }

        // Priority 2 (Windows only): Sort AppData\Local\OpenAI\Codex\bin\*\codex.exe by NEWEST modification time
        if (!this.codexPath && isWin) {
            const localAppData = process.env.LOCALAPPDATA || '';
            const codexBinBase = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
            if (fs.existsSync(codexBinBase)) {
                try {
                    const dirs = fs.readdirSync(codexBinBase);
                    const candidates = [];
                    for (const d of dirs) {
                        const candidate = path.join(codexBinBase, d, 'codex.exe');
                        if (fs.existsSync(candidate)) {
                            candidates.push({ path: candidate, mtime: fs.statSync(candidate).mtimeMs });
                        }
                    }
                    candidates.sort((a, b) => b.mtime - a.mtime);
                    if (candidates.length > 0) {
                        this.codexPath = candidates[0].path;
                    }
                } catch (e) {}
            }
        }

        // Priority 3: Check standard npm / system paths
        if (!this.codexPath) {
            const stdCandidates = isWin ? [
                path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
                path.join(homeDir, 'AppData', 'Roaming', 'npm', 'codex.cmd')
            ] : [
                '/usr/local/bin/codex',
                '/usr/bin/codex',
                path.join(homeDir, '.local', 'bin', 'codex'),
                path.join(homeDir, '.npm-global', 'bin', 'codex')
            ];

            for (const c of stdCandidates) {
                if (c && fs.existsSync(c)) {
                    this.codexPath = c;
                    break;
                }
            }
        }

        // Priority 4: which/where lookup
        if (!this.codexPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} codex`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.codexPath = found;
            } catch { /* not found */ }
        }

        if (this.codexPath) {
            console.log(`[CodexAgent] Located codex CLI at: ${this.codexPath}`);
            await this.discoverModels();
        } else {
            console.warn('[CodexAgent] codex CLI not found.');
        }
    }

    async discoverModels({ force = false } = {}) {
        if (force && this.codexPath) {
            try {
                const models = normalizeCodexModels(await queryCodexAppServer(this.codexPath));
                if (models.length > 1) {
                    this.sessionStore.setAvailableModels('codex', models);
                    console.log(`[CodexAgent] Discovered ${models.length - 1} current models from app-server model/list.`);
                    return models;
                }
            } catch (e) {
                console.warn(`[CodexAgent] Live model discovery failed; using cache: ${e.message}`);
            }
        }

        const homeDir = os.homedir();
        const cacheFile = path.join(homeDir, '.codex', 'models_cache.json');
        if (fs.existsSync(cacheFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                const dynamicModels = normalizeCodexModels(data.models, 'cache', homeDir);
                if (dynamicModels.length > 1) {
                    this.sessionStore.setAvailableModels('codex', dynamicModels);
                    console.log(`[CodexAgent] Discovered ${dynamicModels.length - 1} models from models_cache.json.`);
                    return dynamicModels;
                }
            } catch (e) {
                console.warn(`[CodexAgent] Could not read models_cache.json: ${e.message}`);
            }
        }
        return null;
    }

    async onStart() {
        // Runs per request
    }

    async onStop() {
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch {}
            this.process = null;
        }
    }

    clearSession(chatId) {
        if (!chatId) return;
        this.sessionStore.clearSession('codex', chatId);
        if (this.chatHistories) this.chatHistories.delete(chatId);
        const historyFile = path.join(this.sessionStore.dir, `codex_history_${chatId}.json`);
        try { if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile); } catch {}
    }

    attachSession(chatId, sessionId, extra = {}) {
        if (chatId && sessionId) this.sessionStore.setSession('codex', sessionId, chatId, extra);
    }

    async listSessions(limit = 12) {
        const { listCodexSessions } = require('../core/sessionCatalog');
        return listCodexSessions(os.homedir(), limit);
    }

    async sendMessage(unifiedMessage) {
        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const model = this.sessionStore.getActiveModel('codex', chatId);
        const reasoningEffort = activeEffort(this.sessionStore, 'codex', model, this.sessionStore.getAvailableModels('codex'), chatId);
        const sessionId = this.sessionStore.getSession('codex', chatId);

        this.emitStatus('⏳ Thinking...');

        const isWin = process.platform === 'win32';
        const bin = this.codexPath || (isWin ? 'codex.cmd' : 'codex');

        let args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
        if (model && model !== 'default') {
            args.push('-m', model);
        }
        if (reasoningEffort) {
            args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
        }
        if (sessionId) {
            args.push('resume', sessionId, prompt);
        } else {
            args.push(prompt);
        }

        const workspaceRoot = this.sessionStore.getWorkspaceCwd('codex', chatId);
        const env = this.getSpawnEnv({ CI: 'true' });

        return new Promise((resolve) => {
            const spawnCmd = (isWin && bin.endsWith('.cmd')) ? 'cmd.exe' : bin;
            const spawnArgs = (isWin && bin.endsWith('.cmd')) ? ['/c', bin, ...args] : args;

            this.process = spawn(spawnCmd, spawnArgs, {
                cwd: workspaceRoot,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let buffer = '';
            let fullText = '';
            let lastEmittedLength = 0;
            let stderrText = '';

            const processEvent = (event) => {
                if (!event || typeof event !== 'object') return;

                const sid = event.session_id || event.thread_id || event.payload?.session_id || event.payload?.id;
                if (sid) this.sessionStore.setSession('codex', sid, chatId);
                if (event.type === 'session_meta' && event.payload?.session_id) {
                    this.sessionStore.setSession('codex', event.payload.session_id, chatId);
                }

                // 1. Message updates
                if (event.type === 'item.updated' || event.type === 'item.completed') {
                    if (event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
                        fullText = event.item.text;
                        if (fullText.length > lastEmittedLength) {
                            const delta = fullText.slice(lastEmittedLength);
                            lastEmittedLength = fullText.length;
                            this.emitText(delta);
                        }
                    }
                }

                // 2. Tool call indicator
                if (event.type === 'item.created' && event.item && event.item.type === 'tool_call') {
                    this.emitToolCall(event.item.name || 'tool');
                }

                // 3. Token usage tracking
                if (event.type === 'turn.completed' && event.usage) {
                    const { input_tokens, output_tokens } = event.usage;
                    const total = (input_tokens || 0) + (output_tokens || 0);
                    this.sessionStore.recordUsage('codex', total, input_tokens || 0, output_tokens || 0);
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
                        // ignore non-JSON logging
                    }
                    if (ev) {
                        try {
                            processEvent(ev);
                        } catch (err) {
                            console.error('[CodexAgent] processEvent error:', err.message);
                        }
                    }
                }
            });

            this.process.stderr.on('data', (chunk) => {
                const msg = chunk.toString().trim();
                if (msg && !msg.includes('Reading additional input')) {
                    console.log(`[CodexAgent STDERR] ${msg}`);
                    stderrText += msg + '\n';
                }
            });

            this.process.on('close', () => {
                this.process = null;
                if (!fullText && stderrText) {
                    // Extract concise error summary without dumping huge prompt bodies
                    const firstLine = stderrText.split('\n').filter(l => l.includes('ERROR') || l.includes('Error:') || l.trim()).shift() || 'Unknown error';
                    const cleanErr = firstLine.length > 250 ? firstLine.slice(0, 250) + '...' : firstLine;
                    fullText = `⚠️ <b>Codex Error:</b>\n<code>${cleanErr}</code>`;
                }
                this.emitFinished(fullText);
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[CodexAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

module.exports = CodexAgent;
module.exports.normalizeCodexModels = normalizeCodexModels;
module.exports.queryCodexAppServer = queryCodexAppServer;
