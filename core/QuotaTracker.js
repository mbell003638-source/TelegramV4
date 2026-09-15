// =============================================================================
//  core/QuotaTracker.js — Subscription Quota & Headroom Awareness
//
//  The operator does not pay per token. Every upstream here is an existing
//  SUBSCRIPTION (Claude Code, Codex, Grok, …) with session and weekly ceilings.
//  When one of those ceilings is hit the agent behind it simply stops working —
//  a whole batch of background agents was lost to exactly that during this
//  project. core/ProviderRouter.js tracks *cost* (PRICE_TABLE / _recordUsage);
//  nothing tracked *remaining headroom*, so routing could not prefer an agent
//  that still had capacity.
//
//  This module is the missing half. It is a deliberate SIBLING of the router's
//  circuit breaker, not a replacement:
//
//    breaker (ProviderRouter._tripBreaker)  transient failure, 5s → 5min,
//                                           exponential, per provider/key.
//    QuotaTracker (this file)               quota exhaustion, minutes → days,
//                                           resets on a CLOCK the provider
//                                           tells us about, per provider/agent.
//
//  Two things are recorded:
//    1. record()         — observed usage, accumulated into rolling session /
//                          day / week windows.
//    2. markExhausted()  — a provider said "no more" (HTTP 429 + a human
//                          message). parseRateLimitHint() digs the reset time
//                          out of the headers or the prose.
//
//  Then rank()/pick() answer the only question routing cares about: which
//  target still has room, and if none, when the soonest one comes back.
//
//  HONESTY RULE: when no limit is configured for a target we report
//  `limit: null` / `remaining: null`. A wrong limit is worse than no limit —
//  it would make the router confidently route into a wall.
//
//  Persistence is self-contained: the raw `database.db` (node:sqlite) handle
//  when a database is supplied, otherwise `<baseDir>/store/quota.json`. It
//  never touches core/Database.js. The clock is injectable (`now`) and there
//  are no timers anywhere — nothing in here ever sleeps.
//
//  Node builtins only. No new npm dependencies.
// =============================================================================
const fs = require('fs');
const path = require('path');

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Claude-style sessions are 5 hours; that is the default session window. */
const DEFAULT_SESSION_MS = 5 * HOUR_MS;
const DEFAULT_DAY_MS = DAY_MS;
const DEFAULT_WEEK_MS = 7 * DAY_MS;

const WINDOWS = Object.freeze(['session', 'day', 'week']);

/**
 * Exhaustion with NO known reset time. One hour is deliberately conservative:
 * long enough to route around a dead subscription, short enough that a target
 * is never written off forever on a guess.
 */
const DEFAULT_BACKOFF_MS = 60 * MINUTE_MS;

/**
 * Sanity bounds on a parsed hint — past these we return null rather than
 * trust an accident. A RELATIVE hint ("in 42 minutes", "resets 1:50am") is
 * inferred, so it is held to two weeks: no subscription window is longer.
 * An ABSOLUTE hint (an HTTP date, an epoch) was stated outright by the
 * provider, so it only has to be this side of absurd.
 */
const MAX_HINT_MS = 14 * DAY_MS;
const MAX_ABSOLUTE_HINT_MS = 90 * DAY_MS;

/** Hint sources the provider stated as a wall-clock instant, not a delta. */
const ABSOLUTE_SOURCES = Object.freeze(['retry-after-date', 'x-ratelimit-reset', 'explicit']);

/**
 * Ranking score for a target whose limits are unconfigured. Neutral on
 * purpose: better than a known nearly-exhausted target, worse than a known
 * fresh one. This is a ranking placeholder only — headroom() still reports
 * null, so no fabricated limit ever reaches the UI.
 */
const UNKNOWN_SCORE = 0.5;

/** Duration units accepted in free text ("try again in 42 minutes"). */
const DURATION_UNITS = Object.freeze({
    ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
    s: SECOND_MS, sec: SECOND_MS, secs: SECOND_MS, second: SECOND_MS, seconds: SECOND_MS,
    m: MINUTE_MS, min: MINUTE_MS, mins: MINUTE_MS, minute: MINUTE_MS, minutes: MINUTE_MS,
    h: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS, hour: HOUR_MS, hours: HOUR_MS,
    d: DAY_MS, day: DAY_MS, days: DAY_MS,
});

/** Words that make a bare clock time ("1:50am") trustworthy as a reset time. */
const RESET_TRIGGER = /reset|try again|retry|available|come back|back at|unlock|limit/i;

function emptyBucket(startedAt) {
    return { startedAt: startedAt === undefined ? null : startedAt, tokens: 0, requests: 0 };
}

