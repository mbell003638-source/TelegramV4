// =============================================================================
//  core/Scheduler.js — Cron Scheduler Engine for `scheduled_tasks`
//
//  Makes the dashboard's scheduled-tasks feature real:
//    1. Ticks on a timer (default 30s), gated by the SCHEDULER_ENABLED switch
//    2. Picks up every task whose next_run has passed (missed runs catch up)
//    3. Dispatches the prompt through ActionExecutor (or an injected runner)
//    4. Persists last_run / last_result and the recomputed next_run
//
//  Cron support: 5 fields (minute hour day-of-month month day-of-week) with
//  `*`, `N`, `a,b,c` lists, `a-b` ranges and `*/n` (also `a-b/n`) steps.
//  Day-of-month and day-of-week follow standard cron OR semantics: when both
//  fields are restricted, a day matching EITHER field qualifies.
//  Node builtins only — no external cron dependency.
// =============================================================================

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Hard bound so an impossible expression (e.g. `0 0 30 2 *`) terminates.
const SEARCH_HORIZON_MS = 4 * 366 * DAY_MS;          // ~4 years of candidates
const MAX_SEARCH_STEPS = 4 * 366 * 24 * 60 + 10000;  // ~4 years of minutes
const MAX_RESULT_CHARS = 4000;

const CRON_FIELDS = [
    { key: 'minute', label: 'minute', min: 0, max: 59 },
    { key: 'hour', label: 'hour', min: 0, max: 23 },
    { key: 'dayOfMonth', label: 'day-of-month', min: 1, max: 31 },
    { key: 'month', label: 'month', min: 1, max: 12 },
    { key: 'dayOfWeek', label: 'day-of-week', min: 0, max: 7 },
];

function parseCronField(raw, field, expr) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) throw new Error(`Invalid cron expression "${expr}": empty ${field.label} field`);

    const values = new Set();
    for (const part of text.split(',')) {
        const chunk = part.trim();
        if (!chunk) {
            throw new Error(`Invalid cron expression "${expr}": empty ${field.label} list item`);
        }

        const pieces = chunk.split('/');
        if (pieces.length > 2) {
            throw new Error(`Invalid cron expression "${expr}": malformed ${field.label} step "${chunk}"`);
        }
        const rangeText = pieces[0].trim();
        let step = 1;
        if (pieces.length === 2) {
            const stepText = pieces[1].trim();
            if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
                throw new Error(`Invalid cron expression "${expr}": ${field.label} step must be a positive integer (got "${chunk}")`);
            }
            step = Number(stepText);
        }

        let start;
        let end;
        if (rangeText === '*') {
            start = field.min;
            end = field.max;
        } else if (/^\d+$/.test(rangeText)) {
            start = Number(rangeText);
            end = pieces.length === 2 ? field.max : start;
        } else {
            const range = rangeText.match(/^(\d+)-(\d+)$/);
            if (!range) {
                throw new Error(`Invalid cron expression "${expr}": unsupported ${field.label} value "${chunk}"`);
            }
            start = Number(range[1]);
            end = Number(range[2]);
        }

        if (start < field.min || end > field.max || start > end) {
            throw new Error(`Invalid cron expression "${expr}": ${field.label} value "${chunk}" outside ${field.min}-${field.max}`);
        }
        for (let value = start; value <= end; value += step) values.add(value);
    }

    // Cron allows 7 as Sunday alongside 0.
    if (field.key === 'dayOfWeek' && values.has(7)) {
        values.delete(7);
        values.add(0);
    }
    if (values.size === 0) {
        throw new Error(`Invalid cron expression "${expr}": ${field.label} field matches nothing`);
    }
    return values;
}

