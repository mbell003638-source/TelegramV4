// =============================================================================
//  core/GoalEngine.js — Autonomous, Persistent Goal Pursuit
//
//  Every other path in this app is request-driven: the user asks, an agent
//  answers, the turn ends. A GOAL is different. It outlives the session, it is
//  pursued without being asked again, and it stops only when it is done, it is
//  genuinely blocked, or the user abandons it.
//
//  This module is the spine that wires the pieces that already exist:
//    core/TaskPlanner.js     — decomposition (plan() gives the step graph)
//    core/AgentDelegation.js — execution (delegateAndRun() with depth guards)
//    core/Council.js         — a second opinion when a step keeps failing
//    core/MemorySearch.js    — what we already know about this goal
//    core/SkillRegistry.js   — the how-to notes relevant to a step
//    core/Scheduler.js       — the cadence that makes progress unattended
//
//  THE ONE-STEP RULE
//  step() advances a goal by exactly ONE unit of work and returns. It does not
//  loop. A long-running internal loop cannot be observed, cannot be cancelled,
//  and does not survive a restart; a single persisted step can do all three.
//  The scheduler (or a route, or a test) supplies the cadence.
//
//  FAILURE IS BOUNDED BY CONSTRUCTION
//  A failing step increments `attempts` and is retried up to `max_attempts`.
//  When the retries run out the council is asked for guidance ONCE (recorded
//  on the goal) and the step gets one grace attempt. If that also fails the
//  goal is marked `blocked` with `last_error` and stops consuming work. A goal
//  can never retry forever, and step() never throws at its caller.
//
//  EVERY collaborator is injected and OPTIONAL. The module must construct and
//  behave sanely with only { database }, because in a degraded boot the others
//  may simply not be there. Node builtins only.
// =============================================================================

const crypto = require('crypto');

const GOAL_STATUS = Object.freeze({
    PENDING: 'pending',
    PLANNING: 'planning',
    RUNNING: 'running',
    BLOCKED: 'blocked',
    NEEDS_INPUT: 'needs_input',
    COMPLETED: 'completed',
    ABANDONED: 'abandoned',
});

const GOAL_STATUSES = Object.freeze(Object.values(GOAL_STATUS));

/** Statuses that still consume work when the scheduler comes around. */
const ACTIVE_STATUSES = Object.freeze([
    GOAL_STATUS.PENDING, GOAL_STATUS.PLANNING, GOAL_STATUS.RUNNING,
]);

/** Statuses step() refuses to do work for — it reports `done` instead. */
const TERMINAL_STATUSES = Object.freeze([
    GOAL_STATUS.COMPLETED, GOAL_STATUS.ABANDONED, GOAL_STATUS.BLOCKED, GOAL_STATUS.NEEDS_INPUT,
]);

/** Per-step lifecycle inside plan_json. A failed step returns to `pending`. */
const STEP_STATUS = Object.freeze({
    PENDING: 'pending',
    OK: 'ok',
    FAILED: 'failed',
    SKIPPED: 'skipped',
});

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SCHEDULE = '*/15 * * * *';
const SCHEDULER_AGENT_ID = 'goalengine';
const GOAL_EVENT_KEY = 'goalengine';

const MAX_OUTPUT_CHARS = 4000;
const MAX_ERROR_CHARS = 1000;
const MAX_TITLE_CHARS = 300;
const MAX_MEMORIES = 5;
const MAX_SKILLS = 3;
const SKILL_PROMPT_BUDGET = 2000;
const MAX_GOALS_PER_TICK = 3;
const MAX_LIST_LIMIT = 500;
const MAX_HISTORY_ENTRIES = 50;

function text(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.output === 'string') return value.output;
        if (typeof value.content === 'string') return value.content;
        if (typeof value.answer === 'string') return value.answer;
        try { return JSON.stringify(value); } catch (err) { return String(value); }
    }
    return String(value);
}

function clip(value, max = MAX_OUTPUT_CHARS) {
    const body = text(value);
    return body.length > max ? `${body.slice(0, max)}\n...[truncated]` : body;
}

function errorMessage(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    return String(err);
}

function positiveInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function safeJsonParse(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
        return fallback;
    }
}

function safeJsonStringify(value, fallback = '{}') {
    try {
        const out = JSON.stringify(value === undefined ? null : value);
        return typeof out === 'string' ? out : fallback;
    } catch (err) {
        return fallback;
    }
}

function clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.round(Math.max(0, Math.min(1, num)) * 10000) / 10000;
}

class GoalEngine {
    /**
     * Nothing but `database` is required. Every collaborator is optional and a
     * missing one degrades the behaviour instead of breaking it.
     *
     * @param {object}   opts
     * @param {object}   opts.database        AssistantDatabase, or any object exposing a
     *                                        node:sqlite handle as `.db` — required
     * @param {object}   [opts.planner]       core/TaskPlanner — plan() for decomposition
     * @param {object}   [opts.delegation]    core/AgentDelegation — delegateAndRun() execution
     * @param {object}   [opts.council]       core/Council — deliberate() for a stuck step
     * @param {object}   [opts.memorySearch]  core/MemorySearch — search()/recentContext()
     * @param {object}   [opts.skills]        core/SkillRegistry — search()/renderForPrompt()
     * @param {object}   [opts.scheduler]     core/Scheduler — registered on construction
     * @param {object}   [opts.eventBus]      channelEventBus — progress events
     * @param {number}   [opts.maxAttempts=5] Consecutive step failures tolerated per goal
     * @param {number}   [opts.stepTimeoutMs] Per-step ceiling, default 10 min (0 disables)
     * @param {Function} [opts.taskRunner]    async (ctx) => output. Escape hatch for
     *                                        embedders/tests with no delegation wired.
     * @param {Function} [opts.now]           Injectable clock, default () => Date.now()
     */
    constructor({
        database,
        planner = null,
        delegation = null,
        council = null,
        memorySearch = null,
        skills = null,
        scheduler = null,
        eventBus = null,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
        taskRunner = null,
        now = null,
    } = {}) {
        if (!database) throw new Error('[GoalEngine] A database instance is required');
        const handle = database.db && typeof database.db.prepare === 'function' ? database.db : database;
        if (!handle || typeof handle.prepare !== 'function') {
            throw new Error('[GoalEngine] database must expose a node:sqlite handle (database.db)');
        }

        this.database = database;
        this.db = handle;
        this.planner = planner || null;
        this.delegation = delegation || null;
        this.council = council || null;
        this.memorySearch = memorySearch || null;
        this.skills = skills || null;
        this.scheduler = scheduler || null;
        this.eventBus = eventBus || null;
        this.maxAttempts = positiveInt(maxAttempts, DEFAULT_MAX_ATTEMPTS);
        this.stepTimeoutMs = Number.isFinite(Number(stepTimeoutMs)) && Number(stepTimeoutMs) >= 0
            ? Number(stepTimeoutMs)
            : DEFAULT_STEP_TIMEOUT_MS;
        this.taskRunner = typeof taskRunner === 'function' ? taskRunner : null;
        this._clock = typeof now === 'function' ? now : () => Date.now();

        this.stepping = new Set();   // goal ids in flight — the double-advance guard

        this._ensureSchema();

        if (this.scheduler) {
            try {
                this.registerWithScheduler(this.scheduler);
            } catch (err) {
                console.warn(`[GoalEngine] Scheduler registration failed: ${errorMessage(err)}`);
            }
        }
    }

