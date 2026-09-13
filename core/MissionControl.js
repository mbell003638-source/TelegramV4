// =============================================================================
//  core/MissionControl.js — Mission Control Web Server & SSE Streamer
//
//  Serves the local Kanban Dashboard on http://localhost:3141
//  Connects:
//    - Web Kanban UI to SQLite database (mission_tasks, hive_mind, memories)
//    - Real-time SSE event bus to channelEventBus
//    - Chat & task execution to ActionExecutor and Agents
// =============================================================================
const http = require('http');
const { getDashboardHtml } = require('./dashboardHtml');
const { channelEventBus, ChannelEvents } = require('./EventBus');
const { globalAgentPool } = require('./AgentPool');
const { globalSatelliteHub } = require('./SatelliteHub');
const fs = require('fs');
const path = require('path');

class MissionControlServer {
    constructor({ database, sessionStore, actionExecutor, agents, port = 3141, token = null }) {
        this.db = database;
        this.sessionStore = sessionStore;
        this.actionExecutor = actionExecutor;
        this.agents = agents;
        this.port = Number(port) || 3141;
        this.token = token || process.env.DASHBOARD_TOKEN || 'admin';
        this.server = null;
        this.sseClients = new Set();

        // Listen for EventBus events to broadcast via SSE
        this._wireEvents();
    }

    _wireEvents() {
        channelEventBus.onAgentMessage((data) => {
            this.broadcast('chat.message', data);
        });

        channelEventBus.onToolCall((data) => {
            this.broadcast('chat.tool_call', data);
        });

        channelEventBus.onStatus((data) => {
            this.broadcast('chat.status', data);
        });

        channelEventBus.onFinished((data) => {
            this.broadcast('chat.finished', data);
        });

        channelEventBus.onError((data) => {
            this.broadcast('chat.error', data);
        });
    }

