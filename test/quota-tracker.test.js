const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const QuotaTracker = require('../core/QuotaTracker');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SESSION_MS = 5 * HOUR_MS;
const UNKNOWN_SCORE = 0.5;

/** Pinned UTC instant so tests never depend on the wall clock. */
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0); // 2026-03-10 12:00:00Z

/**
 * Fresh JSON-backed tracker in a temp dir. Persistence writes
 * `<dir>/store/quota.json` — the repo `store/` is never touched.
 * Cleanup is best-effort: an EPERM on rmSync must never fail a test.
 */
function makeTracker(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
    let nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : T0;
    const now = typeof opts.now === 'function' ? opts.now : () => nowMs;
    const { nowMs: _dropNowMs, now: _dropNow, ...rest } = opts;
    const tracker = new QuotaTracker({ baseDir: dir, now, ...rest });
    return {
        tracker,
        dir,
        get time() { return nowMs; },
        set time(v) { nowMs = v; },
        advance(ms) { nowMs += ms; return nowMs; },
        reopen(extra = {}) {
            return new QuotaTracker({ baseDir: dir, now, ...rest, ...extra });
        },
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

function assertNullCaps(window) {
    assert.equal(window.limit, null);
    assert.equal(window.remaining, null);
    assert.equal(window.pct, null);
    assert.equal(window.requestLimit, null);
    assert.equal(window.requestsRemaining, null);
    assert.equal(window.requestPct, null);
}

// ===========================================================================
//  Honesty — unconfigured targets never invent a limit
// ===========================================================================

test('unconfigured target reports limit: null / remaining: null — never invents a cap', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const h = tracker.headroom('claude-code');
        for (const name of QuotaTracker.WINDOWS) {
            assert.ok(h[name], `expected a ${name} window`);
            assertNullCaps(h[name]);
            assert.equal(h[name].used, 0);
            assert.equal(h[name].requests, 0);
        }
    } finally { cleanup(); }
});

test('recording usage on an unconfigured target still leaves remaining null', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        tracker.record({ providerId: 'claude-code', tokens: 999_999, requests: 40 });
        const h = tracker.headroom('claude-code');
        for (const name of QuotaTracker.WINDOWS) {
            assert.equal(h[name].used, 999_999);
            assert.equal(h[name].requests, 40);
            assertNullCaps(h[name]);
        }
        const report = tracker.report();
        assert.equal(report.limitsConfigured, false);
        assert.equal(report.targets[0].headroom.session.remaining, null);
        assert.equal(report.targets[0].headroom.session.limit, null);
    } finally { cleanup(); }
});

test('configured remaining is limit minus used, floored at zero — never fabricated', () => {
    const { tracker, cleanup } = makeTracker({
        limits: { 'claude-code': { session: { tokens: 1000, requests: 10 } } },
    });
    try {
        tracker.record({ providerId: 'claude-code', tokens: 200, requests: 3 });
        const session = tracker.headroom('claude-code').session;
        assert.equal(session.limit, 1000);
        assert.equal(session.remaining, 800);
        assert.equal(session.requestLimit, 10);
        assert.equal(session.requestsRemaining, 7);

        tracker.record({ providerId: 'claude-code', tokens: 5000, requests: 20 });
        const over = tracker.headroom('claude-code').session;
        assert.equal(over.used, 5200);
        assert.equal(over.limit, 1000);
        assert.equal(over.remaining, 0, 'remaining must not go negative or grow with over-use');
        assert.equal(over.requestsRemaining, 0);
    } finally { cleanup(); }
});

// ===========================================================================
//  record() — windows, clock injection, rollover
// ===========================================================================

test('record accumulates tokens and requests into session/day/week windows', () => {
    const box = makeTracker();
    try {
        const first = box.tracker.record({ providerId: 'claude-code', agentKey: 'opus', tokens: 100, requests: 1 });
        assert.equal(first.tokens, 100);
        assert.equal(first.requests, 1);
        assert.equal(first.key, 'claude-code::opus');

        box.tracker.record({
            providerId: 'claude-code',
            agentKey: 'opus',
            tokens: { total_tokens: 50 },
            requests: 2,
        });
        // prompt + completion shape, default requests = 1
        box.tracker.record({
            providerId: 'claude-code',
            agentKey: 'opus',
            tokens: { prompt_tokens: 10, completion_tokens: 5 },
        });

        const h = box.tracker.headroom({ providerId: 'claude-code', agentKey: 'opus' });
        for (const name of QuotaTracker.WINDOWS) {
            assert.equal(h[name].used, 165);
            assert.equal(h[name].requests, 4);
            assert.equal(h[name].startedAt, T0);
            assert.equal(h[name].resetsAt, T0 + h[name].spanMs);
        }
    } finally { box.cleanup(); }
});