    _now() {
        return this._clock();
    }

    /**
     * `goals` belongs to this module, so the DDL lives here. core/Database.js is
     * owned elsewhere; keeping the schema local makes the engine usable against
     * a bare DatabaseSync handle and matches the shipped SQL style (TEXT ids,
     * INTEGER epoch-ms, IF NOT EXISTS everywhere).
     */
    _ensureSchema() {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS goals (
                    id            TEXT PRIMARY KEY,
                    title         TEXT NOT NULL,
                    description   TEXT NOT NULL DEFAULT '',
                    status        TEXT NOT NULL DEFAULT 'pending',
                    progress      REAL NOT NULL DEFAULT 0,
                    plan_json     TEXT,
                    context_json  TEXT,
                    created_at    INTEGER NOT NULL,
                    updated_at    INTEGER NOT NULL,
                    completed_at  INTEGER,
                    last_error    TEXT,
                    attempts      INTEGER NOT NULL DEFAULT 0,
                    max_attempts  INTEGER NOT NULL DEFAULT 5,
                    chat_id       TEXT NOT NULL DEFAULT '',
                    owner_agent   TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_goals_status
                    ON goals(status, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_goals_chat
                    ON goals(chat_id, created_at DESC);
            `);
        } catch (err) {
            console.warn(`[GoalEngine] Schema check failed: ${errorMessage(err)}`);
        }
    }

    // =========================================================================
    //  EVENTS & JOURNAL  (all best-effort — telemetry never breaks a goal)
    // =========================================================================

    _emit(event) {
        if (!this.eventBus) return;
        try {
            if (event && event.status === 'failed' && typeof this.eventBus.emitError === 'function') {
                this.eventBus.emitError(GOAL_EVENT_KEY, event.error || 'goal step failed', event.goalId);
            } else if (typeof this.eventBus.emitStatus === 'function') {
                this.eventBus.emitStatus(GOAL_EVENT_KEY, this._describeEvent(event), event && event.goalId);
            }
        } catch (err) {
            console.warn(`[GoalEngine] eventBus emit failed: ${errorMessage(err)}`);
        }
    }

    _describeEvent(event) {
        const e = event || {};
        const where = e.stepId ? `${e.goalId}/${e.stepId}` : String(e.goalId || 'goal');
        switch (e.status) {
            case 'created':     return `🎯 ${where}: goal created`;
            case 'planned':     return `🗂️ ${where}: ${e.stepCount || 0} step(s) planned`;
            case 'started':     return `▶️ ${where}: step started`;
            case 'ok':          return `✅ ${where}: step done (${Math.round((e.progress || 0) * 100)}%)`;
            case 'failed':      return `⚠️ ${where}: ${e.error || 'step failed'}`;
            case 'blocked':     return `⛔ ${where}: blocked — ${e.error || 'retries exhausted'}`;
            case 'needs_input': return `❓ ${where}: waiting on the user`;
            case 'completed':   return `🏁 ${where}: goal complete`;
            case 'abandoned':   return `🗑️ ${where}: goal abandoned`;
            case 'resumed':     return `🔄 ${where}: goal resumed`;
            default:            return `${where}: ${e.status || 'update'}`;
        }
    }

    _journal(action, goal, summary, artifacts = null) {
        if (!this.database || typeof this.database.recordHiveMind !== 'function') return;
        try {
            this.database.recordHiveMind(
                GOAL_EVENT_KEY,
                String((goal && goal.chat_id) || ''),
                action,
                clip(summary, 500),
                artifacts
            );
        } catch (err) {
            console.warn(`[GoalEngine] Could not journal ${action}: ${errorMessage(err)}`);
        }
    }

    /** A completed or blocked goal is worth remembering across sessions. */
    _remember(goal, body) {
        if (!this.database || typeof this.database.addMemory !== 'function') return;
        try {
            this.database.addMemory(
                String((goal && goal.chat_id) || 'global') || 'global',
                clip(body, 1500),
                {
                    summary: clip(`Goal "${(goal && goal.title) || ''}" -> ${(goal && goal.status) || ''}`, 200),
                    importance: 0.8,
                    salience: 0.9,
                    source: 'goal_engine',
                }
            );
        } catch (err) {
            console.warn(`[GoalEngine] Could not persist goal memory: ${errorMessage(err)}`);
        }
    }

    // =========================================================================
    //  PERSISTENCE
    // =========================================================================

    _newId() {
        return `goal_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    }

    /** Parse the JSON columns and surface the step list, without mutating the row. */
    _decorate(row) {
        if (!row) return null;
        const plan = safeJsonParse(row.plan_json, null);
        const context = safeJsonParse(row.context_json, {}) || {};
        const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
        return {
            ...row,
            progress: Number(row.progress) || 0,
            attempts: Number(row.attempts) || 0,
            max_attempts: positiveInt(row.max_attempts, this.maxAttempts),
            plan,
            context,
            steps,
            stepCount: steps.length,
            done: TERMINAL_STATUSES.includes(String(row.status)),
        };
    }

    _row(id) {
        const key = text(id).trim();
        if (!key) return null;
        try {
            return this.db.prepare('SELECT * FROM goals WHERE id = ?').get(key) || null;
        } catch (err) {
            console.warn(`[GoalEngine] get(${key}) failed: ${errorMessage(err)}`);
            return null;
        }
    }

    /**
     * Write a partial update. Only whitelisted columns are touched and
     * `updated_at` always moves, so a caller cannot desync the row.
     */
    _update(id, patch = {}) {
        const key = text(id).trim();
        if (!key) return null;

        const columns = {
            title: (v) => clip(v, MAX_TITLE_CHARS),
            description: (v) => clip(v, MAX_OUTPUT_CHARS),
            status: (v) => text(v),
            progress: (v) => clamp01(v),
            plan_json: (v) => (v === null ? null : (typeof v === 'string' ? v : safeJsonStringify(v))),
            context_json: (v) => (v === null ? null : (typeof v === 'string' ? v : safeJsonStringify(v))),
            completed_at: (v) => (v === null || v === undefined ? null : Number(v)),
            last_error: (v) => (v === null || v === undefined ? null : clip(v, MAX_ERROR_CHARS)),
            attempts: (v) => Math.max(0, Math.floor(Number(v) || 0)),
            max_attempts: (v) => positiveInt(v, this.maxAttempts),
            chat_id: (v) => text(v),
            owner_agent: (v) => text(v),
        };

        const sets = [];
        const params = [];
        for (const [column, coerce] of Object.entries(columns)) {
            if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
            sets.push(`${column} = ?`);
            params.push(coerce(patch[column]));
        }
        sets.push('updated_at = ?');
        params.push(this._now());
        params.push(key);

        try {
            this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        } catch (err) {
            console.warn(`[GoalEngine] update(${key}) failed: ${errorMessage(err)}`);
        }
        return this.get(key);
    }

    // =========================================================================
    //  CRUD
    // =========================================================================

    /**
     * Persist a new `pending` goal. A goal with no title cannot be listed,
     * discussed or reported on, so an empty title is refused outright.
     * @returns {object} the decorated goal
     */
    create({ title, description = '', chatId = '', ownerAgent = '', maxAttempts = null } = {}) {
        const name = text(title).trim();
        if (!name) throw new Error('[GoalEngine] create() requires a non-empty title');

        const id = this._newId();
        const createdAt = this._now();
        const cap = positiveInt(maxAttempts, this.maxAttempts);

        try {
            this.db.prepare(`
                INSERT INTO goals
                    (id, title, description, status, progress, plan_json, context_json,
                     created_at, updated_at, completed_at, last_error, attempts, max_attempts,
                     chat_id, owner_agent)
                VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)
            `).run(
                id,
                clip(name, MAX_TITLE_CHARS),
                clip(description, MAX_OUTPUT_CHARS),
                GOAL_STATUS.PENDING,
                safeJsonStringify({ history: [], councilGuidance: [], inputs: [] }),
                createdAt,
                createdAt,
                cap,
                text(chatId),
                text(ownerAgent)
            );
        } catch (err) {
            console.warn(`[GoalEngine] create("${name}") failed: ${errorMessage(err)}`);
            throw new Error(`[GoalEngine] Could not persist the goal: ${errorMessage(err)}`);
        }

        const goal = this.get(id);
        this._journal('goal_created', goal, `${name} (${id})`, { id, title: name });
        this._emit({ goalId: id, status: 'created', title: name });
        return goal;
    }

    /** @returns {object|null} decorated goal, or null when the id is unknown */
    get(id) {
        return this._decorate(this._row(id));
    }

    /** Newest first. `status` may be a single status or an array of them. */
    list({ status = null, chatId = null, limit = 50 } = {}) {
        const cap = Math.min(MAX_LIST_LIMIT, positiveInt(limit, 50));
        const where = [];
        const params = [];

        const statuses = (Array.isArray(status) ? status : [status])
            .map((s) => text(s).trim())
            .filter(Boolean);
        if (statuses.length === 1) {
            where.push('status = ?');
            params.push(statuses[0]);
        } else if (statuses.length > 1) {
            where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
            params.push(...statuses);
        }

        const chat = text(chatId).trim();
        if (chat) {
            where.push('chat_id = ?');
            params.push(chat);
        }

        const sql = `
            SELECT * FROM goals
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        `;
        try {
            return this.db.prepare(sql).all(...params, cap).map((row) => this._decorate(row));
        } catch (err) {
            console.warn(`[GoalEngine] list() failed: ${errorMessage(err)}`);
            return [];
        }
    }

    /** Stop pursuing a goal for good. Idempotent. */
    abandon(id, reason = '') {
        const row = this._row(id);
        if (!row) {
            console.warn(`[GoalEngine] abandon(${id}): no such goal`);
            return null;
        }
        if (row.status === GOAL_STATUS.ABANDONED) return this._decorate(row);

        const why = text(reason).trim() || 'abandoned by request';
        const goal = this._update(row.id, {
            status: GOAL_STATUS.ABANDONED,
            last_error: why,
            completed_at: this._now(),
        });
        this._journal('goal_abandoned', goal, `${row.title}: ${why}`);
        this._remember(goal, `Goal "${row.title}" was abandoned: ${why}`);
        this._emit({ goalId: row.id, status: 'abandoned', error: why });
        return goal;
    }

    /**
     * Put a blocked / abandoned / waiting goal back into play: attempts reset,
     * the recorded error cleared, and any step marked failed or skipped when
     * the goal stalled becomes retryable again.
     */
    resume(id) {
        const row = this._row(id);
        if (!row) {
            console.warn(`[GoalEngine] resume(${id}): no such goal`);
            return null;
        }
        if (row.status === GOAL_STATUS.COMPLETED) return this._decorate(row);

        const plan = safeJsonParse(row.plan_json, null);
        let planJson = null;
        if (plan && Array.isArray(plan.steps)) {
            plan.steps = plan.steps.map((step) => (
                step && (step.status === STEP_STATUS.FAILED || step.status === STEP_STATUS.SKIPPED)
                    ? { ...step, status: STEP_STATUS.PENDING, error: null }
                    : step
            ));
            planJson = safeJsonStringify(plan);
        }

        const patch = {
            status: plan ? GOAL_STATUS.RUNNING : GOAL_STATUS.PENDING,
            attempts: 0,
            last_error: null,
            completed_at: null,
        };
        if (planJson) patch.plan_json = planJson;

        const goal = this._update(row.id, patch);
        this._journal('goal_resumed', goal, `${row.title} resumed from ${row.status}`);
        this._emit({ goalId: row.id, status: 'resumed' });
        return goal;
    }

    // =========================================================================
    //  PLANNING
    //
    //  Decomposition is already solved in core/TaskPlanner.js, so we reuse it.
    //  With no planner injected the goal is NOT rejected — it degrades to a
    //  single step carrying the description, which is still a pursuable goal.
    // =========================================================================

    async planGoal(id) {
        const row = this._row(id);
        if (!row) {
            console.warn(`[GoalEngine] planGoal(${id}): no such goal`);
            return null;
        }
        if (row.status === GOAL_STATUS.ABANDONED || row.status === GOAL_STATUS.COMPLETED) {
            console.warn(`[GoalEngine] planGoal(${row.id}): already ${row.status}`);
            return this._decorate(row);
        }

        this._update(row.id, { status: GOAL_STATUS.PLANNING });

        const request = this._goalRequest(row);
        let tasks = null;
        let meta = { source: 'fallback', rationale: '', fallback: true, reason: 'no planner injected' };

        if (this.planner && typeof this.planner.plan === 'function') {
            try {
                const produced = await this.planner.plan(request, {
                    context: clip(row.description, 2000),
                    requestId: `goal_${row.id}`,
                });
                const list = this._tasksOf(produced);
                if (list.length) {
                    tasks = list;
                    meta = {
                        source: 'planner',
                        rationale: clip(produced && produced.rationale, 1000),
                        fallback: Boolean(produced && produced.fallback),
                        reason: text(produced && produced.fallbackReason),
                    };
                } else {
                    meta.reason = 'planner returned no tasks';
                }
            } catch (err) {
                console.warn(`[GoalEngine] planGoal(${row.id}) planner failed: ${errorMessage(err)}`);
                meta.reason = `planner failed: ${errorMessage(err)}`;
            }
        }

        if (!tasks || !tasks.length) {
            tasks = [{
                id: 's1',
                type: 'general',
                description: request,
                dependsOn: [],
                suggestedAgent: text(row.owner_agent).trim() || null,
                args: {},
            }];
        }

        const plan = {
            request,
            createdAt: this._now(),
            source: meta.source,
            rationale: meta.rationale,
            fallback: meta.fallback,
            fallbackReason: meta.reason,
            steps: tasks.map((task, index) => ({
                id: task.id || `s${index + 1}`,
                type: task.type || 'general',
                description: task.description,
                dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
                suggestedAgent: task.suggestedAgent || null,
                args: task.args && typeof task.args === 'object' ? task.args : {},
                status: STEP_STATUS.PENDING,
                attempts: 0,
                output: null,
                error: null,
                startedAt: null,
                completedAt: null,
                agent: null,
            })),
        };

        const goal = this._update(row.id, {
            status: GOAL_STATUS.RUNNING,
            plan_json: plan,
            progress: 0,
            attempts: 0,
            last_error: null,
        });

        this._journal('goal_planned', goal, `${row.title}: ${plan.steps.length} step(s) via ${meta.source}`, {
            id: row.id,
            steps: plan.steps.map((s) => ({ id: s.id, type: s.type, description: s.description })),
        });
        this._emit({ goalId: row.id, status: 'planned', stepCount: plan.steps.length });
        return goal;
    }

    _goalRequest(row) {
        const title = text(row && row.title).trim();
        const description = text(row && row.description).trim();
        if (title && description) return `${title}\n\n${description}`;
        return title || description || 'Pursue the goal.';
    }

    /**
     * Accept whatever shape a planner hands back (a plan object, a bare array,
     * a `{tasks}` wrapper, plain strings) and normalize it into steps with
     * unique ids and dependencies that actually resolve.
     */
    _tasksOf(produced) {
        let list = null;
        if (Array.isArray(produced)) {
            list = produced;
        } else if (produced && typeof produced === 'object') {
            for (const key of ['tasks', 'steps', 'plan', 'subtasks']) {
                if (Array.isArray(produced[key])) { list = produced[key]; break; }
            }
        }
        if (!Array.isArray(list)) return [];

        const seen = new Set();
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
            const item = list[i];
            if (item === null || item === undefined) continue;
            const entry = typeof item === 'string' ? { description: item } : item;
            if (typeof entry !== 'object') continue;

            const description = text(
                entry.description || entry.task || entry.prompt || entry.instruction
                || entry.goal || entry.name
            ).trim();
            if (!description) continue;

            let stepId = text(entry.id).trim() || `s${out.length + 1}`;
            while (seen.has(stepId)) stepId = `${stepId}_${out.length + 1}`;
            seen.add(stepId);

            const rawDeps = entry.dependsOn ?? entry.depends_on ?? entry.deps ?? entry.dependencies ?? [];
            out.push({
                id: stepId,
                type: text(entry.type).trim() || 'general',
                description,
                dependsOn: (Array.isArray(rawDeps) ? rawDeps : [rawDeps]).map((d) => text(d).trim()).filter(Boolean),
                suggestedAgent: text(entry.suggestedAgent || entry.agent || entry.assignee).trim() || null,
                args: entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args) ? { ...entry.args } : {},
            });
        }

        // Drop dependencies that point at nothing, and self-references — an
        // unsatisfiable dependency would stall the goal forever.
        const ids = new Set(out.map((t) => t.id));
        return out.map((task) => ({
            ...task,
            dependsOn: [...new Set(task.dependsOn.filter((d) => d !== task.id && ids.has(d)))],
        }));
    }

