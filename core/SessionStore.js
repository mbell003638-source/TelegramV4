// =============================================================================
//  core/SessionStore.js — Session & Preferences Manager
//
//  Handles per-chat session isolation, model preferences, and token usage metrics.
//  Uses asynchronous atomic JSON file persistence with automatic rotation.
// =============================================================================
const fs = require('fs');
const path = require('path');

const STALE_SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL = 60 * 60 * 1000;        // Run cleanup every 1 hour
const WRITE_DEBOUNCE_MS = Number(process.env.PERSISTENCE_DEBOUNCE_MS) || 150;
const BACKUP_COUNT = Number(process.env.PERSISTENCE_BACKUPS) || 3;
const SCHEMA_VERSION = 2;

const DEFAULT_MODELS = {
    antigravity: [
        { id: 'default', name: 'Auto / Default (Recommended)' },
        { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High Effort)' },
        { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Med Effort)' },
        { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low Effort)' },
        { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High Effort)' },
        { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Med Effort)' },
        { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low Effort)' },
        { id: 'gemini-3.5-flash-medium', name: 'Gemini 3.5 Flash' },
        { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High Effort)' },
        { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low Effort)' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
        { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B' }
    ],
    codex: [
        { id: 'default', name: 'Default (Codex CLI)' },
        { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
        { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Flagship)' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
        { id: 'gpt-5.2', name: 'GPT-5.2' },
        { id: 'gpt-5.1', name: 'GPT-5.1' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'o3-mini', name: 'o3-mini' },
        { id: 'o3', name: 'o3' },
        { id: 'o1', name: 'o1' }
    ],
    claude: [
        { id: 'default', name: 'Default (Opus 5)' },
        { id: 'claude-opus-5', name: 'Claude Opus 5 (Flagship)' },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' }
    ],
    opencode: [
        { id: 'default', name: 'Default Model' },
        { id: 'tokenrouter/z-ai/glm-5.3-free', name: 'GLM 5.3 (Free / TokenRouter)' },
        { id: 'nvidia/z-ai/glm-5.2', name: 'GLM 5.2 (Nvidia)' },
        { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Nvidia)' },
        { id: 'nvidia/deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro (Nvidia)' },
        { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)' }
    ],
    pi: [
        { id: 'default', name: 'Default Model' },
        { id: 'nvidia/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro (Nvidia)' },
        { id: 'nvidia/google/gemma-3-12b-it', name: 'Gemma 3 12B (Nvidia)' },
        { id: 'nvidia/meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision (Nvidia)' },
        { id: 'nvidia/moonshotai/kimi-k3', name: 'Kimi K3 (Nvidia)' },
        { id: 'nvidia/nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B (Nvidia)' },
        { id: 'nvidia/openai/gpt-oss-120b', name: 'GPT-OSS 120B (Nvidia)' }
    ],
    grok: [
        { id: 'default', name: 'Default (grok-4.6)' },
        { id: 'grok-4.6', name: 'Grok 4.6 (Latest)' },
        { id: 'grok-4.5', name: 'Grok 4.5' }
    ],
    hermes: [
        { id: 'default', name: 'Default Model' }
    ],
    openclaw: [
        { id: 'default', name: 'Default Model' }
    ]
};

class SessionStore {
    constructor(baseDir) {
        this.dir = path.join(baseDir, 'sessions');
        if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

        this.prefsFile = path.join(this.dir, 'preferences.json');
        this.sessionsFile = path.join(this.dir, 'sessions.json');
        this.usageFile = path.join(this.dir, 'usage.json');
        this.chatPrefsFile = path.join(this.dir, 'chat_preferences.json');
        this._pendingWrites = new Map();
        this._writeTimers = new Map();

        this.prefs = this._load(this.prefsFile) || {
            activeAgent: 'antigravity',
            models: {},
            voiceMode: false,
        };
        this.sessions = this._load(this.sessionsFile) || {};
        this.usage = this._load(this.usageFile) || {};

        // Per-chat preferences: { "chatId": { activeAgent: "gemini" } }
        // This enables per-chat isolation — different chats can use different agents
        this.chatPrefs = this._load(this.chatPrefsFile) || {};
        this._migrateLegacyState();

        // Stale session cleanup timer
        this._cleanupTimer = setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL);
        this._cleanupTimer.unref();
        // Run once on startup
        this.cleanupStaleSessions();
    }

    _load(file) {
        try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
        catch { return null; }
    }

    _migrateLegacyState() {
        // Legacy installations used four independent JSON files. Keep them
        // readable, but stamp a schema marker so future migrations are explicit.
        const marker = path.join(this.dir, 'schema.json');
        const current = this._load(marker);
        if (!current || current.version !== SCHEMA_VERSION) {
            this._save(marker, { version: SCHEMA_VERSION, migratedAt: new Date().toISOString() });
        }
    }

    _save(file, data) {
        this._pendingWrites.set(file, data);
        clearTimeout(this._writeTimers.get(file));
        this._writeTimers.set(file, setTimeout(() => this._flushFile(file), WRITE_DEBOUNCE_MS));
    }

    async _flushFile(file) {
        const data = this._pendingWrites.get(file);
        if (data === undefined) return;
        this._pendingWrites.delete(file);
        this._writeTimers.delete(file);
        const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.promises.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8');
            if (fs.existsSync(file)) {
                for (let i = BACKUP_COUNT - 1; i >= 1; i--) {
                    const from = `${file}.${i}.bak`;
                    const to = `${file}.${i + 1}.bak`;
                    if (fs.existsSync(from)) await fs.promises.rename(from, to).catch(() => {});
                }
                await fs.promises.copyFile(file, `${file}.1.bak`).catch(() => {});
            }
            await fs.promises.rename(tempFile, file);
        } catch (e) {
            await fs.promises.rm(tempFile, { force: true }).catch(() => {});
            console.error(`[SessionStore] Async save failed: ${e.message}`);
        }
    }

    async flush() {
        for (const timer of this._writeTimers.values()) clearTimeout(timer);
        const files = [...this._pendingWrites.keys()];
        await Promise.all(files.map(file => this._flushFile(file)));
    }

    // --- Preferences (global defaults) ---
    getActiveAgent(chatId) {
        // Per-chat override takes priority over global default
        let agent = (chatId && this.chatPrefs[chatId]?.activeAgent) ? this.chatPrefs[chatId].activeAgent : this.prefs.activeAgent;
        if (agent === 'desktop' || !agent) {
            agent = 'antigravity';
            if (chatId && this.chatPrefs[chatId]) {
                this.chatPrefs[chatId].activeAgent = 'antigravity';
                this._save(this.chatPrefsFile, this.chatPrefs);
            }
        }
        return agent;
    }

    setActiveAgent(agent, chatId) {
        if (chatId) {
            // Set per-chat agent preference
            if (!this.chatPrefs[chatId]) this.chatPrefs[chatId] = {};
            this.chatPrefs[chatId].activeAgent = agent;
            this._save(this.chatPrefsFile, this.chatPrefs);
        }
        // A chat override must not silently change the default for other chats.
        if (!chatId) {
            this.prefs.activeAgent = agent;
            this._save(this.prefsFile, this.prefs);
        }
    }

    setAvailableModels(agent, models) {
        if (!this.dynamicModels) this.dynamicModels = {};
        this.dynamicModels[agent] = models;
    }

    getAvailableModels(agent) {
        return this.dynamicModels?.[agent] || DEFAULT_MODELS[agent] || [];
    }

    getActiveModel(agent, chatId) {
        if (chatId && this.chatPrefs[chatId]?.models?.[agent]) {
            return this.chatPrefs[chatId].models[agent];
        }
        return this.prefs.models?.[agent] || DEFAULT_MODELS[agent]?.[0]?.id || null;
    }

    setActiveModel(agent, model, chatId) {
        if (chatId) {
            if (!this.chatPrefs[chatId]) this.chatPrefs[chatId] = {};
            if (!this.chatPrefs[chatId].models) this.chatPrefs[chatId].models = {};
            this.chatPrefs[chatId].models[agent] = model;
            this._save(this.chatPrefsFile, this.chatPrefs);
        }
        if (!chatId) {
            if (!this.prefs.models) this.prefs.models = {};
            this.prefs.models[agent] = model;
            this._save(this.prefsFile, this.prefs);
        }
    }

    getReasoningEffort(agent, model, chatId) {
        if (!model) return null;
        return this.chatPrefs[chatId]?.reasoningEfforts?.[agent]?.[model]
            || this.prefs.reasoningEfforts?.[agent]?.[model]
            || null;
    }

    setReasoningEffort(agent, model, effort, chatId) {
        const target = chatId ? this._chatPref(chatId) : this.prefs;
        if (!target.reasoningEfforts) target.reasoningEfforts = {};
        if (!target.reasoningEfforts[agent]) target.reasoningEfforts[agent] = {};
        if (effort) target.reasoningEfforts[agent][model] = effort;
        else delete target.reasoningEfforts[agent][model];
        this._save(chatId ? this.chatPrefsFile : this.prefsFile, chatId ? this.chatPrefs : this.prefs);
    }

    getModel(agent) { return this.getActiveModel(agent); }
    setModel(agent, model) { this.setActiveModel(agent, model); }
    getVoiceMode() { return this.prefs.voiceMode; }
    setVoiceMode(mode) { this.prefs.voiceMode = mode; this._save(this.prefsFile, this.prefs); }

    _chatPref(chatId) {
        if (!chatId) return null;
        if (!this.chatPrefs[chatId]) this.chatPrefs[chatId] = {};
        return this.chatPrefs[chatId];
    }

    memoriesPath() {
        return path.join(this.dir, 'MEMORIES.md');
    }

    getMemories() {
        const file = this.memoriesPath();
        try {
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        } catch {
            return '';
        }
    }

    addMemory(note) {
        const text = String(note || '').trim();
        if (!text) return false;
        const file = this.memoriesPath();
        const header = '# USER PROFILE & PREFERENCES\n';
        try {
            if (!fs.existsSync(file)) fs.writeFileSync(file, header, 'utf8');
            fs.appendFileSync(file, `\n- ${text}`, 'utf8');
            return true;
        } catch (e) {
            console.error(`[SessionStore] Failed to save memory: ${e.message}`);
            return false;
        }
    }

    clearMemories() {
        fs.writeFileSync(this.memoriesPath(), '# USER PROFILE & PREFERENCES\n', 'utf8');
    }

    getPendingMemories(chatId) {
        return this.chatPrefs[chatId]?.pendingMemories || [];
    }

    addPendingMemory(chatId, note) {
        const text = String(note || '').trim();
        if (!chatId || !text) return;
        const prefs = this._chatPref(chatId);
        if (!prefs.pendingMemories) prefs.pendingMemories = [];
        prefs.pendingMemories.push(text);
        this._save(this.chatPrefsFile, this.chatPrefs);
    }

    clearPendingMemories(chatId) {
        if (!chatId || !this.chatPrefs[chatId]?.pendingMemories) return;
        this.chatPrefs[chatId].pendingMemories = [];
        this._save(this.chatPrefsFile, this.chatPrefs);
    }

    getRecentTurns(chatId) {
        return this.chatPrefs[chatId]?.recentTurns || [];
    }

    appendRecentTurn(chatId, turn) {
        if (!chatId) return;
        const prefs = this._chatPref(chatId);
        const turns = prefs.recentTurns || [];
        turns.push({
            agent: turn.agent || '',
            agentName: turn.agentName || turn.agent || 'agent',
            userText: String(turn.userText || '').slice(0, 1500),
            assistantText: String(turn.assistantText || '').slice(0, 2500),
            at: Date.now(),
        });
        prefs.recentTurns = turns.slice(-4);
        this._save(this.chatPrefsFile, this.chatPrefs);
    }

    clearRecentTurns(chatId) {
        if (!chatId || !this.chatPrefs[chatId]) return;
        this.chatPrefs[chatId].recentTurns = [];
        this._save(this.chatPrefsFile, this.chatPrefs);
    }

    // =========================================================================
    //  PER-CHAT SESSION ISOLATION
    //
    //  Composite key: agentKey:chatId
    //  Allows:
    //    - Different agents active in different chats
    //    - Separate conversation sessions per chat
    // =========================================================================

    /**
     * Build composite session key: agent:chatId
     */
    _buildKey(agent, chatId) {
        return chatId ? `${agent}:${chatId}` : agent;
    }

    getSession(agent, chatId) {
        const meta = this.getSessionMeta(agent, chatId);
        return meta ? meta.sessionId : null;
    }

    getSessionMeta(agent, chatId) {
        const key = this._buildKey(agent, chatId);
        const session = this.sessions[key];
        if (!session) return null;
        if (typeof session === 'object') return session;
        return { sessionId: session, agent, chatId: chatId || null, cwd: null };
    }

    getChatCwd(chatId) {
        const cwd = chatId && this.chatPrefs[chatId]?.cwd;
        if (cwd) {
            try {
                if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
            } catch { /* fall through */ }
        }
        return null;
    }

    setChatCwd(chatId, cwd) {
        if (!chatId) return;
        const prefs = this._chatPref(chatId);
        if (cwd) prefs.cwd = cwd;
        else delete prefs.cwd;
        this._save(this.chatPrefsFile, this.chatPrefs);
    }

    getWorkspaceCwd(agent, chatId) {
        const candidates = [
            this.getChatCwd(chatId),
            this.getSessionMeta(agent, chatId)?.cwd,
            process.env.WORKSPACE_ROOT,
            process.cwd(),
        ];
        for (const cwd of candidates) {
            if (!cwd) continue;
            try {
                if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
            } catch { /* try next */ }
        }
        return process.cwd();
    }

    setSession(agent, sessionId, chatId, extra = {}) {
        const key = this._buildKey(agent, chatId);
        const existing = this.getSessionMeta(agent, chatId) || {};
        const cwd = extra.cwd || existing.cwd || null;
        this.sessions[key] = {
            sessionId,
            agent,
            chatId: chatId || null,
            lastActivity: Date.now(),
            cwd: cwd || null,
        };
        this._save(this.sessionsFile, this.sessions);
    }

    clearSession(agent, chatId) {
        const key = this._buildKey(agent, chatId);
        delete this.sessions[key];
        this._save(this.sessionsFile, this.sessions);
    }

    /**
     * Clear all sessions — used when switching agents
     */
    clearAllSessions() {
        const count = Object.keys(this.sessions).length;
        this.sessions = {};
        this._save(this.sessionsFile, this.sessions);
        return count;
    }

    /**
     * Stale session cleanup
     * Removes sessions that haven't been active in 24 hours.
     */
    cleanupStaleSessions(maxAgeMs = STALE_SESSION_TTL) {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, session] of Object.entries(this.sessions)) {
            const lastActivity = typeof session === 'object' ? session.lastActivity : 0;
            if (lastActivity && (now - lastActivity) > maxAgeMs) {
                delete this.sessions[key];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`[SessionStore] Cleaned up ${cleaned} stale session(s) (older than ${Math.round(maxAgeMs / 3600000)}h)`);
            this._save(this.sessionsFile, this.sessions);
        }

        return cleaned;
    }

    /**
     * Stop the cleanup timer (for graceful shutdown)
     */
    stop() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        return this.flush();
    }

    // --- Usage Tracking ---
    getUsage(agent) {
        if (!this.usage[agent]) {
            this.usage[agent] = { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastReset: new Date().toISOString() };
        }
        return this.usage[agent];
    }

    trackRequest(agent) {
        const u = this.getUsage(agent);
        u.totalRequests++;
        this._save(this.usageFile, this.usage);
    }

    trackTokens(agent, input, output) {
        const u = this.getUsage(agent);
        u.totalInputTokens += input || 0;
        u.totalOutputTokens += output || 0;
        this._save(this.usageFile, this.usage);
    }

    recordUsage(agent, total, input, output) {
        this.trackTokens(agent, input, output);
    }

    resetUsage() {
        this.usage = {};
        this._save(this.usageFile, this.usage);
    }
}

module.exports = SessionStore;