test('record uses the injected clock when `at` is omitted, and honours `at` when given', () => {
    const box = makeTracker({ nowMs: T0 });
    try {
        box.tracker.record({ providerId: 'grok', tokens: 1 });
        assert.equal(box.tracker.headroom('grok').session.startedAt, T0);

        box.time = T0 + HOUR_MS;
        box.tracker.record({ providerId: 'grok', tokens: 1 }); // still inside the 5h session
        assert.equal(box.tracker.headroom('grok').session.used, 2);
        assert.equal(box.tracker.headroom('grok').session.startedAt, T0);

        // Explicit `at` is independent of the injected now().
        box.tracker.record({ providerId: 'codex', tokens: 9, requests: 3, at: T0 + 250 });
        const h = box.tracker.headroom('codex', T0 + 250);
        assert.equal(h.session.used, 9);
        assert.equal(h.session.requests, 3);
        assert.equal(h.session.startedAt, T0 + 250);
    } finally { box.cleanup(); }
});

test('windows roll over when now advances past windowMs, including custom spans', () => {
    const sessionMs = 1000;
    const dayMs = 10_000;
    const weekMs = 50_000;
    const box = makeTracker({ windows: { sessionMs, dayMs, weekMs } });
    try {
        box.tracker.record({ providerId: 'grok', tokens: 100, requests: 2, at: T0 });

        // View-only expiry: the session bucket is gone without a new record().
        box.time = T0 + sessionMs;
        const expired = box.tracker.headroom('grok');
        assert.equal(expired.session.used, 0);
        assert.equal(expired.session.startedAt, null);
        assert.equal(expired.session.resetsAt, null);
        assert.equal(expired.day.used, 100, 'day window has not elapsed');
        assert.equal(expired.week.used, 100);

        // Recording after the boundary starts a fresh session and keeps the day tally.
        box.tracker.record({ providerId: 'grok', tokens: 7, requests: 1 });
        const rolled = box.tracker.headroom('grok');
        assert.equal(rolled.session.used, 7);
        assert.equal(rolled.session.requests, 1);
        assert.equal(rolled.session.startedAt, T0 + sessionMs);
        assert.equal(rolled.day.used, 107);
        assert.equal(rolled.day.requests, 3);

        box.time = T0 + dayMs;
        const dayExpired = box.tracker.headroom('grok');
        assert.equal(dayExpired.day.used, 0);
        assert.equal(dayExpired.week.used, 107);

        box.tracker.record({ providerId: 'grok', tokens: 1, requests: 1 });
        const dayRolled = box.tracker.headroom('grok');
        assert.equal(dayRolled.day.used, 1);
        assert.equal(dayRolled.day.startedAt, T0 + dayMs);
        assert.equal(dayRolled.week.used, 108);

        box.time = T0 + weekMs;
        assert.equal(box.tracker.headroom('grok').week.used, 0);
        box.tracker.record({ providerId: 'grok', tokens: 4 });
        assert.equal(box.tracker.headroom('grok').week.used, 4);
        assert.equal(box.tracker.headroom('grok').week.startedAt, T0 + weekMs);
    } finally { box.cleanup(); }
});