    // =========================================================================
    //  CONTEXT GATHERING — memories + skills, both optional
    // =========================================================================

    _gatherContext(goal, step) {
        const query = `${text(goal && goal.title)} ${text(step && step.description)}`.trim();
        const out = { query, memories: [], skillNames: [], skillsPrompt: '' };

        if (this.memorySearch) {
            try {
                let rows = [];
                if (typeof this.memorySearch.search === 'function') {
                    rows = this.memorySearch.search(query, {
                        chatId: text(goal && goal.chat_id) || undefined,
                        agentId: text(goal && goal.owner_agent) || undefined,
                        limit: MAX_MEMORIES,
                    }) || [];
                }
                if ((!rows || !rows.length) && typeof this.memorySearch.recentContext === 'function') {
                    rows = this.memorySearch.recentContext(text(goal && goal.chat_id), MAX_MEMORIES) || [];
                }
                out.memories = (Array.isArray(rows) ? rows : []).slice(0, MAX_MEMORIES).map((row) => ({
                    summary: clip((row && (row.summary || row.raw_text || row.text)) || row, 400),
                    score: Number(row && row.score) || 0,
                }));
            } catch (err) {
                console.warn(`[GoalEngine] Memory lookup failed: ${errorMessage(err)}`);
            }
        }

        if (this.skills) {
            try {
                let hits = [];
                if (typeof this.skills.search === 'function') {
                    hits = this.skills.search(query) || [];
                }
                out.skillNames = (Array.isArray(hits) ? hits : [])
                    .slice(0, MAX_SKILLS)
                    .map((s) => text(s && s.name ? s.name : s).trim())
                    .filter(Boolean);
                if (out.skillNames.length && typeof this.skills.renderForPrompt === 'function') {
                    out.skillsPrompt = clip(
                        this.skills.renderForPrompt(out.skillNames, { budget: SKILL_PROMPT_BUDGET }),
                        SKILL_PROMPT_BUDGET
                    );
                }
            } catch (err) {
                console.warn(`[GoalEngine] Skill lookup failed: ${errorMessage(err)}`);
            }
        }

        return out;
    }