    broadcast(event, data) {
        if (this.sseClients.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.sseClients) {
            try {
                client.write(payload);
            } catch (err) {
                this.sseClients.delete(client);
            }
        }
    }

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handleRequest(req, res));
            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.warn(`[MissionControl] Port ${this.port} in use. Dashboard may already be running.`);
                    resolve(false);
                } else {
                    reject(err);
                }
            });
            this.server.listen(this.port, '0.0.0.0', () => {
                console.log(`🚀 Mission Control Dashboard online at: http://localhost:${this.port}/?token=${this.token}`);
                resolve(true);
            });
        });
    }

    stop() {
        return new Promise((resolve) => {
            for (const client of this.sseClients) {
                try { client.end(); } catch (_) {}
            }
            this.sseClients.clear();
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    _sendJson(res, statusCode, data) {
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end(body);
    }

    _readBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
                if (body.length > 5 * 1024 * 1024) { // 5MB limit
                    reject(new Error('Payload too large'));
                }
            });
            req.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : {});
                } catch (e) {
                    resolve({});
                }
            });
            req.on('error', reject);
        });
    }

    async _handleRequest(req, res) {
        // CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            });
            return res.end();
        }

        const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = reqUrl.pathname;
        const query = Object.fromEntries(reqUrl.searchParams.entries());

        // Auth check (allow / without token to prompt or query token)
        const reqToken = query.token || req.headers['authorization']?.replace('Bearer ', '');
        if (this.token && reqToken !== this.token) {
            if (pathname === '/') {
                res.writeHead(401, { 'Content-Type': 'text/html' });
                return res.end(`
                    <html><body style="background:#0f0f0f;color:#fff;font-family:sans-serif;padding:40px;text-align:center;">
                        <h2>🔒 ClaudeClaw Mission Control</h2>
                        <p style="color:#888;">Authentication token required. Pass <code>?token=YOUR_TOKEN</code> in the URL.</p>
                    </body></html>
                `);
            }
            return this._sendJson(res, 401, { error: 'Unauthorized' });
        }

        try {
            // Serve Dashboard HTML
            if (pathname === '/') {
                const chatId = query.chatId || '';
                const html = getDashboardHtml(this.token, chatId);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(html);
            }

            // Real-Time SSE Event Stream
            if (pathname === '/api/chat/stream' || pathname === '/api/events') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                });
                res.write(': connected\n\n');
                this.sseClients.add(res);
                req.on('close', () => {
                    this.sseClients.delete(res);
                });
                return;
            }

            // 1. Status & System Info
            if (pathname === '/api/info' || pathname === '/api/status' || pathname === '/api/health') {
                const activeAgentKey = this.sessionStore?.getActiveAgent() || 'antigravity';
                const agent = this.agents[activeAgentKey];
                return this._sendJson(res, 200, {
                    status: 'online',
                    version: '4.2.0-universal',
                    botName: 'ClaudeClaw Super Assistant',
                    telegramConnected: true,
                    isProcessing: this.actionExecutor?.isProcessing || false,
                    activeAgent: activeAgentKey,
                    agentEmoji: agent?.emoji || '🤖',
                    satellites: globalSatelliteHub.getStatus(),
                    uptimeSeconds: Math.floor(process.uptime()),
                    timestamp: Date.now(),
                    contextPct: 15,
                    turns: 0,
                    compactions: 0,
                    sessionAge: 'active',
                    waConnected: false,
                    slackConnected: false,
                });
            }

            // 2. Agents List (Dynamic CLI agent status & model capabilities)
            if (pathname === '/api/agents') {
                const chatId = query.chatId || null;
                const activeAgentKey = this.sessionStore?.getActiveAgent(chatId) || 'antigravity';
                const list = Object.keys(this.agents).map((key) => {
                    const a = this.agents[key];
                    const activeModel = this.sessionStore?.getActiveModel(key, chatId) || 'default';
                    const availableModels = this.sessionStore?.getAvailableModels(key) || [];
                    const isActive = key === activeAgentKey;
                    const usage = this.db.getUsage ? this.db.getUsage(key) : {};
                    return {
                        id: key,
                        name: a.name || key,
                        emoji: a.emoji || '🤖',
                        status: 'live',
                        active: isActive,
                        running: true,
                        todayTurns: Number(usage?.totalRequests || 0),
                        model: activeModel,
                        availableModels: availableModels,
                        description: `CLI engine adapter for ${a.name}`,
                    };
                });
                return this._sendJson(res, 200, { agents: list, activeAgent: activeAgentKey });
            }

            // 2b. Agent Model Management (GET / PATCH / POST)
            if (pathname.match(/^\/api\/agents\/([^/]+)\/model$/)) {
                const agentId = pathname.split('/')[3];
                const chatId = query.chatId || null;
                if (req.method === 'GET') {
                    const model = this.sessionStore?.getActiveModel(agentId, chatId) || 'default';
                    const availableModels = this.sessionStore?.getAvailableModels(agentId) || [];
                    return this._sendJson(res, 200, { agentId, model, availableModels });
                }
                if (req.method === 'PATCH' || req.method === 'POST') {
                    const body = await this._readBody(req);
                    if (body.model) {
                        this.sessionStore?.setActiveModel(agentId, body.model, chatId);
                        // If custom model, add to available dynamic models so it appears in UI
                        const current = this.sessionStore?.getAvailableModels(agentId) || [];
                        if (!current.some(m => (typeof m === 'string' ? m : m.id) === body.model)) {
                            const newModelEntry = { id: body.model, name: body.name || body.model };
                            this.sessionStore?.setAvailableModels(agentId, [...current, newModelEntry]);
                        }
                        this.broadcast('agent.model_updated', { agentId, model: body.model });
                        return this._sendJson(res, 200, { success: true, agentId, model: body.model });
                    }
                    return this._sendJson(res, 400, { error: 'Model required' });
                }
            }

            // 2c. Global Model Switch (PATCH /api/agents/model)
            if (pathname === '/api/agents/model' && (req.method === 'PATCH' || req.method === 'POST')) {
                const body = await this._readBody(req);
                const chatId = query.chatId || null;
                if (body.model) {
                    for (const agentKey of Object.keys(this.agents)) {
                        this.sessionStore?.setActiveModel(agentKey, body.model, chatId);
                    }
                    this.broadcast('agent.global_model_updated', { model: body.model });
                    return this._sendJson(res, 200, { success: true, model: body.model });
                }
                return this._sendJson(res, 400, { error: 'Model required' });
            }

            // 2d. Switch Active Agent (POST /api/agents/active or /api/agents/switch)
            if ((pathname === '/api/agents/active' || pathname === '/api/agents/switch') && (req.method === 'POST' || req.method === 'PATCH')) {
                const body = await this._readBody(req);
                const agentId = body.agentId || body.agent;
                const chatId = query.chatId || null;
                if (agentId && this.agents[agentId]) {
                    this.sessionStore?.setActiveAgent(agentId, chatId);
                    this.broadcast('agent.switched', { activeAgent: agentId });
                    return this._sendJson(res, 200, { success: true, activeAgent: agentId });
                }
                return this._sendJson(res, 400, { error: 'Valid agentId required' });
            }

            // 2e. Agent Lifecycle (activate, deactivate, tasks, delete)
            if (pathname.match(/^\/api\/agents\/([^/]+)\/activate$/) && req.method === 'POST') {
                const agentId = pathname.split('/')[3];
                const chatId = query.chatId || null;
                const agent = this.agents[agentId];
                if (agent) {
                    this.sessionStore?.setActiveAgent(agentId, chatId);
                    if (typeof agent.ensureRunning === 'function') {
                        agent.ensureRunning().catch(err => console.warn(`[AgentActivate] ${agent.name}: ${err.message}`));
                    }
                    this.broadcast('agent.switched', { activeAgent: agentId });
                    return this._sendJson(res, 200, { ok: true, activeAgent: agentId, pid: process.pid, message: `Activated ${agent.name}` });
                }
                return this._sendJson(res, 404, { ok: false, error: `Agent not found: ${agentId}` });
            }

            if (pathname.match(/^\/api\/agents\/([^/]+)\/deactivate$/) && req.method === 'POST') {
                const agentId = pathname.split('/')[3];
                const agent = this.agents[agentId];
                if (agent) {
                    if (typeof agent.stop === 'function') {
                        await agent.stop();
                    }
                    this.broadcast('agent.stopped', { agentId });
                    return this._sendJson(res, 200, { ok: true, agentId, message: `Stopped ${agent.name}` });
                }
                return this._sendJson(res, 404, { ok: false, error: `Agent not found: ${agentId}` });
            }

            if (pathname.match(/^\/api\/agents\/([^/]+)\/tasks$/) && req.method === 'GET') {
                const agentId = pathname.split('/')[3];
                const tasks = this.db.getMissionTasks({ agentId }) || [];
                return this._sendJson(res, 200, { tasks });
            }

            if (pathname.match(/^\/api\/agents\/([^/]+)(\/full)?$/) && req.method === 'DELETE') {
                const agentId = pathname.split('/')[3];
                const agent = this.agents[agentId];
                if (agent) {
                    if (typeof agent.stop === 'function') {
                        await agent.stop();
                    }
                    this.sessionStore?.clearSession(agentId);
                    return this._sendJson(res, 200, { ok: true, message: `Agent ${agentId} cleared` });
                }
                return this._sendJson(res, 404, { ok: false, error: `Agent not found: ${agentId}` });
            }

            // 2f. Agent Templates & Validation (For New Agent Wizard)
            if (pathname === '/api/agents/templates' && req.method === 'GET') {
                return this._sendJson(res, 200, { templates: [] });
            }
            if (pathname === '/api/agents/validate-id' && req.method === 'GET') {
                return this._sendJson(res, 200, { valid: true });
            }

            // 2g. Agent Usage Tokens
            if (pathname.match(/^\/api\/agents\/([^/]+)\/tokens$/)) {
                const agentId = pathname.split('/')[3];
                const usage = this.db?.getUsage(agentId) || { inputTokens: 0, outputTokens: 0, turns: 0, costUsd: 0 };
                return this._sendJson(res, 200, usage);
            }

            // 2f. Chat History & Conversation
            if (pathname === '/api/chat/history' || pathname.match(/^\/api\/agents\/([^/]+)\/conversation$/)) {
                const chatId = query.chatId || 'dashboard_chat';
                const memories = this.db?.getMemories(chatId, { limit: Number(query.limit) || 40 }) || [];
                const turns = memories.map(m => ({
                    role: m.source === 'user' ? 'user' : 'assistant',
                    content: m.raw_text || m.summary,
                    source: m.source,
                    timestamp: m.created_at,
                }));
                return this._sendJson(res, 200, { turns });
            }

            // 3. Mission Tasks (Kanban)
            if (pathname === '/api/mission/tasks') {
                if (req.method === 'GET') {
                    const tasks = this.db.getMissionTasks({
                        agentId: query.agentId,
                        status: query.status,
                    });
                    return this._sendJson(res, 200, { tasks });
                }

                if (req.method === 'POST') {
                    const body = await this._readBody(req);
                    const task = this.db.createMissionTask({
                        title: body.title || 'Untitled Task',
                        prompt: body.prompt || body.title || '',
                        assignedAgent: body.assignedAgent || body.agent || 'main',
                        priority: body.priority || 0,
                        createdBy: 'dashboard',
                    });
                    this.broadcast('mission.task_created', task);

                    // If auto-run requested or agent assigned, execute asynchronously
                    if (body.runImmediately && this.actionExecutor) {
                        this._executeMissionTask(task);
                    }

                    return this._sendJson(res, 201, { task });
                }
            }

            // Scheduled Cron Tasks (GET /api/tasks)
            if (pathname === '/api/tasks') {
                const tasks = (this.db.getScheduledTasks ? this.db.getScheduledTasks(query.chatId) : []) || [];
                return this._sendJson(res, 200, { tasks });
            }

            // Summary Metrics: /api/summary
            if (pathname === '/api/summary') {
                const agentsList = Object.keys(this.agents);
                const activeAgentKey = this.sessionStore?.getActiveAgent() || 'antigravity';
                const missionTasks = this.db.getMissionTasks() || [];
                return this._sendJson(res, 200, {
                    ok: true,
                    agentsCount: agentsList.length,
                    activeAgent: activeAgentKey,
                    tasksCount: missionTasks.length,
                });
            }

            // Single Mission Task Route: /api/mission/tasks/:id
            if (pathname.startsWith('/api/mission/tasks/')) {
                const parts = pathname.split('/');
                const taskId = parts[4];

                if (req.method === 'GET') {
                    const task = this.db.getMissionTask(taskId);
                    if (!task) return this._sendJson(res, 404, { error: 'Task not found' });
                    return this._sendJson(res, 200, { task });
                }

                if (req.method === 'PATCH') {
                    const body = await this._readBody(req);
                    let task = null;
                    if (body.status) {
                        task = this.db.updateMissionTaskStatus(taskId, body.status, {
                            result: body.result,
                            error: body.error,
                        });
                    }
                    if (body.assignedAgent) {
                        task = this.db.reassignMissionTask(taskId, body.assignedAgent);
                    }
                    this.broadcast('mission.task_updated', task);
                    return this._sendJson(res, 200, { task });
                }

                if (req.method === 'POST' && (parts[5] === 'cancel' || pathname.endsWith('/cancel'))) {
                    const task = this.db.updateMissionTaskStatus(taskId, 'cancelled');
                    this.broadcast('mission.task_updated', task);
                    return this._sendJson(res, 200, { ok: true, task });
                }

                if (req.method === 'DELETE') {
                    this.db.deleteMissionTask(taskId);
                    this.broadcast('mission.task_deleted', { id: taskId });
                    return this._sendJson(res, 200, { success: true });
                }
            }

            // 4. Hive Mind Entries
            if (pathname === '/api/hive-mind') {
                if (req.method === 'DELETE') {
                    this.db.clearHiveMind();
                    this.broadcast('hive.cleared', {});
                    return this._sendJson(res, 200, { ok: true });
                }
                const entries = this.db.getHiveMindEntries({
                    agentId: query.agentId,
                    limit: Number(query.limit) || 30,
                });
                return this._sendJson(res, 200, { entries });
            }

            // 5. Memories
            if (pathname === '/api/memories/pinned') {
                const chatId = query.chatId || '';
                const memories = this.db.getMemories(chatId, { minSalience: 0.8, limit: 30 }) || [];
                return this._sendJson(res, 200, { memories });
            }
            if (pathname === '/api/memories/list') {
                const chatId = query.chatId || '';
                const limit = Number(query.limit) || 30;
                const offset = Number(query.offset) || 0;
                const memories = this.db.getMemories(chatId, { limit: limit + offset }) || [];
                const page = memories.slice(offset, offset + limit);
                return this._sendJson(res, 200, { memories: page, total: memories.length });
            }
            if (pathname.startsWith('/api/memories')) {
                const chatId = query.chatId || '';
                const memories = this.db.getMemories(chatId, {
                    minSalience: Number(query.minSalience) || 0.1,
                    limit: Number(query.limit) || 50,
                }) || [];
                const total = memories.length;
                const pinned = memories.filter(m => (m.salience || 0) >= 0.8).length;
                return this._sendJson(res, 200, {
                    memories,
                    stats: {
                        total: total || 0,
                        pinned: pinned || 0,
                        consolidations: 0,
                        importanceDistribution: [
                            { bucket: '0-0.2', count: memories.filter(m => (m.importance || 0) < 0.2).length },
                            { bucket: '0.2-0.4', count: memories.filter(m => (m.importance || 0) >= 0.2 && (m.importance || 0) < 0.4).length },
                            { bucket: '0.4-0.6', count: memories.filter(m => (m.importance || 0) >= 0.4 && (m.importance || 0) < 0.6).length },
                            { bucket: '0.6-0.8', count: memories.filter(m => (m.importance || 0) >= 0.6 && (m.importance || 0) < 0.8).length },
                            { bucket: '0.8-1.0', count: memories.filter(m => (m.importance || 0) >= 0.8).length },
                        ],
                    },
                    fading: memories.filter(m => (m.salience || 0) < 0.4).slice(0, 5),
                    topAccessed: memories.slice().sort((a, b) => (b.access_count || 0) - (a.access_count || 0)).slice(0, 5),
                    consolidations: [],
                });
            }

            // 6. Token Usage
            if (pathname === '/api/tokens') {
                const stats = {};
                let todayInput = 0;
                let todayOutput = 0;
                let todayTurns = 0;
                for (const agentKey of Object.keys(this.agents)) {
                    const u = this.db.getUsage(agentKey) || {};
                    stats[agentKey] = u;
                    todayInput += Number(u.inputTokens || 0);
                    todayOutput += Number(u.outputTokens || 0);
                    todayTurns += Number(u.totalRequests || 0);
                }
                stats.todayInput = todayInput;
                stats.todayOutput = todayOutput;
                stats.todayTurns = todayTurns;
                return this._sendJson(res, 200, { stats });
            }

            // 7. Concurrency & Resource Pool Management
            if (pathname === '/api/concurrency') {
                if (req.method === 'GET') {
                    return this._sendJson(res, 200, globalAgentPool.getStatus());
                }
                if (req.method === 'POST') {
                    const body = await this._readBody(req);
                    if (body.maxConcurrent) {
                        globalAgentPool.setMaxConcurrent(body.maxConcurrent);
                        this.broadcast('concurrency.updated', globalAgentPool.getStatus());
                        return this._sendJson(res, 200, { success: true, status: globalAgentPool.getStatus() });
                    }
                    return this._sendJson(res, 400, { error: 'maxConcurrent is required' });
                }
            }

            // 7b. Provider Settings & API Keys (OpenClaw / Hermes model configuration)
            if (pathname === '/api/settings/providers') {
                if (req.method === 'GET') {
                    const mask = (key) => key ? (key.slice(0, 7) + '...' + key.slice(-4)) : '';
                    return this._sendJson(res, 200, {
                        providers: {
                            openrouter: {
                                configured: !!process.env.OPENROUTER_API_KEY,
                                masked: mask(process.env.OPENROUTER_API_KEY),
                                label: 'OpenRouter (200+ models, DeepSeek R1, Claude, Llama 3)'
                            },
                            anthropic: {
                                configured: !!process.env.ANTHROPIC_API_KEY,
                                masked: mask(process.env.ANTHROPIC_API_KEY),
                                label: 'Anthropic Claude'
                            },
                            openai: {
                                configured: !!process.env.OPENAI_API_KEY,
                                masked: mask(process.env.OPENAI_API_KEY),
                                baseUrl: process.env.OPENAI_BASE_URL || '',
                                label: 'OpenAI / Codex'
                            },
                            deepseek: {
                                configured: !!process.env.DEEPSEEK_API_KEY,
                                masked: mask(process.env.DEEPSEEK_API_KEY),
                                baseUrl: process.env.DEEPSEEK_BASE_URL || '',
                                label: 'DeepSeek'
                            },
                            groq: {
                                configured: !!process.env.GROQ_API_KEY,
                                masked: mask(process.env.GROQ_API_KEY),
                                label: 'Groq'
                            },
                            ollama: {
                                configured: !!process.env.OLLAMA_BASE_URL,
                                baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
                                label: 'Local LLM (Ollama / LM Studio / vLLM)'
                            },
                            gemini: {
                                configured: !!process.env.GEMINI_API_KEY,
                                masked: mask(process.env.GEMINI_API_KEY),
                                label: 'Google Gemini'
                            },
                            daily: {
                                configured: !!process.env.DAILY_API_KEY,
                                masked: mask(process.env.DAILY_API_KEY),
                                label: 'Daily.co (Live Voice / Video Rooms)'
                            },
                            recall: {
                                configured: !!process.env.RECALL_API_KEY,
                                masked: mask(process.env.RECALL_API_KEY),
                                label: 'Recall.ai (Google Meet Voice Bot)'
                            },
                            pika: {
                                configured: !!process.env.PIKA_API_KEY,
                                masked: mask(process.env.PIKA_API_KEY),
                                label: 'Pika (AI Video Avatar)'
                            }
                        }
                    });
                }

                if (req.method === 'POST') {
                    const body = await this._readBody(req);
                    const envPath = path.resolve(__dirname, '..', '.env');
                    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

                    const keysToUpdate = {
                        OPENROUTER_API_KEY: body.openrouterApiKey,
                        ANTHROPIC_API_KEY: body.anthropicApiKey,
                        OPENAI_API_KEY: body.openaiApiKey,
                        OPENAI_BASE_URL: body.openaiBaseUrl,
                        DEEPSEEK_API_KEY: body.deepseekApiKey,
                        DEEPSEEK_BASE_URL: body.deepseekBaseUrl,
                        GROQ_API_KEY: body.groqApiKey,
                        OLLAMA_BASE_URL: body.ollamaBaseUrl,
                        GEMINI_API_KEY: body.geminiApiKey,
                        DAILY_API_KEY: body.dailyApiKey,
                        RECALL_API_KEY: body.recallApiKey,
                        PIKA_API_KEY: body.pikaApiKey,
                    };

                    for (const [key, val] of Object.entries(keysToUpdate)) {
                        if (val !== undefined && val !== null && String(val).trim() !== '') {
                            const trimmed = String(val).trim();
                            process.env[key] = trimmed;
                            const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
                            if (regex.test(envContent)) {
                                envContent = envContent.replace(regex, `${key}=${trimmed}`);
                            } else {
                                envContent += `\n${key}=${trimmed}`;
                            }
                        }
                    }

                    fs.writeFileSync(envPath, envContent, 'utf8');
                    this.broadcast('settings.updated', { success: true });
                    return this._sendJson(res, 200, { ok: true, message: 'Provider API keys and URLs updated successfully!' });
                }
            }

            // 8. War Room Voice Settings (Gemini Live / Cartesia)
            if (pathname === '/api/warroom/voices') {
                if (req.method === 'GET') {
                    const defaultVoices = {
                        antigravity: 'Charon (Informative)',
                        opencode: 'Aoede (Breezy)',
                        codex: 'Alnilam (Firm)',
                        claude: 'Charon (Informative)',
                        openclaw: 'Leda (Youthful)',
                        hermes: 'Kore (Firm)',
                        pi: 'Puck (Playful)',
                        grok: 'Fenrir (Deep)',
                    };
                    return this._sendJson(res, 200, { voices: this._warRoomVoices || defaultVoices });
                }
                if (req.method === 'POST') {
                    const body = await this._readBody(req);
                    this._warRoomVoices = Object.assign(this._warRoomVoices || {}, body.voices || {});
                    this.broadcast('warroom.voices_updated', this._warRoomVoices);
                    return this._sendJson(res, 200, { ok: true, voices: this._warRoomVoices });
                }
            }

            // 8b. War Room Standup Trigger
            if (pathname === '/api/warroom/standup' && req.method === 'POST') {
                const sessionId = `standup_${Date.now()}`;
                this.db.recordHiveMind('system', 'war_room', 'standup_started', 'Voice standup meeting convened with agent swarm.');
                this.broadcast('warroom.standup_started', { sessionId, timestamp: Date.now() });
                return this._sendJson(res, 200, { ok: true, sessionId, message: 'War room voice standup convened.' });
            }

            // 8c. War Room Standup Interactive Speech & Message
            if (pathname === '/api/warroom/message' && req.method === 'POST') {
                const body = await this._readBody(req);
                const userMsg = (body.message || '').trim();
                const activeAgentId = this.activeAgentKey || 'codex';
                const activeAgent = this.agents[activeAgentId];
                const agentName = activeAgent ? activeAgent.name : activeAgentId;

                this.db.recordHiveMind('user', 'war_room', 'user_speech', userMsg);

                let reply = `Agent ${agentName} reporting: All systems are operational. Swarm is standing by for your directives.`;
                const lower = userMsg.toLowerCase();
                if (lower.includes('status') || lower.includes('report')) {
                    const taskCount = this.db.getMissionTasks().length;
                    reply = `${agentName} status report: Swarm has ${Object.keys(this.agents).length} live agents connected. ${taskCount} tasks logged in mission control. Concurrency pool is healthy.`;
                } else if (lower.includes('task') || lower.includes('todo') || lower.includes('in progress')) {
                    const queued = this.db.getMissionTasks('queued').length;
                    const inProg = this.db.getMissionTasks('in_progress').length;
                    reply = `Task update: ${inProg} in progress, ${queued} queued. All agents ready for new tasks.`;
                } else if (lower.includes('help') || lower.includes('who')) {
                    reply = `War Room active agents: Antigravity, OpenCode, Codex, Claude Code, OpenClaw, Hermes, Pi Agent, and Grok. Ready to assist.`;
                }

                this.db.recordHiveMind(activeAgentId, 'war_room', 'agent_speech', reply);
                return this._sendJson(res, 200, { ok: true, agentId: activeAgentId, agentName, reply });
            }

            // 9. Live Meetings Dispatch (Google Meet, Pika, Recall.ai, Daily.co)
            if (pathname === '/api/meetings') {
                if (req.method === 'GET') {
                    return this._sendJson(res, 200, { sessions: this._meetingSessions || [] });
                }
                if (req.method === 'DELETE') {
                    this._meetingSessions = [];
                    this.broadcast('meeting.cleared', {});
                    return this._sendJson(res, 200, { ok: true, message: 'All meeting sessions cleared' });
                }
            }

            if (pathname.startsWith('/api/meetings/') && req.method === 'DELETE') {
                const sessionId = pathname.slice('/api/meetings/'.length);
                if (this._meetingSessions) {
                    const idx = this._meetingSessions.findIndex(s => s.id === sessionId);
                    if (idx !== -1) {
                        const removed = this._meetingSessions.splice(idx, 1)[0];
                        this.db.recordHiveMind(removed.agentId || 'system', 'live_meetings', 'meeting_ended', `Meeting link for ${removed.agentId} (${removed.provider}) was removed.`);
                        this.broadcast('meeting.removed', { id: sessionId });
                        return this._sendJson(res, 200, { ok: true, message: 'Meeting session removed' });
                    }
                }
                return this._sendJson(res, 404, { error: 'Session not found' });
            }

            if (pathname === '/api/meetings/dispatch' && req.method === 'POST') {
                const body = await this._readBody(req);
                const provider = body.provider || 'daily';
                const agentId = body.agentId || 'claude';
                let meetUrl = body.meetUrl && body.meetUrl.trim();

                // If Google Meet mode and no custom URL provided, point to https://meet.google.com/new
                if (!meetUrl && (provider === 'google' || provider === 'meet')) {
                    meetUrl = 'https://meet.google.com/new';
                }

                // If Daily.co mode and no custom URL provided, provision a real room
                if (!meetUrl && provider === 'daily') {
                    if (process.env.DAILY_API_KEY) {
                        try {
                            const dailyRes = await fetch('https://api.daily.co/v1/rooms', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${process.env.DAILY_API_KEY.trim()}`,
                                },
                                body: JSON.stringify({
                                    properties: {
                                        exp: Math.floor(Date.now() / 1000) + 7200,
                                        enable_chat: true,
                                        enable_screenshare: true,
                                    },
                                }),
                            });
                            const dailyData = await dailyRes.json();
                            if (dailyData.url) {
                                meetUrl = dailyData.url;
                            }
                        } catch (err) {
                            console.warn('[Daily.co] Room provision error:', err.message);
                        }
                    }
                    // Fallback to instant live WebRTC room that works immediately without 404 or moderator login
                    if (!meetUrl) {
                        const roomCode = `ClaudeClaw-${agentId}-${Date.now().toString(36)}`;
                        meetUrl = `https://p2p.mirotalk.com/join/${roomCode}`;
                    }
                } else if (!meetUrl) {
                    const roomCode = `ClaudeClaw-${agentId}-${Date.now().toString(36)}`;
                    meetUrl = `https://p2p.mirotalk.com/join/${roomCode}`;
                }

                const session = {
                    id: `meet_${Date.now()}`,
                    provider: provider,
                    agentId: agentId,
                    meetUrl: meetUrl,
                    mode: body.mode || 'direct',
                    autoBrief: !!body.autoBrief,
                    status: 'live',
                    createdAt: Date.now(),
                };
                this._meetingSessions = this._meetingSessions || [];
                this._meetingSessions.unshift(session);
                this.db.recordHiveMind(session.agentId, 'live_meetings', 'meeting_active', `Agent ${session.agentId} live in ${session.provider} room: ${session.meetUrl}`);
                this.broadcast('meeting.dispatched', session);
                return this._sendJson(res, 200, { ok: true, session });
            }

            // 10. Chat Send (Dashboard Web Chat)
            if (pathname === '/api/chat/send' && req.method === 'POST') {
                const body = await this._readBody(req);
                const text = body.message || body.text || '';
                const agentKey = body.agentId || this.sessionStore?.getActiveAgent('dashboard_chat') || 'antigravity';
                if (body.agentId) {
                    this.sessionStore?.setActiveAgent(body.agentId, 'dashboard_chat');
                }
                if (body.model) {
                    this.sessionStore?.setActiveModel(agentKey, body.model, 'dashboard_chat');
                }

                // Dispatch to ActionExecutor
                if (this.actionExecutor && text) {
                    const fakeMsg = {
                        id: `dash_${Date.now()}`,
                        platform: 'dashboard',
                        chatId: 'dashboard_chat',
                        user: { id: 'admin', username: 'DashboardUser' },
                        content: { type: 'text', text },
                        raw: {
                            reply: async (replyText) => {
                                this.broadcast('chat.assistant_reply', { text: replyText });
                            },
                        },
                    };
                    // Enqueue
                    this.actionExecutor._enqueue(fakeMsg);
                }

                return this._sendJson(res, 200, { success: true, agent: agentKey });
            }

            // 9. Satellite Workers (Distributed Windows/Remote nodes)
            if (pathname === '/api/satellite/poll') {
                const body = (req.method === 'POST') ? await this._readBody(req) : {};
                const satelliteId = body.satelliteId || query.satelliteId || 'windows-desktop';
                const metadata = {
                    hostname: body.hostname || query.hostname,
                    platform: body.platform || query.platform || 'win32',
                    systemInfo: body.systemInfo || {},
                };
                const ip = req.socket?.remoteAddress || '127.0.0.1';
                globalSatelliteHub.handlePoll(satelliteId, res, metadata, ip);
                return;
            }

            if (pathname === '/api/satellite/response' && req.method === 'POST') {
                const body = await this._readBody(req);
                const satelliteId = body.satelliteId || query.satelliteId;
                const result = globalSatelliteHub.handleResponse(satelliteId, body);
                return this._sendJson(res, 200, result);
            }

            if (pathname === '/api/satellite/status') {
                return this._sendJson(res, 200, globalSatelliteHub.getStatus());
            }

            // 404 for unknown endpoints
            return this._sendJson(res, 404, { error: `Endpoint not found: ${pathname}` });

        } catch (err) {
            console.error('[MissionControl Error]', err);
            return this._sendJson(res, 500, { error: err.message });
        }
    }

    async _executeMissionTask(task) {
        const slotId = `mission_${task.id}`;
        const agentKey = task.assigned_agent && this.agents[task.assigned_agent] ? task.assigned_agent : 'antigravity';
        const agent = this.agents[agentKey];

        await globalAgentPool.acquire(slotId, {
            agentKey,
            priority: task.priority || 0,
            description: task.title,
        });

        try {
            this.db.updateMissionTaskStatus(task.id, 'in_progress');
            this.broadcast('mission.task_updated', { ...task, status: 'in_progress' });

            // Run agent via ActionExecutor or Agent directly
            if (agent && typeof agent.execute === 'function') {
                const result = await agent.execute(task.prompt, `task_${task.id}`);
                this.db.updateMissionTaskStatus(task.id, 'completed', { result });
                this.db.recordHiveMind(agentKey, 'mission_control', `completed_task_${task.id}`, task.title, [task.id]);
                this.broadcast('mission.task_updated', { ...task, status: 'completed', result });
            }
        } catch (err) {
            this.db.updateMissionTaskStatus(task.id, 'failed', { error: err.message });
            this.broadcast('mission.task_updated', { ...task, status: 'failed', error: err.message });
        } finally {
            globalAgentPool.release(slotId);
        }
    }
}

module.exports = MissionControlServer;
