// =============================================================================
//  core/Database.js — SQLite WAL-Mode Database for Universal Assistant
//
//  Unifies:
//    1. Mission Control Kanban tasks (`mission_tasks`)
//    2. Hive Mind blackboard delegation (`hive_mind`)
//    3. Salient memories with decay & importance (`memories`)
//    4. Scheduled cron jobs (`scheduled_tasks`)
//    5. Token usage & telemetry (`token_usage`)
//    6. Cross-CLI session catalog & chat preferences (`chat_preferences`)
//    7. Audit logging (`audit_log`)
//
//  Uses Node.js 22+ built-in synchronous SQLite (node:sqlite) for zero external
//  compilation dependencies across Windows, Linux, and ARM.
// =============================================================================
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AssistantDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');

        this._createSchema();
    }

    _createSchema() {
        this.db.exec(`
            -- 1. Mission Control Kanban Tasks
            CREATE TABLE IF NOT EXISTS mission_tasks (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                prompt          TEXT NOT NULL,
                assigned_agent  TEXT NOT NULL DEFAULT 'main',
                status          TEXT NOT NULL DEFAULT 'queued', -- queued, in_progress, completed, failed
                result          TEXT,
                error           TEXT,
                created_by      TEXT NOT NULL DEFAULT 'telegram',
                priority        INTEGER NOT NULL DEFAULT 0,     -- 0=Normal, 1=High, 2=Urgent
                created_at      INTEGER NOT NULL,
                started_at      INTEGER,
                completed_at    INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_mission_status
                ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);

            -- 2. Hive Mind Inter-Agent Delegation
            CREATE TABLE IF NOT EXISTS hive_mind (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                chat_id     TEXT NOT NULL,
                action      TEXT NOT NULL,
                summary     TEXT NOT NULL,
                artifacts   TEXT, -- JSON encoded file paths / objects
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_hive_mind_agent ON hive_mind(agent_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_hive_mind_time ON hive_mind(created_at DESC);

            -- 3. Inter-Agent Direct Tasks
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

            -- 4. Unified Salient Memories
            CREATE TABLE IF NOT EXISTS memories (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id       TEXT NOT NULL,
                source        TEXT NOT NULL DEFAULT 'conversation',
                raw_text      TEXT NOT NULL,
                summary       TEXT NOT NULL,
                entities      TEXT NOT NULL DEFAULT '[]',
                topics        TEXT NOT NULL DEFAULT '[]',
                importance    REAL NOT NULL DEFAULT 0.5,
                salience      REAL NOT NULL DEFAULT 1.0,
                consolidated  INTEGER NOT NULL DEFAULT 0,
                created_at    INTEGER NOT NULL,
                accessed_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(chat_id, salience DESC);

            -- 5. Scheduled Tasks
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id          TEXT PRIMARY KEY,
                chat_id     TEXT NOT NULL DEFAULT '',
                agent_id    TEXT NOT NULL DEFAULT 'main',
                prompt      TEXT NOT NULL,
                schedule    TEXT NOT NULL,
                next_run    INTEGER NOT NULL,
                last_run    INTEGER,
                last_result TEXT,
                status      TEXT NOT NULL DEFAULT 'active',
                created_at  INTEGER NOT NULL
            );

            -- 6. Token Usage & Costs
            CREATE TABLE IF NOT EXISTS token_usage (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id        TEXT NOT NULL,
                chat_id         TEXT NOT NULL DEFAULT '',
                session_id      TEXT,
                input_tokens    INTEGER NOT NULL DEFAULT 0,
                output_tokens   INTEGER NOT NULL DEFAULT 0,
                total_tokens    INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_token_agent ON token_usage(agent_id, created_at DESC);

            -- 7. Chat Preferences & Active Sessions
            CREATE TABLE IF NOT EXISTS chat_preferences (
                chat_id         TEXT PRIMARY KEY,
                active_agent    TEXT NOT NULL DEFAULT 'antigravity',
                active_model    TEXT,
                reasoning_effort TEXT,
                voice_mode      INTEGER NOT NULL DEFAULT 0,
                cwd             TEXT,
                updated_at      INTEGER NOT NULL
            );

            -- 8. CLI Session Catalog
            CREATE TABLE IF NOT EXISTS cli_sessions (
                agent_key       TEXT NOT NULL,
                chat_id         TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                cwd             TEXT,
                title           TEXT,
                updated_at      INTEGER NOT NULL,
                PRIMARY KEY(agent_key, chat_id)
            );

            -- 9. Audit Logging
            CREATE TABLE IF NOT EXISTS audit_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL DEFAULT 'main',
                chat_id     TEXT NOT NULL DEFAULT '',
                action      TEXT NOT NULL,
                detail      TEXT NOT NULL DEFAULT '',
                blocked     INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

            -- 10. Suggestions Feature (ClaudeClaw V3 Pack 04)
            CREATE TABLE IF NOT EXISTS suggestions (
                id              TEXT PRIMARY KEY,
                agent_id        TEXT NOT NULL,
                suggestion_type TEXT NOT NULL,
                summary         TEXT NOT NULL,
                details_json    TEXT,
                dismissed_at    INTEGER,
                created_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_suggestions_agent ON suggestions(agent_id, created_at DESC);

            -- 11. War Room agent voice assignments (persisted across restarts)
            CREATE TABLE IF NOT EXISTS agent_voices (
                agent_id    TEXT PRIMARY KEY,
                voice       TEXT NOT NULL,
                updated_at  INTEGER NOT NULL
            );

            -- 12. Live meeting sessions (persisted across restarts)
            CREATE TABLE IF NOT EXISTS live_meetings (
                id          TEXT PRIMARY KEY,
                agent_id    TEXT NOT NULL,
                provider    TEXT NOT NULL DEFAULT '',
                meet_url    TEXT NOT NULL DEFAULT '',
                topic       TEXT NOT NULL DEFAULT '',
                payload     TEXT,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_meetings_time ON live_meetings(created_at DESC);
        `);
    }

    seedDemoTasks() {
        try {
            const countRow = this.db.prepare('SELECT COUNT(*) as count FROM mission_tasks').get();
            if (countRow && countRow.count === 0) {
                const now = Date.now();
                this.db.prepare(`
                    INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority, created_by, created_at, result)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run('task_welcome_1', 'Welcome to ClaudeClaw Mission Control', 'Verify swarm coordination and CLI engine adapters.', 'codex', 'completed', 2, 'system', now - 3600000, 'All CLI engines initialized.');

                this.db.prepare(`
                    INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run('task_providers_2', 'Configure Providers & API Keys', 'Open Provider Settings to configure OpenRouter, OpenAI, Anthropic, DeepSeek, or Ollama.', 'grok', 'in_progress', 1, 'system', now - 1800000);

                this.db.prepare(`
                    INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run('task_swarm_3', 'Multi-Agent Hive Mind Delegation', 'Test multi-agent collaboration and tool execution via chat or Kanban.', 'claude', 'queued', 0, 'system', now);
            }

            const hiveRow = this.db.prepare('SELECT COUNT(*) as count FROM hive_mind').get();
            if (hiveRow && hiveRow.count === 0) {
                this.recordHiveMind('system', 'dashboard_chat', 'swarm_initialized', 'ClaudeClaw Super Assistant online with 8 CLI engines.');
            }

            const memRow = this.db.prepare('SELECT COUNT(*) as count FROM memories').get();
            if (memRow && memRow.count === 0) {
                this.addMemory('global', 'User Profile & Preferences: Handle: Ahemnani. Mode: Autonomous YOLO execution. Style: Direct, technical, and concise.', {
                    summary: 'User Profile: Ahemnani (Autonomous YOLO mode, concise technical style)',
                    importance: 0.95,
                    salience: 1.0,
                    source: 'user_profile'
                });
                this.addMemory('global', 'System Protocol: Clean single-turn responses for basic greetings. Proactive agent delegation across domain tasks.', {
                    summary: 'System Rules: Concise greeting responses and proactive multi-agent delegation',
                    importance: 0.90,
                    salience: 0.95,
                    source: 'system_rules'
                });
                this.addMemory('global', 'Infrastructure Context: Modular Telegram Bridge v4 architecture with Web Mission Control HUD & TCP lock on port 47200.', {
                    summary: 'Infrastructure: Modular v4 architecture with Browser HUD & TCP lock',
                    importance: 0.85,
                    salience: 0.90,
                    source: 'infrastructure'
                });
                this.addMemory('global', 'Swarm Composition: 8 Specialized CLI engines (Antigravity, OpenCode, Codex, Claude, OpenClaw, Hermes, Pi, Grok) with live stdio/ACP.', {
                    summary: 'Swarm: 8 CLI engines configured with model discovery and tool execution',
                    importance: 0.80,
                    salience: 0.85,
                    source: 'swarm_registry'
                });
                this.addMemory('global', 'War Room HUD: Multi-agent council deliberation (/discuss) with Antigravity as Consolidator synthesizer.', {
                    summary: 'War Room: Virtual boardroom council and morning standup roll call',
                    importance: 0.75,
                    salience: 0.80,
                    source: 'warroom'
                });
            }
        } catch (e) {
            console.warn('[Database] Seed notice:', e.message);
        }
    }

    // =========================================================================
    //  MISSION CONTROL KANBAN TASKS
    // =========================================================================

    createMissionTask({ id, title, prompt, assignedAgent = 'main', priority = 0, createdBy = 'telegram' }) {
        const taskId = id || `task_${crypto.randomUUID().slice(0, 8)}`;
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority, created_by, created_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
        `);
        stmt.run(taskId, title, prompt, assignedAgent, priority, createdBy, now);
        return this.getMissionTask(taskId);
    }

    getMissionTask(id) {
        const stmt = this.db.prepare('SELECT * FROM mission_tasks WHERE id = ?');
        return stmt.get(id) || null;
    }

    getMissionTasks({ agentId, status, limit = 50 } = {}) {
        let sql = 'SELECT * FROM mission_tasks WHERE 1=1';
        const params = [];
        if (agentId && agentId !== 'all') {
            sql += ' AND assigned_agent = ?';
            params.push(agentId);
        }
        if (status && status !== 'all') {
            sql += ' AND status = ?';
            params.push(status);
        }
        sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?';
        params.push(limit);

        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }

    updateMissionTaskStatus(id, status, { result = null, error = null } = {}) {
        const now = Date.now();
        let sql = 'UPDATE mission_tasks SET status = ?';
        const params = [status];

        if (status === 'in_progress') {
            sql += ', started_at = ?';
            params.push(now);
        } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            sql += ', completed_at = ?';
            params.push(now);
            if (result !== null) {
                sql += ', result = ?';
                params.push(typeof result === 'string' ? result : JSON.stringify(result));
            }
            if (error !== null) {
                sql += ', error = ?';
                params.push(String(error));
            }
        }
        sql += ' WHERE id = ?';
        params.push(id);

        this.db.prepare(sql).run(...params);
        return this.getMissionTask(id);
    }

    reassignMissionTask(id, assignedAgent) {
        this.db.prepare('UPDATE mission_tasks SET assigned_agent = ? WHERE id = ?').run(assignedAgent, id);
        return this.getMissionTask(id);
    }

    deleteMissionTask(id) {
        return this.db.prepare('DELETE FROM mission_tasks WHERE id = ?').run(id);
    }

    // =========================================================================
    //  HIVE MIND INTER-AGENT BLACKBOARD
    // =========================================================================

    recordHiveMind(agentId, chatId, action, summary, artifacts = null) {
        const now = Date.now();
        const artStr = artifacts ? (typeof artifacts === 'string' ? artifacts : JSON.stringify(artifacts)) : null;
        const stmt = this.db.prepare(`
            INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(agentId, chatId, action, summary, artStr, now);
    }

    getHiveMindEntries({ agentId, limit = 20 } = {}) {
        let sql = 'SELECT * FROM hive_mind';
        const params = [];
        if (agentId && agentId !== 'all') {
            sql += ' WHERE agent_id = ?';
            params.push(agentId);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        return this.db.prepare(sql).all(...params);
    }

    clearHiveMind() {
        this.db.prepare('DELETE FROM hive_mind').run();
    }

    // =========================================================================
    //  SALIENT MEMORIES & RECENT TURNS
    // =========================================================================

    addMemory(chatId, text, { summary = '', importance = 0.5, salience = 1.0, source = 'conversation' } = {}) {
        const now = Date.now();
        const s = summary || text.slice(0, 120);
        const stmt = this.db.prepare(`
            INSERT INTO memories (chat_id, source, raw_text, summary, importance, salience, created_at, accessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(chatId, source, text, s, importance, salience, now, now);
    }

    getMemories(chatId, { minSalience = 0.1, limit = 20 } = {}) {
        const stmt = this.db.prepare(`
            SELECT * FROM memories
            WHERE (chat_id = ? OR chat_id = 'global' OR ? = '' OR ? IS NULL) AND salience >= ?
            ORDER BY salience DESC, accessed_at DESC
            LIMIT ?
        `);
        return stmt.all(chatId || 'global', chatId || '', chatId || '', minSalience, limit);
    }

    decayMemories(chatId, decayFactor = 0.95) {
        const stmt = this.db.prepare(`
            UPDATE memories
            SET salience = salience * ?
            WHERE chat_id = ?
        `);
        stmt.run(decayFactor, chatId);
    }

    clearMemories(chatId) {
        this.db.prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId);
    }

    // =========================================================================
    //  CHAT PREFERENCES & CLI SESSIONS
    // =========================================================================

    getChatPreferences(chatId) {
        const row = this.db.prepare('SELECT * FROM chat_preferences WHERE chat_id = ?').get(chatId);
        if (!row) return null;
        return {
            activeAgent: row.active_agent,
            activeModel: row.active_model,
            reasoningEffort: row.reasoning_effort,
            voiceMode: Boolean(row.voice_mode),
            cwd: row.cwd,
        };
    }

    setChatPreferences(chatId, prefs) {
        const now = Date.now();
        const existing = this.getChatPreferences(chatId) || {
            activeAgent: 'antigravity',
            activeModel: null,
            reasoningEffort: null,
            voiceMode: false,
            cwd: null,
        };
        const merged = { ...existing, ...prefs };
        const stmt = this.db.prepare(`
            INSERT INTO chat_preferences (chat_id, active_agent, active_model, reasoning_effort, voice_mode, cwd, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                active_agent = excluded.active_agent,
                active_model = excluded.active_model,
                reasoning_effort = excluded.reasoning_effort,
                voice_mode = excluded.voice_mode,
                cwd = excluded.cwd,
                updated_at = excluded.updated_at
        `);
        stmt.run(
            chatId,
            merged.activeAgent,
            merged.activeModel,
            merged.reasoningEffort,
            merged.voiceMode ? 1 : 0,
            merged.cwd,
            now
        );
    }

    getSession(agentKey, chatId) {
        const row = this.db.prepare('SELECT session_id FROM cli_sessions WHERE agent_key = ? AND chat_id = ?').get(agentKey, chatId);
        return row ? row.session_id : null;
    }

    setSession(agentKey, sessionId, chatId, cwd = null, title = null) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO cli_sessions (agent_key, chat_id, session_id, cwd, title, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_key, chat_id) DO UPDATE SET
                session_id = excluded.session_id,
                cwd = COALESCE(excluded.cwd, cli_sessions.cwd),
                title = COALESCE(excluded.title, cli_sessions.title),
                updated_at = excluded.updated_at
        `);
        stmt.run(agentKey, chatId, sessionId, cwd, title, now);
    }

    clearSession(agentKey, chatId) {
        this.db.prepare('DELETE FROM cli_sessions WHERE agent_key = ? AND chat_id = ?').run(agentKey, chatId);
    }

    // =========================================================================
    //  TOKEN USAGE & TELEMETRY
    // =========================================================================

    recordTokenUsage(agentId, inputTokens, outputTokens, totalTokens, chatId = '') {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO token_usage (agent_id, chat_id, input_tokens, output_tokens, total_tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(agentId, chatId, inputTokens, outputTokens, totalTokens, now);
    }

    getUsage(agentId) {
        const stmt = this.db.prepare(`
            SELECT
                COUNT(*) as total_requests,
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(total_tokens), 0) as total_tokens
            FROM token_usage
            WHERE agent_id = ?
        `);
        const row = stmt.get(agentId) || {};
        return {
            totalRequests: Number(row.total_requests || 0),
            totalInputTokens: Number(row.total_input || 0),
            totalOutputTokens: Number(row.total_output || 0),
            totalTokens: Number(row.total_tokens || 0),
        };
    }

    resetUsage(agentId) {
        this.db.prepare('DELETE FROM token_usage WHERE agent_id = ?').run(agentId);
    }

    // =========================================================================
    //  AUDIT LOG
    // =========================================================================

    logAudit(agentId, chatId, action, detail = '', blocked = false) {
        const now = Date.now();
        let detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
        let isBlocked = blocked ? 1 : 0;
        if (typeof blocked === 'object') {
            detailStr += ' ' + JSON.stringify(blocked);
            isBlocked = 1;
        }
        const stmt = this.db.prepare(`
            INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(agentId, chatId, action, detailStr, isBlocked, now);
    }

    getAuditLog(limit = 50) {
        return this.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
    }

    addSuggestion(id, agentId, type, summary, detailsJson = '{}') {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO suggestions (id, agent_id, suggestion_type, summary, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(id, agentId, type, summary, typeof detailsJson === 'string' ? detailsJson : JSON.stringify(detailsJson), now);
    }

    getSuggestions(includeDismissed = false) {
        if (includeDismissed) {
            return this.db.prepare('SELECT * FROM suggestions ORDER BY created_at DESC').all();
        }
        return this.db.prepare('SELECT * FROM suggestions WHERE dismissed_at IS NULL ORDER BY created_at DESC').all();
    }

    // --- War Room Voices (persisted; previously in-memory only) ---
    getAgentVoices() {
        try {
            const rows = this.db.prepare('SELECT agent_id, voice FROM agent_voices').all() || [];
            const out = {};
            for (const row of rows) out[row.agent_id] = row.voice;
            return out;
        } catch (err) {
            console.warn('[Database] getAgentVoices failed:', err.message);
            return {};
        }
    }

    setAgentVoices(voices = {}) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO agent_voices (agent_id, voice, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(agent_id) DO UPDATE SET voice = excluded.voice, updated_at = excluded.updated_at
        `);
        for (const [agentId, voice] of Object.entries(voices)) {
            if (!agentId || !voice) continue;
            try { stmt.run(String(agentId), String(voice), now); } catch (err) {
                console.warn(`[Database] setAgentVoices(${agentId}) failed: ${err.message}`);
            }
        }
        return this.getAgentVoices();
    }

    // --- Live Meeting Sessions (persisted; previously in-memory only) ---
    getMeetingSessions(limit = 50) {
        try {
            const rows = this.db.prepare(
                'SELECT * FROM live_meetings ORDER BY created_at DESC LIMIT ?'
            ).all(limit) || [];
            return rows.map((row) => {
                let extra = {};
                try { extra = row.payload ? JSON.parse(row.payload) : {}; } catch (e) {}
                return {
                    ...extra,
                    id: row.id,
                    agentId: row.agent_id,
                    provider: row.provider,
                    meetUrl: row.meet_url,
                    topic: row.topic,
                    createdAt: row.created_at,
                };
            });
        } catch (err) {
            console.warn('[Database] getMeetingSessions failed:', err.message);
            return [];
        }
    }

    addMeetingSession(session = {}) {
        const id = session.id || `meet_${Date.now()}`;
        const { id: _i, agentId: _a, provider: _p, meetUrl: _m, topic: _t, createdAt: _c, ...extra } = session;
        try {
            this.db.prepare(`
                INSERT INTO live_meetings (id, agent_id, provider, meet_url, topic, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    agent_id = excluded.agent_id, provider = excluded.provider,
                    meet_url = excluded.meet_url, topic = excluded.topic, payload = excluded.payload
            `).run(
                id,
                String(session.agentId || 'system'),
                String(session.provider || ''),
                String(session.meetUrl || ''),
                String(session.topic || ''),
                JSON.stringify(extra),
                Number(session.createdAt) || Date.now()
            );
        } catch (err) {
            console.warn('[Database] addMeetingSession failed:', err.message);
        }
        return { ...session, id };
    }

    removeMeetingSession(id) {
        try {
            const row = this.db.prepare('SELECT * FROM live_meetings WHERE id = ?').get(id);
            if (!row) return null;
            this.db.prepare('DELETE FROM live_meetings WHERE id = ?').run(id);
            return { id: row.id, agentId: row.agent_id, provider: row.provider, meetUrl: row.meet_url, topic: row.topic };
        } catch (err) {
            console.warn('[Database] removeMeetingSession failed:', err.message);
            return null;
        }
    }

    clearMeetingSessions() {
        try { this.db.prepare('DELETE FROM live_meetings').run(); } catch (err) {
            console.warn('[Database] clearMeetingSessions failed:', err.message);
        }
        return true;
    }

    dismissSuggestion(id) {
        const now = Date.now();
        this.db.prepare('UPDATE suggestions SET dismissed_at = ? WHERE id = ?').run(now, id);
    }
}

let instance = null;

function getDatabase(dbDir = path.join(__dirname, '..', 'store')) {
    if (!instance) {
        const dbPath = process.env.DB_PATH
            ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.join(__dirname, '..', process.env.DB_PATH))
            : path.join(dbDir, 'assistant.db');
        instance = new AssistantDatabase(dbPath);
        instance.seedDemoTasks();
    }
    return instance;
}

module.exports = {
    AssistantDatabase,
    getDatabase,
};