    /** The prompt one step runs with: the goal, the step, and what we know. */
    _composePrompt(goal, step, plan, gathered) {
        const parts = ['You are pursuing a persistent goal autonomously. Complete ONLY the current step.'];
        parts.push(`GOAL: ${text(goal && goal.title)}`);

        const description = text(goal && goal.description).trim();
        if (description) parts.push(`GOAL DETAIL: ${clip(description, 1500)}`);

        const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
        if (steps.length > 1) {
            const checklist = steps
                .map((s) => `  [${s.status === STEP_STATUS.OK ? 'x' : ' '}] ${s.id}: ${clip(s.description, 200)}`)
                .join('\n');
            parts.push(`PLAN (${steps.length} steps):\n${checklist}`);
        }

        const upstream = this._upstreamOutputs(step, steps);
        if (upstream.length) {
            parts.push(`RESULTS SO FAR:\n${upstream.map((u) => `  ${u.id}: ${clip(u.output, 800)}`).join('\n')}`);
        }

        if (gathered && gathered.memories.length) {
            parts.push(`RELEVANT MEMORY:\n${gathered.memories.map((m) => `  - ${m.summary}`).join('\n')}`);
        }
        if (gathered && gathered.skillsPrompt) parts.push(gathered.skillsPrompt);

        const guidance = this._latestGuidance(goal);
        if (guidance) parts.push(`COUNCIL GUIDANCE AFTER REPEATED FAILURE:\n${clip(guidance, 1500)}`);

        const answers = this._latestInputs(goal);
        if (answers.length) {
            const rendered = answers
                .map((a) => `  Q: ${clip(a.question, 200)}\n  A: ${clip(a.answer, 500)}`)
                .join('\n');
            parts.push(`USER ANSWERS:\n${rendered}`);
        }

        if (step && step.error) parts.push(`THE PREVIOUS ATTEMPT FAILED WITH: ${clip(step.error, 500)}`);
        parts.push(`CURRENT STEP (${step && step.id}): ${text(step && step.description)}`);
        return parts.join('\n\n');
    }

