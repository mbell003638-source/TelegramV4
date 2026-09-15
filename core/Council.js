// =============================================================================
//  core/Council.js — Honest multi-agent council ("counselling with all models")
//
//  Pose one question to several agents, collect their REAL positions, then
//  synthesise a conclusion out of what they actually said.
//
//  THE INVARIANT — every word this module attributes to an agent came off that
//  agent's own transport, in this process, during this call. There are no
//  canned lines, no "plausible" filler, no domain fallbacks and no roster of
//  invented voices anywhere in this file. An agent that errors, times out or
//  answers with nothing gets `ok: false` plus the real error, is quoted
//  nowhere, and is excluded from the synthesis — its failure never aborts the
//  round and is never papered over.
//
//  The guard is mechanical, not a promise: every raw transport return is
//  recorded in a ledger, verifyAttribution() re-checks each agent-attributed
//  string in a result against that ledger, and the mechanical synthesis is
//  re-rendered and compared byte for byte so its only agent content is
//  verbatim quotes. Anything the Council says in its own voice is prefixed
//  `[Council]` so it can never be mistaken for an agent speaking.
//
//  Transports, tried in this order — all three already live in this codebase:
//    1. agent.sendMessage() + EventBus turn collection   (core/TaskPlanner.js)
//    2. agent.execute(prompt, sessionId)                 (core/MissionControl.js)
//    3. actionExecutor._enqueue() + synthetic reply ctx  (core/Scheduler.js)
//
//  Gated by the WARROOM_TEXT_ENABLED kill switch. Node builtins only.
// =============================================================================

const COUNCIL_EVENT_KEY = 'council';
const COUNCIL_SWITCH = 'WARROOM_TEXT_ENABLED';
const DEFAULT_CHAT_ID = 'war_room';
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_ROUNDS = 1;
const MAX_ROUNDS = 5;
const DEFAULT_TIMEOUT_MS = Number(process.env.COUNCIL_AGENT_TIMEOUT_MS) || 120000;
const DEFAULT_POLL_MS = Number(process.env.COUNCIL_POLL_MS) || 150;
const DEFAULT_SYNTHESIS_MODEL =
    process.env.COUNCIL_SYNTHESIS_MODEL || process.env.TASK_PLANNER_MODEL || 'gpt-4o-mini';

/** Quotes are trimmed only inside PROMPTS — never in the rendered output. */
const MAX_PROMPT_QUOTE_CHARS = 4000;
/** Per-agent ledger bound, so a long-lived Council cannot grow without limit. */
const LEDGER_LIMIT = 500;

/**
 * Stable display order for the real agent keys this project ships
 * (mirrors AGENT_ENV_MAP in core/AgentOverrides.js). It ONLY orders keys that
 * are actually present in the injected registry — it never invents a member.
 */
const PREFERRED_ORDER = Object.freeze([
    'claude', 'codex', 'grok', 'antigravity', 'hermes', 'pi', 'opencode', 'openclaw',
]);

const MECHANICAL_HEADER =
    '[Council] No model was available to synthesise this deliberation. What follows is a '
    + 'mechanical summary assembled by core/Council.js from the agents\' own words, quoted '
    + 'verbatim. Nothing here was written by a model.';

const MECHANICAL_FOOTER =
    '[Council] Those are the individual positions exactly as given. No consensus was reached, '
    + 'computed or implied by this summary.';

const EMPTY_SYNTHESIS_TEXT =
    '[Council] No agent returned a usable position, so there is nothing to synthesise. '
    + 'See the per-agent errors for why each one was not heard.';

const STANDUP_PROMPT =
    'Standup roll call. Report your own current status in two or three sentences: what you are '
    + 'working on, what you have finished since the last standup, and anything blocking you. '
    + 'Report only what is actually true of you right now — if you do not know something, say so '
    + 'plainly instead of guessing.';

function asText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.output === 'string') return value.output;
        if (typeof value.response === 'string') return value.response;
        try { return JSON.stringify(value); } catch (err) { return String(value); }
    }
    return String(value);
}

/** Pull assistant text out of an OpenAI-shaped chat completion payload. */
function messageText(data) {
    if (!data || typeof data !== 'object') return '';
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
        if (choice.message && choice.message.content != null) return asText(choice.message.content);
        if (choice.text != null) return asText(choice.text);
        if (choice.delta && choice.delta.content != null) return asText(choice.delta.content);
    }
    if (data.content != null) return asText(data.content);
    if (typeof data.output_text === 'string') return data.output_text;
    return '';
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Positions are handed out as copies so a caller cannot mutate the round's view. */
function clonePosition(position) {
    return { ...position };
}

