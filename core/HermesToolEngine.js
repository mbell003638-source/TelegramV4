// =============================================================================
//  core/HermesToolEngine.js — Nous Research Hermes Function-Calling Engine
//
//  Implements the Nous Research Hermes-Function-Calling & Hermes-Agent protocol:
//    - Scratchpad parsing (<thought>...</thought>)
//    - Structured XML tool invocation (<tool_call>...</tool_call>)
//    - Tool response synthesis (<tool_response>...</tool_response>)
//    - Hermes Self-Correction Reflection loop on tool errors
//
//  ---------------------------------------------------------------------------
//  ORCHESTRATION TOOLS, NOT AGENT TOOLS
//  ---------------------------------------------------------------------------
//  Every CLI this bridge drives (Claude Code, Codex, Grok, Hermes, OpenClaw)
//  already ships a complete file / shell / web tool suite of its own, and each
//  does it better than a re-implementation here would. So this engine does NOT
//  compete with them. What it adds are the capabilities that only exist one
//  layer ABOVE the agents — the orchestration surface:
//
//    recall_memory      search the shared cross-agent memory
//    remember           write a salient fact back into that shared memory
//    list_agents        see who is on the swarm and what state they are in
//    delegate_to_agent  hand a task to another agent
//    list_skills        see which reusable skills are installed
//    use_skill          invoke one of them
//
//  (bash / read_file / write_file stay for the bare-model case, where the
//   engine drives a raw Hermes model that has no CLI of its own underneath.)
//
//  ---------------------------------------------------------------------------
//  DEPENDENCY INJECTION
//  ---------------------------------------------------------------------------
//  Nothing here is `require`d from a sibling orchestration module. Every
//  collaborator is OPTIONAL and injected — via `new HermesToolEngine({...})` or
//  `engine.configure({...})`. The module therefore loads, and every tool stays
//  registered and advertised, even when those modules do not exist on disk yet.
//  A tool whose dependency is missing fails with a readable
//  "<thing> not configured" error that the model can reflect on and route
//  around; it never throws out of executeTool().
// =============================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { globalTruncator } = require('./TruncationEngine');
const { globalLoopGuard } = require('./LoopGuard');
const { globalApprovalGate } = require('./SecurityApprovalGate');

/**
 * Every collaborator the engine can use. All optional, all injected.
 *
 *   memorySearch  core/MemorySearch.js     search(query, { chatId, agentId, limit }) -> hits[]
 *   database      core/Database.js         addMemory(chatId, text, { summary, importance, salience, source })
 *   delegation    core/AgentDelegation.js  delegate({ fromAgent, toAgent, prompt, chatId })
 *   skills        core/SkillRegistry.js    list() -> skills[] ; use(name, { args, chatId, agentId })
 *   agents        live agent roster: a plain object keyed by agent id, a Map, an
 *                 array, a () => roster function, or an object with listAgents().
 *
 * The last three are guardrails. They default to the process-wide singletons
 * and are only ever overridden by tests.
 */
const DEPENDENCY_KEYS = [
    'memorySearch',
    'database',
    'delegation',
    'skills',
    'agents',
    'approvalGate',
    'loopGuard',
    'truncator',
];

class HermesToolEngine {
    /**
     * @param {object} [dependencies] see DEPENDENCY_KEYS. All optional.
     */
    constructor(dependencies = {}) {
        this.tools = new Map();
        this.deps = {
            memorySearch: null,
            database: null,
            delegation: null,
            skills: null,
            agents: null,
            approvalGate: globalApprovalGate,
            loopGuard: globalLoopGuard,
            truncator: globalTruncator,
        };
        this.configure(dependencies);
        this._registerDefaultTools();
        this._registerOrchestrationTools();
    }