    _upstreamOutputs(step, steps) {
        const deps = step && Array.isArray(step.dependsOn) ? step.dependsOn : [];
        if (!deps.length) return [];
        const byId = new Map((steps || []).map((s) => [s.id, s]));
        return deps
            .map((id) => byId.get(id))
            .filter((s) => s && s.status === STEP_STATUS.OK && s.output)
            .map((s) => ({ id: s.id, output: s.output }));
    }

    _latestGuidance(goal) {
        const list = goal && goal.context && Array.isArray(goal.context.councilGuidance)
            ? goal.context.councilGuidance
            : [];
        const last = list[list.length - 1];
        return last ? text(last.guidance || last.text) : '';
    }

    _latestInputs(goal) {
        const list = goal && goal.context && Array.isArray(goal.context.inputs) ? goal.context.inputs : [];
        return list.slice(-3).map((entry) => ({
            question: text(entry && entry.question),
            answer: text(entry && entry.answer),
        }));
    }

    // =========================================================================
    //  STEP — exactly ONE unit of work per call
    // =========================================================================

    /**
     * Advance a goal by one unit of work and return. Planning counts as a unit,
     * so a `pending` goal is planned by the first call and its first step runs
     * on the second. NEVER throws: every failure comes back in the result.
     *
     * @returns {Promise<{goalId:string, status:string, stepId:string|null,
     *                    ok:boolean, output:string|null, error:string|null,
     *                    progress:number, done:boolean}>}
     */
    async step(id) {
        const key = text(id).trim();
        const shape = (extra = {}) => ({
            goalId: key,
            status: GOAL_STATUS.PENDING,
            stepId: null,
            ok: false,
            output: null,
            error: null,
            progress: 0,
            done: false,
            ...extra,
        });

        try {
            const goal = this.get(key);
            if (!goal) {
                console.warn(`[GoalEngine] step(${key}): no such goal`);
                return shape({ error: 'no such goal', done: true });
            }
            if (TERMINAL_STATUSES.includes(String(goal.status))) {
                // A completed / abandoned / blocked / waiting goal consumes no
                // more work. This is what stops a blocked goal from spinning.
                return shape({
                    status: goal.status,
                    progress: goal.progress,
                    error: goal.last_error || null,
                    ok: goal.status === GOAL_STATUS.COMPLETED,
                    done: true,
                });
            }
            if (this.stepping.has(goal.id)) {
                console.warn(`[GoalEngine] step(${goal.id}): already in flight, skipping`);
                return shape({ status: goal.status, progress: goal.progress, error: 'already in flight' });
            }

            this.stepping.add(goal.id);
            try {
                return await this._stepOnce(goal, shape);
            } finally {
                this.stepping.delete(goal.id);
            }
        } catch (err) {
            // The contract is absolute: step() never throws at its caller.
            console.warn(`[GoalEngine] step(${key}) failed unexpectedly: ${errorMessage(err)}`);
            const current = this.get(key);
            return shape({
                status: current ? current.status : GOAL_STATUS.PENDING,
                progress: current ? current.progress : 0,
                error: errorMessage(err),
                done: current ? current.done : false,
            });
        }
    }

    async _stepOnce(goal, shape) {
        // --- Unit of work #0: planning ---------------------------------------
        if (!goal.plan || !Array.isArray(goal.steps) || !goal.steps.length) {
            const planned = await this.planGoal(goal.id);
            if (!planned || !planned.steps.length) {
                const blocked = this._block(goal, 'planning produced no steps');
                return shape({
                    status: blocked.status,
                    progress: blocked.progress,
                    error: blocked.last_error,
                    done: true,
                });
            }
            return shape({
                status: planned.status,
                progress: planned.progress,
                ok: true,
                output: `Planned ${planned.steps.length} step(s).`,
                done: false,
            });
        }

        const plan = goal.plan;
        const steps = goal.steps;

        // --- Pick the next ready step ----------------------------------------
        const byId = new Map(steps.map((s) => [s.id, s]));
        const isDone = (s) => Boolean(s) && s.status === STEP_STATUS.OK;
        const ready = steps.find((s) => s.status === STEP_STATUS.PENDING
            && (s.dependsOn || []).every((dep) => isDone(byId.get(dep))));

        if (!ready) {
            const remaining = steps.filter((s) => s.status === STEP_STATUS.PENDING);
            if (!remaining.length) return shape(this._complete(goal, plan));
            // Nothing runnable but work outstanding: the graph cannot be
            // satisfied (a cycle, or a step wedged behind a failed one).
            const blocked = this._block(
                goal,
                `unsatisfiable plan: ${remaining.map((s) => s.id).join(', ')} cannot start`
            );
            return shape({
                status: blocked.status,
                progress: blocked.progress,
                error: blocked.last_error,
                done: true,
            });
        }

        // --- Gather context, then run exactly this one step --------------------
        const gathered = this._gatherContext(goal, ready);
        const prompt = this._composePrompt(goal, ready, plan, gathered);

        ready.startedAt = this._now();
        ready.attempts = (Number(ready.attempts) || 0) + 1;
        this._emit({ goalId: goal.id, stepId: ready.id, status: 'started' });

        let output = null;
        let failure = null;
        let agentUsed = null;
        try {
            const executed = await this._runStep(goal, ready, prompt, gathered);
            output = clip(executed && executed.output, MAX_OUTPUT_CHARS);
            agentUsed = executed && executed.agent ? text(executed.agent) : null;
            if (!output) output = 'Completed with no output.';
        } catch (err) {
            failure = errorMessage(err);
        }

        if (failure) return shape(await this._recordFailure(goal, plan, ready, failure));
        return shape(this._recordSuccess(goal, plan, ready, output, agentUsed, gathered));
    }