test('default session window rolls at 5 hours while the day window holds', () => {
    const box = makeTracker();
    try {
        box.tracker.record({ providerId: 'grok', tokens: 40, at: T0 });
        box.time = T0 + SESSION_MS;
        assert.equal(box.tracker.headroom('grok').session.used, 0);
        assert.equal(box.tracker.headroom('grok').day.used, 40);

        box.tracker.record({ providerId: 'grok', tokens: 3 });
        assert.equal(box.tracker.headroom('grok').session.used, 3);
        assert.equal(box.tracker.headroom('grok').day.used, 43);
        assert.equal(box.tracker.headroom('grok').week.used, 43);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Persistence — JSON fallback under temp baseDir
// ===========================================================================

test('record persists and a new QuotaTracker on the same baseDir reloads it', () => {
    const box = makeTracker();
    try {
        box.tracker.record({ providerId: 'codex', agentKey: 'gpt', tokens: 42, requests: 3 });
        box.tracker.markExhausted({
            providerId: 'codex',
            agentKey: 'gpt',
            headers: { 'retry-after': '90' },
            reason: 'weekly cap',
            at: T0,
        });
        assert.equal(box.tracker.save(), true);

        const quotaFile = path.join(box.dir, 'store', 'quota.json');
        assert.equal(fs.existsSync(quotaFile), true, 'JSON fallback must land in the temp store/');
        const dumped = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
        assert.equal(dumped.targets['codex::gpt'].windows.session.tokens, 42);

        const revived = box.reopen();
        const h = revived.headroom({ providerId: 'codex', agentKey: 'gpt' });
        assert.equal(h.session.used, 42);
        assert.equal(h.session.requests, 3);
        assert.equal(revived.isExhausted({ providerId: 'codex', agentKey: 'gpt' }), true);
        assert.equal(revived.availableAt({ providerId: 'codex', agentKey: 'gpt' }), T0 + 90 * SECOND_MS);

        const report = revived.report();
        assert.equal(report.persistence, 'json');
        assert.equal(report.targetCount, 1);
        // JSON fallback has no sqlite audit trail.
        assert.deepEqual(revived.history(), []);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  parseRateLimitHint + markExhausted
// ===========================================================================

test('parseRateLimitHint reads Retry-After seconds', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const hint = tracker.parseRateLimitHint(null, { 'retry-after': '120' }, T0);
        assert.equal(hint.source, 'retry-after-seconds');
        assert.equal(hint.resetsAt, T0 + 120 * SECOND_MS);
        assert.equal(hint.raw, '120');

        const rec = tracker.markExhausted({
            providerId: 'claude-code',
            headers: { 'Retry-After': ['30'] },
            at: T0,
        });
        assert.equal(rec.assumed, false);
        assert.equal(rec.source, 'retry-after-seconds');
        assert.equal(rec.availableAt, T0 + 30 * SECOND_MS);
    } finally { cleanup(); }
});

test('parseRateLimitHint reads Retry-After HTTP date', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const httpDate = 'Wed, 11 Mar 2026 07:28:00 GMT';
        const parsed = Date.parse(httpDate);
        const hint = tracker.parseRateLimitHint('', { 'Retry-After': httpDate }, T0);
        assert.equal(hint.source, 'retry-after-date');
        assert.equal(hint.resetsAt, parsed);

        const rec = tracker.markExhausted({
            providerId: 'grok',
            headers: { 'retry-after': httpDate },
            at: T0,
        });
        assert.equal(rec.source, 'retry-after-date');
        assert.equal(rec.resetsAt, parsed);
        assert.equal(rec.availableAt, parsed);
        assert.equal(rec.assumed, false);
    } finally { cleanup(); }
});

test('parseRateLimitHint reads x-ratelimit-reset as epoch seconds or milliseconds', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const resetMs = T0 + HOUR_MS;
        const asMs = tracker.parseRateLimitHint(null, { 'x-ratelimit-reset': String(resetMs) }, T0);
        assert.equal(asMs.source, 'x-ratelimit-reset');
        assert.equal(asMs.resetsAt, resetMs);

        const resetSec = Math.floor(resetMs / SECOND_MS);
        const asSec = tracker.parseRateLimitHint(null, { 'X-Rate-Limit-Reset': String(resetSec) }, T0);
        assert.equal(asSec.source, 'x-ratelimit-reset');
        assert.equal(asSec.resetsAt, resetSec * SECOND_MS);

        const rec = tracker.markExhausted({
            providerId: 'codex',
            headers: { 'ratelimit-reset': String(resetSec) },
            at: T0,
        });
        assert.equal(rec.source, 'x-ratelimit-reset');
        assert.equal(rec.availableAt, resetSec * SECOND_MS);
    } finally { cleanup(); }
});

