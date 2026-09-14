// =============================================================================
//  core/ProviderRegistry.js — OmniRouter Upstream Provider Registry
//
//  Persistent catalogue of upstream AI providers sitting behind the single
//  OmniRouter master key. Seeds sensible defaults, hydrates API keys from the
//  environment (never destroying keys already saved on disk) and persists the
//  merged result to store/providers.json.
//
//  Provider shape:
//    { id, label, baseUrl, keys: [], enabled, priority, models: [],
//      headers: {}, weight, keyless, aliases, auth }
//
//  `priority` is lower-is-preferred. `weight` biases the 'weighted' routing
//  strategy in ProviderRouter. A provider is only ever `enabled` when it holds
//  at least one key — keyless providers (ollama) are exempt.
// =============================================================================
const fs = require('fs');
const path = require('path');

const DEFAULT_PROVIDERS = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        priority: 10,
        weight: 3,
        aliases: ['or'],
    },
    {
        id: 'anthropic',
        label: 'Anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        priority: 20,
        weight: 2,
        auth: 'x-api-key',
        aliases: ['claude'],
    },
    {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        priority: 30,
        weight: 2,
        aliases: ['gpt'],
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        priority: 40,
        weight: 1,
        aliases: [],
    },
    {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        priority: 50,
        weight: 1,
        aliases: [],
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        priority: 60,
        weight: 1,
        aliases: ['google'],
    },
    {
        id: 'moonshot',
        label: 'Moonshot (Kimi)',
        baseUrl: 'https://api.moonshot.cn/v1',
        priority: 70,
        weight: 1,
        aliases: ['kimi'],
    },
    {
        id: 'xai',
        label: 'xAI (Grok)',
        baseUrl: 'https://api.x.ai/v1',
        priority: 80,
        weight: 1,
        aliases: ['grok'],
    },
    {
        id: 'ollama',
        label: 'Ollama (local)',
        baseUrl: 'http://localhost:11434/v1',
        priority: 90,
        weight: 1,
        keyless: true,
        aliases: ['local'],
    },
];

// process.env name → provider id
const ENV_KEY_MAP = {
    OPENROUTER_API_KEY: 'openrouter',
    ANTHROPIC_API_KEY: 'anthropic',
    OPENAI_API_KEY: 'openai',
    DEEPSEEK_API_KEY: 'deepseek',
    GROQ_API_KEY: 'groq',
    GEMINI_API_KEY: 'gemini',
    MOONSHOT_API_KEY: 'moonshot',
    XAI_API_KEY: 'xai',
};

// Same masking style used by the Mission Control dashboard.
function maskKey(key) {
    if (!key) return '';
    const str = String(key);
    // Short keys would leak entirely through slice(0,7)+slice(-4) — blank them.
    if (str.length <= 11) return '*'.repeat(str.length);
    return str.slice(0, 7) + '...' + str.slice(-4);
}

class ProviderRegistry {
    /**
     * @param {string} baseDir   project root (store/providers.json lives under it)
     * @param {object} options   { env, file, seed, autoSave }
     */
    constructor(baseDir = process.cwd(), options = {}) {
        this.baseDir = baseDir;
        this.storeDir = path.join(this.baseDir, 'store');
        this.file = options.file || path.join(this.storeDir, 'providers.json');
        this.env = options.env || process.env;
        this.autoSave = options.autoSave !== false;
        this.providers = new Map();

        if (options.seed !== false) {
            for (const def of DEFAULT_PROVIDERS) {
                this.providers.set(def.id, this._normalize(def));
            }
        }

        this.load();
        this._hydrateFromEnv();
        for (const entry of this.providers.values()) this._syncEnabled(entry);
        if (this.autoSave) this.save();
    }

    // -------------------------------------------------------------------------
    //  Internals
    // -------------------------------------------------------------------------

    _normalize(raw = {}) {
        return {
            id: String(raw.id || '').toLowerCase(),
            label: raw.label || raw.id || '',
            baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
            keys: Array.isArray(raw.keys) ? raw.keys.filter(Boolean).map(String) : [],
            enabled: Boolean(raw.enabled),
            priority: Number.isFinite(raw.priority) ? raw.priority : 100,
            models: Array.isArray(raw.models) ? raw.models.filter(Boolean).map(String) : [],
            headers: raw.headers && typeof raw.headers === 'object' ? { ...raw.headers } : {},
            weight: Number.isFinite(raw.weight) && raw.weight > 0 ? raw.weight : 1,
            keyless: Boolean(raw.keyless),
            auth: raw.auth || 'bearer',
            aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(Boolean).map(a => String(a).toLowerCase()) : [],
            manualDisable: Boolean(raw.manualDisable),
        };
    }

    /** A provider is live only when it holds a key (or needs none) and was not manually disabled. */
    _syncEnabled(entry) {
        entry.enabled = Boolean(!entry.manualDisable && (entry.keyless || entry.keys.length > 0));
        return entry.enabled;
    }

    /** Merge env keys in. Never removes a key already persisted in providers.json. */
    _hydrateFromEnv() {
        for (const [envName, providerId] of Object.entries(ENV_KEY_MAP)) {
            const value = this.env[envName];
            if (!value) continue;
            const entry = this.providers.get(providerId);
            if (!entry) continue;
            for (const key of String(value).split(',').map(k => k.trim()).filter(Boolean)) {
                if (!entry.keys.includes(key)) entry.keys.push(key);
            }
        }
    }

