const BaseAgent = require('./BaseAgent');
const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const sdk = require('@agentclientprotocol/sdk');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { terminateChild } = require('./processUtils');

class AcpAgentBase extends BaseAgent {
    constructor(key, name, emoji, cliCommand, cliArgs) {
        super(key, name, emoji);
        this.cliCommand = cliCommand;
        this.cliArgs = cliArgs;
        this.connection = null;
        this.child = null;
        this.sessionId = null;
        this.chatSessions = new Map();
        this.agentCapabilities = {};
        this.currentModelId = null;
        this._cancelled = false;
        this._turnText = '';
        this._connectPromise = null;
    }

    resolveBin() {
        if (this.cliCommand && this.cliCommand.includes(path.sep) && fs.existsSync(this.cliCommand)) {
            return this.cliCommand;
        }
        const home = os.homedir();
        const name = this.cliCommand;
        const isWin = process.platform === 'win32';
        const candidates = [
            isWin && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', name + '.cmd') : null,
            isWin && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', name, name + '.exe') : null,
            isWin ? path.join(home, '.grok', 'bin', name + '.exe') : null,
            path.join(home, '.local', 'bin', name),
            path.join(home, '.grok', 'bin', name),
            path.join(home, '.npm-global', 'bin', name),
            '/usr/local/bin/' + name,
            '/usr/bin/' + name,
        ].filter(Boolean);
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) return candidate;
        }
        return name;
    }

    isAcpAlive() {
        return Boolean(this.connection && this.child && this.child.exitCode === null && this.child.signalCode === null);
    }

    acpEnv() {
        const home = os.homedir();
        const pathSep = path.delimiter;
        const currentPath = process.env.PATH || process.env.Path || '';
        return {
            ...process.env,
            CI: 'true',
            GROK_DISABLE_AUTOUPDATER: '1',
            PATH: [
                path.join(home, '.local', 'bin'),
                path.join(home, '.grok', 'bin'),
                path.join(home, '.npm-global', 'bin'),
                currentPath
            ].join(pathSep),
        };
    }

    async connectAcp() {
        if (this.isAcpAlive()) return this.connection;
        if (this._connectPromise) return this._connectPromise;

        this._connectPromise = (async () => {
            const workspaceRoot = this.workspaceCwd();
            const bin = this.resolveBin();
            console.log(`[${this.name}] Starting ACP: ${bin} ${this.cliArgs.join(' ')}`);

            const isWin = process.platform === 'win32';
            const useShell = isWin && (bin.endsWith('.cmd') || bin.endsWith('.bat'));

            this.child = spawn(bin, this.cliArgs, {
                cwd: workspaceRoot,
                env: this.acpEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: useShell
            });
            this.process = this.child;

            this.child.stderr.on('data', d => {
                const msg = d.toString().trim();
                if (msg && !msg.includes('ExperimentalWarning') && !msg.includes('DeprecationWarning')) {
                    console.log(`[${this.name} STDERR]:`, msg);
                }
            });

            this.child.once('close', (code, signal) => {
                console.warn(`[${this.name}] ACP process exited (${signal || code})`);
                this.connection = null;
                this.child = null;
                this.process = null;
                this.sessionId = null;
                this.chatSessions.clear();
                this.currentModelId = null;
                if (this._status === 'running') this.setStatus('stopped');
            });

            this.child.once('error', (err) => {
                console.error(`[${this.name}] ACP spawn error: ${err.message}`);
            });

            const rawReadable = Readable.toWeb(this.child.stdout);
            const rawWritable = Writable.toWeb(this.child.stdin);
            const stream = sdk.ndJsonStream(rawWritable, rawReadable);

            this.connection = new sdk.ClientSideConnection(
                (_agent) => ({
                    sessionUpdate: async (params) => this.handleSessionUpdate(params),
                    requestPermission: async () => ({ outcome: { outcome: 'approved' } }),
                    readTextFile: async (req) => {
                        try {
                            return { content: fs.readFileSync(req.path, 'utf8') };
                        } catch { return { content: '' }; }
                    },
                    writeTextFile: async (req) => {
                        try {
                            fs.writeFileSync(req.path, req.content || '', 'utf8');
                            return {};
                        } catch { return {}; }
                    },
                    extNotification: async () => {},
                    extMethod: async () => ({}),
                }),
                stream
            );

            const init = await this.connection.initialize({
                clientInfo: { name: 'TelegramBridge', version: '1.0.0' },
                protocolVersion: sdk.PROTOCOL_VERSION,
                clientCapabilities: {}
            });
            this.agentCapabilities = init?.agentCapabilities || {};
            console.log(`[${this.name}] ACP connected (protocol ${init?.protocolVersion || 'unknown'})`);
            return this.connection;
        })().finally(() => {
            this._connectPromise = null;
        });

        return this._connectPromise;
    }

    _setSession(chatId, sessionId, extra = {}) {
        this.sessionId = sessionId;
        this.currentModelId = null;
        if (chatId && sessionId) {
            this.chatSessions.set(chatId, sessionId);
            if (this.sessionStore) this.sessionStore.setSession(this.key, sessionId, chatId, extra);
        }
    }

    workspaceCwd(chatId) {
        if (this.sessionStore && typeof this.sessionStore.getWorkspaceCwd === 'function') {
            return this.sessionStore.getWorkspaceCwd(this.key, chatId);
        }
        return process.env.WORKSPACE_ROOT || process.cwd();
    }

    async ensureSession(chatId) {
        if (!this.isAcpAlive()) await this.connectAcp();
        const workspaceRoot = this.workspaceCwd(chatId);
        const cached = (chatId && this.chatSessions.get(chatId)) || (chatId && this.sessionStore?.getSession(this.key, chatId)) || null;

        if (cached && this.sessionId === cached && this.chatSessions.get(chatId) === cached) {
            return cached;
        }

        if (cached) {
            const caps = this.agentCapabilities || {};
            const canResume = Boolean(caps.sessionCapabilities?.resume);
            const canLoad = Boolean(caps.loadSession);
            if (canResume) {
                try {
                    await this.connection.resumeSession({ sessionId: cached, cwd: workspaceRoot, mcpServers: [] });
                    this._setSession(chatId, cached);
                    console.log(`[${this.name}] Resumed ACP session ${cached}`);
                    return cached;
                } catch (e) {
                    console.warn(`[${this.name}] resumeSession failed: ${e.message}`);
                }
            }
            if (canLoad) {
                try {
                    await this.connection.loadSession({ sessionId: cached, cwd: workspaceRoot, mcpServers: [] });
                    this._setSession(chatId, cached);
                    console.log(`[${this.name}] Loaded ACP session ${cached}`);
                    return cached;
                } catch (e) {
                    console.warn(`[${this.name}] loadSession failed: ${e.message}`);
                }
            }
        }

        const sessionRes = await this.connection.newSession({
            cwd: workspaceRoot,
            mcpServers: [],
            _meta: { yoloMode: true },
        });
        this._setSession(chatId, sessionRes.sessionId, { cwd: workspaceRoot });
        console.log(`[${this.name}] New ACP session ${sessionRes.sessionId} cwd=${workspaceRoot}`);
        return sessionRes.sessionId;
    }

    async onStart() {
        await this.connectAcp();
    }

    async cancelTurn() {
        this._cancelled = true;
        if (this.connection && this.sessionId) {
            try {
                await this.connection.cancel({ sessionId: this.sessionId });
            } catch (e) {}
        }
    }

    async applyModel(modelId) {
        if (!modelId || modelId === 'default' || modelId === this.currentModelId) return;
        if (this.connection && this.sessionId) {
            try {
                await this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
                this.currentModelId = modelId;
                console.log(`[${this.name}] Active model set to: ${modelId}`);
            } catch (e) {
                console.warn(`[${this.name}] unstable_setSessionModel error:`, e.message);
                try {
                    await this.connection.setSessionConfigOption({
                        sessionId: this.sessionId,
                        configId: 'model',
                        type: 'string',
                        value: modelId
                    });
                    this.currentModelId = modelId;
                } catch (e2) {
                    console.warn(`[${this.name}] setSessionConfigOption error:`, e2.message);
                }
            }
        }
    }

    clearSession(chatId) {
        const old = (chatId && this.chatSessions.get(chatId)) || this.sessionId;
        if (chatId) this.chatSessions.delete(chatId);
        if (chatId && this.sessionStore) this.sessionStore.clearSession(this.key, chatId);
        if (this.sessionId === old) {
            this.sessionId = null;
            this.currentModelId = null;
        }
        if (old && this.connection && typeof this.connection.closeSession === 'function') {
            this.connection.closeSession({ sessionId: old }).catch(() => {});
        }
    }

    async onStop() {
        this._cancelled = true;
        if (this.connection && this.sessionId) {
            try {
                await this.connection.cancel({ sessionId: this.sessionId });
            } catch (e) {}
        }
        const child = this.child;
        this.connection = null;
        this.child = null;
        this.process = null;
        this.sessionId = null;
        this.chatSessions.clear();
        await terminateChild(child);
    }

    async sendMessage(unifiedMessage) {
        this._cancelled = false;
        this._turnText = '';
        await this.connectAcp();
        const chatId = unifiedMessage.chatId;
        await this.ensureSession(chatId);

        const modelId = this.sessionStore?.getActiveModel(this.key, chatId);
        if (modelId && modelId !== 'default' && modelId !== this.currentModelId) {
            await this.applyModel(modelId);
        }

        const promptText = unifiedMessage.content.text;
        this.emitStatus('⏳ Thinking...');

        const res = await this.connection.prompt({
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text: promptText }]
        });

        if (this._cancelled || res?.stopReason === 'cancelled') {
            return;
        }

        const usage = res?.usage || res?._meta?.usage;
        if (usage && this.sessionStore) {
            this.sessionStore.recordUsage(
                this.key,
                usage.total_tokens || usage.totalTokens,
                usage.input_tokens || usage.inputTokens || 0,
                usage.output_tokens || usage.outputTokens || 0
            );
        }

        this.emitFinished(this._turnText || '');
    }

    async handleSessionUpdate(params) {
        if (!params || !params.update) return;

        const update = params.update;
        const type = update.sessionUpdate;

        if (type === 'agent_message_chunk') {
            if (update.content && update.content.text) {
                this._turnText += update.content.text;
                this.emitText(update.content.text);
            }
        } else if (type === 'agent_thought_chunk') {
            if (update.content && update.content.text) {
                this.emitStatus(`🤔 ${update.content.text.substring(0, 40).replace(/\n/g, '')}...`);
            }
        } else if (type === 'tool_call' || type === 'tool_call_update') {
            const name = update.title || update.kind || update.name || update.toolCall?.name || 'tool';
            this.emitToolCall(name);
        } else if (type === 'plan') {
            this.emitStatus('📝 Planning tasks...');
        }
    }
}

module.exports = AcpAgentBase;
