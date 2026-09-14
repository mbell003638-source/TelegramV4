// =============================================================================
//  core/HiveMind.js — ClaudeClaw V3 SQLite State & Delegation Layer
//
//  Native Node.js `node:sqlite` (DatabaseSync, Node 22+) high-performance store.
//  Zero external npm dependencies. WAL mode enabled.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');

class HiveMind {
    constructor(baseDir) {
        this.baseDir = baseDir || process.cwd();
        this.storeDir = path.join(this.baseDir, 'store');
        if (!fs.existsSync(this.storeDir)) {
            fs.mkdirSync(this.storeDir, { recursive: true });
        }

        this.dbPath = path.join(this.storeDir, 'bridge.db');
        this.db = new DatabaseSync(this.dbPath);
        this._initSchema();
    }

    _initSchema() {
        try {
            this.db.exec('PRAGMA journal_mode = WAL;');
            this.db.exec('PRAGMA synchronous = NORMAL;');
        } catch (e) {}

        // 1. Hive Mind activity feed
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS hive_mind (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                action TEXT NOT NULL,
                summary TEXT NOT NULL,
                artifacts TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_hive_created ON hive_mind(created_at DESC);
        `);

        // 2. Mission Control Kanban Tasks
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mission_tasks (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                assigned_agent TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'unassigned',
                priority INTEGER NOT NULL DEFAULT 5,
                result TEXT,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON mission_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_agent ON mission_tasks(assigned_agent);
        `);

        // 3. Three-Layer Memory Store (V3)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                summary TEXT NOT NULL,
                entities TEXT,
                topics TEXT,
                connections TEXT,
                importance REAL NOT NULL DEFAULT 0.7,
                salience REAL NOT NULL DEFAULT 1.0,
                pinned INTEGER NOT NULL DEFAULT 0,
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
        `);

        // Safe column additions for pre-existing tables
        try { this.db.exec('ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.7;'); } catch(e) {}
        try { this.db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'); } catch(e) {}
        try { this.db.exec('ALTER TABLE memories ADD COLUMN connections TEXT;'); } catch(e) {}
        try { this.db.exec('ALTER TABLE mission_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 5;'); } catch(e) {}

        try {
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC);
                CREATE INDEX IF NOT EXISTS idx_mem_salience ON memories(salience);
                CREATE INDEX IF NOT EXISTS idx_mem_pinned ON memories(pinned);
            `);
        } catch (e) {}

        // 4. Multi-Agent War Room Transcript (V3 Pack 01)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS warroom_transcript (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id TEXT NOT NULL,
                turn_id INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                message_text TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'assistant',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_warroom_meeting ON warroom_transcript(meeting_id, turn_id);
        `);

        // 5. Append-Only Audit Log (V3 Pack 03)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                actor_type TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT,
                payload_json TEXT,
                pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
        `);

        // 6. Scheduled Tasks (V3 Cron)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cron_expression TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                next_run_at INTEGER,
                last_run_at INTEGER,
                created_at INTEGER NOT NULL
            );
        `);

        // 7. Suggestions (V3 Pack 04)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                suggestion_type TEXT NOT NULL,
                summary TEXT NOT NULL,
                details_json TEXT,
                dismissed_at INTEGER
            );
        `);

        // 8. Live Meetings & War Room Voices (V3 Meeting Bot & Gemini Live)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS live_meetings (
                id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                url TEXT,
                room_type TEXT DEFAULT 'direct',
                auto_brief INTEGER DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL,
                ended_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_voices (
                agent_id TEXT PRIMARY KEY,
                voice_key TEXT NOT NULL,
                voice_name TEXT NOT NULL,
                voice_desc TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    }

    getAgentVoices() {
        return this.db.prepare('SELECT agent_id, voice_key, voice_name, voice_desc FROM agent_voices').all();
    }

    setAgentVoice(agentId, voiceKey, voiceName, voiceDesc) {
        const stmt = this.db.prepare(`
            INSERT INTO agent_voices (agent_id, voice_key, voice_name, voice_desc, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(agent_id) DO UPDATE SET
                voice_key = excluded.voice_key,
                voice_name = excluded.voice_name,
                voice_desc = excluded.voice_desc,
                updated_at = excluded.updated_at
        `);
        stmt.run(agentId.toLowerCase(), voiceKey, voiceName, voiceDesc, Math.floor(Date.now() / 1000));
    }

    createLiveMeeting(id, mode, agentId, url, roomType = 'direct', autoBrief = true) {
        const stmt = this.db.prepare(`
            INSERT INTO live_meetings (id, mode, agent_id, url, room_type, auto_brief, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        `);
        const now = Math.floor(Date.now() / 1000);
        stmt.run(id, mode, agentId, url, roomType, autoBrief ? 1 : 0, now);
        return { id, mode, agentId, url, roomType, autoBrief, status: 'active', created_at: now };
    }

    getActiveMeetings() {
        return this.db.prepare(`
            SELECT id, mode, agent_id, url, room_type, auto_brief, status, created_at
            FROM live_meetings
            WHERE status = 'active'
            ORDER BY created_at DESC
        `).all();
    }

    terminateMeeting(id) {
        const now = Math.floor(Date.now() / 1000);
        this.db.prepare(`
            UPDATE live_meetings
            SET status = 'ended', ended_at = ?
            WHERE id = ?
        `).run(now, id);
    }

    // ── Hive Mind Feed ─────────────────────────────────────────────────────────

    logAction(agentId, chatId, action, summary, artifacts = null) {
        const stmt = this.db.prepare(`
            INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const now = Math.floor(Date.now() / 1000);
        stmt.run(
            String(agentId || 'system'),
            String(chatId || 'system'),
            String(action || 'action'),
            String(summary || ''),
            artifacts ? JSON.stringify(artifacts) : null,
            now
        );
        return { success: true, timestamp: now };
    }

    getRecentActions(limit = 25, agentId = null) {
        let query = `
            SELECT id, agent_id, chat_id, action, summary, artifacts, created_at
            FROM hive_mind
        `;
        const params = [];
        if (agentId) {
            query += ` WHERE agent_id = ?`;
            params.push(agentId);
        }
        query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
        params.push(limit);

        const stmt = this.db.prepare(query);
        return stmt.all(...params).map(row => ({
            ...row,
            artifacts: row.artifacts ? JSON.parse(row.artifacts) : null
        }));
    }

    // ── Mission Control Tasks ──────────────────────────────────────────────────

    createTask(title, prompt, assignedAgent = 'unassigned', chatId = 'main', priority = 5) {
        const id = 'task_' + crypto.randomBytes(6).toString('hex');
        const now = Math.floor(Date.now() / 1000);
        const status = assignedAgent && assignedAgent !== 'unassigned' ? 'assigned' : 'unassigned';

        const stmt = this.db.prepare(`
            INSERT INTO mission_tasks (id, chat_id, title, prompt, assigned_agent, status, priority, result, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `);
        stmt.run(id, String(chatId), String(title), String(prompt), String(assignedAgent), status, priority, now);

        this.logAction('mission_control', chatId, 'created_task', `Task created: "${title}" assigned to [${assignedAgent}]`);
        this.logAudit('user', 'dashboard', 'create_task', id, { title, assignedAgent, priority });

        return { id, title, prompt, assigned_agent: assignedAgent, status, priority, created_at: now };
    }

    getAllTasks(agentId = null, status = null) {
        let query = `
            SELECT id, chat_id, title, prompt, assigned_agent, status, priority, result, created_at, started_at, completed_at
            FROM mission_tasks
            WHERE 1=1
        `;
        const params = [];
        if (agentId) {
            query += ` AND assigned_agent = ?`;
            params.push(agentId);
        }
        if (status) {
            query += ` AND status = ?`;
            params.push(status);
        }
        query += ` ORDER BY priority DESC, created_at DESC`;

        const stmt = this.db.prepare(query);
        return stmt.all(...params);
    }

    getTask(id) {
        const stmt = this.db.prepare(`
            SELECT id, chat_id, title, prompt, assigned_agent, status, priority, result, created_at, started_at, completed_at
            FROM mission_tasks
            WHERE id = ?
        `);
        return stmt.get(id) || null;
    }

    updateTaskStatus(id, status, result = null) {
        const now = Math.floor(Date.now() / 1000);
        let query = 'UPDATE mission_tasks SET status = ?';
        const params = [status];

        if (status === 'running') {
            query += ', started_at = ?';
            params.push(now);
        } else if (status === 'completed' || status === 'cancelled') {
            query += ', completed_at = ?, result = ?';
            params.push(now, result ? String(result) : null);
        }

        query += ' WHERE id = ?';
        params.push(id);

        const stmt = this.db.prepare(query);
        stmt.run(...params);

        const task = this.getTask(id);
        if (task && status === 'completed') {
            const preview = result ? (result.length > 100 ? result.slice(0, 100) + '...' : result) : 'Completed';
            this.logAction(task.assigned_agent, task.chat_id, 'completed_task', `Finished task "${task.title}": ${preview}`);
            this.logAudit('agent', task.assigned_agent, 'task_completed', id, { preview });
        }

        return task;
    }

    reassignTask(id, newAgent) {
        const status = newAgent && newAgent !== 'unassigned' ? 'assigned' : 'unassigned';
        const stmt = this.db.prepare(`
            UPDATE mission_tasks
            SET assigned_agent = ?, status = ?
            WHERE id = ?
        `);
        stmt.run(String(newAgent), status, id);
        this.logAudit('user', 'dashboard', 'reassign_task', id, { newAgent });
        return this.getTask(id);
    }

    deleteTask(id) {
        const stmt = this.db.prepare('DELETE FROM mission_tasks WHERE id = ?');
        stmt.run(id);
        this.logAudit('user', 'dashboard', 'delete_task', id, {});
        return { success: true, id };
    }

    getMissionTaskHistory(limit = 30, offset = 0) {
        const stmt = this.db.prepare(`
            SELECT id, chat_id, title, prompt, assigned_agent, status, priority, result, created_at, completed_at
            FROM mission_tasks
            WHERE status IN ('completed', 'cancelled')
            ORDER BY completed_at DESC, created_at DESC
            LIMIT ? OFFSET ?
        `);
        const countStmt = this.db.prepare(`
            SELECT COUNT(*) as count FROM mission_tasks WHERE status IN ('completed', 'cancelled')
        `);
        return {
            tasks: stmt.all(limit, offset),
            total: countStmt.get().count
        };
    }

    // ── Audit Log (V3 Pack 03) ─────────────────────────────────────────────────

    logAudit(actorType, actorId, action, target = null, payload = null) {
        const stmt = this.db.prepare(`
            INSERT INTO audit_log (ts, actor_type, actor_id, action, target, payload_json, pinned)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        const now = Math.floor(Date.now() / 1000);
        stmt.run(
            now,
            String(actorType || 'system'),
            String(actorId || 'system'),
            String(action || 'event'),
            target ? String(target) : null,
            payload ? JSON.stringify(payload) : null
        );
        return { success: true, ts: now };
    }

    getAuditLog(limit = 50, offset = 0, actorId = null) {
        let query = `
            SELECT id, ts, actor_type, actor_id, action, target, payload_json, pinned
            FROM audit_log
        `;
        const params = [];
        if (actorId) {
            query += ` WHERE actor_id = ?`;
            params.push(actorId);
        }
        query += ` ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const stmt = this.db.prepare(query);
        return stmt.all(...params).map(row => ({
            ...row,
            payload: row.payload_json ? JSON.parse(row.payload_json) : null
        }));
    }

    getAuditLogCount(actorId = null) {
        let query = `SELECT COUNT(*) as count FROM audit_log`;
        const params = [];
        if (actorId) {
            query += ` WHERE actor_id = ?`;
            params.push(actorId);
        }
        return this.db.prepare(query).get(...params).count;
    }

    getRecentBlockedActions(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT id, ts, actor_type, actor_id, action, target, payload_json
            FROM audit_log
            WHERE action LIKE '%blocked%'
            ORDER BY ts DESC
            LIMIT ?
        `);
        return stmt.all(limit).map(r => ({
            ...r,
            payload: r.payload_json ? JSON.parse(r.payload_json) : null
        }));
    }

    // ── Multi-Agent War Room (V3 Pack 01) ──────────────────────────────────────

    recordWarRoomTurn(meetingId, turnId, agentId, messageText, role = 'assistant') {
        const stmt = this.db.prepare(`
            INSERT INTO warroom_transcript (meeting_id, turn_id, agent_id, message_text, role, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const now = Math.floor(Date.now() / 1000);
        stmt.run(String(meetingId), turnId, String(agentId), String(messageText), role, now);
        return { success: true, meetingId, turnId };
    }

    getWarRoomTranscript(meetingId) {
        const stmt = this.db.prepare(`
            SELECT id, meeting_id, turn_id, agent_id, message_text, role, created_at
            FROM warroom_transcript
            WHERE meeting_id = ?
            ORDER BY turn_id ASC, id ASC
        `);
        return stmt.all(meetingId);
    }

    // ── Three-Layer Memory Landscape (V3) ──────────────────────────────────────

    saveMemory(chatId, summary, rawText = '', importance = 0.7, salience = 1.0, pinned = 0, topics = [], entities = [], connections = []) {
        const stmt = this.db.prepare(`
            INSERT INTO memories (chat_id, raw_text, summary, entities, topics, connections, importance, salience, pinned, access_count, last_accessed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `);
        const now = Math.floor(Date.now() / 1000);
        stmt.run(
            String(chatId),
            String(rawText || summary),
            String(summary),
            JSON.stringify(entities || []),
            JSON.stringify(topics || []),
            JSON.stringify(connections || []),
            importance,
            salience,
            pinned ? 1 : 0,
            now,
            now
        );
        return { success: true, timestamp: now };
    }

    getDashboardMemoryStats(chatId = null) {
        const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');
        const pinnedStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE pinned = 1');
        const avgSalienceStmt = this.db.prepare('SELECT AVG(salience) as avg_sal FROM memories');

        return {
            total: totalStmt.get().count,
            pinned: pinnedStmt.get().count,
            consolidations: 0,
            avgSalience: avgSalienceStmt.get().avg_sal || 1.0
        };
    }

    getDashboardLowSalienceMemories(chatId = null, limit = 10) {
        const stmt = this.db.prepare(`
            SELECT id, chat_id, summary, importance, salience, created_at
            FROM memories
            WHERE salience < 0.5 AND pinned = 0
            ORDER BY salience ASC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    getDashboardTopAccessedMemories(chatId = null, limit = 5) {
        const stmt = this.db.prepare(`
            SELECT id, chat_id, summary, importance, salience, access_count, last_accessed_at
            FROM memories
            ORDER BY access_count DESC, importance DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    getDashboardPinnedMemories(chatId = null) {
        const stmt = this.db.prepare(`
            SELECT id, chat_id, summary, raw_text, entities, topics, connections, importance, salience, pinned, created_at
            FROM memories
            WHERE pinned = 1
            ORDER BY importance DESC, created_at DESC
        `);
        return stmt.all();
    }

    getDashboardMemoriesList(chatId = null, limit = 50, offset = 0, sortBy = 'importance') {
        let orderCol = 'importance DESC';
        if (sortBy === 'salience') orderCol = 'salience DESC';
        if (sortBy === 'recent') orderCol = 'created_at DESC';

        const stmt = this.db.prepare(`
            SELECT id, chat_id, summary, raw_text, entities, topics, connections, importance, salience, pinned, created_at
            FROM memories
            ORDER BY ${orderCol}
            LIMIT ? OFFSET ?
        `);
        const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');

        return {
            memories: stmt.all(limit, offset),
            total: countStmt.get().count
        };
    }

    getDashboardMemoryTimeline(chatId = null, days = 30) {
        const stmt = this.db.prepare(`
            SELECT strftime('%Y-%m-%d', datetime(created_at, 'unixepoch')) as date, COUNT(*) as count
            FROM memories
            GROUP BY date
            ORDER BY date DESC
            LIMIT ?
        `);
        return stmt.all(days);
    }

    getDashboardConsolidations(chatId = null, limit = 5) {
        return [];
    }

    // ── Scheduled Tasks (V3 Cron) ──────────────────────────────────────────────

    getAllScheduledTasks(agentId = null) {
        let query = 'SELECT id, chat_id, agent_id, prompt, cron_expression, status, next_run_at, last_run_at, created_at FROM scheduled_tasks';
        const params = [];
        if (agentId) {
            query += ' WHERE agent_id = ?';
            params.push(agentId);
        }
        return this.db.prepare(query).all(...params);
    }

    deleteScheduledTask(id) {
        this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
        return { ok: true };
    }

    pauseScheduledTask(id) {
        this.db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id);
        return { ok: true };
    }

    resumeScheduledTask(id) {
        this.db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id);
        return { ok: true };
    }

    // ── Global Stats ───────────────────────────────────────────────────────────

    getStats() {
        const totalTasksStmt = this.db.prepare('SELECT COUNT(*) as count FROM mission_tasks');
        const completedTasksStmt = this.db.prepare("SELECT COUNT(*) as count FROM mission_tasks WHERE status = 'completed'");
        const runningTasksStmt = this.db.prepare("SELECT COUNT(*) as count FROM mission_tasks WHERE status = 'running'");
        const hiveEntriesStmt = this.db.prepare('SELECT COUNT(*) as count FROM hive_mind');
        const memCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');

        return {
            total_tasks: totalTasksStmt.get().count,
            completed_tasks: completedTasksStmt.get().count,
            running_tasks: runningTasksStmt.get().count,
            hive_mind_entries: hiveEntriesStmt.get().count,
            total_memories: memCountStmt.get().count
        };
    }

    close() {
        if (this.db) {
            try {
                this.db.close();
            } catch (e) {}
        }
    }
}

module.exports = HiveMind;