function clipResult(value) {
    const text = String(value === undefined || value === null ? '' : value);
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated]` : text;
}

class Scheduler {
    /**
     * @param {object}   opts
     * @param {object}   opts.database         AssistantDatabase instance (required)
     * @param {object}   [opts.actionExecutor] ActionExecutor — the default dispatch path
     * @param {object}   [opts.killSwitches]   KillSwitches instance (SCHEDULER_ENABLED gate)
     * @param {number}   [opts.intervalMs]     Tick interval, default 30000
     * @param {Function} [opts.runner]         async (task) => resultText. Overrides the
     *                                         ActionExecutor path; used by tests and by
     *                                         embedders that dispatch tasks themselves.
     * @param {Function} [opts.now]            Injectable clock, default () => Date.now()
     * @param {number}   [opts.runTimeoutMs]   Per-run timeout, default 10 min (0 disables)
     * @param {number}   [opts.pollMs]         ActionExecutor idle poll interval, default 500
     */
    constructor({
        database,
        actionExecutor = null,
        killSwitches = null,
        intervalMs = 30000,
        runner = null,
        now = null,
        runTimeoutMs = 10 * 60 * 1000,
        pollMs = 500,
    } = {}) {
        if (!database) throw new Error('[Scheduler] A database instance is required');
        this.database = database;
        this.actionExecutor = actionExecutor;
        this.killSwitches = killSwitches;
        this.intervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : 30000;
        this.runner = typeof runner === 'function' ? runner : null;
        this.runTimeoutMs = Number(runTimeoutMs) >= 0 ? Number(runTimeoutMs) : 0;
        this.pollMs = Number(pollMs) > 0 ? Number(pollMs) : 500;
        this._clock = typeof now === 'function' ? now : () => Date.now();

        this.timer = null;
        this.running = new Set();   // in-flight task ids — the overlap guard
        this.inFlight = new Map();  // task id -> settled-when-done promise
    }

    _now() {
        return this._clock();
    }

    // =========================================================================
    //  LIFECYCLE
    // =========================================================================

    start() {
        if (this.timer) return this;
        this._recoverStaleRuns();
        this.timer = setInterval(() => this.tick().catch((err) => {
            console.warn(`[Scheduler] Tick failed: ${err.message}`);
        }), this.intervalMs);
        if (this.timer.unref) this.timer.unref();
        console.log(`[Scheduler] Started — polling scheduled_tasks every ${Math.round(this.intervalMs / 1000)}s`);
        return this;
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.drain();
        return this;
    }

    /** Await every in-flight run (used by stop() and by tests). */
    async drain() {
        while (this.inFlight.size > 0) {
            await Promise.allSettled([...this.inFlight.values()]);
        }
    }

    /** A crash mid-run leaves rows stuck on 'running'; hand them back to the loop. */
    _recoverStaleRuns() {
        try {
            const stale = (this.database.getScheduledTasks() || []).filter((task) => task.status === 'running');
            for (const task of stale) {
                this.database.setScheduledTaskStatus(task.id, 'active');
                console.warn(`[Scheduler] Recovered stale running task ${task.id}`);
            }
        } catch (err) {
            console.warn(`[Scheduler] Stale run recovery failed: ${err.message}`);
        }
    }

    // =========================================================================
    //  CRON PARSING
    // =========================================================================

    /**
     * Parse a 5-field cron expression into value sets.
     * @returns {{expr:string, minute:Set, hour:Set, dayOfMonth:Set, month:Set,
     *            dayOfWeek:Set, domRestricted:boolean, dowRestricted:boolean}}
     * @throws  {Error} on malformed input
     */
    parseCron(expr) {
        const text = String(expr === undefined || expr === null ? '' : expr).trim().replace(/\s+/g, ' ');
        if (!text) throw new Error('Invalid cron expression "": expression is empty');

        const parts = text.split(' ');
        if (parts.length !== 5) {
            throw new Error(`Invalid cron expression "${text}": expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
        }

        const parsed = { expr: text };
        for (let i = 0; i < CRON_FIELDS.length; i++) {
            parsed[CRON_FIELDS[i].key] = parseCronField(parts[i], CRON_FIELDS[i], text);
        }
        // Standard cron: a field that starts with '*' does not restrict the day.
        parsed.domRestricted = !parts[2].startsWith('*');
        parsed.dowRestricted = !parts[4].startsWith('*');
        return parsed;
    }

    /** Does this calendar day satisfy month + the DOM/DOW OR rule? */
    _matchesDate(parsed, date) {
        if (!parsed.month.has(date.getMonth() + 1)) return false;
        const domHit = parsed.dayOfMonth.has(date.getDate());
        const dowHit = parsed.dayOfWeek.has(date.getDay());
        if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
        if (parsed.domRestricted) return domHit;
        if (parsed.dowRestricted) return dowHit;
        return true;
    }

    /** Does this exact minute match the expression? */
    matches(expr, whenMs) {
        const parsed = typeof expr === 'string' ? this.parseCron(expr) : expr;
        const date = new Date(Number(whenMs));
        return this._matchesDate(parsed, date)
            && parsed.hour.has(date.getHours())
            && parsed.minute.has(date.getMinutes());
    }

    /**
     * Next matching epoch-ms STRICTLY AFTER fromMs (local time, like cron).
     * Returns null when nothing matches inside the ~4 year search horizon
     * (e.g. `0 0 30 2 *` — February 30th never happens).
     */
    nextRun(expr, fromMs = null) {
        const parsed = typeof expr === 'string' ? this.parseCron(expr) : expr;
        const startMs = Number.isFinite(Number(fromMs)) ? Number(fromMs) : this._now();
        const limitMs = startMs + SEARCH_HORIZON_MS;

        const candidate = new Date(startMs);
        candidate.setSeconds(0, 0);
        candidate.setMinutes(candidate.getMinutes() + 1); // strictly after fromMs

        let steps = 0;
        while (candidate.getTime() <= limitMs && steps < MAX_SEARCH_STEPS) {
            steps++;
            if (!this._matchesDate(parsed, candidate)) {
                // Whole day is out — jump to the next midnight instead of 1440 steps.
                candidate.setHours(0, 0, 0, 0);
                candidate.setDate(candidate.getDate() + 1);
                continue;
            }
            if (parsed.hour.has(candidate.getHours()) && parsed.minute.has(candidate.getMinutes())) {
                return candidate.getTime();
            }
            candidate.setMinutes(candidate.getMinutes() + 1);
        }
        console.warn(`[Scheduler] No upcoming run for cron "${parsed.expr}" within the search horizon`);
        return null;
    }

    // =========================================================================
    //  SCHEDULING
    // =========================================================================

    /** Validate a cron expression, compute its first run, and persist the task. */
    scheduleTask({ id = null, chatId = '', agentId = 'main', prompt = '', schedule = '', status = 'active', from = null } = {}) {
        this.parseCron(schedule); // throws on malformed input
        const base = Number.isFinite(Number(from)) ? Number(from) : this._now();
        const next = this.nextRun(schedule, base);
        if (!next) throw new Error(`Cron expression "${schedule}" has no upcoming run`);
        return this.database.createScheduledTask({ id, chatId, agentId, prompt, schedule, nextRun: next, status });
    }

    // =========================================================================
    //  TICK LOOP
    // =========================================================================

    /**
     * One scheduler pass. Starts every due task that is not already in flight
     * and returns immediately — await drain() for the runs themselves.
     * @returns {Promise<{skipped:boolean, reason:string|null, due:number,
     *                    started:string[], skippedRunning:string[]}>}
     */
    async tick(nowMs = null) {
        const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : this._now();
        const summary = { skipped: false, reason: null, due: 0, started: [], skippedRunning: [] };

        if (this.killSwitches && typeof this.killSwitches.isEnabled === 'function') {
            let enabled = true;
            try {
                enabled = this.killSwitches.isEnabled('SCHEDULER_ENABLED');
            } catch (err) {
                console.warn(`[Scheduler] Kill switch check failed: ${err.message}`);
            }
            if (!enabled) {
                summary.skipped = true;
                summary.reason = 'SCHEDULER_ENABLED';
                return summary;
            }
        }

        let due = [];
        try {
            due = this.database.getDueScheduledTasks(now) || [];
        } catch (err) {
            console.warn(`[Scheduler] Could not read due tasks: ${err.message}`);
            return summary;
        }
        summary.due = due.length;

        for (const task of due) {
            if (!task || !task.id) continue;
            if (this.running.has(task.id)) {
                // Overlap guard: a previous run has not finished yet.
                summary.skippedRunning.push(task.id);
                continue;
            }
            this.running.add(task.id);
            summary.started.push(task.id);
            const promise = this._runTask(task, now).catch((err) => {
                // _runTask never rethrows, but one bad task must never kill the loop.
                console.warn(`[Scheduler] Unexpected failure for ${task.id}: ${err.message}`);
            }).finally(() => {
                this.running.delete(task.id);
                this.inFlight.delete(task.id);
            });
            this.inFlight.set(task.id, promise);
        }
        return summary;
    }

    async _runTask(task, startedAt) {
        try {
            this.database.updateScheduledTaskRun(task.id, { status: 'running', lastRunAt: startedAt });
        } catch (err) {
            console.warn(`[Scheduler] Could not mark ${task.id} running: ${err.message}`);
        }

        let lastResult;
        try {
            const output = await this._executeWithTimeout(task);
            const text = String(output === undefined || output === null ? '' : output).trim();
            lastResult = clipResult(text || 'Completed with no output.');
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            lastResult = clipResult(/^Timed out/i.test(message) ? message : `Error: ${message}`);
            console.warn(`[Scheduler] Task ${task.id} failed: ${message}`);
        }

        const finishedAt = this._now();
        let nextRun = null;
        try {
            nextRun = this.nextRun(task.schedule, finishedAt);
        } catch (err) {
            console.warn(`[Scheduler] Task ${task.id} has an invalid schedule "${task.schedule}": ${err.message}`);
        }

        let status = 'active';
        if (!nextRun) {
            // Nothing left to run (impossible or malformed cron) — park it.
            status = 'paused';
            lastResult = clipResult(`${lastResult}\n[Scheduler] Paused: "${task.schedule}" has no upcoming run.`);
        }

        try {
            // A run can outlive a dashboard pause/delete; never resurrect the row.
            const current = this.database.getScheduledTask(task.id);
            if (!current) return;
            if (current.status === 'paused') status = 'paused';
            this.database.updateScheduledTaskRun(task.id, {
                nextRun: nextRun || undefined,
                lastResult,
                lastRunAt: startedAt,
                status,
            });
        } catch (err) {
            console.warn(`[Scheduler] Could not persist run of ${task.id}: ${err.message}`);
        }
    }

    _executeWithTimeout(task) {
        const run = Promise.resolve().then(() => this._execute(task));
        if (!this.runTimeoutMs) return run;

        let timer = null;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Timed out after ${this.runTimeoutMs} ms`)),
                this.runTimeoutMs
            );
            if (timer.unref) timer.unref();
        });
        return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    }

    _execute(task) {
        if (this.runner) return this.runner(task);
        return this._dispatchViaActionExecutor(task);
    }

    // =========================================================================
    //  DEFAULT DISPATCH — ActionExecutor
    //
    //  ActionExecutor has no request/response entry point: work is queued with
    //  _enqueue(unifiedMessage) and the answer comes back through the message's
    //  own `raw` callbacks (the same synthetic-ctx pattern MissionControl uses
    //  for dashboard chat). We capture that text, then wait until the chat is
    //  idle again. Embedders wanting a different transport pass { runner }.
    // =========================================================================

    async _dispatchViaActionExecutor(task) {
        const executor = this.actionExecutor;
        if (!executor || typeof executor._enqueue !== 'function') {
            throw new Error('No actionExecutor wired into the Scheduler (pass { actionExecutor } or { runner })');
        }

        const chatId = String(task.chat_id || '').trim() || 'scheduler';
        const agentKey = String(task.agent_id || '').trim();
        if (agentKey && agentKey !== 'main' && executor.agents && executor.agents[agentKey]
            && executor.sessionStore && typeof executor.sessionStore.setActiveAgent === 'function') {
            try {
                executor.sessionStore.setActiveAgent(agentKey, chatId);
            } catch (err) {
                console.warn(`[Scheduler] Could not pin agent ${agentKey} for ${task.id}: ${err.message}`);
            }
        }

        let captured = '';
        const capture = (text) => {
            const value = String(text || '');
            if (!value || value.includes('Thinking...') || value.includes('Queued for this chat')) return;
            captured = value;
        };
        const ack = async () => ({ message_id: Math.floor(Math.random() * 100000) });

        executor._enqueue({
            id: `sched_${task.id}_${this._now()}`,
            platform: 'scheduler',
            chatId,
            user: { id: 'scheduler', username: 'Scheduler' },
            content: { type: 'text', text: String(task.prompt || '') },
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
        });

        await this._awaitChatIdle(executor, chatId);
        const lastResponse = executor.lastResponses && typeof executor.lastResponses.get === 'function'
            ? executor.lastResponses.get(chatId)
            : '';
        return captured || lastResponse || '';
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
}

module.exports = Scheduler;
