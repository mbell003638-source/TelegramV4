// =============================================================================
//  core/AgentDelegation.js — Agent-to-Agent Delegation over `inter_agent_tasks`
//
//  The schema shipped an `inter_agent_tasks` table that nothing ever read or
//  wrote: agents shared memory and conversation context, but one agent could
//  not hand work to another. This module makes that table real.
//
//    1. delegate()  validates the target and persists a `pending` row
//    2. run()       dispatches the prompt at the target agent, then records
//                   result + completed_at + status (completed / failed)
//    3. getTasks() / pending() / getTask() / cancel() — the read surface
//
//  LOOP SAFETY — the reason the depth and cycle guards exist:
//  A delegating to B while B delegates back to A is an unbounded spend loop.
//  The delegation chain is encoded in the task id itself, so depth and
//  ancestry survive a restart without widening the table:
//
//      iad_9f3a21c4                depth 1    main   -> claude
//      iad_9f3a21c4.7b2e           depth 2    claude -> codex
//      iad_9f3a21c4.7b2e.c1d0      depth 3    codex  -> hermes   (maxDepth)
//
//  A 4th hop is refused, and so is any hop whose target already appears in
//  its own ancestor chain.
//
//  Persistence lives here rather than in core/Database.js: it drives the raw
//  `database.db` (node:sqlite DatabaseSync) handle and uses only the columns
//  the table already has. Node builtins only.
// =============================================================================
const crypto = require('node:crypto');

const MAX_RESULT_CHARS = 4000;
const DEFAULT_MAX_DEPTH = 3;

const DELEGATION_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

const DELEGATION_EVENTS = {
    CREATED: 'agent.delegation.created',
    STARTED: 'agent.delegation.started',
    COMPLETED: 'agent.delegation.completed',
    FAILED: 'agent.delegation.failed',
    CANCELLED: 'agent.delegation.cancelled',
};

function text(value) {
    return String(value === undefined || value === null ? '' : value);
}