class Council {
    /**
     * @param {object} [opts]
     * @param {object} [opts.agents]          registry keyed by real agent id (see index.js)
     * @param {object} [opts.actionExecutor]  core/ActionExecutor — third transport
     * @param {object} [opts.router]          core/ProviderRouter — synthesis only
     * @param {object} [opts.database]        AssistantDatabase — transcript journal
     * @param {object} [opts.killSwitches]    core/KillSwitches — WARROOM_TEXT_ENABLED
     * @param {object} [opts.eventBus]        channelEventBus — agent turns + progress
     * @param {number} [opts.concurrency]     default parallel asks (3)
     * @param {number} [opts.timeoutMs]       default per-agent timeout
     * @param {string} [opts.chatId]          chat id used for journalling/dispatch
     * @param {string} [opts.synthesisModel]  model slug for synthesize()
     */
    constructor({
        agents, actionExecutor, router, database, killSwitches, eventBus,
        concurrency, timeoutMs, chatId, synthesisModel, pollMs,
    } = {}) {
        this.agents = agents && typeof agents === 'object' ? agents : {};
        this.actionExecutor = actionExecutor || null;
        this.router = router || null;
        this.database = database || null;
        this.killSwitches = killSwitches || null;
        this.eventBus = eventBus || null;
        this.defaultConcurrency = positiveInt(concurrency, DEFAULT_CONCURRENCY);
        this.defaultTimeoutMs = positiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
        this.chatId = String(chatId || DEFAULT_CHAT_ID);
        this.synthesisModel = synthesisModel || DEFAULT_SYNTHESIS_MODEL;
        this.pollMs = positiveInt(pollMs, DEFAULT_POLL_MS);

        /** agentKey -> Set<verbatim text the transport returned>. The guard's source of truth. */
        this._spoken = new Map();
        this._seq = 0;
    }

    // =========================================================================
    //  Roster
    // =========================================================================

    /**
     * Resolve the participant list to real agent keys.
     * With no request, the whole injected registry sits on the council, ordered
     * by PREFERRED_ORDER. A requested key that is NOT in the registry is kept
     * so it can be reported as a failure — silently dropping it would hide that
     * the caller asked for a member who was never there.
     * @returns {string[]}
     */
    resolveParticipants(requested) {
        const registry = this.agents && typeof this.agents === 'object' ? this.agents : {};
        const keys = Object.keys(registry);

        if (Array.isArray(requested) && requested.length) {
            const seen = new Set();
            const out = [];
            for (const raw of requested) {
                let key = '';
                if (typeof raw === 'string') key = raw.trim();
                else if (raw && typeof raw === 'object') key = String(raw.agentKey || raw.key || raw.id || '').trim();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(key);
            }
            return out;
        }

        const preferred = PREFERRED_ORDER.filter(key => keys.includes(key));
        const extra = keys.filter(key => !PREFERRED_ORDER.includes(key));
        return [...preferred, ...extra];
    }

    agentName(agentKey) {
        const agent = this.agents ? this.agents[agentKey] : null;
        return (agent && typeof agent.name === 'string' && agent.name) || String(agentKey);
    }

    // =========================================================================
    //  Deliberation
    // =========================================================================