    /**
     * Wire (or re-wire) collaborators after construction — this is how the
     * process-wide `globalHermesEngine` gets hooked up from index.js once the
     * database, memory index, delegation router and skill registry are alive.
     *
     * Only keys actually present are touched, so partial wiring is safe and
     * repeatable. `undefined` means "leave as-is"; an explicit `null` unwires.
     *
     * @returns {HermesToolEngine} this, for chaining.
     */
    configure(dependencies = {}) {
        if (!dependencies || typeof dependencies !== 'object') return this;
        for (const key of DEPENDENCY_KEYS) {
            if (!Object.prototype.hasOwnProperty.call(dependencies, key)) continue;
            const value = dependencies[key];
            if (value === undefined) continue;
            this.deps[key] = value;
        }
        return this;
    }

    /**
     * Which collaborators are currently wired — for boot diagnostics.
     * @returns {Object<string, boolean>}
     */
    getDependencyStatus() {
        const status = {};
        for (const key of DEPENDENCY_KEYS) status[key] = Boolean(this.deps[key]);
        return status;
    }

    /**
     * Register a callable tool.
     */
    registerTool(name, description, parameters, handler) {
        if (!name || typeof name !== 'string') {
            throw new Error('registerTool requires a non-empty tool name');
        }
        if (typeof handler !== 'function') {
            throw new Error(`registerTool('${name}') requires a handler function`);
        }
        this.tools.set(name, {
            name,
            description,
            parameters,
            handler,
        });
        return this;
    }

    /**
     * Parse text for Hermes <thought> and <tool_call> tags.
     */
    parseOutput(text) {
        const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
        const thought = thoughtMatch ? thoughtMatch[1].trim() : null;

        const toolCalls = [];
        const toolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
        let match;
        while ((match = toolRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed && parsed.name) {
                    toolCalls.push({
                        name: parsed.name,
                        arguments: parsed.arguments || {},
                        raw: match[1].trim(),
                    });
                }
            } catch (e) {
                console.warn(`[HermesEngine] Failed parsing tool call JSON: ${match[1]}`);
            }
        }

        // Clean user-facing text by removing thought and tool_call tags
        const cleanText = text
            .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
            .trim();

