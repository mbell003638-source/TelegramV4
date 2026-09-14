// =============================================================================
//  core/TaskPlanner.js — HuggingGPT / JARVIS-style 4-stage controller
//
//  A port of the Microsoft JARVIS (HuggingGPT) idea onto this app's agent fleet:
//    #1 Task Planning     — an LLM decomposes a request into a DAG of subtasks
//    #2 Model Selection   — each subtask is matched to the best local CLI agent
//                           or router model that can serve it
//    #3 Task Execution    — topological run, independent branches in parallel
//    #4 Response Synthesis— every result merged into one coherent answer
//
//  Transport is always core/ProviderRouter.js — this module never speaks HTTP.
//  Everything is injectable (router, agents, database, eventBus) so the whole
//  pipeline is unit-testable with zero network.
//
//  The planner LLM is untrusted output: it wraps JSON in prose, in ```json
//  fences, emits trailing commas or a bare array. _parsePlanText() repairs all
//  of that, and an unrecoverable response degrades to a single-task plan
//  carrying the original request. plan() must never throw at the caller.
// =============================================================================

const DEFAULT_PLANNER_MODEL =
    process.env.TASK_PLANNER_MODEL || process.env.OMNIROUTER_PLANNER_MODEL || 'gpt-4o-mini';

const PLANNER_EVENT_KEY = 'taskplanner';

/** Authoritative local CLI agents — mirrors AGENT_ENV_MAP in core/AgentOverrides.js. */
const LOCAL_AGENT_IDS = Object.freeze([
    'claude', 'codex', 'opencode', 'grok', 'hermes', 'pi', 'openclaw', 'antigravity',
]);

/**
 * The task taxonomy the planner LLM must choose from — this project's analogue
 * of HuggingGPT's HuggingFace pipeline tags.
 */
const TASK_TYPES = Object.freeze([
    'chat', 'reasoning', 'research', 'coding', 'code-review', 'debugging',
    'writing', 'summarization', 'translation', 'math', 'planning', 'analysis',
    'shell', 'vision', 'counselling', 'general',
]);

/** Common aliases the LLM emits for the canonical types above. */
const TYPE_ALIASES = Object.freeze({
    'text-generation': 'writing',
    'text2text-generation': 'writing',
    'question-answering': 'reasoning',
    'conversational': 'chat',
    'summarize': 'summarization',
    'summarisation': 'summarization',
    'translate': 'translation',
    'code': 'coding',
    'code-generation': 'coding',
    'programming': 'coding',
    'review': 'code-review',
    'codereview': 'code-review',
    'debug': 'debugging',
    'bugfix': 'debugging',
    'search': 'research',
    'web-search': 'research',
    'websearch': 'research',
    'maths': 'math',
    'calculation': 'math',
    'plan': 'planning',
    'analyse': 'analysis',
    'analyze': 'analysis',
    'command': 'shell',
    'terminal': 'shell',
    'bash': 'shell',
    'image': 'vision',
    'image-to-text': 'vision',
    'visual-question-answering': 'vision',
    'advice': 'counselling',
    'therapy': 'counselling',
    'counseling': 'counselling',
});

/**
 * Deterministic capability profile per local CLI agent. `priority` is the
 * stable tie-breaker so selectModel() returns identical output for identical
 * input, forever (no clocks, no randomness, no map-iteration luck).
 */
const AGENT_PROFILES = Object.freeze({
    claude: {
        priority: 1,
        types: ['coding', 'code-review', 'reasoning', 'writing', 'analysis', 'planning', 'debugging'],
        keywords: ['refactor', 'architecture', 'explain', 'review', 'essay', 'document'],
    },
    codex: {
        priority: 2,
        types: ['coding', 'debugging', 'shell', 'code-review'],
        keywords: ['patch', 'compile', 'test', 'bug', 'stack trace', 'script'],
    },
    grok: {
        priority: 3,
        types: ['research', 'analysis', 'reasoning', 'chat'],
        keywords: ['news', 'latest', 'search', 'trend', 'current'],
    },
    hermes: {
        priority: 4,
        types: ['reasoning', 'math', 'analysis', 'planning'],
        keywords: ['tool', 'function', 'calculate', 'prove', 'derive'],
    },
    opencode: {
        priority: 5,
        types: ['coding', 'debugging', 'shell'],
        keywords: ['repo', 'file', 'implement', 'edit'],
    },
    openclaw: {
        priority: 6,
        types: ['shell', 'coding', 'planning', 'analysis'],
        keywords: ['automate', 'workflow', 'browser', 'device'],
    },
    pi: {
        priority: 7,
        types: ['counselling', 'chat', 'writing'],
        keywords: ['feel', 'advice', 'support', 'emotional', 'listen', 'empathy'],
    },
    antigravity: {
        priority: 8,
        types: ['vision', 'research', 'summarization', 'chat'],
        keywords: ['image', 'photo', 'diagram', 'screenshot', 'multimodal'],
    },
});

/** Hints used to score bare router model ids when no local agent fits. */
const MODEL_TYPE_HINTS = Object.freeze([
    { match: ['coder', 'code', 'codestral', 'devstral'], types: ['coding', 'debugging', 'code-review'] },
    { match: ['vision', 'vl', 'multimodal', 'gemini', 'pixtral'], types: ['vision'] },
    { match: ['reason', 'think', 'o1', 'o3', 'r1', 'deepseek-r'], types: ['reasoning', 'math', 'analysis', 'planning'] },
    { match: ['sonar', 'search', 'perplexity'], types: ['research'] },
    { match: ['instruct', 'chat', 'turbo'], types: ['chat', 'writing', 'summarization'] },
]);

const MAX_JSON_CANDIDATES = 24;
const MAX_TASKS = 25;