    /**
     * Ask every participant the same question in parallel, optionally over
     * several rounds, then synthesise only the positions that came back.
     *
     * Never throws: a refusal (kill switch off, blank question, empty council)
     * and a partial round both come back in the normal result shape.
     *
     * @param {string} question
     * @param {object} [opts]
     * @param {string[]} [opts.participants] agent keys (default: whole registry)
     * @param {number}   [opts.rounds]       deliberation rounds (default 1, max 5)
     * @param {number}   [opts.concurrency]  parallel asks (default 3)
     * @param {number}   [opts.timeoutMs]    per-agent timeout
     * @param {function} [opts.onProgress]   progress callback
     * @returns {Promise<{ok, blocked, error, question, positions, synthesis,
     *                    participants, errored, transcript, requestId, stats}>}
     */
    async deliberate(question, opts = {}) {
        const {
            participants: requested, rounds: requestedRounds, concurrency: requestedConcurrency,
            timeoutMs: requestedTimeout, onProgress, signal,
        } = opts || {};

        const requestId = opts.requestId || this._nextRequestId('council');
        const chatId = String(opts.chatId || this.chatId);
        const text = typeof question === 'string' ? question.trim() : asText(question).trim();
        const rounds = Math.min(MAX_ROUNDS, positiveInt(requestedRounds, DEFAULT_ROUNDS));
        const concurrency = positiveInt(requestedConcurrency, this.defaultConcurrency);
        const timeoutMs = positiveInt(requestedTimeout, this.defaultTimeoutMs);
        const startedAt = Date.now();

        if (!text) {
            return this._refusal({
                question: '', requestId, concurrency,
                error: 'A council needs a question: the question was empty or whitespace only.',
            });
        }
        if (!this._switchEnabled()) {
            this._emit({ phase: 'deliberate', status: 'blocked', requestId }, onProgress);
            return this._refusal({
                question: text, requestId, concurrency, blocked: true,
                error: `Council deliberation blocked: the ${COUNCIL_SWITCH} kill switch is off.`,
            });
        }

        const participants = this.resolveParticipants(requested);
        if (!participants.length) {
            return this._refusal({
                question: text, requestId, concurrency,
                error: 'No council participants: the agent registry is empty and none were requested.',
            });
        }

        this._emit({
            phase: 'deliberate', status: 'started', requestId,
            question: text.slice(0, 200), participants, rounds, concurrency,
        }, onProgress);

        const transcript = [];
        let latest = [];
        let peakConcurrency = 0;
        let asked = 0;

        for (let round = 1; round <= rounds; round += 1) {
            const priors = latest.filter(p => p.ok);
            this._emit({
                phase: 'round', status: 'started', requestId, round, rounds,
                participants, priorPositions: priors.length,
            }, onProgress);

            const pool = await this._runPool(participants, concurrency, async (agentKey) => {
                this._emit({ phase: 'ask', status: 'started', requestId, round, agentKey }, onProgress);
                const prompt = this._positionPrompt(text, agentKey, round, rounds, priors);
                const position = await this._askAgent(agentKey, prompt, {
                    requestId: `${requestId}:r${round}`, chatId, timeoutMs, signal,
                });
                position.round = round;
                this._emit({
                    phase: 'ask', status: position.ok ? 'ok' : 'failed', requestId, round,
                    agentKey, ms: position.ms, error: position.error, timedOut: position.timedOut,
                }, onProgress);
                return position;
            });

            asked += participants.length;
            peakConcurrency = Math.max(peakConcurrency, pool.peak);
            latest = pool.results;
            transcript.push({ round, positions: pool.results.map(clonePosition) });

            this._emit({
                phase: 'round', status: 'ok', requestId, round, rounds,
                heard: pool.results.filter(p => p.ok).length,
                failed: pool.results.filter(p => !p.ok).length,
            }, onProgress);
        }

        // The last round is each agent's current position: a member who spoke in
        // round 1 and then dropped out is reported as having dropped out, not
        // quoted from a stale round. The transcript keeps the earlier words.
        const positions = latest.map(clonePosition);
        const errored = positions
            .filter(p => !p.ok)
            .map(p => ({ agentKey: p.agentKey, name: p.name, error: p.error, timedOut: p.timedOut }));

        const synthesis = await this.synthesize(text, positions, {
            requestId, onProgress, signal, model: opts.model,
        });

        const result = {
            ok: true,
            blocked: false,
            error: null,
            question: text,
            positions,
            synthesis,
            participants,
            errored,
            transcript,
            requestId,
            stats: {
                rounds,
                asked,
                heard: positions.filter(p => p.ok).length,
                failed: errored.length,
                concurrency,
                peakConcurrency,
                ms: Date.now() - startedAt,
            },
        };

        this._journal('council_deliberation', chatId, result);
        this._emit({
            phase: 'deliberate', status: 'ok', requestId,
            heard: result.stats.heard, failed: result.stats.failed,
            synthesizedBy: synthesis.synthesizedBy,
        }, onProgress);
        this._emitFinished(synthesis.text, requestId);
        return result;
    }

    /**
     * Merge ONLY the successful positions into one conclusion.
     *
     * With a router, one model writes the conclusion from the quoted positions.
     * Without one (or when the call fails), the fallback is a mechanical
     * summary that quotes each agent verbatim and says in its own first line
     * that no model synthesised it. Neither path ever asserts a consensus the
     * agents did not state themselves.
     *
     * @returns {Promise<{text, fallback, empty, synthesizedBy, model, providerId,
     *                    usage, quotes, missing, note}>}
     */
    async synthesize(question, positions, opts = {}) {
        const list = Array.isArray(positions) ? positions : [];
        const q = typeof question === 'string' ? question.trim() : asText(question).trim();

        const heard = list.filter(p => p && p.ok === true && typeof p.text === 'string' && p.text.trim());
        const quotes = heard.map(p => ({
            agentKey: p.agentKey,
            name: p.name || this.agentName(p.agentKey),
            text: p.text,
        }));
        const missing = list
            .filter(p => p && !(p.ok === true && typeof p.text === 'string' && p.text.trim()))
            .map(p => ({
                agentKey: p.agentKey,
                name: p.name || this.agentName(p.agentKey),
                error: p.error || 'no position returned',
            }));

        if (!quotes.length) {
            return {
                text: EMPTY_SYNTHESIS_TEXT,
                fallback: true, empty: true, synthesizedBy: null, model: null,
                providerId: null, usage: null, quotes: [], missing,
                note: 'No model synthesised this: no agent produced a position.',
            };
        }

        if (this.router && typeof this.router.chatCompletion === 'function') {
            const model = opts.model || this.synthesisModel;
            try {
                const result = await this.router.chatCompletion({
                    model,
                    messages: [
                        { role: 'system', content: this._synthesisSystemPrompt() },
                        { role: 'user', content: this._synthesisUserPrompt(q, quotes, missing) },
                    ],
                }, { signal: opts.signal });
                const answer = messageText(result && result.data).trim();
                if (answer) {
                    return {
                        text: answer,
                        fallback: false,
                        empty: false,
                        synthesizedBy: 'router',
                        model: (result && result.model) || model,
                        providerId: (result && result.providerId) || null,
                        usage: (result && result.usage) || null,
                        quotes,
                        missing,
                        note: null,
                    };
                }
                console.warn('[Council] Router returned an empty synthesis; using the mechanical summary.');
            } catch (err) {
                console.warn('[Council] Router synthesis failed:', (err && err.message) || err);
            }
        }

        return {
            text: Council.renderMechanicalSynthesis(q, quotes, missing),
            fallback: true,
            empty: false,
            synthesizedBy: null,
            model: null,
            providerId: null,
            usage: null,
            quotes,
            missing,
            note: 'No model synthesised this: the positions below are quoted verbatim, unmerged.',
        };
    }

