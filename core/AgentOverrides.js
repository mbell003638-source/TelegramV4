// =============================================================================
//  core/AgentOverrides.js — Per-Agent Provider Override Toggles
//
//  One toggle per agent (claude, codex, grok, hermes, opencode, openclaw,
//  pi, antigravity):
//    ON  → the agent's CLI is pointed at a chosen provider/key via an ENV
//          OVERLAY merged at spawn time (see BaseAgent.getSpawnEnv).
//    OFF → the overlay disappears entirely and the CLI falls back to exactly
//          its original default (process.env), losslessly.
//
//  Nothing here mutates process.env — the overlay is applied per-spawn, so an
//  override on one agent can never leak into another agent or into the bridge
//  itself. `snapshot` records what each override shadows (with null meaning
//  "was unset") so the revert is provably exact and survives a restart.
//
//  Persisted to store/agent-overrides.json. Node builtins only.
// =============================================================================
const fs = require('fs');
const path = require('path');

// Marker var, always set while an override is on, so it can be verified from
// inside a spawned process (`echo $OMNIROUTER_ACTIVE`).
const MARKER_VAR = 'OMNIROUTER_ACTIVE';

// Which env vars each CLI actually reads, grouped by role.
// Values are ALWAYS arrays (antigravity needs two api-key vars), so the UI can
// introspect them uniformly. A role that is absent is not supported by that CLI.
const AGENT_ENV_MAP = {
    claude:      { baseUrl: ['ANTHROPIC_BASE_URL'], apiKey: ['ANTHROPIC_AUTH_TOKEN'], model: ['ANTHROPIC_MODEL'] },
    codex:       { baseUrl: ['OPENAI_BASE_URL'],    apiKey: ['OPENAI_API_KEY'],    model: ['OPENAI_MODEL'] },
    opencode:    { baseUrl: ['OPENAI_BASE_URL'],    apiKey: ['OPENAI_API_KEY'] },
    grok:        { baseUrl: ['XAI_BASE_URL'],       apiKey: ['XAI_API_KEY'],       model: ['GROK_MODEL'] },
    hermes:      { baseUrl: ['OPENAI_BASE_URL'],    apiKey: ['OPENAI_API_KEY'],    model: ['HERMES_MODEL'] },
    pi:          { baseUrl: ['OPENAI_BASE_URL'],    apiKey: ['OPENAI_API_KEY'] },
    openclaw:    { baseUrl: ['OPENAI_BASE_URL'],    apiKey: ['OPENAI_API_KEY'] },
    // agy (Gemini CLI) has no documented base-url env — GEMINI_BASE_URL /
    // GOOGLE_GEMINI_BASE_URL are not honoured — so this agent cannot be
    // pointed at the gateway. Only apiKey overlay is supported.
    antigravity: { apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
};

const ROLES = ['baseUrl', 'apiKey', 'model'];

// Fixed env vars applied alongside an override. `null` means delete that key
// from the spawn env (see BaseAgent.getSpawnEnv). Claude Code maps
// ANTHROPIC_API_KEY → X-Api-Key and ANTHROPIC_AUTH_TOKEN → Authorization:
// Bearer; setting both is an auth conflict, so the API key is unset while
// the toggle is on. Claude Code >= 2.1.129 uses gateway discovery to pull
// GET /v1/models into its own /model picker.
const AGENT_ENV_CONSTANTS = {
    claude: {
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        ANTHROPIC_API_KEY: null,
    },
};

/** Repo-standard secret mask: first 7 + '...' + last 4. */
function maskKey(key) {
    if (!key) return '';
    const str = String(key);
    if (str.length <= 12) return '*'.repeat(str.length);
    return str.slice(0, 7) + '...' + str.slice(-4);
}

class AgentOverrides {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.storeDir = path.join(this.baseDir, 'store');
        this.filePath = path.join(this.storeDir, 'agent-overrides.json');
        this.overrides = {};
        this._load();
    }

    // --- Persistence -------------------------------------------------------

    _load() {
        try {
            if (!fs.existsSync(this.filePath)) return;
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            const agents = parsed && typeof parsed === 'object' ? parsed.agents : null;
            if (agents && typeof agents === 'object') {
                for (const [key, state] of Object.entries(agents)) {
                    if (!(key in AGENT_ENV_MAP)) continue;
                    if (!state || typeof state !== 'object') continue;
                    this.overrides[key] = {
                        enabled: Boolean(state.enabled),
                        providerId: state.providerId || null,
                        model: state.model || null,
                        baseUrl: state.baseUrl || null,
                        apiKey: state.apiKey || null,
                        snapshot: state.snapshot && typeof state.snapshot === 'object' ? { ...state.snapshot } : {},
                        updatedAt: state.updatedAt || null,
                    };
                }
            }
        } catch (err) {
            console.warn('[AgentOverrides] Failed to read agent-overrides.json:', err.message);
        }
    }

    _save() {
        try {
            if (!fs.existsSync(this.storeDir)) {
                fs.mkdirSync(this.storeDir, { recursive: true });
            }
            const payload = { version: 1, agents: this.overrides };
            fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
        } catch (err) {
            console.warn('[AgentOverrides] Failed to persist agent-overrides.json:', err.message);
        }
    }

    // --- Internals ---------------------------------------------------------

    /** Env var names this agent's override *can* control (flat, deduped). */
    _varsFor(agentKey) {
        const entry = AGENT_ENV_MAP[agentKey];
        if (!entry) return [];
        const names = [];
        for (const role of ROLES) {
            for (const name of entry[role] || []) {
                if (!names.includes(name)) names.push(name);
            }
        }
        for (const name of Object.keys(AGENT_ENV_CONSTANTS[agentKey] || {})) {
            if (!names.includes(name)) names.push(name);
        }
        return names;
    }

    /** Env var names an override with these values would actually set. */
    _varsToSet(agentKey, values) {
        const entry = AGENT_ENV_MAP[agentKey];
        if (!entry) return [];
        const names = [];
        for (const role of ROLES) {
            const value = values ? values[role] : null;
            if (value === undefined || value === null || value === '') continue;
            for (const name of entry[role] || []) {
                if (!names.includes(name)) names.push(name);
            }
        }
        if (names.length) {
            for (const name of Object.keys(AGENT_ENV_CONSTANTS[agentKey] || {})) {
                if (!names.includes(name)) names.push(name);
            }
            names.push(MARKER_VAR);
        }
        return names;
    }

    // --- Public API --------------------------------------------------------

    /** Is this agent's toggle currently on? */
    isEnabled(agentKey) {
        const state = this.overrides[agentKey];
        return Boolean(state && state.enabled);
    }

    /**
     * RAW state for one agent (includes the plaintext api key) — server-side
     * use only. Use describe() for anything that reaches a UI or a log.
     */
    get(agentKey) {
        const state = this.overrides[agentKey];
        if (!state) return null;
        return { ...state, snapshot: { ...state.snapshot } };
    }

    /** RAW state for every agent that has one. Server-side only. */
    getAll() {
        const out = {};
        for (const key of Object.keys(this.overrides)) {
            out[key] = this.get(key);
        }
        return out;
    }

    /**
     * Toggle ON: reconfigure this agent to run against the given provider.
     * The ORIGINAL value of every var the overlay will shadow is snapshotted
     * first (null = the var was unset), which is what makes disable() exact.
     */
    enable(agentKey, { providerId, model, baseUrl, apiKey } = {}) {
        if (!(agentKey in AGENT_ENV_MAP)) {
            throw new Error(`Unknown agent key: ${agentKey}`);
        }
        const values = {
            baseUrl: baseUrl || null,
            apiKey: apiKey || null,
            model: model || null,
        };

        const snapshot = {};
        for (const name of this._varsToSet(agentKey, values)) {
            const prior = process.env[name];
            snapshot[name] = prior === undefined ? null : prior;
        }

        this.overrides[agentKey] = {
            enabled: true,
            providerId: providerId || null,
            model: values.model,
            baseUrl: values.baseUrl,
            apiKey: values.apiKey,
            snapshot,
            updatedAt: new Date().toISOString(),
        };
        this._save();
        return this.describe(agentKey);
    }

    /**
     * Toggle OFF: drop the overlay so the agent reverts to its default.
     * Returns the restored view — `restored[VAR]` is the value the spawn env
     * falls back to, with null meaning "unset again" (never an empty string).
     */
    disable(agentKey) {
        const state = this.overrides[agentKey];
        const snapshot = state && state.snapshot ? state.snapshot : {};
        const restored = {};
        for (const [name, value] of Object.entries(snapshot)) {
            restored[name] = value === undefined ? null : value;
        }

        if (state) {
            this.overrides[agentKey] = {
                enabled: false,
                providerId: null,
                model: null,
                baseUrl: null,
                apiKey: null,
                snapshot: {},
                updatedAt: new Date().toISOString(),
            };
            this._save();
        }

        return {
            agentKey,
            enabled: false,
            restored,
            envOverlay: this.getEnvOverlay(agentKey),
        };
    }

    /**
     * CORE METHOD — the env vars to merge into the child process env at spawn
     * time. `{}` when the toggle is off, so the agent keeps its default.
     * Never contains undefined or empty-string values. A value of `null`
     * means delete that key from the spawn env (do not set '').
     */
    getEnvOverlay(agentKey) {
        const overlay = {};
        try {
            const entry = AGENT_ENV_MAP[agentKey];
            const state = this.overrides[agentKey];
            if (!entry || !state || !state.enabled) return overlay;

            for (const role of ROLES) {
                const value = state[role];
                if (value === undefined || value === null || value === '') continue;
                for (const name of entry[role] || []) {
                    overlay[name] = String(value);
                }
            }
            if (Object.keys(overlay).length) {
                for (const [name, value] of Object.entries(AGENT_ENV_CONSTANTS[agentKey] || {})) {
                    overlay[name] = value === null ? null : String(value);
                }
                overlay[MARKER_VAR] = '1';
            }
        } catch (err) {
            console.warn(`[AgentOverrides] Failed to build env overlay for ${agentKey}:`, err.message);
            return {};
        }
        return overlay;
    }

    /** UI-friendly summary. The api key is ALWAYS masked — never raw. */
    describe(agentKey) {
        const state = this.overrides[agentKey];
        const supported = agentKey in AGENT_ENV_MAP;
        return {
            agentKey,
            supported,
            enabled: Boolean(state && state.enabled),
            providerId: (state && state.providerId) || null,
            model: (state && state.model) || null,
            baseUrl: (state && state.baseUrl) || null,
            apiKey: maskKey(state && state.apiKey) || null,
            hasApiKey: Boolean(state && state.apiKey),
            envVars: this._varsFor(agentKey),
            activeEnvVars: Object.keys(this.getEnvOverlay(agentKey)),
            updatedAt: (state && state.updatedAt) || null,
        };
    }

    /** describe() for every toggleable agent — safe to serve to a UI. */
    describeAll() {
        const out = {};
        for (const key of Object.keys(AGENT_ENV_MAP)) {
            out[key] = this.describe(key);
        }
        return out;
    }
}

let instance = null;

/**
 * Module-level singleton. `baseDir` is honoured only on the first call (or the
 * first call after resetAgentOverrides()).
 */
function getAgentOverrides(baseDir) {
    if (!instance) {
        instance = new AgentOverrides(baseDir);
    }
    return instance;
}

/** Drop the singleton (tests / hot reload). */
function resetAgentOverrides() {
    instance = null;
}

module.exports = {
    AgentOverrides,
    getAgentOverrides,
    resetAgentOverrides,
    AGENT_ENV_MAP,
    AGENT_ENV_CONSTANTS,
    maskKey,
    MARKER_VAR,
};