function emptyUsage() {
    return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(ledger, delta) {
    if (!ledger || !delta || typeof delta !== 'object') return ledger;
    ledger.requests += Number(delta.requests) || 0;
    ledger.promptTokens += Number(delta.promptTokens ?? delta.prompt_tokens) || 0;
    ledger.completionTokens += Number(delta.completionTokens ?? delta.completion_tokens) || 0;
    ledger.totalTokens += Number(delta.totalTokens ?? delta.total_tokens) || 0;
    ledger.costUsd += Number(delta.costUsd) || 0;
    return ledger;
}

function asText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
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

class TaskPlanner {
    /**
     * @param {object}   [opts]
     * @param {object}   [opts.router]       core/ProviderRouter instance (LLM transport)
     * @param {object}   [opts.agents]       registry keyed by agent id (see index.js)
     * @param {object}   [opts.database]     AssistantDatabase — optional plan journal
     * @param {object}   [opts.eventBus]     channelEventBus — progress events
     * @param {string}   [opts.plannerModel] model slug used for stages #1 and #4
     * @param {function} [opts.taskRunner]   override subtask execution (tests)
     * @param {number}   [opts.concurrency]  default parallelism for execute()
     */
    constructor({ router, agents, database, eventBus, plannerModel, taskRunner, concurrency } = {}) {
        this.router = router || null;
        this.agents = agents && typeof agents === 'object' ? agents : {};
        this.database = database || null;
        this.eventBus = eventBus || null;
        this.plannerModel = plannerModel || DEFAULT_PLANNER_MODEL;
        this.taskRunner = typeof taskRunner === 'function' ? taskRunner : null;
        this.defaultConcurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3;
        this._seq = 0;
    }

    // =========================================================================
    //  Events
    // =========================================================================

    _emit(event, onProgress) {
        if (typeof onProgress === 'function') {
            try { onProgress(event); } catch (err) {
                console.warn('[TaskPlanner] onProgress handler threw:', err.message);
            }
        }
        if (!this.eventBus) return;
        try {
            if (event.status === 'failed' && typeof this.eventBus.emitError === 'function') {
                this.eventBus.emitError(PLANNER_EVENT_KEY, event.error || 'task failed', event.requestId);
            } else if (typeof this.eventBus.emitStatus === 'function') {
                this.eventBus.emitStatus(PLANNER_EVENT_KEY, this._describeEvent(event), event.requestId);
            }
        } catch (err) {
            console.warn('[TaskPlanner] eventBus emit failed:', err.message);
        }
    }

    _describeEvent(event) {
        const where = event.taskId ? `${event.taskId}` : event.phase;
        switch (event.status) {
            case 'started':   return `▶️ ${where}: ${event.description || event.phase}`;
            case 'ok':        return `✅ ${where} done`;
            case 'failed':    return `❌ ${where}: ${event.error || 'failed'}`;
            case 'skipped':   return `⏭️ ${where}: ${event.reason || 'dependency failed'}`;
            default:          return `${event.phase}: ${event.status}`;
        }
    }

    _nextRequestId(prefix = 'plan') {
        this._seq += 1;
        return `${prefix}_${this._seq}_${Date.now().toString(36)}`;
    }

    // =========================================================================
    //  Stage #1 — Task Planning
    // =========================================================================

    _plannerSystemPrompt(agentIds) {
        const agentLine = agentIds.length
            ? agentIds.map(id => `"${id}"`).join(', ')
            : '(none available)';
        return [
            '#1 Task Planning Stage. You decompose a user request into the smallest set of',
            'solvable subtasks, as a dependency DAG.',
            '',
            'Reply with JSON ONLY — no prose, no markdown fences. Shape:',
            '{"tasks":[{"id":"t1","type":"<task type>","description":"<what to do>",',
            '"dependsOn":["<id of a prerequisite task>"],"suggestedAgent":"<agent id or null>",',
            '"args":{"text":"<input or <GENERATED>-t1 to reuse a prior task output>"}}],',
            '"rationale":"<one sentence on why this decomposition>"}',
            '',
            `The "type" field MUST be one of: ${TASK_TYPES.join(', ')}.`,
            `The "suggestedAgent" field must be one of: ${agentLine}, or null.`,
            '"dependsOn" lists the ids of tasks that must finish first because this task',
            'consumes what they produce. Use "<GENERATED>-<id>" inside args to reference a',
            'prior task output. Independent tasks MUST have an empty dependsOn so they run',
            'in parallel. Never create a cycle.',
            '',
            'Parse out as few tasks as possible while still fully resolving the request.',
            'If the request needs no decomposition, return exactly one task.',
        ].join('\n');
    }

    /**
     * Stage #1 — decompose `request` into a normalized plan.
     * Never throws: a dead router or unparseable output degrades to a
     * single-task fallback plan carrying the original request.
     *
     * @returns {Promise<{tasks: Array, rationale: string, fallback: boolean, usage: object, raw: string}>}
     */
    async plan(request, { context, availableAgents, requestId, onProgress, signal } = {}) {
        const text = String(request == null ? '' : request).trim();
        const usage = emptyUsage();
        const rid = requestId || this._nextRequestId('plan');
        const agentIds = this._agentIds(availableAgents);

        if (!text) {
            return this._fallbackPlan('', 'empty request', usage, '');
        }

        this._emit({ phase: 'plan', status: 'started', requestId: rid, description: text.slice(0, 120) }, onProgress);

        let raw = '';
        try {
            if (!this.router || typeof this.router.chatCompletion !== 'function') {
                throw new Error('no router configured');
            }
            const contextLine = context
                ? `The chat log [ ${asText(context).slice(0, 4000)} ] may contain resources I mentioned.\n`
                : '';
            const result = await this.router.chatCompletion({
                model: this.plannerModel,
                temperature: 0.1,
                messages: [
                    { role: 'system', content: this._plannerSystemPrompt(agentIds) },
                    { role: 'user', content: `${contextLine}Now I input { ${text} }. Pay attention to the dependencies and order among tasks.` },
                ],
            }, { signal });
            addUsage(usage, result && result.usage);
            raw = messageText(result && result.data);
        } catch (err) {
            console.warn('[TaskPlanner] Planner LLM call failed:', err.message);
            return this._fallbackPlan(text, `planner unavailable: ${err.message}`, usage, raw);
        }

        const parsed = this._parsePlanText(raw);
        if (!parsed) {
            console.warn('[TaskPlanner] Could not parse planner output; falling back to single task.');
            return this._fallbackPlan(text, 'unparseable planner output', usage, raw);
        }

        const plan = this._normalizePlan(parsed, text);
        if (!plan.tasks.length) {
            return this._fallbackPlan(text, 'planner returned no tasks', usage, raw);
        }
        plan.usage = usage;
        plan.raw = raw;
        plan.request = text;
        this._journal(text, plan);
        this._emit({ phase: 'plan', status: 'ok', requestId: rid, taskCount: plan.tasks.length }, onProgress);
        return plan;
    }

    _fallbackPlan(request, reason, usage, raw) {
        const description = String(request || '').trim() || 'Respond to the user.';
        return {
            tasks: [{
                id: 't1',
                type: 'general',
                description,
                dependsOn: [],
                suggestedAgent: null,
                args: { text: description },
            }],
            rationale: `Fallback single-task plan (${reason}).`,
            fallback: true,
            fallbackReason: reason,
            usage: usage || emptyUsage(),
            raw: raw || '',
            request: description,
        };
    }

    _journal(request, plan) {
        if (!this.database || typeof this.database.recordHiveMind !== 'function') return;
        try {
            this.database.recordHiveMind(
                PLANNER_EVENT_KEY, '', 'plan',
                `${plan.tasks.length} task(s): ${plan.tasks.map(t => t.type).join(', ')}`,
                JSON.stringify({ request: String(request).slice(0, 500), tasks: plan.tasks })
            );
        } catch (err) {
            console.warn('[TaskPlanner] Could not journal plan:', err.message);
        }
    }

    // =========================================================================
    //  Robust JSON extraction & repair
    // =========================================================================

    /**
     * Extract a plan object/array from arbitrary LLM output.
     * Handles: bare JSON, ```json fences, prose-wrapped JSON, trailing commas,
     * single quotes, unquoted keys, comments, smart quotes, truncated output.
     * @returns {object|Array|null} null when nothing usable was found.
     */
    _parsePlanText(text) {
        const src = String(text == null ? '' : text);
        if (!src.trim()) return null;

        for (const candidate of this._jsonCandidates(src)) {
            const parsed = this._tryParse(candidate);
            if (parsed && this._looksLikePlan(parsed)) return parsed;
        }
        // Second pass: accept any parseable JSON, even if it does not look like a plan.
        for (const candidate of this._jsonCandidates(src)) {
            const parsed = this._tryParse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        }
        return null;
    }

    _looksLikePlan(value) {
        if (Array.isArray(value)) {
            return value.some(item => item && typeof item === 'object');
        }
        if (!value || typeof value !== 'object') return false;
        for (const key of ['tasks', 'plan', 'steps', 'subtasks']) {
            if (Array.isArray(value[key])) return true;
        }
        return Boolean(value.task || value.description || value.type || value.id != null);
    }

    /** Ordered list of substrings worth attempting to parse. Most-likely first. */
    _jsonCandidates(src) {
        const out = [];
        const push = value => {
            const trimmed = String(value || '').trim();
            if (trimmed && !out.includes(trimmed) && out.length < MAX_JSON_CANDIDATES) out.push(trimmed);
        };

        // 1. Fenced blocks (```json … ```), most specific signal first.
        const fence = /```[ \t]*(?:json|json5|javascript|js)?[ \t]*\r?\n?([\s\S]*?)```/gi;
        let match;
        while ((match = fence.exec(src)) !== null) push(match[1]);

        // 2. An unterminated fence — model ran out of tokens before closing it.
        const openFence = /```[ \t]*(?:json|json5|javascript|js)?[ \t]*\r?\n([\s\S]*)$/i.exec(src);
        if (openFence) push(openFence[1]);

        // 3. The whole payload, and the payload with fences stripped.
        push(src);
        push(src.replace(/```[a-z0-9]*/gi, ''));

        // 4. Balanced slices carved out of surrounding prose.
        for (const slice of this._balancedSlices(src)) push(slice);

        return out;
    }

    /** Scan for top-level balanced {...} / [...] regions, string- and escape-aware. */
    _balancedSlices(src) {
        const slices = [];
        const closerFor = { '[': ']', '{': '}' };
        for (let i = 0; i < src.length && slices.length < MAX_JSON_CANDIDATES; i++) {
            const open = src[i];
            if (open !== '[' && open !== '{') continue;
            const stack = [];
            let inString = false;
            let quote = '';
            let escaped = false;
            let end = -1;
            for (let j = i; j < src.length; j++) {
                const ch = src[j];
                if (inString) {
                    if (escaped) { escaped = false; continue; }
                    if (ch === '\\') { escaped = true; continue; }
                    if (ch === quote) inString = false;
                    continue;
                }
                if (ch === '"' || ch === '\'') { inString = true; quote = ch; continue; }
                if (ch === '[' || ch === '{') { stack.push(closerFor[ch]); continue; }
                if (ch === ']' || ch === '}') {
                    if (!stack.length || stack.pop() !== ch) { end = -1; break; }
                    if (!stack.length) { end = j; break; }
                }
            }
            if (end > i) {
                slices.push(src.slice(i, end + 1));
                i = end;
            } else if (stack.length) {
                // Truncated tail — close it optimistically and let the repair pass try.
                slices.push(src.slice(i) + stack.reverse().join(''));
            }
        }
        return slices;
    }

    /** JSON.parse with a progressive repair ladder; returns null if hopeless. */
    _tryParse(candidate) {
        const attempts = [];
        const add = value => { if (value && !attempts.includes(value)) attempts.push(value); };

        let text = String(candidate || '').trim();
        if (!text) return null;
        add(text);

        // Strip // and /* */ comments (outside strings).
        text = this._stripComments(text);
        add(text);

        // Normalise smart quotes the model may have emitted.
        text = text.replace(/[“”„″]/g, '"').replace(/[‘’′]/g, '\'');
        add(text);

        // Trailing commas before a closer.
        text = text.replace(/,(\s*[}\]])/g, '$1');
        add(text);

        // Python/JS literals that are not valid JSON.
        text = text
            .replace(/\bNone\b/g, 'null')
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\b(?:undefined|NaN|Infinity)\b/g, 'null');
        add(text);

        // Unquoted object keys.
        text = text.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":');
        add(text);

        // Single-quoted strings → double-quoted (last resort; can bruise apostrophes).
        add(this._singleToDoubleQuotes(text));

        // Repeat the trailing-comma sweep after the quote rewrite.
        add(this._singleToDoubleQuotes(text).replace(/,(\s*[}\]])/g, '$1'));

        for (const attempt of attempts) {
            try {
                const parsed = JSON.parse(attempt);
                if (parsed && typeof parsed === 'object') return parsed;
            } catch (err) { /* try the next rung of the ladder */ }
        }
        return null;
    }

    _stripComments(text) {
        let out = '';
        let inString = false;
        let quote = '';
        let escaped = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = text[i + 1];
            if (inString) {
                out += ch;
                if (escaped) { escaped = false; continue; }
                if (ch === '\\') { escaped = true; continue; }
                if (ch === quote) inString = false;
                continue;
            }
            if (ch === '"' || ch === '\'') { inString = true; quote = ch; out += ch; continue; }
            if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
            if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
            out += ch;
        }
        return out;
    }

    _singleToDoubleQuotes(text) {
        let out = '';
        let inDouble = false;
        let inSingle = false;
        let escaped = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { out += ch; escaped = false; continue; }
            if (ch === '\\') { out += ch; escaped = true; continue; }
            if (inDouble) { out += ch; if (ch === '"') inDouble = false; continue; }
            if (inSingle) {
                if (ch === '\'') { out += '"'; inSingle = false; continue; }
                out += ch === '"' ? '\\"' : ch;
                continue;
            }
            if (ch === '"') { inDouble = true; out += ch; continue; }
            if (ch === '\'') { inSingle = true; out += '"'; continue; }
            out += ch;
        }
        return out;
    }

    // =========================================================================
    //  Plan normalization
    // =========================================================================

    _agentIds(availableAgents) {
        let ids = [];
        if (Array.isArray(availableAgents)) ids = availableAgents.map(String);
        else if (availableAgents && typeof availableAgents === 'object') ids = Object.keys(availableAgents);
        else if (this.agents && typeof this.agents === 'object') ids = Object.keys(this.agents);
        const known = ids.filter(id => LOCAL_AGENT_IDS.includes(id));
        return (known.length ? known : ids).slice().sort();
    }

    _normalizeType(value) {
        const raw = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_]+/g, '-');
        if (!raw) return 'general';
        if (TASK_TYPES.includes(raw)) return raw;
        if (TYPE_ALIASES[raw]) return TYPE_ALIASES[raw];
        for (const type of TASK_TYPES) {
            if (raw.includes(type)) return type;
        }
        return 'general';
    }

    /**
     * Turn any parsed shape into `{ tasks: [...], rationale }` with stable string
     * ids, canonical types, deduped dependsOn, and no dangling or self edges.
     */
    _normalizePlan(parsed, request) {
        let list = null;
        let rationale = '';

        if (Array.isArray(parsed)) {
            list = parsed;
        } else if (parsed && typeof parsed === 'object') {
            for (const key of ['tasks', 'plan', 'steps', 'subtasks']) {
                if (Array.isArray(parsed[key])) { list = parsed[key]; break; }
            }
            if (!list && (parsed.task || parsed.description || parsed.type || parsed.id != null)) list = [parsed];
            rationale = String(parsed.rationale || parsed.reason || parsed.reasoning || parsed.thought || '').trim();
        }
        if (!Array.isArray(list)) return { tasks: [], rationale, fallback: false };

        // Pass 1 — materialise tasks with stable ids.
        const raw = [];
        const idByOriginal = new Map();
        const seenIds = new Set();
        for (let i = 0; i < list.length && raw.length < MAX_TASKS; i++) {
            const item = list[i];
            if (item == null) continue;
            const entry = typeof item === 'string' ? { description: item } : item;
            if (typeof entry !== 'object') continue;

            const original = entry.id != null ? String(entry.id) : '';
            let id = original.trim() || `t${raw.length + 1}`;
            while (seenIds.has(id)) id = `${id}_${raw.length + 1}`;
            seenIds.add(id);
            if (original.trim()) idByOriginal.set(original.trim(), id);
            idByOriginal.set(String(i), id);         // positional fallback for numeric deps

            const args = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
                ? { ...entry.args }
                : {};
            const description = String(
                entry.description || entry.task || entry.prompt || entry.instruction ||
                entry.goal || args.text || entry.name || ''
            ).trim();

            raw.push({
                id,
                type: this._normalizeType(entry.type || entry.task || entry.kind || entry.category),
                description: description || String(request || '').trim(),
                rawDeps: entry.dependsOn ?? entry.depends_on ?? entry.dep ?? entry.deps ?? entry.dependencies ?? [],
                suggestedAgent: this._normalizeAgentId(entry.suggestedAgent || entry.agent || entry.model || entry.assignee),
                args,
            });
        }

        // Pass 2 — resolve dependencies (explicit + <GENERATED>-id references).
        const validIds = new Set(raw.map(t => t.id));
        const tasks = raw.map(task => {
            const deps = new Set();
            const addDep = value => {
                if (value == null) return;
                const key = String(value).trim();
                if (!key || key === '-1') return;
                const resolved = validIds.has(key) ? key : idByOriginal.get(key);
                if (resolved && resolved !== task.id && validIds.has(resolved)) deps.add(resolved);
            };
            const rawDeps = Array.isArray(task.rawDeps) ? task.rawDeps : [task.rawDeps];
            rawDeps.forEach(addDep);

            // HuggingGPT's fix_dep: <GENERATED>-<id> inside args implies a dependency.
            for (const value of Object.values(task.args)) {
                const str = typeof value === 'string' ? value : '';
                const generated = /<GENERATED>[-\s]*([A-Za-z0-9_.-]+)/g;
                let hit;
                while ((hit = generated.exec(str)) !== null) addDep(hit[1]);
            }

            delete task.rawDeps;
            return { ...task, dependsOn: [...deps] };
        });

        return { tasks, rationale, fallback: false };
    }

    _normalizeAgentId(value) {
        if (!value) return null;
        const raw = String(value).trim().toLowerCase();
        if (!raw || raw === 'null' || raw === 'none' || raw === 'auto') return null;
        if (LOCAL_AGENT_IDS.includes(raw)) return raw;
        const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
        if (LOCAL_AGENT_IDS.includes(bare)) return bare;
        return raw;    // may be a "provider/model" slug — selectModel() handles it
    }

    // =========================================================================
    //  Stage #2 — Model Selection  (pure & deterministic)
    // =========================================================================

    /**
     * Score every candidate executor for `task` and return the winner.
     * Pure: no clocks, no randomness, no network — identical input always
     * yields an identical selection. Local CLI agents win ties over router
     * models, matching HuggingGPT's "prefer local endpoints" bias.
     *
     * @param {object} task     normalized task ({ type, description, suggestedAgent })
     * @param {object} catalog  { agents?: object|string[], models?: Array }
     * @returns {{kind:'agent'|'model', id:string, score:number, reasons:string[],
     *            agent?:string, providerId?:string, model?:string}|null}
     */
    selectModel(task, catalog) {
        const safeTask = task && typeof task === 'object' ? task : {};
        const type = this._normalizeType(safeTask.type);
        const description = String(safeTask.description || '').toLowerCase();
        const suggested = this._normalizeAgentId(safeTask.suggestedAgent);

        const { agentIds, models } = this._catalogShape(catalog);
        const candidates = [];

        for (const id of agentIds) {
            const profile = AGENT_PROFILES[id];
            if (!profile) continue;
            const reasons = [];
            let score = 10;                                   // baseline: local is cheap & warm
            if (profile.types.includes(type)) {
                score += 50 - profile.types.indexOf(type) * 2; // earlier in the list = stronger fit
                reasons.push(`type:${type}`);
            }
            for (const keyword of profile.keywords) {
                if (description.includes(keyword)) { score += 8; reasons.push(`kw:${keyword}`); }
            }
            if (suggested && suggested === id) { score += 40; reasons.push('planner-suggested'); }
            if (this._agentAvailable(id)) { score += 15; reasons.push('available'); }
            else if (this.agents && Object.keys(this.agents).length && !(id in this.agents)) { score -= 20; }
            candidates.push({ kind: 'agent', id, agent: id, score, reasons, tiebreak: profile.priority });
        }

        for (let i = 0; i < models.length; i++) {
            const entry = models[i];
            const id = String(entry && (entry.id || entry.model || entry) || '').trim();
            if (!id) continue;
            const lower = id.toLowerCase();
            const reasons = [];
            let score = 5;
            for (const hint of MODEL_TYPE_HINTS) {
                if (!hint.types.includes(type)) continue;
                if (hint.match.some(fragment => lower.includes(fragment))) {
                    score += 30;
                    reasons.push(`model-hint:${type}`);
                    break;
                }
            }
            if (suggested && (lower === suggested || lower.endsWith(`/${suggested}`))) {
                score += 40;
                reasons.push('planner-suggested');
            }
            candidates.push({
                kind: 'model',
                id,
                providerId: (entry && entry.provider) || (id.includes('/') ? id.slice(0, id.indexOf('/')) : null),
                model: (entry && entry.model) || (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id),
                score,
                reasons,
                tiebreak: 100 + i,
            });
        }

        if (!candidates.length) return null;

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;   // local agents win ties
            if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        const winner = candidates[0];
        return {
            kind: winner.kind,
            id: winner.id,
            agent: winner.kind === 'agent' ? winner.agent : undefined,
            providerId: winner.kind === 'model' ? winner.providerId : undefined,
            model: winner.kind === 'model' ? winner.model : undefined,
            score: winner.score,
            reasons: winner.reasons,
        };
    }

    _catalogShape(catalog) {
        let agentSource = this.agents;
        let models = [];
        if (Array.isArray(catalog)) {
            models = catalog;
        } else if (catalog && typeof catalog === 'object') {
            if (catalog.agents !== undefined) agentSource = catalog.agents;
            if (Array.isArray(catalog.models)) models = catalog.models;
        }
        let agentIds = [];
        if (Array.isArray(agentSource)) agentIds = agentSource.map(String);
        else if (agentSource && typeof agentSource === 'object') agentIds = Object.keys(agentSource);
        return { agentIds: agentIds.slice().sort(), models };
    }

    _agentAvailable(id) {
        const agent = this.agents ? this.agents[id] : null;
        if (!agent) return false;
        if (typeof agent.status === 'string' && ['error', 'stopped'].includes(agent.status)) return false;
        return true;
    }

    /** Build a selection catalog: injected agents + (best-effort) router models. */
    async buildCatalog({ availableAgents, models } = {}) {
        const agents = availableAgents || this.agents || {};
        if (Array.isArray(models)) return { agents, models };
        let list = [];
        try {
            if (this.router && typeof this.router.listModels === 'function') {
                list = await this.router.listModels();
            }
        } catch (err) {
            console.warn('[TaskPlanner] Could not list router models:', err.message);
        }
        return { agents, models: Array.isArray(list) ? list : [] };
    }

    // =========================================================================
    //  Stage #3 — Task Execution (topological, bounded parallelism)
    // =========================================================================

    /**
     * Find one dependency cycle, if any.
     * @returns {string[]|null} e.g. ['a','b','a'] — null when the graph is a DAG.
     */
    detectCycle(tasks) {
        const byId = new Map((tasks || []).map(t => [t.id, t]));
        const state = new Map();        // id -> 'visiting' | 'done'
        const stack = [];

        const visit = id => {
            if (state.get(id) === 'done') return null;
            if (state.get(id) === 'visiting') {
                const at = stack.indexOf(id);
                return [...stack.slice(at >= 0 ? at : 0), id];
            }
            state.set(id, 'visiting');
            stack.push(id);
            const task = byId.get(id);
            for (const dep of (task && task.dependsOn) || []) {
                if (!byId.has(dep)) continue;
                const found = visit(dep);
                if (found) return found;
            }
            stack.pop();
            state.set(id, 'done');
            return null;
        };

        for (const task of byId.values()) {
            const found = visit(task.id);
            if (found) return found;
        }
        return null;
    }

    /**
     * Stage #3 — run the plan's DAG. Tasks whose dependencies are all satisfied
     * run in parallel, up to `concurrency`. A failing task is marked `failed`
     * and its dependents are `skipped`; unrelated branches keep running.
     *
     * Throws (fail fast, never hangs) only on a dependency cycle.
     *
     * @returns {Promise<{results: object, order: string[], ok: boolean,
     *                    failed: string[], skipped: string[], usage: object,
     *                    stats: {peakConcurrency: number, concurrency: number}}>}
     */
    async execute(plan, opts = {}) {
        const { onProgress, requestId, signal, catalog, taskRunner } = opts;
        const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
            ? Math.floor(opts.concurrency)
            : this.defaultConcurrency;

        const tasks = this._tasksOf(plan);
        const rid = requestId || this._nextRequestId('exec');
        const usage = emptyUsage();
        const results = Object.create(null);
        const order = [];
        const stats = { peakConcurrency: 0, concurrency };

        if (!tasks.length) {
            return { results, order, ok: true, failed: [], skipped: [], usage, stats };
        }

        const cycle = this.detectCycle(tasks);
        if (cycle) {
            const err = new Error(`[TaskPlanner] Dependency cycle detected: ${cycle.join(' -> ')}`);
            err.name = 'TaskPlannerCycleError';
            err.cycle = cycle;
            this._emit({ phase: 'execute', status: 'failed', requestId: rid, error: err.message }, onProgress);
            throw err;
        }

        const byId = new Map(tasks.map(t => [t.id, t]));
        const state = new Map(tasks.map(t => [t.id, 'pending']));
        const running = new Map();
        const runner = typeof taskRunner === 'function'
            ? taskRunner
            : (this.taskRunner || (ctx => this._defaultTaskRunner(ctx)));

        const settle = (id, result) => {
            results[id] = result;
            state.set(id, result.status);
            order.push(id);
            addUsage(usage, result.usage);
        };

        const start = task => {
            state.set(task.id, 'running');
            stats.peakConcurrency = Math.max(stats.peakConcurrency, running.size + 1);
            this._emit({
                phase: 'task', status: 'started', requestId: rid,
                taskId: task.id, type: task.type, description: task.description,
            }, onProgress);

            const upstream = {};
            for (const dep of task.dependsOn) {
                if (results[dep]) upstream[dep] = results[dep];
            }

            const promise = Promise.resolve()
                .then(() => runner({
                    task: this._resolveArgs(task, upstream),
                    upstream,
                    selection: task.selection || this.selectModel(task, catalog),
                    plan,
                    request: (plan && plan.request) || '',
                    signal,
                    requestId: rid,
                }))
                .then(output => this._toResult(task, output, 'ok'))
                .catch(err => ({
                    id: task.id, type: task.type, description: task.description,
                    status: 'failed', output: null,
                    error: String((err && err.message) || err || 'task failed'),
                    usage: emptyUsage(),
                }))
                .then(result => {
                    running.delete(task.id);
                    settle(task.id, result);
                    this._emit({
                        phase: 'task', status: result.status, requestId: rid,
                        taskId: task.id, type: task.type,
                        error: result.error, output: result.output,
                    }, onProgress);
                });

            running.set(task.id, promise);
        };

        while (true) {
            let startedSomething = false;
            for (const task of tasks) {
                if (state.get(task.id) !== 'pending') continue;

                const deps = task.dependsOn.filter(dep => byId.has(dep));
                const blocked = deps.filter(dep => !results[dep]);
                if (blocked.length) continue;

                const broken = deps.filter(dep => results[dep].status !== 'ok');
                if (broken.length) {
                    settle(task.id, {
                        id: task.id, type: task.type, description: task.description,
                        status: 'skipped', output: null,
                        error: null, skippedBecause: broken,
                        reason: `dependency ${broken.join(', ')} did not succeed`,
                        usage: emptyUsage(),
                    });
                    this._emit({
                        phase: 'task', status: 'skipped', requestId: rid,
                        taskId: task.id, reason: `dependency ${broken.join(', ')} did not succeed`,
                    }, onProgress);
                    startedSomething = true;
                    continue;
                }
                if (running.size >= concurrency) continue;
                start(task);
                startedSomething = true;
            }

            if (running.size) {
                await Promise.race(running.values());
                continue;
            }
            if (!startedSomething) break;
        }

        const failed = Object.values(results).filter(r => r.status === 'failed').map(r => r.id);
        const skipped = Object.values(results).filter(r => r.status === 'skipped').map(r => r.id);
        return { results, order, ok: failed.length === 0, failed, skipped, usage, stats };
    }

    _tasksOf(plan) {
        if (Array.isArray(plan)) return this._normalizePlan(plan, '').tasks;
        if (plan && Array.isArray(plan.tasks)) {
            const needsWork = plan.tasks.some(t => !t || typeof t !== 'object' || !t.id || !Array.isArray(t.dependsOn));
            return needsWork ? this._normalizePlan(plan, plan.request || '').tasks : plan.tasks;
        }
        if (plan && typeof plan === 'object') return this._normalizePlan(plan, '').tasks;
        return [];
    }

    /** Substitute `<GENERATED>-<depId>` placeholders with upstream outputs. */
    _resolveArgs(task, upstream) {
        const args = { ...(task.args || {}) };
        let touched = false;
        for (const [key, value] of Object.entries(args)) {
            if (typeof value !== 'string' || !value.includes('<GENERATED>')) continue;
            args[key] = value.replace(/<GENERATED>[-\s]*([A-Za-z0-9_.-]+)/g, (whole, depId) => {
                const result = upstream[depId];
                if (!result || result.output == null) return whole;
                touched = true;
                return asText(result.output);
            });
        }
        return touched ? { ...task, args } : task;
    }

    _toResult(task, output, status) {
        const payload = output && typeof output === 'object' && !Array.isArray(output) && 'output' in output
            ? output
            : { output };
        return {
            id: task.id,
            type: task.type,
            description: task.description,
            status: payload.status || status,
            output: payload.output == null ? '' : payload.output,
            error: payload.error || null,
            agent: payload.agent || null,
            model: payload.model || null,
            providerId: payload.providerId || null,
            usage: payload.usage || emptyUsage(),
        };
    }

    // -------------------------------------------------------------------------
    //  Default subtask executors
    // -------------------------------------------------------------------------

    async _defaultTaskRunner(ctx) {
        const { selection } = ctx;
        if (selection && selection.kind === 'agent' && this._agentRunnable(selection.agent)) {
            try {
                return await this._runViaAgent(selection.agent, ctx);
            } catch (err) {
                console.warn(`[TaskPlanner] Agent ${selection.agent} failed, falling back to router:`, err.message);
            }
        }
        return this._runViaRouter(ctx);
    }

    _agentRunnable(id) {
        const agent = this.agents ? this.agents[id] : null;
        return Boolean(agent && typeof agent.sendMessage === 'function');
    }

    _taskPrompt(ctx) {
        const { task, upstream } = ctx;
        const lines = [];
        if (ctx.request) lines.push(`Overall user request: ${ctx.request}`);
        lines.push(`Your subtask (${task.type}): ${task.description}`);
        const args = task.args || {};
        const extras = Object.entries(args).filter(([key]) => key !== 'text');
        if (typeof args.text === 'string' && args.text && args.text !== task.description) {
            lines.push(`Input: ${args.text}`);
        }
        if (extras.length) lines.push(`Arguments: ${JSON.stringify(Object.fromEntries(extras))}`);
        const deps = Object.entries(upstream || {});
        if (deps.length) {
            lines.push('Results from prerequisite subtasks:');
            for (const [id, result] of deps) {
                lines.push(`- [${id}] ${result.description || result.type}: ${asText(result.output).slice(0, 2000)}`);
            }
        }
        lines.push('Answer this subtask only, concisely.');
        return lines.join('\n');
    }

    /** Drive a local CLI agent and collect its EventBus output for one turn. */
    _runViaAgent(agentId, ctx) {
        const agent = this.agents[agentId];
        const bus = this.eventBus;
        const prompt = this._taskPrompt(ctx);
        const turnId = `${ctx.requestId || 'task'}:${ctx.task.id}`;
        const timeoutMs = Number(process.env.TASK_PLANNER_AGENT_TIMEOUT_MS) || 180000;

        if (!bus || typeof bus.on !== 'function') {
            throw new Error(`agent ${agentId} needs an eventBus to collect output`);
        }

        return new Promise((resolve, reject) => {
            let chunks = '';
            let done = false;
            const timer = setTimeout(() => finish(new Error(`agent ${agentId} timed out after ${timeoutMs}ms`)), timeoutMs);

            const onMessage = evt => {
                if (!evt || evt.agentKey !== agentId || evt.requestId !== turnId) return;
                if (typeof evt.text === 'string') chunks += evt.text;
            };
            const onFinished = evt => {
                if (!evt || evt.agentKey !== agentId || evt.requestId !== turnId) return;
                finish(null, evt.finalText || chunks);
            };
            const onError = evt => {
                if (!evt || evt.agentKey !== agentId || evt.requestId !== turnId) return;
                finish(new Error(String((evt.error && evt.error.message) || evt.error || 'agent error')));
            };

            function finish(err, text) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try {
                    bus.off('channel.agent.message', onMessage);
                    bus.off('channel.agent.finished', onFinished);
                    bus.off('channel.agent.error', onError);
                } catch (offErr) { /* listener cleanup is best-effort */ }
                if (err) reject(err);
                else resolve({ output: String(text || '').trim(), agent: agentId, usage: emptyUsage() });
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
                        platform: 'taskplanner',
                        chatId: String(ctx.chatId || ''),
                        user: { id: 'taskplanner', displayName: 'TaskPlanner' },
                        content: { type: 'text', text: prompt, attachments: [] },
                        timestamp: Date.now(),
                    });
                })
                .catch(err => finish(err instanceof Error ? err : new Error(String(err))));
        });
    }

    async _runViaRouter(ctx) {
        if (!this.router || typeof this.router.chatCompletion !== 'function') {
            throw new Error('no router configured for subtask execution');
        }
        const selection = ctx.selection;
        const model = (selection && selection.kind === 'model' && selection.id) || this.plannerModel;
        const result = await this.router.chatCompletion({
            model,
            messages: [
                { role: 'system', content: 'You are one expert worker inside a multi-agent pipeline. Solve only the subtask you are given.' },
                { role: 'user', content: this._taskPrompt(ctx) },
            ],
        }, { signal: ctx.signal });
        return {
            output: messageText(result && result.data),
            model: (result && result.model) || model,
            providerId: (result && result.providerId) || null,
            usage: (result && result.usage) || emptyUsage(),
        };
    }

    // =========================================================================
    //  Stage #4 — Response Synthesis
    // =========================================================================

    /**
     * Merge every subtask result into one coherent answer.
     * Never throws: if the router is unavailable the results are stitched
     * together deterministically instead.
     *
     * @returns {Promise<{answer: string, usage: object, fallback: boolean}>}
     */
    async synthesize(request, plan, results, opts = {}) {
        const list = this._resultList(results);
        const usage = emptyUsage();
        const transcript = list.map(r => {
            const head = `[${r.id}] (${r.type}) ${r.description || ''}`.trim();
            if (r.status === 'ok') return `${head}\n  → ${asText(r.output).slice(0, 4000)}`;
            if (r.status === 'skipped') return `${head}\n  → SKIPPED (${r.reason || 'dependency failed'})`;
            return `${head}\n  → FAILED (${r.error || 'unknown error'})`;
        }).join('\n\n');

        try {
            if (!this.router || typeof this.router.chatCompletion !== 'function') {
                throw new Error('no router configured');
            }
            const result = await this.router.chatCompletion({
                model: this.plannerModel,
                messages: [
                    {
                        role: 'system',
                        content: [
                            '#4 Response Generation Stage. You are given the execution log of a',
                            'multi-agent plan. Answer the user directly and completely from the',
                            'inference results, in a friendly tone. Some results may be wrong or',
                            'missing — weigh them carefully, say so plainly, and never invent a',
                            'result that is not in the log. Filter out anything irrelevant.',
                        ].join(' '),
                    },
                    {
                        role: 'user',
                        content: `My request: ${String(request || '').trim()}\n\nPlan rationale: ${(plan && plan.rationale) || 'n/a'}\n\nExecution log:\n${transcript}`,
                    },
                ],
            }, { signal: opts.signal });
            addUsage(usage, result && result.usage);
            const answer = messageText(result && result.data).trim();
            if (answer) return { answer, usage, fallback: false };
            throw new Error('empty synthesis response');
        } catch (err) {
            console.warn('[TaskPlanner] Synthesis failed, stitching results locally:', err.message);
            const ok = list.filter(r => r.status === 'ok');
            const answer = ok.length
                ? ok.map(r => `${r.description || r.type}:\n${asText(r.output)}`).join('\n\n')
                : `I could not complete this request. ${list.map(r => `${r.id}: ${r.error || r.reason || r.status}`).join('; ')}`;
            return { answer, usage, fallback: true };
        }
    }

    _resultList(results) {
        if (Array.isArray(results)) return results.filter(Boolean);
        if (results && typeof results === 'object') {
            if (results.results && typeof results.results === 'object') return this._resultList(results.results);
            return Object.values(results).filter(Boolean);
        }
        return [];
    }

    // =========================================================================
    //  The whole pipeline
    // =========================================================================

    /**
     * plan → select → execute → synthesize.
     * @returns {Promise<{answer, plan, results, usage, stats, ok, requestId}>}
     */
    async run(request, opts = {}) {
        const rid = opts.requestId || this._nextRequestId('run');
        const usage = emptyUsage();
        const options = { ...opts, requestId: rid };

        const plan = await this.plan(request, options);
        addUsage(usage, plan.usage);

        const catalog = opts.catalog || await this.buildCatalog(options);
        for (const task of plan.tasks) {
            try {
                task.selection = this.selectModel(task, catalog);
            } catch (err) {
                console.warn(`[TaskPlanner] Model selection failed for ${task.id}:`, err.message);
                task.selection = null;
            }
        }

        const execution = await this.execute(plan, { ...options, catalog });
        addUsage(usage, execution.usage);

        const synthesis = await this.synthesize(request, plan, execution.results, options);
        addUsage(usage, synthesis.usage);

        this._emit({ phase: 'run', status: execution.ok ? 'ok' : 'failed', requestId: rid }, opts.onProgress);
        if (this.eventBus && typeof this.eventBus.emitFinished === 'function') {
            try { this.eventBus.emitFinished(PLANNER_EVENT_KEY, synthesis.answer, rid); }
            catch (err) { console.warn('[TaskPlanner] emitFinished failed:', err.message); }
        }

        return {
            answer: synthesis.answer,
            plan,
            results: execution.results,
            usage,
            stats: execution.stats,
            ok: execution.ok,
            order: execution.order,
            failed: execution.failed,
            skipped: execution.skipped,
            requestId: rid,
        };
    }
}

module.exports = TaskPlanner;
module.exports.TaskPlanner = TaskPlanner;
module.exports.TASK_TYPES = TASK_TYPES;
module.exports.LOCAL_AGENT_IDS = LOCAL_AGENT_IDS;
module.exports.AGENT_PROFILES = AGENT_PROFILES;