test('parseRateLimitHint reads prose durations and clock times with RESET_TRIGGER words', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const duration = tracker.parseRateLimitHint('Please try again in 42 minutes', {}, T0);
        assert.equal(duration.source, 'text-duration');
        assert.equal(duration.resetsAt, T0 + 42 * MINUTE_MS);

        const compound = tracker.parseRateLimitHint('rate limit: try again in 1 hour and 30 minutes', {}, T0);
        assert.equal(compound.source, 'text-duration');
        assert.equal(compound.resetsAt, T0 + HOUR_MS + 30 * MINUTE_MS);

        // Bare clock, later today (local).
        const midnight = new Date(2026, 2, 10, 0, 0, 0, 0).getTime();
        const morning = tracker.parseRateLimitHint('Your quota resets 1:50am', {}, midnight);
        assert.equal(morning.source, 'text-clock');
        assert.equal(morning.resetsAt, new Date(2026, 2, 10, 1, 50, 0, 0).getTime());

        // Bare clock already past → next occurrence is tomorrow.
        const afternoon = new Date(2026, 2, 10, 14, 0, 0, 0).getTime();
        const tomorrow = tracker.parseRateLimitHint('resets 1:50am', {}, afternoon);
        assert.equal(tomorrow.resetsAt, new Date(2026, 2, 11, 1, 50, 0, 0).getTime());

        const twentyFour = tracker.parseRateLimitHint('limit reached, available at 13:45', {}, midnight);
        assert.equal(twentyFour.source, 'text-clock');
        assert.equal(twentyFour.resetsAt, new Date(2026, 2, 10, 13, 45, 0, 0).getTime());

        // A stray clock without a reset-ish trigger word is not a quota hint.
        assert.equal(tracker.parseRateLimitHint('error at 1:50am on the server', {}, midnight), null);
        assert.equal(tracker.parseRateLimitHint('see you at 13:45', {}, midnight), null);

        const rec = tracker.markExhausted({
            providerId: 'claude-code',
            text: 'try again in 42 minutes',
            at: T0,
        });
        assert.equal(rec.source, 'text-duration');
        assert.equal(rec.availableAt, T0 + 42 * MINUTE_MS);
        assert.equal(rec.assumed, false);
    } finally { cleanup(); }
});

test('unknown hint falls back to DEFAULT_BACKOFF_MS (1 hour) with assumed flag', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        assert.equal(QuotaTracker.DEFAULT_BACKOFF_MS, HOUR_MS);
        assert.equal(tracker.parseRateLimitHint('nope, just no', {}, T0), null);
        assert.equal(QuotaTracker.parseRateLimitHint('garbage', { 'x-foo': '1' }, T0), null);

        const rec = tracker.markExhausted({ providerId: 'grok', text: 'nope, just no', at: T0 });
        assert.equal(rec.assumed, true);
        assert.equal(rec.source, 'default-backoff');
        assert.equal(rec.resetsAt, null);
        assert.equal(rec.availableAt, T0 + QuotaTracker.DEFAULT_BACKOFF_MS);
        assert.equal(tracker.isExhausted('grok', T0), true);
        assert.equal(tracker.availableAt('grok', T0), T0 + HOUR_MS);
    } finally { cleanup(); }
});

test('absurd hint values are rejected as null rather than trusted', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        // Relative hints are capped at two weeks.
        assert.equal(tracker.parseRateLimitHint('try again in 15 days', {}, T0), null);
        assert.equal(tracker.parseRateLimitHint('try again in 20 days', {}, T0), null);

        // Absolute HTTP date / epoch past ~90 days is a parse accident.
        const farDate = new Date(T0 + 91 * DAY_MS).toUTCString();
        assert.equal(tracker.parseRateLimitHint(null, { 'retry-after': farDate }, T0), null);
        assert.equal(tracker.parseRateLimitHint(null, { 'x-ratelimit-reset': String(T0 + 100 * DAY_MS) }, T0), null);

        // Tiny x-ratelimit-reset is a delta, not an epoch — declined, not guessed.
        assert.equal(tracker.parseRateLimitHint(null, { 'x-ratelimit-reset': '60' }, T0), null);

        // markExhausted must not trust the absurd value either: default backoff instead.
        const rec = tracker.markExhausted({
            providerId: 'claude-code',
            text: 'try again in 20 days',
            at: T0,
        });
        assert.equal(rec.assumed, true);
        assert.equal(rec.source, 'default-backoff');
        assert.equal(rec.availableAt, T0 + HOUR_MS);

        assert.equal(tracker.parseRateLimitHint(null, null, T0), null);
        assert.equal(tracker.parseRateLimitHint('', {}, T0), null);
        assert.equal(tracker.parseRateLimitHint(42, 'nope', T0), null);
    } finally { cleanup(); }
});