function clipResult(value) {
    const body = text(value);
    return body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n...[truncated]` : body;
}

class AgentDelegation {
    /**
     * @param {object}   opts
     * @param {object}   opts.database         AssistantDatabase (or any object exposing
     *                                         a node:sqlite handle as `.db`) — required
     * @param {object}   [opts.agents]         agentKey -> agent map (or a Map). Targets
     *                                         are validated against its keys.
     * @param {object}   [opts.actionExecutor] ActionExecutor — the default dispatch path
     * @param {object}   [opts.eventBus]       Anything with .emit(event, payload)
     * @param {Function} [opts.runner]         async (task) => resultText. Overrides the
     *                                         ActionExecutor path; used by tests and by
     *                                         embedders that dispatch work themselves.
     * @param {number}   [opts.maxDepth]       Delegation hops allowed in one chain, default 3
     * @param {number}   [opts.runTimeoutMs]   Per-run timeout, default 10 min (0 disables)
     * @param {number}   [opts.pollMs]         ActionExecutor idle poll interval, default 500
     * @param {Function} [opts.dispatchChatId] (task) => chatId used for the ActionExecutor
     *                                         hand-off. The default is NOT the user's chat
     *                                         id on purpose — see _dispatchChatId().
     * @param {Function} [opts.now]            Injectable clock, default () => Date.now()
     */
    constructor({
        database,
        agents = {},
        actionExecutor = null,
        eventBus = null,
        runner = null,
        maxDepth = DEFAULT_MAX_DEPTH,
        runTimeoutMs = 10 * 60 * 1000,
        pollMs = 500,
        dispatchChatId = null,
        now = null,
    } = {}) {
        if (!database) throw new Error('[AgentDelegation] A database instance is required');
        const handle = database.db && typeof database.db.prepare === 'function' ? database.db : database;
        if (!handle || typeof handle.prepare !== 'function') {
            throw new Error('[AgentDelegation] database must expose a node:sqlite handle (database.db)');
        }

        this.database = database;
        this.db = handle;
        this.agents = agents || {};
        this.actionExecutor = actionExecutor;
        this.eventBus = eventBus;
        this.runner = typeof runner === 'function' ? runner : null;
        this.maxDepth = Number(maxDepth) > 0 ? Math.floor(Number(maxDepth)) : DEFAULT_MAX_DEPTH;
        this.runTimeoutMs = Number(runTimeoutMs) >= 0 ? Number(runTimeoutMs) : 0;
        this.pollMs = Number(pollMs) > 0 ? Number(pollMs) : 500;
        this._dispatchChatIdFn = typeof dispatchChatId === 'function' ? dispatchChatId : null;
        this._clock = typeof now === 'function' ? now : () => Date.now();

        this.running = new Set();   // in-flight task ids — the double-run guard

        this._ensureSchema();
    }

    _now() {
        return this._clock();
    }

    /**
     * The table is created by core/Database.js; this is a no-op there and makes
     * the module usable against a bare DatabaseSync handle. The DDL is a copy of
     * the shipped one — same columns, no redesign — plus two lookup indexes.
     */
    _ensureSchema() {
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS inter_agent_tasks (
                    id            TEXT PRIMARY KEY,
                    from_agent    TEXT NOT NULL,
                    to_agent      TEXT NOT NULL,
                    chat_id       TEXT NOT NULL,
                    prompt        TEXT NOT NULL,
                    status        TEXT NOT NULL DEFAULT 'pending',
                    result        TEXT,
                    created_at    INTEGER NOT NULL,
                    completed_at  INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_inter_agent_queue
                    ON inter_agent_tasks(to_agent, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_inter_agent_chat
                    ON inter_agent_tasks(chat_id, created_at DESC);
            `);
        } catch (err) {
            console.warn(`[AgentDelegation] Schema check failed: ${err.message}`);
        }
    }

    // =========================================================================
    //  AGENT REGISTRY
    // =========================================================================

    /** Registered agent keys — accepts a plain object map or a Map. */
    agentKeys() {
        const agents = this.agents;
        if (!agents) return [];
        if (typeof agents.keys === 'function' && typeof agents.get === 'function') {
            return [...agents.keys()].map((key) => String(key));
        }
        return Object.keys(agents);
    }

    hasAgent(key) {
        const wanted = text(key).trim();
        return wanted !== '' && this.agentKeys().includes(wanted);
    }

    // =========================================================================
    //  DELEGATION CHAIN — encoded in the task id
    //
    //  Root:  iad_<8 hex>            Child: <parentId>.<4 hex>
    //  depth    = number of '.'-separated segments
    //  originId = first segment, parentId = everything but the last segment
    // =========================================================================

    _newId(parentId = null) {
        const seg = crypto.randomUUID().replace(/-/g, '');
        const parent = text(parentId).trim();
        return parent ? `${parent}.${seg.slice(0, 4)}` : `iad_${seg.slice(0, 8)}`;
    }

    _idDepth(id) {
        const value = text(id).trim();
        return value ? value.split('.').length : 0;
    }

    originOf(id) {
        const value = text(id).trim();
        return value ? value.split('.')[0] : null;
    }

    parentOf(id) {
        const parts = text(id).trim().split('.');
        return parts.length > 1 ? parts.slice(0, -1).join('.') : null;
    }

    /** Every ancestor row of `id`, root first, including the row for `id` itself. */
    _ancestorRows(id) {
        const parts = text(id).trim().split('.').filter(Boolean);
        if (parts.length === 0) return [];
        const ids = parts.map((_part, index) => parts.slice(0, index + 1).join('.'));
        try {
            const placeholders = ids.map(() => '?').join(', ');
            const rows = this.db
                .prepare(`SELECT * FROM inter_agent_tasks WHERE id IN (${placeholders})`)
                .all(...ids) || [];
            const byId = new Map(rows.map((row) => [String(row.id), row]));
            return ids.map((key) => byId.get(key)).filter(Boolean);
        } catch (err) {
            console.warn(`[AgentDelegation] Could not read the chain of ${id}: ${err.message}`);
            return [];
        }
    }

    /**
     * The agent chain that produced `taskId`, oldest first.
     * @returns {string[]} e.g. ['main', 'claude', 'codex']
     */
    chainOf(taskId) {
        const chain = [];
        for (const row of this._ancestorRows(taskId)) {
            if (chain.length === 0) chain.push(text(row.from_agent));
            chain.push(text(row.to_agent));
        }
        return chain;
    }

    /** Resolve how deep a prospective delegation sits and who is already in it. */
    _resolveAncestry({ fromAgent, parentId, originId, depth, chain }) {
        const parent = text(parentId).trim() || text(originId).trim() || '';
        let agents = [];
        let hops = 0;

        if (Array.isArray(chain) && chain.length > 0) {
            agents = chain.map((key) => text(key).trim()).filter(Boolean);
            hops = Math.max(agents.length - 1, 0);
        } else if (parent) {
            agents = this.chainOf(parent);
            // A parent row that has been deleted still contributes its encoded depth.
            hops = agents.length > 0 ? agents.length - 1 : this._idDepth(parent);
        }

        if (depth !== null && depth !== undefined && Number.isFinite(Number(depth))) {
            hops = Math.max(hops, Math.max(0, Math.floor(Number(depth))));
        }
        if (agents.length === 0) agents = [text(fromAgent).trim()].filter(Boolean);

        return { parentId: parent || null, chain: agents, hops };
    }

    // =========================================================================
    //  DELEGATE
    // =========================================================================

    /**
     * Persist a `pending` hand-off from one agent to another.
     *
     * @param {object}   opts
     * @param {string}   opts.fromAgent   who is asking (an agent key, 'main', a route, ...)
     * @param {string}   opts.toAgent     must be a key of the injected `agents` map
     * @param {string}   opts.prompt      the work, non-empty
     * @param {string}   [opts.chatId]    chat the delegation belongs to
     * @param {string}   [opts.parentId]  id of the task this one was spawned from —
     *                                    carries depth and ancestry forward
     * @param {string}   [opts.originId]  alias for parentId when only the origin is known
     * @param {number}   [opts.depth]     hops ALREADY travelled (0 for a top-level call);
     *                                    the new task lands at depth + 1
     * @param {string[]} [opts.chain]     explicit agent chain, oldest first, for callers
     *                                    that track it outside the database
     * @returns {object} the persisted task, decorated with depth / origin_id /
     *                   parent_id / chain
     * @throws {Error} unknown target, self-delegation, empty prompt, depth limit, cycle
     */
    delegate({ fromAgent, toAgent, prompt, chatId = '', parentId = null, originId = null, depth = null, chain = null } = {}) {
        const from = text(fromAgent).trim();
        const to = text(toAgent).trim();
        const body = text(prompt).trim();

        if (!from) throw new Error('[AgentDelegation] delegate() requires a fromAgent');
        if (!to) throw new Error('[AgentDelegation] delegate() requires a toAgent');
        if (!body) throw new Error('[AgentDelegation] delegate() requires a non-empty prompt');

        if (!this.hasAgent(to)) {
            const keys = this.agentKeys();
            const known = keys.length > 0 ? keys.join(', ') : '(no agents registered)';
            throw new Error(`[AgentDelegation] Unknown target agent "${to}". Valid agents: ${known}`);
        }
        if (from === to) {
            throw new Error(`[AgentDelegation] Agent "${from}" cannot delegate to itself — that is a loop`);
        }

        const ancestry = this._resolveAncestry({ fromAgent: from, parentId, originId, depth, chain });
        const nextDepth = ancestry.hops + 1;

        if (ancestry.chain.includes(to)) {
            throw new Error(
                `[AgentDelegation] Delegation cycle refused: "${to}" is already in the chain `
                + `${ancestry.chain.join(' -> ')}`
            );
        }
        if (nextDepth > this.maxDepth) {
            throw new Error(
                `[AgentDelegation] Delegation depth limit reached (max ${this.maxDepth}): `
                + `${[...ancestry.chain, to].join(' -> ')}`
            );
        }

        const id = this._newId(ancestry.parentId);
        const createdAt = this._now();
        try {
            this.db.prepare(`
                INSERT INTO inter_agent_tasks
                    (id, from_agent, to_agent, chat_id, prompt, status, result, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
            `).run(id, from, to, text(chatId), body, DELEGATION_STATUS.PENDING, createdAt);
        } catch (err) {
            console.warn(`[AgentDelegation] delegate(${from} -> ${to}) failed: ${err.message}`);
            throw new Error(`[AgentDelegation] Could not persist the delegation: ${err.message}`);
        }

        const task = this._decorate({
            id,
            from_agent: from,
            to_agent: to,
            chat_id: text(chatId),
            prompt: body,
            status: DELEGATION_STATUS.PENDING,
            result: null,
            created_at: createdAt,
            completed_at: null,
        }, [...ancestry.chain, to]);

        this._emit(DELEGATION_EVENTS.CREATED, { task });
        return task;
    }

    /** delegate() + run() in one call — the shape a tool or a route usually wants. */
    async delegateAndRun(opts = {}) {
        const task = this.delegate(opts);
        return this.run(task.id);
    }

    // =========================================================================
    //  RUN
    //
    //  ActionExecutor has no request/response entry point: work is queued with
    //  _enqueue(unifiedMessage) and the answer arrives through the message's own
    //  `raw` callbacks — the synthetic-ctx pattern core/Scheduler.js uses. We
    //  capture that text, then wait until the chat is idle again. Embedders
    //  wanting a different transport pass { runner }.
    // =========================================================================

    /**
     * Execute a pending delegation and record its outcome. NEVER throws: a
     * failure is written to the row as `Error: ...` with status `failed`.
     * @returns {Promise<object|null>} the settled task, or null if it is unknown
     */
    async run(taskId) {
        const task = this.getTask(taskId);
        if (!task) {
            console.warn(`[AgentDelegation] run(${taskId}): no such task`);
            return null;
        }
        if (task.status !== DELEGATION_STATUS.PENDING) {
            console.warn(`[AgentDelegation] run(${task.id}): already ${task.status}, skipping`);
            return task;
        }
        if (this.running.has(task.id)) {
            console.warn(`[AgentDelegation] run(${task.id}): already in flight, skipping`);
            return task;
        }

        this.running.add(task.id);
        try {
            this._update(task.id, { status: DELEGATION_STATUS.RUNNING });
            this._emit(DELEGATION_EVENTS.STARTED, { task: this.getTask(task.id) || task });

            let settled = null;
            try {
                const output = await this._executeWithTimeout(task);
                const body = text(output).trim();
                settled = this._update(task.id, {
                    status: DELEGATION_STATUS.COMPLETED,
                    result: clipResult(body || 'Completed with no output.'),
                    completedAt: this._now(),
                });
                this._emit(DELEGATION_EVENTS.COMPLETED, { task: settled });
            } catch (err) {
                const message = err && err.message ? err.message : String(err);
                console.warn(`[AgentDelegation] Task ${task.id} (${task.from_agent} -> ${task.to_agent}) failed: ${message}`);
                settled = this._update(task.id, {
                    status: DELEGATION_STATUS.FAILED,
                    result: clipResult(/^Timed out/i.test(message) ? message : `Error: ${message}`),
                    completedAt: this._now(),
                });
                this._emit(DELEGATION_EVENTS.FAILED, { task: settled, error: message });
            }
            return settled || this.getTask(task.id);
        } catch (err) {
            // Belt and braces: the bookkeeping must never escape run() either.
            console.warn(`[AgentDelegation] run(${task.id}) bookkeeping failed: ${err.message}`);
            return this.getTask(task.id);
        } finally {
            this.running.delete(task.id);
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

    /** What the target agent actually reads — the prompt plus its provenance. */
    _composePrompt(task) {
        return `[Delegated by agent "${text(task.from_agent)}"]\n\n${text(task.prompt)}`;
    }

    /**
     * Delegation runs on its OWN ActionExecutor chat id, never the user's.
     * Two reasons: the user's active agent must not be hijacked, and a delegating
     * agent is itself mid-turn in the user's chat — enqueuing there and waiting
     * for that chat to go idle would deadlock against its own in-flight message.
     */
    _dispatchChatId(task) {
        if (this._dispatchChatIdFn) return String(this._dispatchChatIdFn(task));
        const chatId = text(task.chat_id).trim() || 'main';
        const target = text(task.to_agent).trim() || 'main';
        return `delegate:${chatId}:${target}`;
    }

    async _dispatchViaActionExecutor(task) {
        const executor = this.actionExecutor;
        if (!executor || typeof executor._enqueue !== 'function') {
            throw new Error('No actionExecutor wired into AgentDelegation (pass { actionExecutor } or { runner })');
        }

        const chatId = this._dispatchChatId(task);
        const agentKey = text(task.to_agent).trim();
        if (agentKey && executor.agents && executor.agents[agentKey]
            && executor.sessionStore && typeof executor.sessionStore.setActiveAgent === 'function') {
            try {
                executor.sessionStore.setActiveAgent(agentKey, chatId);
            } catch (err) {
                console.warn(`[AgentDelegation] Could not pin agent ${agentKey} for ${task.id}: ${err.message}`);
            }
        }

        let captured = '';
        const capture = (value) => {
            const body = text(value);
            if (!body || body.includes('Thinking...') || body.includes('Queued for this chat')) return;
            captured = body;
        };
        const ack = async () => ({ message_id: Math.floor(Math.random() * 100000) });

        executor._enqueue({
            id: `deleg_${task.id}_${this._now()}`,
            platform: 'delegation',
            chatId,
            user: { id: `agent:${text(task.from_agent)}`, username: text(task.from_agent) || 'agent' },
            content: { type: 'text', text: this._composePrompt(task) },
            raw: {
                chat: { id: chatId },
                sendChatAction: async () => {},
                reply: async (value) => { capture(value); return ack(); },
                replyWithAudio: async () => {},
                telegram: {
                    editMessageText: async (_chat, _msgId, _inlineId, value) => { capture(value); },
                    deleteMessage: async () => {},
                    sendMessage: async (_chat, value) => { capture(value); return ack(); },
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

    // =========================================================================
    //  READ / WRITE SURFACE
    // =========================================================================

    /** @returns {object|null} the decorated task row, or null */
    getTask(id) {
        const key = text(id).trim();
        if (!key) return null;
        try {
            const row = this.db.prepare('SELECT * FROM inter_agent_tasks WHERE id = ?').get(key);
            return row ? this._decorate(row) : null;
        } catch (err) {
            console.warn(`[AgentDelegation] getTask(${key}) failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Newest delegations first.
     * @param {object} [filter]
     * @param {string} [filter.chatId]     exact chat id ('' / 'all' = every chat)
     * @param {string} [filter.agentId]    matches EITHER side of the hand-off
     * @param {string} [filter.fromAgent]  sender only
     * @param {string} [filter.toAgent]    target only
     * @param {string} [filter.status]     pending | running | completed | failed | cancelled
     * @param {number} [filter.limit]      default 50, hard cap 500
     * @returns {object[]}
     */
    getTasks({ chatId = null, agentId = null, fromAgent = null, toAgent = null, status = null, limit = 50 } = {}) {
        const where = [];
        const params = [];

        const chat = text(chatId).trim();
        if (chat && chat !== 'all') {
            where.push('chat_id = ?');
            params.push(chat);
        }
        const either = text(agentId).trim();
        if (either) {
            where.push('(from_agent = ? OR to_agent = ?)');
            params.push(either, either);
        }
        const sender = text(fromAgent).trim();
        if (sender) {
            where.push('from_agent = ?');
            params.push(sender);
        }
        const target = text(toAgent).trim();
        if (target) {
            where.push('to_agent = ?');
            params.push(target);
        }
        const state = text(status).trim();
        if (state && state !== 'all') {
            where.push('status = ?');
            params.push(state);
        }

        const cap = Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 500) : 50;
        const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        try {
            const rows = this.db.prepare(`
                SELECT * FROM inter_agent_tasks
                ${clause}
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?
            `).all(...params, cap) || [];
            return rows.map((row) => this._decorate(row));
        } catch (err) {
            console.warn(`[AgentDelegation] getTasks failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Work queued FOR an agent, oldest first — the target's inbox.
     * Omit `agentKey` for every pending delegation.
     */
    pending(agentKey = null, { limit = 50 } = {}) {
        const target = text(agentKey).trim();
        const cap = Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 500) : 50;
        try {
            const rows = target
                ? this.db.prepare(`
                    SELECT * FROM inter_agent_tasks
                    WHERE status = ? AND to_agent = ?
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?
                `).all(DELEGATION_STATUS.PENDING, target, cap)
                : this.db.prepare(`
                    SELECT * FROM inter_agent_tasks
                    WHERE status = ?
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?
                `).all(DELEGATION_STATUS.PENDING, cap);
            return (rows || []).map((row) => this._decorate(row));
        } catch (err) {
            console.warn(`[AgentDelegation] pending(${target || 'all'}) failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Cancel a delegation that has not started. A running one is left alone —
     * the executor cannot be recalled, and run() would overwrite the row anyway.
     * @returns {object|null} the cancelled task, or null if unknown / not pending
     */
    cancel(id) {
        const task = this.getTask(id);
        if (!task) {
            console.warn(`[AgentDelegation] cancel(${id}): no such task`);
            return null;
        }
        if (task.status !== DELEGATION_STATUS.PENDING) {
            console.warn(`[AgentDelegation] cancel(${task.id}): status is ${task.status}, only pending tasks can be cancelled`);
            return null;
        }
        const cancelled = this._update(task.id, {
            status: DELEGATION_STATUS.CANCELLED,
            result: 'Cancelled',
            completedAt: this._now(),
        });
        this._emit(DELEGATION_EVENTS.CANCELLED, { task: cancelled || task });
        return cancelled;
    }

    _update(id, { status, result, completedAt } = {}) {
        const sets = [];
        const params = [];
        if (status !== undefined && status !== null) {
            sets.push('status = ?');
            params.push(String(status));
        }
        if (result !== undefined) {
            sets.push('result = ?');
            params.push(result === null ? null : (typeof result === 'string' ? result : JSON.stringify(result)));
        }
        if (completedAt !== undefined && completedAt !== null) {
            sets.push('completed_at = ?');
            params.push(Number(completedAt));
        }
        if (sets.length === 0) return this.getTask(id);
        try {
            this.db.prepare(`UPDATE inter_agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, text(id));
        } catch (err) {
            console.warn(`[AgentDelegation] update(${id}) failed: ${err.message}`);
        }
        return this.getTask(id);
    }

    /** Rows carry the chain derived from the id, so a UI can indent the tree. */
    _decorate(row, chain = null) {
        const task = { ...row };
        task.depth = this._idDepth(row.id);
        task.origin_id = this.originOf(row.id);
        task.parent_id = this.parentOf(row.id);
        if (chain) task.chain = chain;
        return task;
    }

    _emit(event, payload) {
        const bus = this.eventBus;
        if (!bus || typeof bus.emit !== 'function') return;
        try {
            bus.emit(event, payload);
        } catch (err) {
            console.warn(`[AgentDelegation] Emitting ${event} failed: ${err.message}`);
        }
    }
}

AgentDelegation.Events = DELEGATION_EVENTS;
AgentDelegation.Status = DELEGATION_STATUS;
AgentDelegation.MAX_RESULT_CHARS = MAX_RESULT_CHARS;

module.exports = AgentDelegation;