    /**
     * Execute one step under the step timeout. Delegation goes first (it owns
     * the depth and cycle guards), then an injected taskRunner, then the
     * planner's own run(). With none of them wired the step fails honestly
     * rather than reporting phantom progress.
     */
    async _runStep(goal, step, prompt, gathered) {
        const run = Promise.resolve().then(() => this._dispatch(goal, step, prompt, gathered));
        if (!this.stepTimeoutMs) return run;

        let timer = null;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error(`Step ${step.id} timed out after ${Math.round(this.stepTimeoutMs / 1000)}s`)),
                this.stepTimeoutMs
            );
            if (timer && timer.unref) timer.unref();
        });
        return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    }

    async _dispatch(goal, step, prompt, gathered) {
        const toAgent = this._resolveAgent(goal, step);

        if (this.delegation && toAgent && typeof this.delegation.delegateAndRun === 'function') {
            const owner = text(goal.owner_agent).trim();
            const task = await this.delegation.delegateAndRun({
                fromAgent: owner && owner !== toAgent ? owner : GOAL_EVENT_KEY,
                toAgent,
                prompt,
                chatId: text(goal.chat_id),
            });
            if (!task) throw new Error(`delegation returned nothing for step ${step.id}`);
            const status = text(task.status);
            if (status && status !== 'completed') {
                throw new Error(text(task.result) || `delegated step ${step.id} ended as ${status}`);
            }
            return { output: text(task.result), agent: toAgent };
        }

        if (this.taskRunner) {
            const output = await this.taskRunner({
                goal, step, prompt, context: gathered, agent: toAgent,
            });
            return { output, agent: toAgent };
        }

        if (this.planner && typeof this.planner.run === 'function') {
            const result = await this.planner.run(prompt, { chatId: text(goal.chat_id) });
            if (result && result.ok === false) {
                throw new Error(text(result.error) || `planner run failed for step ${step.id}`);
            }
            return { output: text(result && result.answer !== undefined ? result.answer : result), agent: toAgent };
        }

        throw new Error('no executor available: inject delegation, taskRunner or a planner');
    }

    /** Which agent carries this step? Never invent one delegation would reject. */
    _resolveAgent(goal, step) {
        const candidates = [
            text(step && step.suggestedAgent).trim(),
            text(goal && goal.owner_agent).trim(),
        ].filter(Boolean);

        if (this.planner && typeof this.planner.selectModel === 'function') {
            try {
                const agents = this.delegation && typeof this.delegation.agentKeys === 'function'
                    ? this.delegation.agentKeys()
                    : undefined;
                const selection = this.planner.selectModel({
                    type: step && step.type,
                    description: step && step.description,
                    suggestedAgent: step && step.suggestedAgent,
                }, { agents });
                const picked = text(selection && (selection.agent || selection.id)).trim();
                if (picked) candidates.push(picked);
            } catch (err) {
                console.warn(`[GoalEngine] Model selection failed for ${step && step.id}: ${errorMessage(err)}`);
            }
        }

        if (!this.delegation || typeof this.delegation.hasAgent !== 'function') {
            return candidates[0] || null;
        }
        for (const candidate of candidates) {
            try {
                if (this.delegation.hasAgent(candidate)) return candidate;
            } catch (err) {
                console.warn(`[GoalEngine] hasAgent(${candidate}) failed: ${errorMessage(err)}`);
            }
        }
        try {
            const keys = typeof this.delegation.agentKeys === 'function' ? this.delegation.agentKeys() : [];
            return keys && keys.length ? text(keys[0]) : null;
        } catch (err) {
            console.warn(`[GoalEngine] agentKeys() failed: ${errorMessage(err)}`);
            return null;
        }
    }

    // =========================================================================
    //  OUTCOME BOOKKEEPING
    // =========================================================================

    _persistPlan(goalId, plan, patch = {}) {
        return this._update(goalId, { plan_json: plan, ...patch });
    }

    _progressOf(plan, previous) {
        const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
        if (!steps.length) return clamp01(previous);
        const settled = steps.filter((s) => s.status === STEP_STATUS.OK).length;
        // Monotonic on purpose: progress is a report to a human, and a number
        // that slides backwards reads as a bug even when the maths is right.
        return clamp01(Math.max(Number(previous) || 0, settled / steps.length));
    }

    _recordSuccess(goal, plan, step, output, agentUsed, gathered) {
        step.status = STEP_STATUS.OK;
        step.output = output;
        step.error = null;
        step.completedAt = this._now();
        step.agent = agentUsed || step.agent || null;

        const progress = this._progressOf(plan, goal.progress);
        const context = this._contextWith(goal, {
            history: [{
                at: this._now(),
                stepId: step.id,
                ok: true,
                agent: step.agent,
                memories: (gathered && gathered.memories.length) || 0,
                skills: (gathered && gathered.skillNames) || [],
            }],
        });

        const allDone = plan.steps.every((s) => s.status === STEP_STATUS.OK);
        const patch = {
            progress,
            attempts: 0,
            last_error: null,
            context_json: context,
            status: allDone ? GOAL_STATUS.COMPLETED : GOAL_STATUS.RUNNING,
        };
        if (allDone) patch.completed_at = this._now();

        const updated = this._persistPlan(goal.id, plan, patch);
        this._journal('goal_step_ok', updated || goal, `${goal.title} / ${step.id}: ${clip(output, 300)}`);
        this._emit({ goalId: goal.id, stepId: step.id, status: 'ok', progress });

        if (allDone) {
            this._journal('goal_completed', updated || goal, `${goal.title} completed`);
            this._remember(updated || goal, `Goal "${goal.title}" completed. Final step output: ${clip(output, 800)}`);
            this._emit({ goalId: goal.id, status: 'completed', progress: 1 });
        }

        return {
            status: updated ? updated.status : patch.status,
            stepId: step.id,
            ok: true,
            output,
            error: null,
            progress: updated ? updated.progress : progress,
            done: allDone,
        };
    }

    /**
     * THE FAILURE POLICY, in one place:
     *   1. attempts += 1; the step stays retryable and the goal stays `running`
     *   2. attempts <  max_attempts -> retry on the next step() call
     *   3. attempts >= max_attempts -> ask the council ONCE, record the answer
     *      on the goal, and grant exactly one grace attempt
     *   4. still failing (or no council at all) -> `blocked` with `last_error`,
     *      and no further work is ever consumed
     */
    async _recordFailure(goal, plan, step, failure) {
        step.error = clip(failure, MAX_ERROR_CHARS);
        step.completedAt = this._now();

        const attempts = (Number(goal.attempts) || 0) + 1;
        const max = positiveInt(goal.max_attempts, this.maxAttempts);
        const progress = this._progressOf(plan, goal.progress);
        const historyEntry = {
            at: this._now(),
            stepId: step.id,
            ok: false,
            error: clip(failure, 500),
            attempt: attempts,
        };

        console.warn(`[GoalEngine] Goal ${goal.id} step ${step.id} failed (attempt ${attempts}/${max}): ${failure}`);
        this._emit({ goalId: goal.id, stepId: step.id, status: 'failed', error: failure });

        // --- 2. Retries still available ---------------------------------------
        if (attempts < max) {
            const updated = this._persistPlan(goal.id, plan, {
                status: GOAL_STATUS.RUNNING,
                attempts,
                last_error: failure,
                progress,
                context_json: this._contextWith(goal, { history: [historyEntry] }),
            });
            return {
                status: updated ? updated.status : GOAL_STATUS.RUNNING,
                stepId: step.id,
                ok: false,
                output: null,
                error: clip(failure, MAX_ERROR_CHARS),
                progress: updated ? updated.progress : progress,
                done: false,
            };
        }

        // --- 3. Retries exhausted: one second opinion, exactly once ------------
        const consulted = Boolean(goal.context && goal.context.councilConsulted);
        if (!consulted && this.council && typeof this.council.deliberate === 'function') {
            const guidance = await this._askCouncil(goal, step, failure);
            const updated = this._persistPlan(goal.id, plan, {
                status: GOAL_STATUS.RUNNING,
                // The grace attempt: the next failure lands back on `max` and,
                // with councilConsulted set, falls straight through to blocked.
                attempts: Math.max(0, max - 1),
                last_error: failure,
                progress,
                context_json: this._contextWith(goal, {
                    history: [historyEntry],
                    councilConsulted: true,
                    councilGuidance: [{
                        at: this._now(),
                        stepId: step.id,
                        error: clip(failure, 500),
                        guidance: clip(guidance.text, 2000),
                        ok: guidance.ok,
                    }],
                }),
            });
            this._journal('goal_council', updated || goal, `${goal.title} / ${step.id}: ${clip(guidance.text, 300)}`);
            return {
                status: updated ? updated.status : GOAL_STATUS.RUNNING,
                stepId: step.id,
                ok: false,
                output: null,
                error: clip(failure, MAX_ERROR_CHARS),
                progress: updated ? updated.progress : progress,
                done: false,
            };
        }

        // --- 4. Give up, loudly and permanently -------------------------------
        step.status = STEP_STATUS.FAILED;
        for (const other of plan.steps) {
            if (other.status === STEP_STATUS.PENDING && (other.dependsOn || []).includes(step.id)) {
                other.status = STEP_STATUS.SKIPPED;
                other.error = `dependency ${step.id} failed`;
            }
        }

        const updated = this._persistPlan(goal.id, plan, {
            status: GOAL_STATUS.BLOCKED,
            attempts,
            last_error: failure,
            progress,
            context_json: this._contextWith(goal, { history: [historyEntry] }),
        });
        this._journal('goal_blocked', updated || goal, `${goal.title} / ${step.id} blocked: ${clip(failure, 300)}`);
        this._remember(updated || goal, `Goal "${goal.title}" is blocked at step ${step.id}: ${clip(failure, 800)}`);
        this._emit({ goalId: goal.id, stepId: step.id, status: 'blocked', error: failure });

        return {
            status: GOAL_STATUS.BLOCKED,
            stepId: step.id,
            ok: false,
            output: null,
            error: clip(failure, MAX_ERROR_CHARS),
            progress: updated ? updated.progress : progress,
            done: true,
        };
    }

    async _askCouncil(goal, step, failure) {
        const question = [
            'A persistent goal is stuck. Advise on how to proceed.',
            `GOAL: ${text(goal.title)}`,
            text(goal.description).trim() ? `DETAIL: ${clip(goal.description, 800)}` : '',
            `FAILING STEP (${step.id}): ${text(step.description)}`,
            `ERROR AFTER ${goal.max_attempts} ATTEMPT(S): ${clip(failure, 800)}`,
            'Should the step be reformulated, delegated elsewhere, or is the goal itself unachievable?',
        ].filter(Boolean).join('\n');

        try {
            const result = await this.council.deliberate(question, {
                chatId: text(goal.chat_id),
                rounds: 1,
                requestId: `goal_${goal.id}_${step.id}`,
            });
            const synthesis = result && result.synthesis;
            const body = text(
                (synthesis && (synthesis.text || synthesis))
                || (result && result.answer)
                || (result && result.text)
            ).trim();
            if (!body) {
                const why = result && result.error ? `: ${text(result.error)}` : '';
                return { ok: false, text: `Council returned no guidance${why}` };
            }
            return { ok: result ? result.ok !== false : false, text: body };
        } catch (err) {
            console.warn(`[GoalEngine] Council guidance failed for ${goal.id}: ${errorMessage(err)}`);
            return { ok: false, text: `Council unavailable: ${errorMessage(err)}` };
        }
    }

    _complete(goal, plan) {
        const updated = this._update(goal.id, {
            status: GOAL_STATUS.COMPLETED,
            progress: 1,
            attempts: 0,
            last_error: null,
            completed_at: this._now(),
        });
        const count = (plan && Array.isArray(plan.steps) ? plan.steps : []).length;
        this._journal('goal_completed', updated || goal, `${goal.title} completed`);
        this._remember(updated || goal, `Goal "${goal.title}" completed (${count} step(s)).`);
        this._emit({ goalId: goal.id, status: 'completed', progress: 1 });
        return {
            status: GOAL_STATUS.COMPLETED,
            stepId: null,
            ok: true,
            output: 'Goal already complete.',
            error: null,
            progress: 1,
            done: true,
        };
    }

    _block(goal, reason) {
        const why = clip(reason, MAX_ERROR_CHARS);
        console.warn(`[GoalEngine] Goal ${goal.id} blocked: ${why}`);
        const updated = this._update(goal.id, { status: GOAL_STATUS.BLOCKED, last_error: why });
        this._journal('goal_blocked', updated || goal, `${goal.title}: ${why}`);
        this._emit({ goalId: goal.id, status: 'blocked', error: why });
        return updated || { status: GOAL_STATUS.BLOCKED, progress: goal.progress, last_error: why };
    }

    /** Merge into context_json: arrays append (bounded), scalars overwrite. */
    _contextWith(goal, patch = {}) {
        const base = (goal && goal.context && typeof goal.context === 'object') ? { ...goal.context } : {};
        base.history = Array.isArray(base.history) ? base.history : [];
        base.councilGuidance = Array.isArray(base.councilGuidance) ? base.councilGuidance : [];
        base.inputs = Array.isArray(base.inputs) ? base.inputs : [];

        for (const [key, value] of Object.entries(patch)) {
            if (Array.isArray(base[key]) && Array.isArray(value)) {
                base[key] = [...base[key], ...value].slice(-MAX_HISTORY_ENTRIES);
            } else {
                base[key] = value;
            }
        }
        return base;
    }

    // =========================================================================
    //  BOUNDED DRIVER
    // =========================================================================

    /**
     * Call step() until the goal stops making progress. The bound is mandatory:
     * without it a cheap-and-always-failing step would spin the event loop.
     * @returns {Promise<{goalId, status, progress, done, stepsRun, results, reason}>}
     */
    async runUntilBlocked(id, { maxSteps = 10 } = {}) {
        const key = text(id).trim();
        const cap = Math.min(1000, positiveInt(maxSteps, 10));
        const results = [];
        let last = null;
        let reason = `maxSteps (${cap}) reached`;

        for (let i = 0; i < cap; i += 1) {
            last = await this.step(key);
            results.push(last);
            if (!last) { reason = 'step returned nothing'; break; }
            if (last.done) { reason = `goal is ${last.status}`; break; }
            if (!last.ok && last.error === 'already in flight') { reason = 'already in flight'; break; }
        }

        const goal = this.get(key);
        return {
            goalId: key,
            status: goal ? goal.status : ((last && last.status) || GOAL_STATUS.PENDING),
            progress: goal ? goal.progress : ((last && last.progress) || 0),
            done: goal ? goal.done : Boolean(last && last.done),
            stepsRun: results.length,
            results,
            reason,
        };
    }

    // =========================================================================
    //  UNATTENDED PROGRESS
    // =========================================================================

    /**
     * Register a Scheduler task handler so goals advance with nobody watching.
     * core/Scheduler.js is owned elsewhere and is NOT modified: this only calls
     * its public registerTaskHandler(), plus scheduleTask() to create the cron
     * row when one is not already installed.
     *
     * @returns {{registered:boolean, agentId:string, schedule:string,
     *            taskId:string|null, error:string|null}}
     */
    registerWithScheduler(scheduler, {
        schedule = DEFAULT_SCHEDULE,
        agentId = SCHEDULER_AGENT_ID,
        chatId = '',
        maxGoals = MAX_GOALS_PER_TICK,
    } = {}) {
        const target = scheduler || this.scheduler;
        const out = {
            registered: false,
            agentId: String(agentId || SCHEDULER_AGENT_ID),
            schedule: String(schedule || DEFAULT_SCHEDULE),
            taskId: null,
            error: null,
        };

        if (!target || typeof target.registerTaskHandler !== 'function') {
            out.error = 'scheduler does not expose registerTaskHandler()';
            console.warn(`[GoalEngine] ${out.error}`);
            return out;
        }

        try {
            target.registerTaskHandler(out.agentId, (task) => this.tick({
                chatId: text(task && task.chat_id) || text(chatId),
                maxGoals,
            }));
            out.registered = true;
            this.scheduler = target;
        } catch (err) {
            out.error = errorMessage(err);
            console.warn(`[GoalEngine] registerTaskHandler failed: ${out.error}`);
            return out;
        }

        // Best-effort cron row so the handler actually gets called. Its absence
        // is not an error — an embedder may drive tick() on its own cadence.
        try {
            if (typeof target.scheduleTask === 'function'
                && this.database && typeof this.database.getScheduledTasks === 'function') {
                const existing = (this.database.getScheduledTasks() || [])
                    .find((row) => String(row.agent_id) === out.agentId);
                if (existing) {
                    out.taskId = String(existing.id);
                } else {
                    const created = target.scheduleTask({
                        chatId: text(chatId),
                        agentId: out.agentId,
                        prompt: 'Advance autonomous goals',
                        schedule: out.schedule,
                    });
                    out.taskId = created && created.id ? String(created.id) : null;
                }
            }
        } catch (err) {
            console.warn(`[GoalEngine] Could not install the goal cron row: ${errorMessage(err)}`);
        }

        return out;
    }

    /**
     * One unattended sweep: advance a bounded number of active goals by exactly
     * one step each. Returns a text line, which is what Scheduler records as
     * the task result. Never throws.
     */
    async tick({ chatId = '', maxGoals = MAX_GOALS_PER_TICK } = {}) {
        const cap = positiveInt(maxGoals, MAX_GOALS_PER_TICK);
        let goals = [];
        try {
            goals = this.list({ status: ACTIVE_STATUSES, chatId: text(chatId) || null, limit: cap });
        } catch (err) {
            console.warn(`[GoalEngine] tick() listing failed: ${errorMessage(err)}`);
            return '[GoalEngine] tick: could not list goals';
        }
        if (!goals.length) return '[GoalEngine] tick: no active goals';

        const lines = [];
        for (const goal of goals) {
            const result = await this.step(goal.id);
            lines.push(
                `${goal.id} (${clip(goal.title, 60)}): ${result.status}`
                + `${result.stepId ? ` step=${result.stepId}` : ''}`
                + ` ${result.ok ? 'ok' : `error=${clip(result.error, 120)}`}`
            );
        }
        return `[GoalEngine] tick: advanced ${lines.length} goal(s)\n${lines.join('\n')}`;
    }

    // =========================================================================
    //  ASKING THE USER
    //
    //  Inventing an answer to an ambiguous requirement is worse than pausing:
    //  the goal then burns its remaining attempts pursuing the wrong thing, and
    //  every downstream step inherits the wrong assumption.
    // =========================================================================

    /** Park the goal on a question. It consumes no further work until answered. */
    needsInput(id, question) {
        const ask = text(question).trim();
        if (!ask) throw new Error('[GoalEngine] needsInput() requires a question');

        const row = this._row(id);
        if (!row) {
            console.warn(`[GoalEngine] needsInput(${id}): no such goal`);
            return null;
        }
        if (row.status === GOAL_STATUS.ABANDONED || row.status === GOAL_STATUS.COMPLETED) {
            console.warn(`[GoalEngine] needsInput(${row.id}): goal is already ${row.status}`);
            return this._decorate(row);
        }

        const goal = this._decorate(row);
        const updated = this._update(row.id, {
            status: GOAL_STATUS.NEEDS_INPUT,
            context_json: this._contextWith(goal, {
                pendingQuestion: { at: this._now(), question: clip(ask, 2000) },
            }),
        });
        this._journal('goal_needs_input', updated || goal, `${row.title}: ${clip(ask, 300)}`);
        this._emit({ goalId: row.id, status: 'needs_input' });
        return updated;
    }

    /** Record the answer and put the goal back to work. */
    provideInput(id, answer) {
        const body = text(answer).trim();
        if (!body) throw new Error('[GoalEngine] provideInput() requires a non-empty answer');

        const row = this._row(id);
        if (!row) {
            console.warn(`[GoalEngine] provideInput(${id}): no such goal`);
            return null;
        }

        const goal = this._decorate(row);
        const pending = goal.context && goal.context.pendingQuestion ? goal.context.pendingQuestion : null;
        const hasPlan = Boolean(goal.plan && Array.isArray(goal.plan.steps) && goal.plan.steps.length);
        const stillTerminal = row.status === GOAL_STATUS.COMPLETED || row.status === GOAL_STATUS.ABANDONED;

        const updated = this._update(row.id, {
            status: stillTerminal ? row.status : (hasPlan ? GOAL_STATUS.RUNNING : GOAL_STATUS.PENDING),
            attempts: 0,
            last_error: null,
            context_json: this._contextWith(goal, {
                pendingQuestion: null,
                inputs: [{
                    at: this._now(),
                    question: clip(pending && pending.question, 2000),
                    answer: clip(body, 2000),
                }],
            }),
        });
        this._journal('goal_input', updated || goal, `${row.title}: ${clip(body, 300)}`);
        this._emit({ goalId: row.id, status: 'resumed' });
        return updated;
    }

    /** The outstanding question, or '' — what a banner or a route renders. */
    pendingQuestion(id) {
        const goal = this.get(id);
        const pending = goal && goal.context ? goal.context.pendingQuestion : null;
        return pending ? text(pending.question) : '';
    }

    // =========================================================================
    //  SUMMARY — for the banner and the UI
    // =========================================================================

    /** Counts by status, with every known status present (zero-filled). */
    summary() {
        const byStatus = {};
        for (const status of GOAL_STATUSES) byStatus[status] = 0;

        let total = 0;
        try {
            const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM goals GROUP BY status').all();
            for (const row of rows || []) {
                const status = text(row && row.status) || GOAL_STATUS.PENDING;
                const count = Number(row && row.count) || 0;
                byStatus[status] = (byStatus[status] || 0) + count;
                total += count;
            }
        } catch (err) {
            console.warn(`[GoalEngine] summary() failed: ${errorMessage(err)}`);
        }

        const active = ACTIVE_STATUSES.reduce((sum, status) => sum + (byStatus[status] || 0), 0);
        return {
            total,
            active,
            attention: (byStatus[GOAL_STATUS.BLOCKED] || 0) + (byStatus[GOAL_STATUS.NEEDS_INPUT] || 0),
            byStatus,
            ...byStatus,
        };
    }
}

module.exports = GoalEngine;
module.exports.GoalEngine = GoalEngine;
module.exports.GOAL_STATUS = GOAL_STATUS;
module.exports.GOAL_STATUSES = GOAL_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
module.exports.STEP_STATUS = STEP_STATUS;
module.exports.DEFAULT_GOAL_SCHEDULE = DEFAULT_SCHEDULE;
module.exports.SCHEDULER_AGENT_ID = SCHEDULER_AGENT_ID;
