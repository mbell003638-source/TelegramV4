// =============================================================================
//  core/ProviderRouter.js — OmniRouter: one key, many providers
//
//  A unified, OpenAI-compatible routing layer. External tools point at a single
//  master key; this module fans the request out across every configured
//  upstream provider. It fuses three ideas:
//
//    • OpenRouter-like — OpenAI-shaped surface, "provider/model" slugs, a
//      `models: []` fallback array in the request body, usage + cost ledger.
//    • OmniRoute-like  — failover chains with a per-provider/key circuit
//      breaker and exponential-backoff health tracking.
//    • 9router-like    — per-provider KEY POOL with rotation strategies
//      (priority | round-robin | least-used | weighted).
//
//  Every outbound HTTP call goes through an injectable transport so the whole
//  router is testable without a socket:
//
//    transport(request) -> Promise<{ status, headers, data?, raw?, stream? }>
//      request = { url, method, headers, body, stream, timeoutMs, providerId, model }
//      - reject with an Error for network-level failures (trips the breaker)
//      - when request.stream is true and the upstream returned 2xx, resolve
//        with `stream` (a Readable of raw SSE bytes) instead of `data`
//
//  Slug rules (see ProviderRegistry.resolveModel):
//    "anthropic/claude-sonnet-4"            → pinned to the anthropic provider
//    "openrouter/anthropic/claude-sonnet-4" → pinned to openrouter
//    "gpt-4o"                               → unpinned, routed by strategy
// =============================================================================
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const STRATEGIES = ['priority', 'round-robin', 'least-used', 'weighted'];

const BREAKER_BASE_MS = 5000;        // first cooldown after a failure
const BREAKER_MAX_MS = 300000;       // cap at 5 minutes
const MODEL_CACHE_TTL_MS = 300000;   // listModels() cache — 5 minutes
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

