// =============================================================================
//  core/BaseAgent.js — Abstract Base Agent
//
//  Defines the core agent lifecycle state machine:
//    created → initializing → ready → starting → running → stopping → stopped
//  And abstract methods: onInitialize, onStart, onStop, sendMessage, editMessage
//  Also provides getSpawnEnv() — the per-agent provider override overlay that
//  subclasses merge into their CLI subprocess env (see core/AgentOverrides.js).
// =============================================================================
const { channelEventBus } = require('./EventBus');

class BaseAgent {
    constructor(key, name, emoji) {
        this.key = key;         // 'gemini', 'opencode', etc.
        this.name = name;       // 'Gemini CLI'
        this.emoji = emoji;     // '💎'
        this._status = 'created';
        this.process = null;
        this.errorMessage = null;
        this.currentRequestId = null;
        this.modelControl = { discovery: 'static', effort: false };
    }

    get status() { return this._status; }
    get isWarm() { return this._status === 'running'; }

    /** Is this agent's provider override toggle currently on? */
    get overrideActive() {
        try {
            const { getAgentOverrides } = require('./AgentOverrides');
            return getAgentOverrides().isEnabled(this.key);
        } catch (err) {
            console.warn(`[BaseAgent] Failed to read override state for ${this.key}:`, err.message);
            return false;
        }
    }

    /**
     * Build the env for a spawned CLI subprocess.
     * Merge order: process.env  ←  extra  ←  provider override overlay.
     * The overlay is `{}` when the toggle is off, so the agent keeps exactly
     * its default env. Never throws — falls back to `{ ...process.env, ...extra }`.
     */
    getSpawnEnv(extra = {}) {
        const base = { ...process.env, ...(extra || {}) };
        try {
            const { getAgentOverrides } = require('./AgentOverrides');
            const overlay = getAgentOverrides().getEnvOverlay(this.key);
            return { ...base, ...overlay };
        } catch (err) {
            console.warn(`[BaseAgent] Failed to apply override overlay for ${this.key}:`, err.message);
            return base;
        }
    }

    setStatus(status, error) {
        const old = this._status;
        this._status = status;
        this.errorMessage = error || null;
        console.log(`[${this.name}] Status: ${old} → ${status}${error ? ` (${error})` : ''}`);
    }

    // --- Lifecycle ---
    async initialize() {
        this.setStatus('initializing');
        try {
            await this.onInitialize();
            this.setStatus('ready');
        } catch (err) {
            this.setStatus('error', err.message);
            throw err;
        }
    }

    async start() {
        if (this._status !== 'ready' && this._status !== 'stopped') {
            throw new Error(`Cannot start agent in status: ${this._status}`);
        }
        this.setStatus('starting');
        try {
            await this.onStart();
            this.setStatus('running');
        } catch (err) {
            this.setStatus('error', err.message);
            throw err;
        }
    }

    /**
     * Bring the agent to `running` without repeating expensive initialize()
     * work (CLI lookups, model discovery) on every first message.
     */
    async ensureRunning() {
        if (this._status === 'running') return;
        if (this._startPromise) return this._startPromise;
        this._startPromise = (async () => {
            try {
                if (this._status === 'created' || this._status === 'error') {
                    await this.initialize();
                }
                if (this._status === 'ready' || this._status === 'stopped') {
                    await this.start();
                }
            } finally {
                this._startPromise = null;
            }
        })();
        return this._startPromise;
    }

    async stop() {
        if (this._status !== 'running' && this._status !== 'error') return;
        this.setStatus('stopping');
        try {
            await this.onStop();
            this.setStatus('stopped');
        } catch (err) {
            this.setStatus('error', err.message);
        }
    }

    // --- EventBus helpers (agents emit events, Gateway listens) ---
    setRequestContext(requestId) { this.currentRequestId = requestId || null; }
    emitText(text) { channelEventBus.emitAgentMessage(this.key, { type: 'text', text }, this.currentRequestId); }
    emitToolCall(toolName) { channelEventBus.emitToolCall(this.key, toolName, this.currentRequestId); }
    emitStatus(msg) { channelEventBus.emitStatus(this.key, msg, this.currentRequestId); }
    emitFinished(finalText) { channelEventBus.emitFinished(this.key, finalText, this.currentRequestId); }
    emitError(err) { channelEventBus.emitError(this.key, err, this.currentRequestId); }

    // --- Abstract methods (subclasses MUST implement) ---
    async onInitialize() { throw new Error('Not implemented: onInitialize'); }
    async onStart() { throw new Error('Not implemented: onStart'); }
    async onStop() { throw new Error('Not implemented: onStop'); }

    /**
     * Send a user's message to the agent.
     * This is the core method — it takes a UnifiedIncomingMessage and
     * emits events via the EventBus as the agent responds.
     */
    async sendMessage(unifiedMessage) { throw new Error('Not implemented: sendMessage'); }
}

module.exports = BaseAgent;