    /**
     * Deterministic, quote-only summary. Kept static and pure so
     * verifyAttribution() can re-render it and compare byte for byte — that
     * comparison is what proves the fallback added no agent speech of its own.
     */
    static renderMechanicalSynthesis(question, quotes, missing = []) {
        const lines = [MECHANICAL_HEADER, ''];
        const q = String(question == null ? '' : question).trim();
        if (q) lines.push(`Question: ${q}`, '');

        for (const quote of Array.isArray(quotes) ? quotes : []) {
            const name = (quote && quote.name) || (quote && quote.agentKey) || 'unknown agent';
            lines.push(`${name} (${(quote && quote.agentKey) || 'unknown'}) said, verbatim:`);
            lines.push(String((quote && quote.text) || ''));
            lines.push('');
        }

        const absent = Array.isArray(missing) ? missing : [];
        if (absent.length) {
            const rendered = absent
                .map(m => `${(m && (m.name || m.agentKey)) || 'unknown'} (${(m && m.error) || 'unreachable'})`)
                .join('; ');
            lines.push(`[Council] Not heard from: ${rendered}.`, '');
        }

        lines.push(MECHANICAL_FOOTER);
        return lines.join('\n').trim();
    }

    // =========================================================================
    //  Standup
    // =========================================================================

    /**
     * Roll call: each agent reports its OWN status, in its own words. An agent
     * that cannot be reached gets a `[Council]`-prefixed line saying exactly
     * that, plus the real error — never a stand-in status.
     *
     * `observed` is process telemetry read off the agent object (status flags),
     * not speech, and is labelled separately for that reason.
     *
     * @returns {Promise<{ok, blocked, error, timestamp, participants, reports,
     *                    errored, requestId, stats}>}
     */
    async standup(opts = {}) {
        const {
            participants: requested, concurrency: requestedConcurrency,
            timeoutMs: requestedTimeout, onProgress, signal,
        } = opts || {};

        const requestId = opts.requestId || this._nextRequestId('standup');
        const chatId = String(opts.chatId || this.chatId);
        const concurrency = positiveInt(requestedConcurrency, this.defaultConcurrency);
        const timeoutMs = positiveInt(requestedTimeout, this.defaultTimeoutMs);
        const startedAt = Date.now();

        if (!this._switchEnabled()) {
            this._emit({ phase: 'standup', status: 'blocked', requestId }, onProgress);
            return {
                ok: false,
                blocked: true,
                error: `Council standup blocked: the ${COUNCIL_SWITCH} kill switch is off.`,
                timestamp: Date.now(),
                participants: [],
                reports: [],
                errored: [],
                requestId,
                stats: { asked: 0, heard: 0, failed: 0, concurrency, peakConcurrency: 0, ms: 0 },
            };
        }

        const participants = this.resolveParticipants(requested);
        this._emit({ phase: 'standup', status: 'started', requestId, participants }, onProgress);

        const pool = await this._runPool(participants, concurrency, async (agentKey) => {
            this._emit({ phase: 'report', status: 'started', requestId, agentKey }, onProgress);
            const answer = await this._askAgent(agentKey, STANDUP_PROMPT, {
                requestId, chatId, timeoutMs, signal,
            });
            const report = {
                ...answer,
                observed: this._observe(agentKey),
                // The only line the Council writes itself here, and it says so.
                line: answer.ok ? answer.text : `[Council] ${answer.name} could not be reached: ${answer.error}`,
            };
            this._emit({
                phase: 'report', status: report.ok ? 'ok' : 'failed', requestId,
                agentKey, ms: report.ms, error: report.error, timedOut: report.timedOut,
            }, onProgress);
            return report;
        });

        const reports = pool.results;
        const errored = reports
            .filter(r => !r.ok)
            .map(r => ({ agentKey: r.agentKey, name: r.name, error: r.error, timedOut: r.timedOut }));

        const result = {
            ok: true,
            blocked: false,
            error: null,
            timestamp: Date.now(),
            participants,
            reports,
            errored,
            requestId,
            stats: {
                asked: participants.length,
                heard: reports.filter(r => r.ok).length,
                failed: errored.length,
                concurrency,
                peakConcurrency: pool.peak,
                ms: Date.now() - startedAt,
            },
        };

        this._journal('council_standup', chatId, result);
        this._emit({
            phase: 'standup', status: 'ok', requestId,
            heard: result.stats.heard, failed: result.stats.failed,
        }, onProgress);
        return result;
    }

    // =========================================================================
    //  Fabrication guard
    // =========================================================================