    _resolveId(id) {
        const wanted = String(id || '').toLowerCase();
        if (!wanted) return null;
        if (this.providers.has(wanted)) return wanted;
        for (const entry of this.providers.values()) {
            if (entry.aliases.includes(wanted)) return entry.id;
        }
        return null;
    }

    _require(id) {
        const resolved = this._resolveId(id);
        if (!resolved) throw new Error(`[ProviderRegistry] Unknown provider: ${id}`);
        return this.providers.get(resolved);
    }

    // -------------------------------------------------------------------------
    //  Persistence
    // -------------------------------------------------------------------------

    load() {
        try {
            if (!fs.existsSync(this.file)) return this;
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : [];
            for (const raw of list) {
                if (!raw || !raw.id) continue;
                const id = String(raw.id).toLowerCase();
                const existing = this.providers.get(id);
                if (existing) {
                    // Saved state wins for mutable fields; defaults keep the plumbing.
                    const merged = this._normalize({ ...existing, ...raw, id });
                    merged.keyless = existing.keyless;
                    merged.auth = existing.auth;
                    merged.aliases = existing.aliases;
                    for (const key of existing.keys) {
                        if (!merged.keys.includes(key)) merged.keys.push(key);
                    }
                    this.providers.set(id, merged);
                } else {
                    this.providers.set(id, this._normalize({ ...raw, id }));
                }
            }
        } catch (err) {
            console.warn('[ProviderRegistry] Failed to load providers.json:', err.message);
        }
        return this;
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const payload = { version: 1, savedAt: new Date().toISOString(), providers: this.getAll() };
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (err) {
            console.warn('[ProviderRegistry] Failed to persist providers.json:', err.message);
        }
        return this;
    }

    // -------------------------------------------------------------------------
    //  Public API
    // -------------------------------------------------------------------------

    /** @returns {object[]} deep-ish copies of every provider, priority ordered */
    getAll() {
        return [...this.providers.values()]
            .map(entry => ({ ...entry, keys: [...entry.keys], models: [...entry.models], headers: { ...entry.headers }, aliases: [...entry.aliases] }))
            .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    }

    /** @returns {object|null} the live provider entry (mutable) by id or alias */
    get(id) {
        const resolved = this._resolveId(id);
        return resolved ? this.providers.get(resolved) : null;
    }

    /** Create or patch a provider. Unknown ids are created. */
    upsert(id, patch = {}) {
        const key = String(id || '').toLowerCase();
        if (!key) throw new Error('[ProviderRegistry] upsert requires an id');
        const existing = this.providers.get(this._resolveId(key) || key);
        const entry = this._normalize({ ...(existing || {}), ...patch, id: existing ? existing.id : key });
        if (existing && patch.keys === undefined) entry.keys = [...existing.keys];
        this.providers.set(entry.id, entry);
        this._syncEnabled(entry);
        if (this.autoSave) this.save();
        return entry;
    }

    addKey(id, key) {
        const entry = this._require(id);
        const value = String(key || '').trim();
        if (!value) throw new Error('[ProviderRegistry] addKey requires a non-empty key');
        if (!entry.keys.includes(value)) entry.keys.push(value);
        entry.manualDisable = false;
        this._syncEnabled(entry);
        if (this.autoSave) this.save();
        return entry;
    }

    /** Remove by exact key string or by numeric index. */
    removeKey(id, keyOrIndex) {
        const entry = this._require(id);
        if (typeof keyOrIndex === 'number' && Number.isInteger(keyOrIndex)) {
            if (keyOrIndex >= 0 && keyOrIndex < entry.keys.length) entry.keys.splice(keyOrIndex, 1);
        } else {
            const idx = entry.keys.indexOf(String(keyOrIndex));
            if (idx !== -1) entry.keys.splice(idx, 1);
        }
        this._syncEnabled(entry);
        if (this.autoSave) this.save();
        return entry;
    }

    /** Explicitly enable/disable. Enabling still requires at least one key. */
    setEnabled(id, bool) {
        const entry = this._require(id);
        entry.manualDisable = !bool;
        this._syncEnabled(entry);
        if (this.autoSave) this.save();
        return entry.enabled;
    }

    /** Safe-to-render view: keys are masked, raw key material never escapes. */
    maskedView() {
        return this.getAll().map(entry => ({
            ...entry,
            keys: entry.keys.map(maskKey),
            keyCount: entry.keys.length,
            hasKey: entry.keys.length > 0,
        }));
    }

    /**
     * Parse an OpenRouter-style "provider/model" slug.
     * "anthropic/claude-sonnet-4"            → { providerId:'anthropic', model:'claude-sonnet-4' }
     * "openrouter/anthropic/claude-sonnet-4" → { providerId:'openrouter', model:'anthropic/claude-sonnet-4' }
     * "gpt-4o"                               → null (no prefix)
     * "meta-llama/llama-3.1-70b"             → null (prefix is not a registered provider)
     */
    resolveModel(slug) {
        const raw = String(slug || '').trim();
        const idx = raw.indexOf('/');
        if (idx <= 0 || idx === raw.length - 1) return null;
        const providerId = this._resolveId(raw.slice(0, idx));
        if (!providerId) return null;
        return { providerId, model: raw.slice(idx + 1) };
    }
}

module.exports = ProviderRegistry;
module.exports.ProviderRegistry = ProviderRegistry;
module.exports.DEFAULT_PROVIDERS = DEFAULT_PROVIDERS;
module.exports.ENV_KEY_MAP = ENV_KEY_MAP;
module.exports.maskKey = maskKey;