test('headers take precedence over prose, and explicit resetsAt over both', () => {
    const { tracker, cleanup } = makeTracker();
    try {
        const hinted = tracker.parseRateLimitHint(
            'try again in 42 minutes',
            { 'retry-after': '10' },
            T0
        );
        assert.equal(hinted.source, 'retry-after-seconds');
        assert.equal(hinted.resetsAt, T0 + 10 * SECOND_MS);

        const rec = tracker.markExhausted({
            providerId: 'grok',
            resetsAt: T0 + 5 * SECOND_MS,
            text: 'try again in 42 minutes',
            headers: { 'retry-after': '10' },
            at: T0,
        });
        assert.equal(rec.source, 'explicit');
        assert.equal(rec.availableAt, T0 + 5 * SECOND_MS);
        assert.equal(rec.assumed, false);
    } finally { cleanup(); }
});

// ===========================================================================
//  isExhausted / availableAt clock
// ===========================================================================

test('isExhausted is true until availableAt, then false', () => {
    const box = makeTracker();
    try {
        box.tracker.markExhausted({
            providerId: 'grok',
            headers: { 'retry-after': '60' },
            at: T0,
        });
        assert.equal(box.tracker.isExhausted('grok', T0), true);
        assert.equal(box.tracker.isExhausted('grok', T0 + 59_999), true);
        assert.equal(box.tracker.availableAt('grok', T0), T0 + 60 * SECOND_MS);

        assert.equal(box.tracker.isExhausted('grok', T0 + 60 * SECOND_MS), false);
        assert.equal(box.tracker.availableAt('grok', T0 + 60 * SECOND_MS), null);
        // Auto-clear sticks — a later look-back does not resurrect it.
        assert.equal(box.tracker.isExhausted('grok', T0), false);

        assert.equal(box.tracker.isExhausted('never-seen'), false);
        assert.equal(box.tracker.availableAt('never-seen'), null);
    } finally { box.cleanup(); }
});