        return { thought, toolCalls, cleanText };
    }

    /**
     * Execute a parsed tool call with safety guardrails (LoopGuard, Truncator,
     * ApprovalGate).
     *
     * NEVER throws. Anything that goes wrong — an unknown tool, a missing
     * dependency, a handler that blows up, output that will not serialise —
     * comes back as a structured <tool_response> with status "error" plus a
     * reflection prompt. That is exactly what the Hermes self-correction loop
     * feeds back to the model so it can fix itself.
     *
     * @param {{name: string, arguments: object}} toolCall
     * @param {{chatId?: string, workspaceDir?: string, agentId?: string}} [options]
     * @returns {Promise<string>} a <tool_response> XML block
     */
    async executeTool(toolCall, options = {}) {
        const {
            chatId = 'default',
            workspaceDir = process.cwd(),
            agentId = null,
        } = options || {};
        const name = (toolCall && toolCall.name) || 'unknown';

        try {
            const args = (toolCall && toolCall.arguments) || {};

            // 1. Loop Guard: Check for repetitive execution
            const loopGuard = this.deps.loopGuard;
            if (loopGuard && typeof loopGuard.checkToolCall === 'function') {
                const loopCheck = loopGuard.checkToolCall(chatId, name, args);
                if (loopCheck && loopCheck.isLoop) {
                    return this.formatToolResponse(name, {
                        status: 'error',
                        error: loopCheck.reason,
                    });
                }
            }

            const tool = this.tools.get(name);
            if (!tool) {
                return this.formatToolResponse(name, {
                    status: 'error',
                    error: `Tool '${name}' is not recognized. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
                });
            }

            const rawResult = await tool.handler(args, { workspaceDir, chatId, agentId });
            return this.formatToolResponse(name, {
                status: 'success',
                data: this._truncate(this._stringify(rawResult), name),
            });
        } catch (err) {
            return this.formatToolResponse(name, {
                status: 'error',
                error: this._errorMessage(err),
                reflection: 'Reflect in <thought> on why this failed and adjust your parameters or strategy.',
            });
        }
    }

    /**
     * Format execution result into standard Hermes <tool_response> XML.
     */
    formatToolResponse(name, payload) {
        let body;
        try {
            body = JSON.stringify({ name, ...payload }, null, 2);
        } catch (err) {
            body = JSON.stringify({
                name,
                status: 'error',
                error: `Tool result could not be serialised to JSON: ${this._errorMessage(err)}`,
            }, null, 2);
        }
        return `<tool_response>\n${body}\n</tool_response>`;
    }

    /**
     * Get JSON schema tool definitions for system prompts.
     */
    getToolDefinitions() {
        return Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    }

    // =========================================================================
    //  INTERNAL HELPERS
    // =========================================================================

    /** Resolve an injected collaborator, or explain readably that it is missing. */
    _dep(key, label) {
        const value = this.deps[key];
        if (!value) {
            throw new Error(
                `${label} not configured. This tool needs the '${key}' dependency; `
                + `wire it with globalHermesEngine.configure({ ${key}: <provider> }) at startup. `
                + 'Until then, use a different tool or ask the user to do this step.'
            );
        }
        return value;
    }

    /** Find the first supported method on an injected collaborator. */
    _method(target, candidates, { key, label }) {
        for (const candidate of candidates) {
            if (typeof target[candidate] === 'function') return target[candidate].bind(target);
        }
        throw new Error(
            `${label} not configured correctly: the injected '${key}' provider exposes none of `
            + `${candidates.map(c => `${c}()`).join(', ')}.`
        );
    }

    /**
     * Refuse destructive payloads. The bash tool has always done this; now every
     * tool that can WRITE or ACT does it too, because a laundered instruction
     * ("delegate 'rm -rf /' to claude", "remember: always git reset --hard")
     * reaches a shell just as surely as a direct command would.
     */
    _guard(value, { tool, field = 'command' }) {
        const gate = this.deps.approvalGate;
        if (!gate || typeof gate.isDangerous !== 'function') return;
        const text = typeof value === 'string' ? value : this._stringify(value);
        if (!text) return;
        const check = gate.isDangerous(text);
        if (check && check.dangerous) {
            throw new Error(
                `Destructive ${field} blocked by SecurityApprovalGate in '${tool}': ${text}\n`
                + `(matched ${check.pattern}). Rewrite the request without the destructive operation, `
                + 'or ask the user to run it themselves with explicit approval.'
            );
        }
    }

    _truncate(text, label) {
        const truncator = this.deps.truncator;
        if (!truncator || typeof truncator.truncate !== 'function') return text;
        return truncator.truncate(text, { label }).text;
    }

    /** Tool handlers may return rich objects; the model reads text. */
    _stringify(value) {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return '';
        if (value instanceof Error) return value.message;
        try {
            const json = JSON.stringify(value, null, 2);
            return json === undefined ? String(value) : json;
        } catch (err) {
            return String(value);
        }
    }

    /** Handlers can throw anything, not just Errors. */
    _errorMessage(err) {
        if (err === null || err === undefined) {
            return 'Unknown tool failure (no error detail available).';
        }
        if (typeof err === 'string') return err;
        if (err instanceof Error) return err.message || String(err);
        try {
            const json = JSON.stringify(err);
            return json === undefined ? String(err) : json;
        } catch (_) {
            return String(err);
        }
    }

    _limit(value, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return fallback;
        return Math.min(Math.floor(n), 100);
    }

    _score(value, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(1, Math.max(0, n));
    }

    /** Coerce whatever a provider hands back into a plain array. */
    _toArray(value, nestedKey) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (value instanceof Map) return Array.from(value.values());
        if (nestedKey && Array.isArray(value[nestedKey])) return value[nestedKey];
        if (typeof value === 'object') return Object.values(value);
        return [value];
    }

    /** Accept a roster as an object map, Map, array, factory fn or provider. */
    _normalizeAgents(registry) {
        let raw = registry;
        if (typeof raw === 'function') raw = raw();
        else if (raw && typeof raw.listAgents === 'function') raw = raw.listAgents();

        const out = [];
        if (!raw) return out;
        if (raw instanceof Map) {
            for (const [key, value] of raw.entries()) out.push(this._shapeAgent(key, value));
        } else if (Array.isArray(raw)) {
            for (const value of raw) out.push(this._shapeAgent(null, value));
        } else if (typeof raw === 'object') {
            for (const key of Object.keys(raw)) out.push(this._shapeAgent(key, raw[key]));
        }
        return out.filter(Boolean);
    }

    _shapeAgent(key, value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') return { id: value, name: value, status: 'unknown' };
        if (typeof value !== 'object') return null;

        const id = value.key || value.id || key || value.name;
        if (!id) return null;

        const shaped = {
            id: String(id),
            name: String(value.name || id),
            status: String(value.status || (value.isWarm ? 'running' : 'unknown')),
            warm: Boolean(value.isWarm),
        };
        if (value.emoji) shaped.emoji = String(value.emoji);
        if (value.description) shaped.description = String(value.description);
        if (value.errorMessage) shaped.error = String(value.errorMessage);
        return shaped;
    }

    /** Keep memory hits compact, but never drop a shape we do not recognise. */
    _shapeMemoryHit(hit) {
        if (!hit || typeof hit !== 'object') return { text: String(hit) };
        const shaped = {
            id: hit.id,
            agentId: hit.agentId !== undefined ? hit.agentId : hit.agent_id,
            source: hit.source,
            score: hit.score,
            createdAt: hit.createdAt !== undefined ? hit.createdAt : hit.created_at,
            text: hit.snippet || hit.text || hit.summary,
        };
        for (const k of Object.keys(shaped)) {
            if (shaped[k] === undefined || shaped[k] === null || shaped[k] === '') delete shaped[k];
        }
        return Object.keys(shaped).length ? shaped : hit;
    }

    // =========================================================================
    //  BARE-MODEL TOOLS (bash / read_file / write_file)
    // =========================================================================

    _registerDefaultTools() {
        // 1. Bash / Shell execution
        this.registerTool('bash', 'Execute a command in the bash shell', {
            type: 'object',
            properties: { command: { type: 'string', description: 'Command to run' } },
            required: ['command'],
        }, async ({ command }, { workspaceDir }) => {
            this._guard(command, { tool: 'bash', field: 'command' });
            return new Promise((resolve) => {
                exec(command, { cwd: workspaceDir, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                    const output = (stdout || stderr || '').trim();
                    if (err) {
                        resolve(`Exit code ${err.code || 1}\n${output}\n${err.message}`);
                    } else {
                        resolve(output || '(Success with no output)');
                    }
                });
            });
        });

        // 2. Read File
        this.registerTool('read_file', 'Read contents of a file', {
            type: 'object',
            properties: { filePath: { type: 'string', description: 'Relative path to file' } },
            required: ['filePath'],
        }, async ({ filePath }, { workspaceDir }) => {
            const resolved = path.resolve(workspaceDir, filePath);
            if (!fs.existsSync(resolved)) {
                throw new Error(`File not found: ${filePath}`);
            }
            return fs.readFileSync(resolved, 'utf8');
        });

        // 3. Write File
        this.registerTool('write_file', 'Write content to a file', {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Relative path to file' },
                content: { type: 'string', description: 'File contents to write' },
            },
            required: ['filePath', 'content'],
        }, async ({ filePath, content }, { workspaceDir }) => {
            const resolved = path.resolve(workspaceDir, filePath);
            const parent = path.dirname(resolved);
            if (!fs.existsSync(parent)) {
                fs.mkdirSync(parent, { recursive: true });
            }
            fs.writeFileSync(resolved, content, 'utf8');
            return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${filePath}`;
        });
    }

    // =========================================================================
    //  ORCHESTRATION TOOLS (memory / swarm / skills)
    // =========================================================================

    _registerOrchestrationTools() {
        // 4. Recall shared memory — READ
        this.registerTool(
            'recall_memory',
            'Search the shared cross-agent memory for anything ANY agent learned in ANY past session. '
            + 'Read-only. Use it before asking the user to repeat context you may already have.',
            {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Natural-language search terms' },
                    limit: { type: 'number', description: 'Maximum hits to return (default 10, max 100)' },
                    agentId: { type: 'string', description: 'Restrict to memories recorded by one agent' },
                    chatId: { type: 'string', description: 'Restrict to one chat (defaults to the current chat)' },
                },
                required: ['query'],
            },
            async (args = {}, ctx = {}) => {
                const memorySearch = this._dep('memorySearch', 'memory search');
                const query = String(args.query || '').trim();
                if (!query) {
                    throw new Error("recall_memory requires a non-empty 'query' string.");
                }
                const search = this._method(memorySearch, ['search'], {
                    key: 'memorySearch',
                    label: 'memory search',
                });
                const hits = await search(query, {
                    chatId: args.chatId || ctx.chatId,
                    agentId: args.agentId || undefined,
                    limit: this._limit(args.limit, 10),
                });
                const list = this._toArray(hits, 'results');
                if (!list.length) {
                    return {
                        query,
                        count: 0,
                        results: [],
                        note: 'Nothing in shared memory matched. Try broader or different terms, '
                            + 'or accept that this is genuinely new context.',
                    };
                }
                return {
                    query,
                    count: list.length,
                    results: list.map(hit => this._shapeMemoryHit(hit)),
                };
            },
        );

        // 5. Write shared memory — WRITE (guarded)
        this.registerTool(
            'remember',
            'Write a salient fact to the shared cross-agent memory so every agent can recall it later. '
            + 'Use it for durable things: decisions, user preferences, hard-won facts about this system. '
            + 'Do not use it for chit-chat or for anything already visible in the current conversation.',
            {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The fact, written so it still makes sense with no other context' },
                    summary: { type: 'string', description: 'Optional short label for the memory' },
                    importance: { type: 'number', description: '0..1, how much this matters long-term (default 0.5)' },
                    salience: { type: 'number', description: '0..1, initial recall weight (default 1.0)' },
                    source: { type: 'string', description: 'Where it came from (default: the calling agent)' },
                    chatId: { type: 'string', description: "Chat to attach it to; 'global' makes it swarm-wide" },
                },
                required: ['text'],
            },
            async (args = {}, ctx = {}) => {
                const database = this._dep('database', 'memory store');
                const text = String(args.text || '').trim();
                if (!text) {
                    throw new Error("remember requires a non-empty 'text' string.");
                }
                this._guard(text, { tool: 'remember', field: 'memory text' });
                const addMemory = this._method(database, ['addMemory'], {
                    key: 'database',
                    label: 'memory store',
                });
                const chatId = args.chatId || ctx.chatId || 'global';
                const options = {
                    summary: args.summary ? String(args.summary) : '',
                    importance: this._score(args.importance, 0.5),
                    salience: this._score(args.salience, 1.0),
                    source: args.source ? String(args.source) : (ctx.agentId ? `agent:${ctx.agentId}` : 'agent'),
                };
                await addMemory(chatId, text, options);
                return { stored: true, chatId, chars: text.length, ...options };
            },
        );

        // 6. Swarm roster — READ
        this.registerTool(
            'list_agents',
            'List the agents on this swarm and their current status, so you can decide who to hand work to. '
            + 'Call this before delegate_to_agent rather than guessing an agent id.',
            { type: 'object', properties: {}, required: [] },
            async () => {
                const registry = this._dep('agents', 'agent registry');
                const agents = this._normalizeAgents(registry);
                return { count: agents.length, agents };
            },
        );

        // 7. Delegation — ACT (guarded)
        this.registerTool(
            'delegate_to_agent',
            'Hand a task to another agent on the swarm and return its result. '
            + 'Use list_agents first to see valid ids. Prefer delegating specialist work over attempting it yourself.',
            {
                type: 'object',
                properties: {
                    toAgent: { type: 'string', description: 'Target agent id, from list_agents' },
                    prompt: { type: 'string', description: 'The full, self-contained task for that agent' },
                    fromAgent: { type: 'string', description: 'Your own agent id (defaults to the running agent)' },
                    chatId: { type: 'string', description: 'Chat this delegation belongs to' },
                },
                required: ['toAgent', 'prompt'],
            },
            async (args = {}, ctx = {}) => {
                const delegation = this._dep('delegation', 'delegation');
                const toAgent = String(args.toAgent || '').trim();
                const prompt = String(args.prompt || '').trim();
                if (!toAgent) {
                    throw new Error("delegate_to_agent requires 'toAgent'. Call list_agents to see valid ids.");
                }
                if (!prompt) {
                    throw new Error("delegate_to_agent requires a non-empty 'prompt' describing the task.");
                }
                const fromAgent = String(args.fromAgent || ctx.agentId || 'hermes');
                if (fromAgent === toAgent) {
                    throw new Error(
                        `delegate_to_agent cannot delegate to itself ('${toAgent}'). `
                        + 'Do the work directly, or pick a different agent.'
                    );
                }
                this._guard(prompt, { tool: 'delegate_to_agent', field: 'delegated prompt' });

                const chatId = args.chatId || ctx.chatId || 'default';
                const loopGuard = this.deps.loopGuard;
                if (loopGuard && typeof loopGuard.checkDelegation === 'function') {
                    const circular = loopGuard.checkDelegation(chatId, fromAgent, toAgent, prompt);
                    if (circular && circular.isLoop) throw new Error(circular.reason);
                }

                const delegate = this._method(delegation, ['delegate'], {
                    key: 'delegation',
                    label: 'delegation',
                });
                const result = await delegate({ fromAgent, toAgent, prompt, chatId });
                return {
                    delegated: true,
                    fromAgent,
                    toAgent,
                    chatId,
                    result: result === undefined ? null : result,
                };
            },
        );

        // 8. Skill catalogue — READ
        this.registerTool(
            'list_skills',
            'List the reusable skills (saved procedures and playbooks) installed on this bridge, '
            + 'with the arguments each one takes. Call this before use_skill.',
            { type: 'object', properties: {}, required: [] },
            async () => {
                const skills = this._dep('skills', 'skills');
                const list = this._method(skills, ['list', 'listSkills', 'getSkills', 'all'], {
                    key: 'skills',
                    label: 'skills',
                });
                const items = this._toArray(await list(), 'skills');
                return { count: items.length, skills: items };
            },
        );

        // 9. Skill invocation — ACT (guarded)
        this.registerTool(
            'use_skill',
            'Run one of the installed skills by name. Call list_skills first to see valid names and their arguments.',
            {
                type: 'object',
                properties: {
                    skill: { type: 'string', description: 'Skill name, exactly as list_skills reported it' },
                    args: { type: 'object', description: 'Arguments for the skill' },
                },
                required: ['skill'],
            },
            async (args = {}, ctx = {}) => {
                const skills = this._dep('skills', 'skills');
                const name = String(args.skill || args.name || '').trim();
                if (!name) {
                    throw new Error("use_skill requires a 'skill' name. Call list_skills to see valid names.");
                }
                const skillArgs = (args.args && typeof args.args === 'object') ? args.args : {};
                this._guard(skillArgs, { tool: 'use_skill', field: 'skill arguments' });
                const use = this._method(skills, ['use', 'useSkill', 'run', 'invoke', 'execute'], {
                    key: 'skills',
                    label: 'skills',
                });
                const result = await use(name, {
                    args: skillArgs,
                    chatId: ctx.chatId,
                    agentId: ctx.agentId,
                });
                return { skill: name, result: result === undefined ? null : result };
            },
        );
    }
}

const globalHermesEngine = new HermesToolEngine();

module.exports = {
    HermesToolEngine,
    globalHermesEngine,
};