    /**
     * Re-check a result against the ledger of raw transport returns.
     *
     * Verifies that (a) every string presented as an agent's words is one this
     * process actually received from that agent, (b) a failed position/report
     * carries no text at all, (c) a Council-written line is `[Council]`-marked,
     * (d) nobody in `errored` is quoted in the synthesis, and (e) a mechanical
     * synthesis is exactly a verbatim re-render of its own quotes — so the
     * fallback cannot have slipped prose in between them.
     *
     * @returns {{ok: boolean, checked: number, violations: object[]}}
     */
    verifyAttribution(result) {
        const violations = [];
        let checked = 0;

        if (!result || typeof result !== 'object') {
            return { ok: false, checked: 0, violations: [{ where: 'result', reason: 'not an object' }] };
        }

        const checkSpoken = (where, agentKey, text) => {
            checked += 1;
            if (!this._spoke(agentKey, text)) {
                violations.push({
                    where, agentKey, reason: 'not in the transport ledger for this agent',
                    text: String(text == null ? '' : text).slice(0, 200),
                });
            }
        };

        const scan = (entries, where) => {
            for (const entry of Array.isArray(entries) ? entries : []) {
                if (!entry || typeof entry !== 'object') continue;
                const at = `${where}[${entry.agentKey}]`;
                if (entry.ok === true) {
                    checkSpoken(at, entry.agentKey, entry.text);
                } else {
                    checked += 1;
                    if (String(entry.text == null ? '' : entry.text) !== '') {
                        violations.push({
                            where: at, agentKey: entry.agentKey,
                            reason: 'a failed agent carries text',
                            text: String(entry.text).slice(0, 200),
                        });
                    }
                    if (typeof entry.line === 'string' && !entry.line.startsWith('[Council] ')) {
                        violations.push({
                            where: `${at}.line`, agentKey: entry.agentKey,
                            reason: 'an unreachable agent\'s line is not marked as the Council speaking',
                            text: entry.line.slice(0, 200),
                        });
                    }
                }
            }
        };

        scan(result.positions, 'positions');
        scan(result.reports, 'reports');
        for (const round of Array.isArray(result.transcript) ? result.transcript : []) {
            scan(round && round.positions, `transcript.round${round && round.round}`);
        }

        const synthesis = result.synthesis;
        if (synthesis && typeof synthesis === 'object') {
            const failedKeys = new Set((Array.isArray(result.errored) ? result.errored : [])
                .map(e => e && e.agentKey));
            for (const quote of Array.isArray(synthesis.quotes) ? synthesis.quotes : []) {
                checkSpoken('synthesis.quotes', quote && quote.agentKey, quote && quote.text);
                checked += 1;
                if (failedKeys.has(quote && quote.agentKey)) {
                    violations.push({
                        where: 'synthesis.quotes', agentKey: quote && quote.agentKey,
                        reason: 'a failed agent was quoted in the synthesis',
                    });
                }
            }
            if (synthesis.fallback === true && synthesis.empty !== true) {
                checked += 1;
                const expected = Council.renderMechanicalSynthesis(
                    result.question || '', synthesis.quotes || [], synthesis.missing || [],
                );
                if (String(synthesis.text) !== expected) {
                    violations.push({
                        where: 'synthesis.text',
                        reason: 'the mechanical summary is not a verbatim re-render of its own quotes',
                    });
                }
            }
        }

        return { ok: violations.length === 0, checked, violations };
    }

    /** Everything this process has actually heard from `agentKey`, verbatim. */
    utterancesOf(agentKey) {
        const set = this._spoken.get(agentKey);
        return set ? Array.from(set) : [];
    }

    _remember(agentKey, text) {
        if (!agentKey || typeof text !== 'string' || !text) return;
        let set = this._spoken.get(agentKey);
        if (!set) {
            set = new Set();
            this._spoken.set(agentKey, set);
        }
        set.add(text);
        while (set.size > LEDGER_LIMIT) {
            const oldest = set.values().next();
            if (oldest.done) break;
            set.delete(oldest.value);
        }
    }

    _spoke(agentKey, text) {
        const set = this._spoken.get(agentKey);
        return Boolean(set && typeof text === 'string' && set.has(text));
    }

    // =========================================================================
    //  Transports — how the Council actually reaches an agent
    // =========================================================================

    /**
     * Ask one agent one question. Resolves to a position; never throws and
     * never invents text: an empty answer is a failure, not an opening.
     * @returns {Promise<{agentKey, name, ok, text, error, ms, via, timedOut}>}
     */
    async _askAgent(agentKey, prompt, opts = {}) {
        const startedAt = Date.now();
        const name = this.agentName(agentKey);
        const timeoutMs = positiveInt(opts.timeoutMs, this.defaultTimeoutMs);
        const agent = this.agents ? this.agents[agentKey] : null;
        const fail = (error, via, timedOut) => ({
            agentKey, name, ok: false, text: '', error, ms: Date.now() - startedAt,
            via: via || null, timedOut: Boolean(timedOut),
        });

        if (!agent) {
            const error = `unknown agent "${agentKey}": not present in the injected agent registry`;
            console.warn(`[Council] ${error}`);
            return fail(error, null, false);
        }

        let via = null;
        try {
            let raw;
            if (typeof agent.sendMessage === 'function' && this.eventBus && typeof this.eventBus.on === 'function') {
                via = 'sendMessage';
                raw = await this._withTimeout(this._askViaEventBus(agentKey, agent, prompt, opts), timeoutMs, agentKey);
            } else if (typeof agent.execute === 'function') {
                via = 'execute';
                raw = await this._withTimeout(
                    Promise.resolve().then(() => agent.execute(prompt, `council_${opts.requestId || this._nextRequestId('turn')}`)),
                    timeoutMs, agentKey,
                );
            } else if (this.actionExecutor && typeof this.actionExecutor._enqueue === 'function') {
                via = 'actionExecutor';
                raw = await this._withTimeout(this._askViaActionExecutor(agentKey, prompt, opts), timeoutMs, agentKey);
            } else {
                throw new Error(
                    `agent "${agentKey}" is not reachable: it exposes neither sendMessage() nor execute(), `
                    + 'and no actionExecutor was injected',
                );
            }

            const text = asText(raw).trim();
            if (!text) {
                // Silence is silence. Reported as such, never filled in.
                return fail(`agent "${agentKey}" returned an empty response via ${via}`, via, false);
            }

            this._remember(agentKey, text);
            return { agentKey, name, ok: true, text, error: null, ms: Date.now() - startedAt, via, timedOut: false };
        } catch (err) {
            const message = String((err && err.message) || err || 'agent call failed');
            console.warn(`[Council] ${agentKey} did not answer: ${message}`);
            return fail(message, via, Boolean(err && err.councilTimeout));
        }
    }