function emptyState(providerId, agentKey) {
    return {
        providerId,
        agentKey,
        windows: { session: emptyBucket(), day: emptyBucket(), week: emptyBucket() },
        totals: { tokens: 0, requests: 0 },
        lastUsedAt: null,
        exhausted: null,   // { at, resetsAt, availableAt, reason, source, assumed }
    };
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function positiveLimit(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Accept epoch ms, a Date, or an ISO-ish string. Anything else → null. */
function toEpoch(value) {
    try {
        if (value === null || value === undefined || value === '') return null;
        if (value instanceof Date) {
            const t = value.getTime();
            return Number.isFinite(t) ? t : null;
        }
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^\d+$/.test(trimmed)) {
                const n = Number(trimmed);
                // Bare digits: below the ms-epoch threshold it must be seconds.
                return n > 1e12 ? n : n * SECOND_MS;
            }
            const parsed = Date.parse(trimmed);
            return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
    } catch (err) {
        return null;
    }
}

class QuotaTracker {
    /**
     * @param {object}   [opts]
     * @param {object}   [opts.database]  AssistantDatabase; `database.db` is used raw
     * @param {string}   [opts.baseDir]   project root (JSON fallback in <baseDir>/store)
     * @param {object}   [opts.limits]    see _limitFor() for the accepted shapes
     * @param {Function} [opts.now]       clock injection, defaults to Date.now
     * @param {object}   [opts.windows]   { sessionMs, dayMs, weekMs } overrides
     * @param {number}   [opts.defaultBackoffMs] backoff when a reset time is unknown
     */
    constructor({ database, baseDir, limits, now, windows, defaultBackoffMs } = {}) {
        this.db = database || null;
        this.raw = database && database.db ? database.db : null;
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.storeDir = path.join(this.baseDir, 'store');
        this.statePath = path.join(this.storeDir, 'quota.json');
        this.now = typeof now === 'function' ? now : () => Date.now();
        this.limits = limits && typeof limits === 'object' ? limits : {};

        const w = windows && typeof windows === 'object' ? windows : {};
        this.windowMs = {
            session: positiveLimit(w.sessionMs) || DEFAULT_SESSION_MS,
            day: positiveLimit(w.dayMs) || DEFAULT_DAY_MS,
            week: positiveLimit(w.weekMs) || DEFAULT_WEEK_MS,
        };
        this.defaultBackoffMs = positiveLimit(defaultBackoffMs) || DEFAULT_BACKOFF_MS;

        this.targets = new Map();   // "providerId::agentKey" → state

        this._ensureTables();
        this._load();
    }

    static get WINDOWS() { return WINDOWS; }

    static get DEFAULT_BACKOFF_MS() { return DEFAULT_BACKOFF_MS; }

    // -------------------------------------------------------------------------
    //  Target identity
    // -------------------------------------------------------------------------

    /**
     * Normalise anything routing might hand us into { providerId, agentKey }.
     * Accepts "provider", "provider::agent", { providerId, agentKey },
     * { provider, agent } or { id }.
     */
    _target(target) {
        try {
            if (typeof target === 'string') {
                const [providerId, agentKey] = target.split('::');
                return {
                    providerId: String(providerId || 'unknown').trim() || 'unknown',
                    agentKey: agentKey && agentKey !== '-' ? String(agentKey).trim() : null,
                };
            }
            if (target && typeof target === 'object') {
                const providerId = target.providerId ?? target.provider ?? target.id ?? 'unknown';
                const agentKey = target.agentKey ?? target.agent ?? target.model ?? null;
                const blank = agentKey === null || agentKey === undefined || agentKey === '' || agentKey === '-';
                return {
                    providerId: String(providerId || 'unknown').trim() || 'unknown',
                    agentKey: blank ? null : String(agentKey).trim(),
                };
            }
        } catch (err) {
            console.warn('[QuotaTracker] Unreadable target:', err.message);
        }
        return { providerId: 'unknown', agentKey: null };
    }

    /** Stable map key. Mirrors ProviderRouter._breakerKey's "a::b" shape. */
    _key(target) {
        const t = this._target(target);
        return `${t.providerId}::${t.agentKey || '-'}`;
    }

    /** Get-or-create. */
    _state(target) {
        const t = this._target(target);
        const key = `${t.providerId}::${t.agentKey || '-'}`;
        let state = this.targets.get(key);
        if (!state) {
            state = emptyState(t.providerId, t.agentKey);
            this.targets.set(key, state);
        }
        return state;
    }

    /** Read-only lookup — never creates a target, so reads cannot mutate. */
    _peek(target) {
        return this.targets.get(this._key(target)) || null;
    }

    // -------------------------------------------------------------------------
    //  Usage windows
    // -------------------------------------------------------------------------

    /**
     * Accumulate observed usage.
     *
     * Windows are anchored at the first record inside them and roll when the
     * clock passes `startedAt + windowMs` — which is how a real subscription
     * session behaves: the 5h clock starts with your first message, not at
     * midnight.
     *
     * @param {object} opts
     * @param {string} opts.providerId
     * @param {string} [opts.agentKey]
     * @param {number|object} [opts.tokens] a count, or an OpenAI-shaped usage object
     * @param {number} [opts.requests=1]
     * @param {number|Date|string} [opts.at] observation time (defaults to now)
     * @returns {object|null} { key, tokens, requests, headroom }
     */
    record({ providerId, agentKey, tokens, requests = 1, at } = {}) {
        try {
            const state = this._state({ providerId, agentKey });
            const when = toEpoch(at) ?? this.now();
            const addTokens = this._tokenCount(tokens);
            const addRequests = Math.max(0, num(requests));

            for (const name of WINDOWS) {
                const bucket = state.windows[name] || emptyBucket();
                const span = this.windowMs[name];
                if (bucket.startedAt === null) {
                    bucket.startedAt = when;
                } else if (when >= bucket.startedAt + span) {
                    // Boundary crossed — the old window is gone, start a fresh one.
                    bucket.startedAt = when;
                    bucket.tokens = 0;
                    bucket.requests = 0;
                }
                bucket.tokens += addTokens;
                bucket.requests += addRequests;
                state.windows[name] = bucket;
            }

            state.totals.tokens += addTokens;
            state.totals.requests += addRequests;
            state.lastUsedAt = when;

            // A successful call is hard evidence the quota is NOT exhausted, so
            // it clears a standing exhaustion (our reset hint may have been
            // pessimistic, or the provider may have topped us up early).
            if (state.exhausted && when >= num(state.exhausted.at)) {
                state.exhausted = null;
            }

            const key = this._key({ providerId, agentKey });
            this._persist(key, state);
            return {
                key,
                tokens: addTokens,
                requests: addRequests,
                headroom: this.headroom({ providerId, agentKey }, when),
            };
        } catch (err) {
            console.warn('[QuotaTracker] Failed to record usage:', err.message);
            return null;
        }
    }

    /** A bare number, or any of the usage shapes ProviderRouter sees. */
    _tokenCount(tokens) {
        if (tokens === null || tokens === undefined) return 0;
        if (typeof tokens === 'number') return Math.max(0, num(tokens));
        if (typeof tokens === 'object') {
            const total = tokens.total_tokens ?? tokens.totalTokens ?? tokens.total;
            if (total !== undefined) return Math.max(0, num(total));
            const input = tokens.prompt_tokens ?? tokens.promptTokens ?? tokens.input_tokens ?? tokens.input ?? 0;
            const output = tokens.completion_tokens ?? tokens.completionTokens ?? tokens.output_tokens ?? tokens.output ?? 0;
            return Math.max(0, num(input) + num(output));
        }
        return 0;
    }

    /**
     * Non-mutating view of one window: an expired bucket reads as empty, so a
     * reader always sees the truth without record() having been called first.
     */
    _windowView(state, name, when) {
        const span = this.windowMs[name];
        const bucket = (state && state.windows && state.windows[name]) || emptyBucket();
        if (bucket.startedAt === null || when >= bucket.startedAt + span) {
            return { startedAt: null, resetsAt: null, tokens: 0, requests: 0, spanMs: span };
        }
        return {
            startedAt: bucket.startedAt,
            resetsAt: bucket.startedAt + span,
            tokens: num(bucket.tokens),
            requests: num(bucket.requests),
            spanMs: span,
        };
    }

    // -------------------------------------------------------------------------
    //  Configured limits
    // -------------------------------------------------------------------------

    /**
     * Resolve the configured limit for one target/window, most specific first:
     *   limits["provider::agent"] → limits[agent] → limits[provider] → limits.default
     *
     * Each entry is keyed by window name, and a window's value is either a
     * number (interpreted as tokens) or { tokens, requests }:
     *
     *   limits: {
     *       'claude-code':       { session: { tokens: 2e6, requests: 200 }, week: 1e7 },
     *       'claude-code::opus': { session: { tokens: 5e5 } },
     *       default:             { day: { requests: 500 } },
     *   }
     *
     * A limits object written with window names at the TOP level is treated as
     * the default for every target.
     *
     * @returns {{tokens: number|null, requests: number|null}}
     */
    _limitFor(target, name) {
        try {
            const t = this._target(target);
            const cfg = this.limits || {};
            const topLevelWindows = WINDOWS.some(w => w in cfg);
            const candidates = topLevelWindows
                ? [cfg]
                : [
                    cfg[`${t.providerId}::${t.agentKey || '-'}`],
                    t.agentKey ? cfg[t.agentKey] : null,
                    cfg[t.providerId],
                    cfg.default,
                    cfg['*'],
                ];
            for (const candidate of candidates) {
                if (!candidate || typeof candidate !== 'object') continue;
                const spec = candidate[name];
                if (spec === null || spec === undefined) continue;
                if (typeof spec === 'number') {
                    const tokens = positiveLimit(spec);
                    if (tokens !== null) return { tokens, requests: null };
                    continue;
                }
                if (typeof spec === 'object') {
                    const tokens = positiveLimit(spec.tokens);
                    const requests = positiveLimit(spec.requests);
                    if (tokens !== null || requests !== null) return { tokens, requests };
                }
            }
        } catch (err) {
            console.warn('[QuotaTracker] Failed to resolve limits:', err.message);
        }
        // Nothing configured. Report the absence honestly; never invent a cap.
        return { tokens: null, requests: null };
    }

    /**
     * Headroom per window.
     *
     * @returns {object} window name → { window, used, limit, remaining, pct,
     *          requests, requestLimit, requestsRemaining, requestPct,
     *          startedAt, resetsAt, spanMs }
     *          `pct` is the PERCENTAGE CONSUMED (0-100). `limit`, `remaining`
     *          and `pct` are null when nothing is configured.
     */
    headroom(target, at) {
        const out = {};
        try {
            const when = toEpoch(at) ?? this.now();
            const state = this._peek(target);
            const pct = (used, cap) => (cap === null ? null : Math.round((used / cap) * 1e4) / 100);
            for (const name of WINDOWS) {
                const view = this._windowView(state, name, when);
                const limit = this._limitFor(target, name);
                out[name] = {
                    window: name,
                    spanMs: view.spanMs,
                    used: view.tokens,
                    limit: limit.tokens,
                    remaining: limit.tokens === null ? null : Math.max(0, limit.tokens - view.tokens),
                    pct: pct(view.tokens, limit.tokens),
                    requests: view.requests,
                    requestLimit: limit.requests,
                    requestsRemaining: limit.requests === null ? null : Math.max(0, limit.requests - view.requests),
                    requestPct: pct(view.requests, limit.requests),
                    startedAt: view.startedAt,
                    resetsAt: view.resetsAt,
                };
            }
        } catch (err) {
            console.warn('[QuotaTracker] Failed to compute headroom:', err.message);
        }
        return out;
    }

    // -------------------------------------------------------------------------
    //  Exhaustion
    // -------------------------------------------------------------------------

    /**
     * Flag a target as out of quota.
     *
     * `resetsAt` is whatever the provider told us (epoch ms, Date or ISO). When
     * it is missing, pass the 429's prose and/or headers as `text`/`headers`
     * and parseRateLimitHint() has a go at it; failing that we fall back to the
     * conservative default backoff rather than banning the target forever.
     *
     * @param {object} opts { providerId, agentKey, resetsAt, reason, text, headers, at }
     * @returns {object|null} the exhaustion record
     */
    markExhausted({ providerId, agentKey, resetsAt, reason, text, headers, at } = {}) {
        try {
            const state = this._state({ providerId, agentKey });
            const when = toEpoch(at) ?? this.now();

            let resolved = toEpoch(resetsAt);
            let source = resolved === null ? null : 'explicit';

            if (resolved === null && (text || headers)) {
                const hint = this.parseRateLimitHint(text, headers, when);
                if (hint) {
                    resolved = hint.resetsAt;
                    source = hint.source;
                }
            }

            const assumed = resolved === null;
            const record = {
                at: when,
                resetsAt: resolved,
                availableAt: assumed ? when + this.defaultBackoffMs : resolved,
                reason: reason ? String(reason) : (text ? String(text).slice(0, 300) : null),
                source: source || 'default-backoff',
                assumed,
            };
            state.exhausted = record;

            const key = this._key({ providerId, agentKey });
            this._persist(key, state);
            this._logExhaustion(key, state, record);
            return { ...record };
        } catch (err) {
            console.warn('[QuotaTracker] Failed to mark exhausted:', err.message);
            return null;
        }
    }

    /** True while the target is out of quota. Expires on its own clock. */
    isExhausted(target, at) {
        try {
            const state = this._peek(target);
            if (!state || !state.exhausted) return false;
            const when = toEpoch(at) ?? this.now();
            if (when >= num(state.exhausted.availableAt)) {
                state.exhausted = null;                 // auto-clear, no timers
                this._persist(this._key(target), state);
                return false;
            }
            return true;
        } catch (err) {
            console.warn('[QuotaTracker] Failed to read exhaustion:', err.message);
            return false;
        }
    }

    /** Epoch ms when an exhausted target comes back, or null if available now. */
    availableAt(target, at) {
        if (!this.isExhausted(target, at)) return null;
        const state = this._peek(target);
        return state && state.exhausted ? num(state.exhausted.availableAt) : null;
    }

    /** Drop a standing exhaustion but keep the usage counters. */
    clearExhaustion(target) {
        const state = this._peek(target);
        if (!state) return false;
        const had = Boolean(state.exhausted);
        state.exhausted = null;
        this._persist(this._key(target), state);
        return had;
    }

    /** Manual override: forget exhaustion AND usage for one target. */
    reset(target) {
        try {
            const t = this._target(target);
            const key = `${t.providerId}::${t.agentKey || '-'}`;
            const fresh = emptyState(t.providerId, t.agentKey);
            this.targets.set(key, fresh);
            this._persist(key, fresh);
            return true;
        } catch (err) {
            console.warn('[QuotaTracker] Failed to reset target:', err.message);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    //  Rate-limit hint parsing
    // -------------------------------------------------------------------------

    /**
     * Pull a reset time out of a 429's headers or prose.
     *
     * Recognised, in precedence order:
     *   1. `Retry-After: 120`                             delta seconds
     *   2. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`   HTTP date
     *   3. `X-RateLimit-Reset: 1790000000`                epoch seconds (or ms)
     *   4. "try again in 42 minutes"                      relative duration,
     *                                                     compound too ("1h 30m")
     *   5. "resets 1:50am" / "resets at 13:45"            bare clock time
     *
     * Returns null — never a guess — when nothing above matches, and never
     * throws on garbage input.
     *
     * @param {string} [text]
     * @param {object} [headers]
     * @param {number|Date|string} [at] reference time (defaults to now)
     * @returns {{resetsAt: number, source: string, raw: string}|null}
     */
    parseRateLimitHint(text, headers, at) {
        try {
            const when = toEpoch(at) ?? this.now();
            const hint = this._fromHeaders(headers, when) || this._fromText(text, when);
            if (!hint || !Number.isFinite(hint.resetsAt)) return null;
            // An absurdly distant hint is a parse accident, not a reset time.
            const cap = ABSOLUTE_SOURCES.includes(hint.source) ? MAX_ABSOLUTE_HINT_MS : MAX_HINT_MS;
            if (hint.resetsAt - when > cap) return null;
            return hint;
        } catch (err) {
            console.warn('[QuotaTracker] Failed to parse rate-limit hint:', err.message);
            return null;
        }
    }

    /** Static convenience for callers that have no tracker instance. */
    static parseRateLimitHint(text, headers, at) {
        const pinned = toEpoch(at);
        const probe = {
            now: () => (pinned === null ? Date.now() : pinned),
            _fromHeaders: QuotaTracker.prototype._fromHeaders,
            _fromText: QuotaTracker.prototype._fromText,
            _header: QuotaTracker.prototype._header,
            _nextLocalTime: QuotaTracker.prototype._nextLocalTime,
        };
        return QuotaTracker.prototype.parseRateLimitHint.call(probe, text, headers, at);
    }

    /** Case-insensitive header lookup that tolerates array values. */
    _header(headers, name) {
        if (!headers || typeof headers !== 'object') return null;
        const want = String(name).toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (String(key).toLowerCase() !== want) continue;
            const flat = Array.isArray(value) ? value[0] : value;
            if (flat === null || flat === undefined) return null;
            return String(flat).trim();
        }
        return null;
    }

    _fromHeaders(headers, when) {
        const retryAfter = this._header(headers, 'retry-after');
        if (retryAfter) {
            if (/^\d+$/.test(retryAfter)) {
                const seconds = Number(retryAfter);
                if (Number.isFinite(seconds) && seconds >= 0) {
                    return { resetsAt: when + seconds * SECOND_MS, source: 'retry-after-seconds', raw: retryAfter };
                }
            } else {
                // Only date-parse something that is NOT pure digits, otherwise
                // Date.parse("120") would happily invent the year 120.
                const parsed = Date.parse(retryAfter);
                if (!Number.isNaN(parsed)) {
                    return { resetsAt: parsed, source: 'retry-after-date', raw: retryAfter };
                }
            }
        }

        const resetHeader = this._header(headers, 'x-ratelimit-reset')
            || this._header(headers, 'x-rate-limit-reset')
            || this._header(headers, 'ratelimit-reset');
        if (resetHeader && /^\d+(\.\d+)?$/.test(resetHeader)) {
            const value = Number(resetHeader);
            if (value > 1e12) return { resetsAt: value, source: 'x-ratelimit-reset', raw: resetHeader };
            // Epoch SECONDS. A smaller number is not plausibly an epoch (some
            // servers put delta-seconds here) so we decline rather than guess.
            if (value > 1e9) return { resetsAt: value * SECOND_MS, source: 'x-ratelimit-reset', raw: resetHeader };
        }
        return null;
    }

    _fromText(text, when) {
        if (typeof text !== 'string' || !text.trim()) return null;
        const body = text.trim();

        // --- relative duration: "try again in 42 minutes", "in 1h 30m" -------
        const relative = body.match(/\bin\s+((?:\d+(?:\.\d+)?\s*[a-zA-Z]+\s*(?:and\s+)?){1,4})/i);
        if (relative) {
            let total = 0;
            let matched = 0;
            for (const pair of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g)) {
                const unit = DURATION_UNITS[String(pair[2]).toLowerCase()];
                if (!unit) continue;
                total += Number(pair[1]) * unit;
                matched += 1;
            }
            if (matched > 0 && total > 0) {
                return { resetsAt: when + total, source: 'text-duration', raw: relative[0].trim() };
            }
        }

        // --- bare clock time: "resets 1:50am", "resets at 13:45" -------------
        // A clock time carries NO DATE, so it is resolved to the NEXT
        // occurrence of that LOCAL time: later today if it is still ahead of
        // us, otherwise tomorrow. Built with the Date(y, mo, d, h, mi)
        // constructor so local DST shifts are handled by the platform.
        // A reset-ish trigger word is required, so a stray timestamp in an
        // unrelated error message is not mistaken for a quota reset.
        if (!RESET_TRIGGER.test(body)) return null;

        const twelve = body.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i);
        if (twelve) {
            let hour = Number(twelve[1]);
            const minute = twelve[2] === undefined ? 0 : Number(twelve[2]);
            const isPm = String(twelve[3]).toLowerCase() === 'p';
            if (hour >= 1 && hour <= 12 && minute <= 59) {
                if (hour === 12) hour = 0;          // 12am → 00, 12pm → 12
                if (isPm) hour += 12;
                return { resetsAt: this._nextLocalTime(when, hour, minute), source: 'text-clock', raw: twelve[0].trim() };
            }
        }

        const twentyFour = body.match(/\b(\d{1,2}):(\d{2})\b/);
        if (twentyFour) {
            const hour = Number(twentyFour[1]);
            const minute = Number(twentyFour[2]);
            if (hour <= 23 && minute <= 59) {
                return { resetsAt: this._nextLocalTime(when, hour, minute), source: 'text-clock', raw: twentyFour[0].trim() };
            }
        }
        return null;
    }

    /** The next epoch ms at which the local wall clock reads hour:minute. */
    _nextLocalTime(when, hour, minute) {
        const ref = new Date(when);
        let candidate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hour, minute, 0, 0).getTime();
        if (candidate <= when) {
            candidate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1, hour, minute, 0, 0).getTime();
        }
        return candidate;
    }

    // -------------------------------------------------------------------------
    //  Ranking
    // -------------------------------------------------------------------------

    /**
     * Score a target: the TIGHTEST remaining fraction across every window that
     * has a configured limit (1 = untouched, 0 = full). Unconfigured targets
     * get the neutral UNKNOWN_SCORE — see that constant's note.
     */
    _score(target, when) {
        const headroom = this.headroom(target, when);
        let score = null;
        for (const name of WINDOWS) {
            const h = headroom[name];
            if (!h) continue;
            if (h.limit !== null) {
                const fraction = Math.max(0, Math.min(1, h.remaining / h.limit));
                score = score === null ? fraction : Math.min(score, fraction);
            }
            if (h.requestLimit !== null) {
                const fraction = Math.max(0, Math.min(1, h.requestsRemaining / h.requestLimit));
                score = score === null ? fraction : Math.min(score, fraction);
            }
        }
        return { score: score === null ? UNKNOWN_SCORE : score, known: score !== null, headroom };
    }

    /**
     * Order targets best-first: available before exhausted, most headroom
     * first, and the exhausted tail sorted by who returns soonest.
     *
     * Fully deterministic — no RNG, one clock read for the whole call, and a
     * lexicographic key tiebreak — so identical inputs always route the same way.
     *
     * @param {Array|object|string} targets
     * @returns {Array<object>} [{ key, providerId, agentKey, target, exhausted,
     *          availableAt, resetsAt, reason, assumedReset, score, scoreKnown,
     *          headroom, sessionTokens }]
     */
    rank(targets, at) {
        try {
            const list = Array.isArray(targets) ? targets : [targets];
            const when = toEpoch(at) ?? this.now();
            const rows = [];
            for (const target of list) {
                if (target === null || target === undefined) continue;
                const t = this._target(target);
                const exhausted = this.isExhausted(target, when);
                const state = this._peek(target);
                const standing = exhausted && state ? state.exhausted : null;
                const scored = this._score(target, when);
                rows.push({
                    key: `${t.providerId}::${t.agentKey || '-'}`,
                    providerId: t.providerId,
                    agentKey: t.agentKey,
                    target,
                    exhausted,
                    availableAt: standing ? num(standing.availableAt) : null,
                    resetsAt: standing ? standing.resetsAt : null,
                    reason: standing ? standing.reason : null,
                    assumedReset: standing ? Boolean(standing.assumed) : false,
                    score: scored.score,
                    scoreKnown: scored.known,
                    headroom: scored.headroom,
                    sessionTokens: scored.headroom.session ? scored.headroom.session.used : 0,
                });
            }

            rows.sort((a, b) => {
                if (a.exhausted !== b.exhausted) return a.exhausted ? 1 : -1;
                if (a.exhausted && b.exhausted) {
                    const aa = a.availableAt === null ? Infinity : a.availableAt;
                    const bb = b.availableAt === null ? Infinity : b.availableAt;
                    if (aa !== bb) return aa - bb;
                    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
                }
                if (b.score !== a.score) return b.score - a.score;
                if (a.sessionTokens !== b.sessionTokens) return a.sessionTokens - b.sessionTokens;
                return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
            });
            return rows;
        } catch (err) {
            console.warn('[QuotaTracker] Failed to rank targets:', err.message);
            return [];
        }
    }

    /**
     * The single best target that still has quota, or null when every one of
     * them is exhausted. Use pickWithReason() when you also need to tell the
     * operator *when* something comes back.
     */
    pick(targets, at) {
        return this.pickWithReason(targets, at).target;
    }

    /**
     * pick() plus the explanation.
     * @returns {{target: object|null, allExhausted: boolean, availableAt: number|null,
     *           soonest: object|null, ranked: Array}}
     */
    pickWithReason(targets, at) {
        const ranked = this.rank(targets, at);
        const available = ranked.find(row => !row.exhausted) || null;
        if (available) {
            return { target: available, allExhausted: false, availableAt: null, soonest: null, ranked };
        }
        // Everything is exhausted — rank() already sorted the exhausted tail by
        // who returns soonest, so its head is the one worth waiting for.
        const soonest = ranked[0] || null;
        return {
            target: null,
            allExhausted: ranked.length > 0,
            availableAt: soonest ? soonest.availableAt : null,
            soonest,
            ranked,
        };
    }

    // -------------------------------------------------------------------------
    //  Reporting
    // -------------------------------------------------------------------------

    /** Everything a dashboard tile needs. Never throws. */
    report(at) {
        try {
            const when = toEpoch(at) ?? this.now();
            const keys = Array.from(this.targets.keys()).sort();
            const targets = keys.map((key) => {
                const state = this.targets.get(key);
                const ref = { providerId: state.providerId, agentKey: state.agentKey };
                const exhausted = this.isExhausted(ref, when);
                const standing = exhausted ? state.exhausted : null;
                return {
                    key,
                    providerId: state.providerId,
                    agentKey: state.agentKey,
                    exhausted,
                    exhaustedAt: standing ? standing.at : null,
                    resetsAt: standing ? standing.resetsAt : null,
                    availableAt: standing ? standing.availableAt : null,
                    reason: standing ? standing.reason : null,
                    source: standing ? standing.source : null,
                    assumedReset: standing ? Boolean(standing.assumed) : false,
                    lastUsedAt: state.lastUsedAt,
                    totals: { ...state.totals },
                    headroom: this.headroom(ref, when),
                };
            });
            const exhausted = targets.filter(t => t.exhausted);
            const soonest = exhausted.reduce(
                (best, t) => (t.availableAt !== null && (best === null || t.availableAt < best) ? t.availableAt : best),
                null
            );
            return {
                generatedAt: new Date(when).toISOString(),
                now: when,
                persistence: this.raw ? 'sqlite' : 'json',
                windowMs: { ...this.windowMs },
                defaultBackoffMs: this.defaultBackoffMs,
                limitsConfigured: Object.keys(this.limits || {}).length > 0,
                targetCount: targets.length,
                exhaustedCount: exhausted.length,
                soonestAvailableAt: soonest,
                targets,
            };
        } catch (err) {
            console.warn('[QuotaTracker] Failed to build report:', err.message);
            return { generatedAt: new Date().toISOString(), targets: [], targetCount: 0, exhaustedCount: 0 };
        }
    }

    // -------------------------------------------------------------------------
    //  Persistence — sqlite through the raw handle, else a JSON file
    // -------------------------------------------------------------------------

    /**
     * Our own tables, created through the raw node:sqlite handle so
     * core/Database.js stays untouched. `token_usage` over there is a per-agent
     * cost ledger; these are quota windows and exhaustion events — a different
     * shape with a different lifetime.
     */
    _ensureTables() {
        if (!this.raw) return;
        try {
            this.raw.exec(`
                -- One row per provider/agent target: rolling windows plus any
                -- standing exhaustion, stored as JSON so the shape can grow.
                CREATE TABLE IF NOT EXISTS quota_state (
                    key          TEXT PRIMARY KEY,
                    provider_id  TEXT NOT NULL,
                    agent_key    TEXT,
                    state        TEXT NOT NULL,
                    updated_at   INTEGER NOT NULL
                );

                -- Audit trail of every observed exhaustion, for the UI and for
                -- working out how often a subscription actually runs dry.
                CREATE TABLE IF NOT EXISTS quota_exhaustion_log (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    key          TEXT NOT NULL,
                    provider_id  TEXT NOT NULL,
                    agent_key    TEXT,
                    reason       TEXT,
                    source       TEXT,
                    resets_at    INTEGER,
                    available_at INTEGER,
                    created_at   INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_quota_exhaustion_key
                    ON quota_exhaustion_log(key, created_at DESC);
            `);
        } catch (err) {
            console.warn('[QuotaTracker] Failed to create quota tables:', err.message);
            this.raw = null;   // fall back to the JSON store
        }
    }

    _load() {
        if (this.raw) {
            try {
                const rows = this.raw.prepare('SELECT key, state FROM quota_state').all() || [];
                for (const row of rows) this._hydrate(row.key, row.state);
            } catch (err) {
                console.warn('[QuotaTracker] Failed to read quota_state:', err.message);
            }
            return;
        }
        try {
            if (!fs.existsSync(this.statePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || !parsed.targets) return;
            for (const [key, state] of Object.entries(parsed.targets)) this._hydrate(key, state);
        } catch (err) {
            console.warn('[QuotaTracker] Failed to read quota.json:', err.message);
        }
    }

    /** Rebuild one target from persisted JSON, tolerating anything missing. */
    _hydrate(key, raw) {
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') return;
            const fallback = this._target(key);
            const agentKey = parsed.agentKey === null || parsed.agentKey === undefined
                ? fallback.agentKey
                : String(parsed.agentKey);
            const state = emptyState(String(parsed.providerId || fallback.providerId), agentKey);

            for (const name of WINDOWS) {
                const bucket = parsed.windows && parsed.windows[name];
                if (!bucket || typeof bucket !== 'object') continue;
                state.windows[name] = {
                    startedAt: toEpoch(bucket.startedAt),
                    tokens: num(bucket.tokens),
                    requests: num(bucket.requests),
                };
            }
            if (parsed.totals && typeof parsed.totals === 'object') {
                state.totals = { tokens: num(parsed.totals.tokens), requests: num(parsed.totals.requests) };
            }
            state.lastUsedAt = toEpoch(parsed.lastUsedAt);
            if (parsed.exhausted && typeof parsed.exhausted === 'object') {
                const at = toEpoch(parsed.exhausted.at) ?? 0;
                const resetsAt = toEpoch(parsed.exhausted.resetsAt);
                state.exhausted = {
                    at,
                    resetsAt,
                    availableAt: toEpoch(parsed.exhausted.availableAt)
                        ?? (resetsAt === null ? at + this.defaultBackoffMs : resetsAt),
                    reason: parsed.exhausted.reason ? String(parsed.exhausted.reason) : null,
                    source: parsed.exhausted.source ? String(parsed.exhausted.source) : 'default-backoff',
                    assumed: Boolean(parsed.exhausted.assumed),
                };
            }
            this.targets.set(`${state.providerId}::${state.agentKey || '-'}`, state);
        } catch (err) {
            console.warn('[QuotaTracker] Failed to hydrate quota state:', err.message);
        }
    }

    _serialize(state) {
        return {
            providerId: state.providerId,
            agentKey: state.agentKey,
            windows: {
                session: { ...state.windows.session },
                day: { ...state.windows.day },
                week: { ...state.windows.week },
            },
            totals: { ...state.totals },
            lastUsedAt: state.lastUsedAt,
            exhausted: state.exhausted ? { ...state.exhausted } : null,
        };
    }

    _persist(key, state) {
        if (this.raw) {
            try {
                this.raw.prepare(`
                    INSERT INTO quota_state (key, provider_id, agent_key, state, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        provider_id = excluded.provider_id,
                        agent_key   = excluded.agent_key,
                        state       = excluded.state,
                        updated_at  = excluded.updated_at
                `).run(
                    key,
                    state.providerId,
                    state.agentKey === null ? null : state.agentKey,
                    JSON.stringify(this._serialize(state)),
                    Math.round(this.now())
                );
                return true;
            } catch (err) {
                console.warn('[QuotaTracker] Failed to persist quota_state:', err.message);
                return false;
            }
        }
        return this._saveJson();
    }

    _saveJson() {
        try {
            if (!fs.existsSync(this.storeDir)) {
                fs.mkdirSync(this.storeDir, { recursive: true });
            }
            const targets = {};
            for (const [key, state] of this.targets) targets[key] = this._serialize(state);
            fs.writeFileSync(
                this.statePath,
                JSON.stringify({ version: 1, savedAt: Math.round(this.now()), targets }, null, 2),
                'utf8'
            );
            return true;
        } catch (err) {
            console.warn('[QuotaTracker] Failed to persist quota.json:', err.message);
            return false;
        }
    }

    /** Force a full flush. Useful on shutdown and in tests. */
    save() {
        if (!this.raw) return this._saveJson();
        let ok = true;
        for (const [key, state] of this.targets) {
            if (!this._persist(key, state)) ok = false;
        }
        return ok;
    }

    _logExhaustion(key, state, record) {
        if (!this.raw) return;
        try {
            this.raw.prepare(`
                INSERT INTO quota_exhaustion_log
                    (key, provider_id, agent_key, reason, source, resets_at, available_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                key,
                state.providerId,
                state.agentKey === null ? null : state.agentKey,
                record.reason === null ? null : String(record.reason),
                record.source === null ? null : String(record.source),
                record.resetsAt === null ? null : Math.round(record.resetsAt),
                record.availableAt === null ? null : Math.round(record.availableAt),
                Math.round(record.at)
            );
        } catch (err) {
            console.warn('[QuotaTracker] Failed to log exhaustion:', err.message);
        }
    }

    /** Recent exhaustion events, newest first. Empty without a database. */
    history(limit = 50) {
        if (!this.raw) return [];
        try {
            const cap = Math.max(1, Math.min(500, num(limit) || 50));
            return this.raw.prepare(`
                SELECT key, provider_id, agent_key, reason, source, resets_at, available_at, created_at
                FROM quota_exhaustion_log
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `).all(cap) || [];
        } catch (err) {
            console.warn('[QuotaTracker] Failed to read exhaustion history:', err.message);
            return [];
        }
    }
}

module.exports = QuotaTracker;
module.exports.QuotaTracker = QuotaTracker;
module.exports.WINDOWS = WINDOWS;