// USD per 1M tokens. Unknown models fall back to zero — the ledger still counts
// tokens, it just reports 0 cost rather than guessing.
const PRICE_TABLE = {
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'o3': { input: 2, output: 8 },
    'o3-mini': { input: 1.1, output: 4.4 },
    'o4-mini': { input: 1.1, output: 4.4 },
    'claude-3-opus': { input: 15, output: 75 },
    'claude-3-5-sonnet': { input: 3, output: 15 },
    'claude-3-5-haiku': { input: 0.8, output: 4 },
    'claude-sonnet-4': { input: 3, output: 15 },
    'claude-opus-4': { input: 15, output: 75 },
    'claude-haiku-4': { input: 1, output: 5 },
    'deepseek-chat': { input: 0.27, output: 1.1 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
    'llama-3.1-8b': { input: 0.05, output: 0.08 },
    'llama-3.3-70b': { input: 0.59, output: 0.79 },
    'gemini-1.5-pro': { input: 1.25, output: 5 },
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-2.5-pro': { input: 1.25, output: 10 },
    'moonshot-v1-8k': { input: 0.2, output: 0.2 },
    'kimi-k2': { input: 0.6, output: 2.5 },
    'grok-2': { input: 2, output: 10 },
    'grok-3': { input: 3, output: 15 },
    'grok-4': { input: 3, output: 15 },
};

function emptyBucket() {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

class ProviderRouter {
    /**
     * @param {object}   opts
     * @param {object}   opts.registry   ProviderRegistry instance (required)
     * @param {string}   [opts.masterKey] defaults to process.env.OMNIROUTER_KEY, else generated
     * @param {string}   [opts.strategy]  'priority' | 'round-robin' | 'least-used' | 'weighted'
     * @param {Function} [opts.transport] injectable HTTP transport (see banner)
     * @param {Function} [opts.now]       clock injection, defaults to Date.now
     * @param {string}   [opts.appUrl]    OpenRouter HTTP-Referer
     * @param {string}   [opts.appTitle]  OpenRouter X-Title
     * @param {number}   [opts.timeoutMs]
     */
    constructor(opts = {}) {
        const { registry, masterKey, strategy, transport, now, appUrl, appTitle, timeoutMs } = opts;
        if (!registry) throw new Error('[ProviderRouter] a ProviderRegistry instance is required');

        this.registry = registry;
        this.strategy = STRATEGIES.includes(strategy) ? strategy : 'priority';
        this.transport = typeof transport === 'function' ? transport : this._defaultTransport.bind(this);
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.appUrl = appUrl || process.env.OMNIROUTER_APP_URL || 'https://localhost';
        this.appTitle = appTitle || process.env.OMNIROUTER_APP_TITLE || 'OmniRouter';
        this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

        this.masterKey = masterKey || process.env.OMNIROUTER_KEY || ProviderRouter.generateMasterKey();
        this.generatedMasterKey = !masterKey && !process.env.OMNIROUTER_KEY;

        this.breakers = new Map();    // "providerId::key" → { failures, openUntil, lastError }
        this.keyUsage = new Map();    // "providerId::key" → count
        this.keyCursor = new Map();   // providerId → rotation cursor
        this.providerCursor = 0;      // global provider rotation cursor
        this.providerUsage = new Map(); // providerId → count

        this.usage = { totals: emptyBucket(), byProvider: {}, byModel: {}, startedAt: new Date().toISOString() };
        this.modelCache = { at: 0, data: null };
    }

    static generateMasterKey() {
        return 'omni-' + crypto.randomBytes(24).toString('hex');
    }

    // -------------------------------------------------------------------------
    //  Master key gate
    // -------------------------------------------------------------------------

    getMasterKey() {
        return this.masterKey;
    }

    /** Constant-time compare. Length mismatch short-circuits (timingSafeEqual throws on it). */
    verifyMasterKey(presented) {
        try {
            if (typeof presented !== 'string' || !presented) return false;
            const a = Buffer.from(presented, 'utf8');
            const b = Buffer.from(this.masterKey, 'utf8');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch (err) {
            console.warn('[ProviderRouter] Master key verification failed:', err.message);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    //  Circuit breaker + health
    // -------------------------------------------------------------------------

    _breakerKey(providerId, key) {
        return `${providerId}::${key || '-'}`;
    }

    /** @returns {boolean} true when this provider/key pair is not cooling down */
    _isHealthy(providerId, key) {
        const state = this.breakers.get(this._breakerKey(providerId, key));
        if (!state) return true;
        return this.now() >= state.openUntil;
    }

    /** Trip the breaker with exponential backoff: 5s, 10s, 20s … capped at 5min. */
    _tripBreaker(providerId, key, error) {
        const id = this._breakerKey(providerId, key);
        const state = this.breakers.get(id) || { failures: 0, openUntil: 0, lastError: null };
        state.failures += 1;
        const cooldown = Math.min(BREAKER_BASE_MS * Math.pow(2, state.failures - 1), BREAKER_MAX_MS);
        state.openUntil = this.now() + cooldown;
        state.lastError = error ? String(error.message || error) : null;
        state.cooldownMs = cooldown;
        this.breakers.set(id, state);
        return state;
    }

    _resetBreaker(providerId, key) {
        this.breakers.delete(this._breakerKey(providerId, key));
    }

    /** A provider is routable only if it is enabled and has at least one healthy key. */
    _providerHealthy(provider) {
        if (!provider || !provider.enabled) return false;
        if (provider.keyless || provider.keys.length === 0) return this._isHealthy(provider.id, null);
        return provider.keys.some(key => this._isHealthy(provider.id, key));
    }

    getHealth() {
        const out = {};
        for (const [id, state] of this.breakers.entries()) {
            const [providerId] = id.split('::');
            out[providerId] = out[providerId] || { openKeys: 0, failures: 0, nextRetryAt: 0 };
            out[providerId].failures += state.failures;
            if (this.now() < state.openUntil) {
                out[providerId].openKeys += 1;
                out[providerId].nextRetryAt = Math.max(out[providerId].nextRetryAt, state.openUntil);
            }
        }
        return out;
    }

    // -------------------------------------------------------------------------
    //  Key pool rotation (9router style)
    // -------------------------------------------------------------------------

    /**
     * Pick the next key from a provider's pool, honouring the active strategy.
     * @returns {string|null|undefined} a key, `null` for keyless providers,
     *          or `undefined` when every key is cooling down (skip this provider).
     */
    _nextKey(provider, strategy = this.strategy) {
        if (!provider) return undefined;
        if (provider.keyless && provider.keys.length === 0) {
            return this._isHealthy(provider.id, null) ? null : undefined;
        }
        const pool = provider.keys.filter(key => this._isHealthy(provider.id, key));
        if (pool.length === 0) return undefined;

        let chosen;
        if (strategy === 'round-robin') {
            const cursor = this.keyCursor.get(provider.id) || 0;
            chosen = pool[cursor % pool.length];
            this.keyCursor.set(provider.id, cursor + 1);
        } else if (strategy === 'least-used' || strategy === 'weighted') {
            // 'weighted' biases provider ORDER (below); within a pool every key is
            // equal, so fall through to least-used for a deterministic spread.
            chosen = pool.reduce((best, key) => {
                const a = this.keyUsage.get(this._breakerKey(provider.id, key)) || 0;
                const b = this.keyUsage.get(this._breakerKey(provider.id, best)) || 0;
                return a < b ? key : best;
            }, pool[0]);
        } else {
            chosen = pool[0];
        }

        const usageId = this._breakerKey(provider.id, chosen);
        this.keyUsage.set(usageId, (this.keyUsage.get(usageId) || 0) + 1);
        return chosen;
    }

    getKeyUsage() {
        const out = {};
        for (const [id, count] of this.keyUsage.entries()) out[id] = count;
        return out;
    }

    // -------------------------------------------------------------------------
    //  Candidate chain building
    // -------------------------------------------------------------------------

    _providerHasModel(provider, model) {
        if (!provider.models.length) return false;
        return provider.models.some(entry => entry === model
            || entry === `${provider.id}/${model}`
            || entry.endsWith(`/${model}`));
    }

    /** Which model string this provider should actually be asked for. */
    _modelForProvider(provider, rawModel, resolved) {
        if (this._providerHasModel(provider, rawModel)) return rawModel;
        if (resolved && provider.id === resolved.providerId) return resolved.model;
        if (resolved && this._providerHasModel(provider, resolved.model)) return resolved.model;
        return rawModel;
    }

    _orderProviders(providers, strategy = this.strategy) {
        const list = [...providers];
        if (strategy === 'round-robin') {
            list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
            if (list.length > 1) {
                const offset = this.providerCursor % list.length;
                this.providerCursor += 1;
                return list.slice(offset).concat(list.slice(0, offset));
            }
            return list;
        }
        if (strategy === 'least-used') {
            return list.sort((a, b) =>
                (this.providerUsage.get(a.id) || 0) - (this.providerUsage.get(b.id) || 0)
                || a.priority - b.priority || a.id.localeCompare(b.id));
        }
        if (strategy === 'weighted') {
            // Least-loaded relative to weight — deterministic, no RNG.
            const load = p => (this.providerUsage.get(p.id) || 0) / Math.max(p.weight, 1);
            return list.sort((a, b) => load(a) - load(b) || a.priority - b.priority || a.id.localeCompare(b.id));
        }
        return list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    }

    /**
     * Build the ordered failover chain for a request.
     * @returns {{providerId:string, model:string, source:string}[]}
     */
    buildCandidates(body = {}, strategy = this.strategy) {
        const candidates = [];
        const seen = new Set();
        const push = (providerId, model, source) => {
            if (!providerId || !model) return;
            const id = `${providerId}|${model}`;
            if (seen.has(id)) return;
            seen.add(id);
            candidates.push({ providerId, model, source });
        };

        const requested = [];
        if (body.model) requested.push(String(body.model));
        if (Array.isArray(body.models)) {
            for (const entry of body.models) {
                const value = typeof entry === 'string' ? entry : entry && entry.model;
                if (value) requested.push(String(value));
            }
        }
        if (!requested.length) return candidates;

        // 1 + 2. Explicit provider pins, primary model first then body.models[].
        for (let i = 0; i < requested.length; i++) {
            const resolved = this.registry.resolveModel(requested[i]);
            if (!resolved) continue;
            const provider = this.registry.get(resolved.providerId);
            if (!provider || !provider.enabled) continue;
            push(provider.id, resolved.model, i === 0 ? 'slug' : 'fallback-slug');
        }

        // 3. Everything else that is enabled, ordered by strategy. Providers that
        //    advertise the model win over those with an unknown catalogue.
        const enabled = this.registry.getAll().filter(p => p.enabled);
        const ordered = this._orderProviders(enabled, strategy);
        for (let i = 0; i < requested.length; i++) {
            const raw = requested[i];
            const resolved = this.registry.resolveModel(raw);
            const known = ordered.filter(p => this._providerHasModel(p, raw)
                || (resolved && this._providerHasModel(p, resolved.model)));
            const pool = known.length ? known : ordered;
            for (const provider of pool) {
                push(provider.id, this._modelForProvider(provider, raw, resolved), i === 0 ? 'strategy' : 'fallback');
            }
        }

        return candidates;
    }

    // -------------------------------------------------------------------------
    //  Auth translation
    // -------------------------------------------------------------------------

    /** Per-provider header shaping — Anthropic and OpenRouter differ from the norm. */
    _buildHeaders(provider, key, extra = {}) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(provider.headers || {}),
        };
        if (key) {
            if (provider.auth === 'x-api-key' || provider.id === 'anthropic') {
                headers['x-api-key'] = key;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                headers.Authorization = `Bearer ${key}`;
            }
        }
        if (provider.id === 'openrouter') {
            headers['HTTP-Referer'] = this.appUrl;
            headers['X-Title'] = this.appTitle;
        }
        return { ...headers, ...extra };
    }

    // -------------------------------------------------------------------------
    //  Usage / cost ledger
    // -------------------------------------------------------------------------

    _priceFor(model) {
        const raw = String(model || '').toLowerCase();
        const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
        if (PRICE_TABLE[bare]) return PRICE_TABLE[bare];
        let best = null;
        for (const [name, price] of Object.entries(PRICE_TABLE)) {
            if (bare.startsWith(name) && (!best || name.length > best.name.length)) best = { name, price };
        }
        return best ? best.price : { input: 0, output: 0 };
    }

    /**
     * Accumulate an OpenAI-shaped usage object into the ledger.
     * @returns {object} the delta that was applied
     */
    _recordUsage(providerId, model, usage = {}) {
        const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0) || 0;
        const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0) || 0;
        const total = Number(usage.total_tokens ?? usage.totalTokens ?? 0) || prompt + completion;
        const price = this._priceFor(model);
        const costUsd = (prompt / 1e6) * price.input + (completion / 1e6) * price.output;

        const delta = { requests: 1, promptTokens: prompt, completionTokens: completion, totalTokens: total, costUsd };
        const apply = bucket => {
            bucket.requests += delta.requests;
            bucket.promptTokens += delta.promptTokens;
            bucket.completionTokens += delta.completionTokens;
            bucket.totalTokens += delta.totalTokens;
            bucket.costUsd += delta.costUsd;
        };
        apply(this.usage.totals);
        this.usage.byProvider[providerId] = this.usage.byProvider[providerId] || emptyBucket();
        apply(this.usage.byProvider[providerId]);
        const modelId = `${providerId}/${model}`;
        this.usage.byModel[modelId] = this.usage.byModel[modelId] || emptyBucket();
        apply(this.usage.byModel[modelId]);

        this.providerUsage.set(providerId, (this.providerUsage.get(providerId) || 0) + 1);
        return delta;
    }

    getUsageReport() {
        const round = bucket => ({ ...bucket, costUsd: Math.round(bucket.costUsd * 1e6) / 1e6 });
        return {
            startedAt: this.usage.startedAt,
            generatedAt: new Date().toISOString(),
            totals: round(this.usage.totals),
            byProvider: Object.fromEntries(Object.entries(this.usage.byProvider).map(([k, v]) => [k, round(v)])),
            byModel: Object.fromEntries(Object.entries(this.usage.byModel).map(([k, v]) => [k, round(v)])),
            health: this.getHealth(),
        };
    }

    resetUsage() {
        this.usage = { totals: emptyBucket(), byProvider: {}, byModel: {}, startedAt: new Date().toISOString() };
        return this.getUsageReport();
    }

    // -------------------------------------------------------------------------
    //  Core routing
    // -------------------------------------------------------------------------

    /**
     * Route an OpenAI-shaped chat completion across the failover chain.
     *
     * @param {object} body  { model, messages, stream, models?: [] , ... }
     * @param {object} [opts] { transport, strategy, timeoutMs, headers, signal }
     * @returns {Promise<{ok, data, stream?, providerId, model, attempts, usage}>}
     * @throws  aggregate Error (`.attempts`) when every candidate fails.
     *
     * Streaming: when `body.stream === true` the upstream Readable is handed
     * back untouched on `.stream` so SSE frames pass through byte-for-byte.
     * Token usage cannot be tallied without parsing the stream, so streamed
     * calls are counted as a request with zero tokens.
     */
    async chatCompletion(body = {}, opts = {}) {
        if (!body || typeof body !== 'object') throw new Error('[ProviderRouter] chatCompletion requires an object body');
        const strategy = STRATEGIES.includes(opts.strategy) ? opts.strategy : this.strategy;
        const transport = typeof opts.transport === 'function' ? opts.transport : this.transport;
        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs;
        const streaming = body.stream === true;

        const candidates = this.buildCandidates(body, strategy);
        const attempts = [];
        if (!candidates.length) {
            const err = new Error(`[ProviderRouter] No enabled provider can serve model "${body.model}"`);
            err.name = 'ProviderRouterError';
            err.attempts = attempts;
            err.status = 503;
            throw err;
        }

        for (const candidate of candidates) {
            const provider = this.registry.get(candidate.providerId);
            if (!this._providerHealthy(provider)) {
                attempts.push({ providerId: candidate.providerId, model: candidate.model, ok: false, skipped: true, reason: 'cooling-down' });
                continue;
            }
            const key = this._nextKey(provider, strategy);
            if (key === undefined) {
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, skipped: true, reason: 'no-healthy-key' });
                continue;
            }

            const upstream = { ...body, model: candidate.model };
            delete upstream.models;   // fallback list is ours, never forwarded

            const started = this.now();
            try {
                const response = await transport({
                    url: `${provider.baseUrl}/chat/completions`,
                    method: 'POST',
                    headers: this._buildHeaders(provider, key, opts.headers),
                    body: upstream,
                    stream: streaming,
                    timeoutMs,
                    signal: opts.signal,
                    providerId: provider.id,
                    model: candidate.model,
                });

                const status = Number(response && response.status) || 0;
                if (status >= 200 && status < 300) {
                    this._resetBreaker(provider.id, key);
                    const data = response.data ?? null;
                    const usage = streaming ? null : (data && data.usage) || {};
                    const delta = this._recordUsage(provider.id, candidate.model, usage || {});
                    attempts.push({ providerId: provider.id, model: candidate.model, ok: true, status, ms: this.now() - started });
                    return {
                        ok: true,
                        data,
                        stream: response.stream || null,
                        headers: response.headers || {},
                        providerId: provider.id,
                        model: candidate.model,
                        source: candidate.source,
                        attempts,
                        usage: delta,
                    };
                }

                // Retryable upstream failure → trip the breaker and move on.
                const message = this._errorMessage(response);
                const retryable = status === 429 || status >= 500 || status === 401 || status === 403;
                if (retryable) this._tripBreaker(provider.id, key, new Error(message));
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, status, error: message, ms: this.now() - started });
            } catch (err) {
                // Network-level failure — always trips the breaker.
                this._tripBreaker(provider.id, key, err);
                attempts.push({ providerId: provider.id, model: candidate.model, ok: false, status: 0, error: String(err.message || err), ms: this.now() - started });
            }
        }

        const summary = attempts
            .map(a => `${a.providerId}/${a.model} → ${a.skipped ? a.reason : `${a.status || 'ERR'} ${a.error || ''}`.trim()}`)
            .join('; ');
        const err = new Error(`[ProviderRouter] All ${attempts.length} candidate(s) failed for "${body.model}": ${summary}`);
        err.name = 'ProviderRouterError';
        err.attempts = attempts;
        err.status = attempts.find(a => a.status)?.status || 502;
        throw err;
    }

    _errorMessage(response) {
        try {
            const data = response && response.data;
            if (data && data.error) return String(data.error.message || data.error);
            if (data && data.message) return String(data.message);
            if (response && response.raw) return String(response.raw).slice(0, 500);
        } catch (e) {}
        return `HTTP ${response && response.status}`;
    }

    // -------------------------------------------------------------------------
    //  Model catalogue
    // -------------------------------------------------------------------------

    /**
     * Aggregated catalogue across enabled providers. Never throws — a provider
     * that cannot be listed is skipped with a warning. Cached for 5 minutes.
     * @returns {Promise<{id:string, provider:string, model:string}[]>}
     */
    async listModels(opts = {}) {
        if (!opts.force && this.modelCache.data && this.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
            return this.modelCache.data;
        }
        const transport = typeof opts.transport === 'function' ? opts.transport : this.transport;
        const out = [];
        const seen = new Set();
        const add = (provider, model, extra = {}) => {
            const name = String(model || '').trim();
            if (!name) return;
            const id = `${provider.id}/${name}`;
            if (seen.has(id)) return;
            seen.add(id);
            out.push({ id, provider: provider.id, model: name, object: 'model', owned_by: provider.id, ...extra });
        };

        for (const provider of this.registry.getAll()) {
            if (!provider.enabled) continue;
            if (provider.models.length) {
                for (const model of provider.models) add(provider, model);
                continue;
            }
            if (!this._providerHealthy(provider)) continue;
            const key = this._nextKey(provider);
            if (key === undefined) continue;
            try {
                const response = await transport({
                    url: `${provider.baseUrl}/models`,
                    method: 'GET',
                    headers: this._buildHeaders(provider, key),
                    body: null,
                    stream: false,
                    timeoutMs: opts.timeoutMs || 15000,
                    providerId: provider.id,
                });
                const status = Number(response && response.status) || 0;
                if (status < 200 || status >= 300) throw new Error(this._errorMessage(response));
                const list = response.data?.data || response.data?.models || [];
                if (!Array.isArray(list)) throw new Error('unexpected /models payload');
                for (const item of list) {
                    const name = typeof item === 'string' ? item : item && (item.id || item.name);
                    add(provider, name, typeof item === 'object' && item ? { created: item.created } : {});
                }
            } catch (err) {
                console.warn(`[ProviderRouter] Could not list models for ${provider.id}:`, err.message);
            }
        }

        this.modelCache = { at: this.now(), data: out };
        return out;
    }

    // -------------------------------------------------------------------------
    //  Default transport (Node builtins only)
    // -------------------------------------------------------------------------

    _defaultTransport(request) {
        return new Promise((resolve, reject) => {
            let url;
            try {
                url = new URL(request.url);
            } catch (err) {
                return reject(new Error(`[ProviderRouter] Invalid upstream URL: ${request.url}`));
            }
            const agent = url.protocol === 'http:' ? http : https;
            const payload = request.body ? Buffer.from(JSON.stringify(request.body), 'utf8') : null;
            const headers = { ...request.headers };
            if (payload) headers['Content-Length'] = payload.length;
            if (request.stream) headers.Accept = 'text/event-stream';

            const req = agent.request({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || undefined,
                path: url.pathname + url.search,
                method: request.method || 'POST',
                headers,
            }, res => {
                const status = res.statusCode || 0;
                if (request.stream && status >= 200 && status < 300) {
                    // Hand the raw SSE stream straight back — no re-framing.
                    return resolve({ status, headers: res.headers, stream: res, data: null });
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
                    resolve({ status, headers: res.headers, data, raw });
                });
                res.on('error', reject);
            });

            req.setTimeout(request.timeoutMs || this.timeoutMs, () => {
                req.destroy(new Error(`upstream timeout after ${request.timeoutMs || this.timeoutMs}ms`));
            });
            req.on('error', reject);
            if (request.signal) {
                if (request.signal.aborted) req.destroy(new Error('aborted'));
                else request.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
            }
            if (payload) req.write(payload);
            req.end();
        });
    }

    // -------------------------------------------------------------------------
    //  OpenAI-compatible HTTP surface (mountable, never creates a server)
    // -------------------------------------------------------------------------

    /**
     * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean}
     *          true when the request was handled (caller should stop), false otherwise.
     *
     *   POST /v1/chat/completions
     *   GET  /v1/models
     *   GET  /v1/usage
     *
     * All require `Authorization: Bearer <masterKey>`.
     */
    createHttpHandler() {
        const routes = new Set(['/v1/chat/completions', '/v1/models', '/v1/usage']);

        const send = (res, status, payload, extraHeaders = {}) => {
            try {
                if (res.headersSent) return;
                const bodyText = JSON.stringify(payload);
                res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText), ...extraHeaders });
                res.end(bodyText);
            } catch (err) {
                console.warn('[ProviderRouter] Failed to write response:', err.message);
            }
        };
        const fail = (res, status, message, code, extra = {}) =>
            send(res, status, { error: { message, type: code === 'invalid_api_key' ? 'invalid_request_error' : 'api_error', code, ...extra } });

        const readBody = req => new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_REQUEST_BYTES) {
                    req.destroy();
                    return reject(new Error('request body too large'));
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });

        return (req, res) => {
            let pathname;
            try {
                pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
            } catch (err) {
                return false;
            }
            if (!routes.has(pathname)) return false;

            const auth = String(req.headers.authorization || '');
            const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
            if (!this.verifyMasterKey(presented)) {
                fail(res, 401, 'Invalid OmniRouter master key.', 'invalid_api_key');
                return true;
            }

            const method = String(req.method || 'GET').toUpperCase();

            if (pathname === '/v1/models') {
                if (method !== 'GET') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
                this.listModels()
                    .then(data => send(res, 200, { object: 'list', data }))
                    .catch(err => fail(res, 500, String(err.message || err), 'model_list_failed'));
                return true;
            }

            if (pathname === '/v1/usage') {
                if (method !== 'GET') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
                try {
                    send(res, 200, this.getUsageReport());
                } catch (err) {
                    fail(res, 500, String(err.message || err), 'usage_failed');
                }
                return true;
            }

            // POST /v1/chat/completions
            if (method !== 'POST') { fail(res, 405, 'Method not allowed.', 'method_not_allowed'); return true; }
            readBody(req)
                .then(async raw => {
                    let body;
                    try {
                        body = JSON.parse(raw || '{}');
                    } catch (err) {
                        return fail(res, 400, 'Request body is not valid JSON.', 'invalid_json');
                    }
                    const result = await this.chatCompletion(body);
                    const meta = { 'x-omnirouter-provider': result.providerId, 'x-omnirouter-model': result.model };
                    if (result.stream) {
                        try {
                            res.writeHead(200, {
                                'Content-Type': 'text/event-stream',
                                'Cache-Control': 'no-cache',
                                Connection: 'keep-alive',
                                ...meta,
                            });
                            result.stream.on('error', err => {
                                console.warn('[ProviderRouter] Upstream stream error:', err.message);
                                try { res.end(); } catch (e) {}
                            });
                            result.stream.pipe(res);
                        } catch (err) {
                            console.warn('[ProviderRouter] Failed to pipe stream:', err.message);
                        }
                        return;
                    }
                    send(res, 200, result.data, meta);
                })
                .catch(err => fail(res, err.status && err.status >= 400 ? err.status : 502,
                    String(err.message || err), 'upstream_failed', { attempts: err.attempts || [] }));
            return true;
        };
    }
}

module.exports = ProviderRouter;
module.exports.ProviderRouter = ProviderRouter;
module.exports.STRATEGIES = STRATEGIES;
module.exports.PRICE_TABLE = PRICE_TABLE;