    /**
     * Transport #1 — drive a live CLI agent for one turn and collect its output
     * off the EventBus. The same mechanism core/TaskPlanner.js uses.
     */
    _askViaEventBus(agentKey, agent, prompt, opts = {}) {
        const bus = this.eventBus;
        const turnId = `${opts.requestId || this._nextRequestId('turn')}:${agentKey}`;
        const chatId = String(opts.chatId || this.chatId);

        return new Promise((resolve, reject) => {
            let chunks = '';
            let done = false;

            const onMessage = (evt) => {
                if (!evt || evt.agentKey !== agentKey || evt.requestId !== turnId) return;
                if (typeof evt.text === 'string') chunks += evt.text;
            };
            const onFinished = (evt) => {
                if (!evt || evt.agentKey !== agentKey || evt.requestId !== turnId) return;
                finish(null, evt.finalText || chunks);
            };
            const onError = (evt) => {
                if (!evt || evt.agentKey !== agentKey || evt.requestId !== turnId) return;
                finish(new Error(String((evt.error && evt.error.message) || evt.error || 'agent error')));
            };

            function finish(err, text) {
                if (done) return;
                done = true;
                try {
                    bus.off('channel.agent.message', onMessage);
                    bus.off('channel.agent.finished', onFinished);
                    bus.off('channel.agent.error', onError);
                } catch (offErr) { /* listener cleanup is best-effort */ }
                if (err) reject(err);
                else resolve(String(text || ''));
            }

            bus.on('channel.agent.message', onMessage);
            bus.on('channel.agent.finished', onFinished);
            bus.on('channel.agent.error', onError);

            Promise.resolve()
                .then(() => (typeof agent.ensureRunning === 'function' ? agent.ensureRunning() : null))
                .then(() => {
                    if (typeof agent.setRequestContext === 'function') agent.setRequestContext(turnId);
                    return agent.sendMessage({
                        id: turnId,
                        platform: 'council',
                        chatId,
                        user: { id: 'council', displayName: 'Council' },
                        content: { type: 'text', text: prompt, attachments: [] },
                        timestamp: Date.now(),
                    });
                })
                .catch(err => finish(err instanceof Error ? err : new Error(String(err))));
        });
    }

    /**
     * Transport #3 — ActionExecutor has no request/response entry point, so the
     * answer is captured through a synthetic reply context and the chat is then
     * waited out. Same pattern as core/Scheduler.js `_dispatchViaActionExecutor`.
     * Each agent gets its own chat id so parallel asks never share a queue.
     */
    _askViaActionExecutor(agentKey, prompt, opts = {}) {
        const executor = this.actionExecutor;
        const chatId = `${String(opts.chatId || this.chatId)}:council:${agentKey}`;

        if (executor.agents && executor.agents[agentKey]
            && executor.sessionStore && typeof executor.sessionStore.setActiveAgent === 'function') {
            try {
                executor.sessionStore.setActiveAgent(agentKey, chatId);
            } catch (err) {
                console.warn(`[Council] Could not pin agent ${agentKey}: ${err.message}`);
            }
        }

        let captured = '';
        const capture = (text) => {
            const value = String(text || '');
            if (!value || value.includes('Thinking...') || value.includes('Queued for this chat')) return;
            captured = value;
        };
        const ack = async () => ({ message_id: Math.floor(Math.random() * 100000) });

        return Promise.resolve()
            .then(() => executor._enqueue({
                id: `council_${agentKey}_${Date.now()}`,
                platform: 'council',
                chatId,
                user: { id: 'council', username: 'Council' },
                content: { type: 'text', text: String(prompt || '') },
                raw: {
                    chat: { id: chatId },
                    sendChatAction: async () => {},
                    reply: async (text) => { capture(text); return ack(); },
                    replyWithAudio: async () => {},
                    telegram: {
                        editMessageText: async (_chat, _msgId, _inlineId, text) => { capture(text); },
                        deleteMessage: async () => {},
                        sendMessage: async (_chat, text) => { capture(text); return ack(); },
                    },
                },
            }))
            .then(() => this._awaitChatIdle(executor, chatId))
            .then(() => {
                const last = executor.lastResponses && typeof executor.lastResponses.get === 'function'
                    ? executor.lastResponses.get(chatId)
                    : '';
                return captured || last || '';
            });
    }