test('a successful record() clears a standing exhaustion', () => {
    const box = makeTracker();
    try {
        box.tracker.markExhausted({ providerId: 'grok', headers: { 'retry-after': '3600' }, at: T0 });
        assert.equal(box.tracker.isExhausted('grok', T0), true);
        box.tracker.record({ providerId: 'grok', tokens: 1, at: T0 + 1000 });
        assert.equal(box.tracker.isExhausted('grok', T0 + 1000), false);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  rank / pick / pickWithReason
// ===========================================================================

test('rank and pick prefer remaining headroom; unconfigured scores UNKNOWN_SCORE (0.5)', () => {
    const box = makeTracker({
        limits: {
            'claude-code': { session: { tokens: 1000 } },
            'grok': { session: { tokens: 1000 } },
            'codex': { session: { tokens: 1000 } },
        },
    });
    try {
        const qt = box.tracker;
        qt.record({ providerId: 'claude-code', tokens: 10 });   // remaining 990 → score 0.99
        qt.record({ providerId: 'grok', tokens: 980 });          // remaining 20  → score 0.02
        qt.markExhausted({ providerId: 'codex', headers: { 'retry-after': '3600' }, at: T0 });

        const ranked = qt.rank(['codex', 'grok', 'unknown-provider', 'claude-code']);
        assert.equal(ranked.map((r) => r.providerId).join(','), 'claude-code,unknown-provider,grok,codex');

        assert.equal(ranked[0].exhausted, false);
        assert.ok(ranked[0].score > 0.9);

        assert.equal(ranked[1].providerId, 'unknown-provider');
        assert.equal(ranked[1].score, UNKNOWN_SCORE);
        assert.equal(ranked[1].scoreKnown, false);
        assertNullCaps(ranked[1].headroom.session);

        assert.ok(ranked[2].score < UNKNOWN_SCORE, 'nearly exhausted must rank below unknown');
        assert.equal(ranked[2].scoreKnown, true);

        assert.equal(ranked[3].exhausted, true);
        assert.equal(ranked[3].providerId, 'codex');

        const picked = qt.pick(['codex', 'grok', 'claude-code']);
        assert.equal(picked.providerId, 'claude-code');
        assert.equal(picked.exhausted, false);
    } finally { box.cleanup(); }
});

test('fresh configured target outranks UNKNOWN_SCORE, which outranks nearly exhausted', () => {
    const box = makeTracker({
        limits: {
            'fresh': { session: { tokens: 1000 } },
            'low': { session: { tokens: 1000 } },
        },
    });
    try {
        box.tracker.record({ providerId: 'low', tokens: 990 }); // remaining 10 → 0.01
        const ranked = box.tracker.rank(['low', 'mystery', 'fresh']);
        assert.equal(ranked[0].providerId, 'fresh');
        assert.equal(ranked[0].score, 1);
        assert.equal(ranked[1].providerId, 'mystery');
        assert.equal(ranked[1].score, UNKNOWN_SCORE);
        assert.equal(ranked[2].providerId, 'low');
        assert.ok(ranked[2].score < UNKNOWN_SCORE);
        assert.equal(ranked[2].score, 0.01);
    } finally { box.cleanup(); }
});

test('pickWithReason explains why when every target is exhausted (soonest availableAt)', () => {
    const box = makeTracker();
    try {
        box.tracker.markExhausted({ providerId: 'slow', headers: { 'retry-after': '120' }, at: T0 });
        box.tracker.markExhausted({ providerId: 'fast', headers: { 'retry-after': '30' }, at: T0 });

        const reason = box.tracker.pickWithReason(['slow', 'fast']);
        assert.equal(reason.target, null);
        assert.equal(reason.allExhausted, true);
        assert.equal(reason.availableAt, T0 + 30 * SECOND_MS);
        assert.equal(reason.soonest.providerId, 'fast');
        assert.equal(reason.soonest.availableAt, T0 + 30 * SECOND_MS);
        assert.equal(reason.ranked.length, 2);

        assert.equal(box.tracker.pick(['slow', 'fast']), null);

        const mixed = box.tracker.pickWithReason(['slow', 'open']);
        assert.equal(mixed.allExhausted, false);
        assert.equal(mixed.availableAt, null);
        assert.equal(mixed.soonest, null);
        assert.equal(mixed.target.providerId, 'open');
    } finally { box.cleanup(); }
});

// ===========================================================================
//  reset / clearExhaustion
// ===========================================================================

test('clearExhaustion drops the ban but keeps usage; reset forgets both', () => {
    const box = makeTracker({
        limits: { 'claude-code': { session: { tokens: 1000 } } },
    });
    try {
        const qt = box.tracker;
        qt.record({ providerId: 'claude-code', tokens: 50, requests: 2 });
        qt.markExhausted({ providerId: 'claude-code', text: 'rate limited', at: T0 });
        assert.equal(qt.isExhausted('claude-code'), true);

        assert.equal(qt.clearExhaustion('claude-code'), true);
        assert.equal(qt.isExhausted('claude-code'), false);
        assert.equal(qt.headroom('claude-code').session.used, 50, 'usage counters must survive clearExhaustion');
        assert.equal(qt.headroom('claude-code').session.remaining, 950);
        assert.equal(qt.clearExhaustion('claude-code'), false);
        assert.equal(qt.clearExhaustion('never-seen'), false);

        assert.equal(qt.reset('claude-code'), true);
        const after = qt.headroom('claude-code');
        assert.equal(after.session.used, 0);
        assert.equal(after.session.requests, 0);
        assert.equal(after.session.startedAt, null);
        assert.equal(after.session.remaining, 1000);
        assert.equal(qt.isExhausted('claude-code'), false);

        const report = qt.report();
        assert.equal(report.exhaustedCount, 0);
        assert.equal(report.targets[0].totals.tokens, 0);
    } finally { box.cleanup(); }
});

test('report lists targets honestly and save flushes JSON under the temp dir', () => {
    const box = makeTracker({
        limits: { 'grok': { session: { tokens: 500 } } },
    });
    try {
        box.tracker.record({ providerId: 'grok', tokens: 20 });
        box.tracker.markExhausted({ providerId: 'codex', text: 'weekly cap', at: T0 });
        const report = box.tracker.report();
        assert.equal(report.persistence, 'json');
        assert.equal(report.now, T0);
        assert.equal(report.limitsConfigured, true);
        assert.equal(report.targetCount, 2);
        assert.equal(report.exhaustedCount, 1);
        assert.equal(report.soonestAvailableAt, T0 + HOUR_MS);
        assert.equal(report.defaultBackoffMs, HOUR_MS);
        assert.deepEqual(QuotaTracker.WINDOWS, ['session', 'day', 'week']);

        const grok = report.targets.find((t) => t.providerId === 'grok');
        assert.equal(grok.headroom.session.used, 20);
        assert.equal(grok.headroom.session.remaining, 480);
        const codex = report.targets.find((t) => t.providerId === 'codex');
        assert.equal(codex.headroom.session.remaining, null);
        assert.equal(codex.assumedReset, true);

        assert.equal(box.tracker.save(), true);
        assert.equal(fs.existsSync(path.join(box.dir, 'store', 'quota.json')), true);
    } finally { box.cleanup(); }
});