    _awaitChatIdle(executor, chatId) {
        const isIdle = () => {
            const active = executor.active && typeof executor.active.has === 'function' && executor.active.has(chatId);
            const queue = executor.queues && typeof executor.queues.get === 'function' ? executor.queues.get(chatId) : null;
            return !active && !(queue && queue.length > 0);
        };
        if (isIdle()) return Promise.resolve();
        return new Promise((resolve) => {
            const poll = setInterval(() => {
                if (!isIdle()) return;
                clearInterval(poll);
                resolve();
            }, this.pollMs);
            if (poll.unref) poll.unref();
        });
    }

    _withTimeout(promise, timeoutMs, agentKey) {
        const work = Promise.resolve(promise);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;

        let timer = null;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`agent "${agentKey}" timed out after ${timeoutMs} ms`);
                err.councilTimeout = true;
                reject(err);
            }, timeoutMs);
            if (timer.unref) timer.unref();
        });
        return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    }

    /** Process telemetry read off the agent object — observed, not spoken. */
    _observe(agentKey) {
        const agent = this.agents ? this.agents[agentKey] : null;
        if (!agent) return { present: false, status: null, isWarm: null, lastError: null };
        try {
            return {
                present: true,
                status: typeof agent.status === 'string' ? agent.status : null,
                isWarm: typeof agent.isWarm === 'boolean' ? agent.isWarm : null,
                lastError: agent.errorMessage || null,
            };
        } catch (err) {
            console.warn(`[Council] Could not read the status of ${agentKey}:`, err.message);
            return { present: true, status: null, isWarm: null, lastError: null };
        }
    }

    // =========================================================================
    //  Prompts
    // =========================================================================

    _positionPrompt(question, agentKey, round, rounds, priors) {
        const name = this.agentName(agentKey);
        const lines = [
            `You are ${name} (${agentKey}), one member of a multi-agent council.`,
            '',
            `The council has been asked: "${question}"`,
            '',
        ];

        if (round > 1) {
            const mine = (priors || []).find(p => p.agentKey === agentKey);
            const others = (priors || []).filter(p => p.agentKey !== agentKey);

            lines.push(`This is round ${round} of ${rounds}.`);
            if (mine) {
                lines.push('', 'Your own position in the previous round was:', this._quoteForPrompt(mine.text));
            }
            if (others.length) {
                lines.push('', 'The other members said this in the previous round, quoted verbatim:');
                for (const prior of others) {
                    lines.push(
                        '',
                        `--- ${prior.name || prior.agentKey} (${prior.agentKey}) ---`,
                        this._quoteForPrompt(prior.text),
                    );
                }
            } else {
                lines.push('', 'No other member produced a position in the previous round.');
            }
            lines.push(
                '',
                'Having read the above, give your position for this round: what you now think, what',
                'changed your mind if anything, and where you still disagree. Holding your previous',
                'position is a valid answer — say so if that is the case.',
            );
        } else {
            lines.push(
                'Give your own position in three to six sentences: what you actually think, the',
                'reasoning behind it, and where you are uncertain.',
            );
        }

        lines.push(
            '',
            'Speak only for yourself. Do not speak for the other members or invent what they would',
            'say. If you do not know something, say so plainly rather than guessing.',
        );
        return lines.join('\n');
    }

    _synthesisSystemPrompt() {
        return [
            'You are the council synthesiser. You are given the verbatim positions of several',
            'agents on one question. Merge them into a single conclusion.',
            '',
            'Rules, without exception:',
            '- Use only what the quoted positions actually say. Add no facts of your own.',
            '- Attribute a view only to the member who stated it, and quote accurately.',
            '- Where they disagree, say so and say how. Do not manufacture agreement.',
            '- If a member is listed as not heard from, do not guess what they would have said.',
            '- Finish with the conclusion the positions support, and note what is still unresolved.',
        ].join('\n');
    }

    _synthesisUserPrompt(question, quotes, missing) {
        const lines = [`Question put to the council: "${question}"`, '', 'Positions, verbatim:'];
        for (const quote of quotes) {
            lines.push('', `--- ${quote.name} (${quote.agentKey}) ---`, this._quoteForPrompt(quote.text));
        }
        if (missing && missing.length) {
            const rendered = missing.map(m => `${m.name || m.agentKey} (${m.error})`).join('; ');
            lines.push('', `Not heard from (do not guess their views): ${rendered}.`);
        }
        lines.push('', 'Write the synthesis now.');
        return lines.join('\n');
    }

    /** Prompt-side trimming only — the rendered output always keeps the full text. */
    _quoteForPrompt(text) {
        const value = String(text == null ? '' : text);
        if (value.length <= MAX_PROMPT_QUOTE_CHARS) return value;
        return `${value.slice(0, MAX_PROMPT_QUOTE_CHARS)}\n[...truncated for prompt length...]`;
    }

    // =========================================================================
    //  Plumbing
    // =========================================================================

    /**
     * Run `worker` over `items` with at most `concurrency` in flight.
     * Reports the true peak so a caller (and the tests) can verify the cap.
     */
    async _runPool(items, concurrency, worker) {
        const list = Array.isArray(items) ? items : [];
        const results = new Array(list.length);
        if (!list.length) return { results, peak: 0 };

        const limit = Math.max(1, Math.min(list.length, positiveInt(concurrency, DEFAULT_CONCURRENCY)));
        let next = 0;
        let inFlight = 0;
        let peak = 0;

        const drain = async () => {
            while (next < list.length) {
                const index = next;
                next += 1;
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                try {
                    results[index] = await worker(list[index], index);
                } catch (err) {
                    // A worker absorbs its own failures; this is the last net so
                    // one bad member can never abort the round.
                    const message = String((err && err.message) || err || 'council worker failed');
                    console.warn(`[Council] Worker for ${list[index]} threw: ${message}`);
                    results[index] = {
                        agentKey: list[index], name: this.agentName(list[index]),
                        ok: false, text: '', error: message, ms: 0, via: null, timedOut: false,
                    };
                } finally {
                    inFlight -= 1;
                }
            }
        };

        const workers = [];
        for (let i = 0; i < limit; i += 1) workers.push(drain());
        await Promise.all(workers);
        return { results, peak };
    }

    _switchEnabled() {
        const switches = this.killSwitches;
        if (!switches || typeof switches.isEnabled !== 'function') return true;
        try {
            return switches.isEnabled(COUNCIL_SWITCH) !== false;
        } catch (err) {
            console.warn(`[Council] Could not read the ${COUNCIL_SWITCH} switch:`, err.message);
            return true;
        }
    }

    _refusal({ question, requestId, concurrency, error, blocked = false }) {
        return {
            ok: false,
            blocked,
            error,
            question: question || '',
            positions: [],
            synthesis: null,
            participants: [],
            errored: [],
            transcript: [],
            requestId,
            stats: {
                rounds: 0, asked: 0, heard: 0, failed: 0,
                concurrency: concurrency || 0, peakConcurrency: 0, ms: 0,
            },
        };
    }

    _journal(action, chatId, result) {
        if (!this.database || typeof this.database.recordHiveMind !== 'function') return;
        try {
            const summary = action === 'council_standup'
                ? `Standup: ${result.stats.heard}/${result.stats.asked} agent(s) reported`
                : `Deliberation on "${String(result.question).slice(0, 160)}": `
                    + `${result.stats.heard}/${result.participants.length} position(s) over `
                    + `${result.stats.rounds} round(s), synthesised by `
                    + `${(result.synthesis && result.synthesis.synthesizedBy) || 'no model (mechanical summary)'}`;

            this.database.recordHiveMind(
                COUNCIL_EVENT_KEY,
                String(chatId || DEFAULT_CHAT_ID),
                action,
                summary,
                JSON.stringify(result),
            );
        } catch (err) {
            console.warn('[Council] Could not persist the transcript:', err.message);
        }
    }

    _emit(event, onProgress) {
        if (typeof onProgress === 'function') {
            try {
                onProgress(event);
            } catch (err) {
                console.warn('[Council] onProgress handler threw:', err.message);
            }
        }
        if (!this.eventBus) return;
        try {
            if (event.status === 'failed' && typeof this.eventBus.emitError === 'function') {
                this.eventBus.emitError(COUNCIL_EVENT_KEY, event.error || 'agent failed', event.requestId);
            } else if (typeof this.eventBus.emitStatus === 'function') {
                this.eventBus.emitStatus(COUNCIL_EVENT_KEY, this._describeEvent(event), event.requestId);
            }
        } catch (err) {
            console.warn('[Council] eventBus emit failed:', err.message);
        }
    }

    _emitFinished(text, requestId) {
        if (!this.eventBus || typeof this.eventBus.emitFinished !== 'function') return;
        try {
            this.eventBus.emitFinished(COUNCIL_EVENT_KEY, text, requestId);
        } catch (err) {
            console.warn('[Council] eventBus emitFinished failed:', err.message);
        }
    }

    _describeEvent(event) {
        const who = event.agentKey || event.phase;
        switch (event.status) {
            case 'started': return `▶️ ${who}${event.round ? ` (round ${event.round})` : ''}`;
            case 'ok':      return `✅ ${who}${event.round ? ` (round ${event.round})` : ''}`;
            case 'failed':  return `❌ ${who}: ${event.error || 'failed'}`;
            case 'blocked': return `⛔ ${who}: ${COUNCIL_SWITCH} is off`;
            default:        return `${event.phase}: ${event.status}`;
        }
    }

    _nextRequestId(prefix = 'council') {
        this._seq += 1;
        return `${prefix}_${this._seq}_${Date.now().toString(36)}`;
    }
}

module.exports = Council;
module.exports.Council = Council;
module.exports.COUNCIL_SWITCH = COUNCIL_SWITCH;
module.exports.COUNCIL_EVENT_KEY = COUNCIL_EVENT_KEY;
