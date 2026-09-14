// =============================================================================
//  core/MemorySearch.js — Cross-Session Memory Recall (FTS5 + LIKE fallback)
//
//  Ported from Hermes Agent's session search stack (hermes_state_fts.py /
//  hermes_state_search.py): an FTS5 index over the shared permanent memory so
//  ANY agent can recall what ANY other agent learned, in ANY past session.
//
//  Design notes (mirrors Hermes):
//    * The index is EXTERNAL-CONTENT FTS5 over a plain `memory_index` table.
//      `memory_index` is the canonical index store and exists in BOTH modes, so
//      the row shape, filters, pruning and stats are identical either way.
//    * FTS5 is NOT guaranteed to be compiled into whatever SQLite the running
//      Node was linked against. We probe it at construction and transparently
//      degrade to a deterministic LIKE ranker when it is missing.
//    * Raw user input never reaches MATCH unquoted. Every non-operator token is
//      emitted as a double-quoted FTS5 string, which neutralises the whole
//      special-character grammar (" * - ( ) : ^ @ / NEAR ...).
//    * Strict (implicit AND) MATCH first, then an OR retry, then LIKE — a hit
//      keeps its ranking, a miss still degrades into something useful.
//
//  Owns its own schema entirely; it never edits core/Database.js. It only
//  borrows the raw DatabaseSync handle exposed as `database.db`.
// =============================================================================

const INDEX_TABLE = 'memory_index';
const FTS_TABLE = 'memory_fts';

// Columns projected into the FTS5 index. Order is load-bearing: the bm25()
// weight vector below is positional.
const FTS_COLUMNS = ['text', 'summary', 'agent_id', 'source'];

// text, summary, agent_id, source — the summary is the agent-curated gist, so
// it outweighs the raw body; the identity columns only nudge.
const BM25_WEIGHTS = [1.0, 1.4, 0.3, 0.3];

const FTS_TRIGGERS = ['memory_fts_ai', 'memory_fts_ad', 'memory_fts_au'];
const SOURCE_TRIGGERS = [
    'memory_index_mem_ai',
    'memory_index_mem_au',
    'memory_index_mem_ad',
    'memory_index_hive_ai',
    'memory_index_hive_ad',
];

const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT']);

const DEFAULT_LIMIT = 20;
// Over-fetch factor for the LIKE route so the JS ranker has candidates to sort.
const LIKE_CANDIDATE_FACTOR = 8;
const LIKE_CANDIDATE_CAP = 500;
const SNIPPET_WINDOW = 160;

class MemorySearch {
    /**
     * @param {object}  opts
     * @param {object}  opts.database   AssistantDatabase instance (uses `.db`).
     * @param {boolean} [opts.autoIndex=true]     Install sync triggers and backfill on open.
     * @param {boolean} [opts.forceFallback=false] Ignore FTS5 even when present (ops / tests).
     */
    constructor({ database, autoIndex = true, forceFallback = false } = {}) {
        if (!database || !database.db) {
            throw new Error('[MemorySearch] requires an AssistantDatabase instance with a .db handle');
        }
        this.database = database;
        this.db = database.db;
        this.autoIndex = autoIndex !== false;
        this.forceFallback = forceFallback === true;

        this.ftsAvailable = false;
        this.ftsError = null;
        this.lastIndexedAt = 0;

        this._initSchema();
    }

    /** 'fts5' when the bundled SQLite has FTS5, otherwise 'fallback'. */
    get mode() {
        return this.ftsAvailable ? 'fts5' : 'fallback';
    }

    // =========================================================================
    //  SCHEMA
    // =========================================================================

    _initSchema() {
        // 1. Canonical index store — plain SQL, always available.
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS ${INDEX_TABLE} (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    ref_type    TEXT NOT NULL DEFAULT 'custom',  -- memory | hive | custom
                    ref_id      INTEGER,                          -- source row id (NULL for custom)
                    chat_id     TEXT NOT NULL DEFAULT 'global',
                    agent_id    TEXT NOT NULL DEFAULT '',
                    source      TEXT NOT NULL DEFAULT 'conversation',
                    text        TEXT NOT NULL DEFAULT '',
                    summary     TEXT NOT NULL DEFAULT '',
                    importance  REAL NOT NULL DEFAULT 0.5,
                    salience    REAL NOT NULL DEFAULT 1.0,
                    created_at  INTEGER NOT NULL DEFAULT 0,
                    indexed_at  INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_index_ref
                    ON ${INDEX_TABLE}(ref_type, ref_id);
                CREATE INDEX IF NOT EXISTS idx_memory_index_chat
                    ON ${INDEX_TABLE}(chat_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_memory_index_agent
                    ON ${INDEX_TABLE}(agent_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_memory_index_salience
                    ON ${INDEX_TABLE}(salience, created_at DESC);
            `);
        } catch (err) {
            console.warn(`[MemorySearch] index table create failed: ${err.message}`);
            throw err;
        }

        // 2. Probe FTS5. The bundled SQLite may not have the extension compiled
        //    in; that is a capability error, not a bug, so we degrade quietly.
        this._probeFts5();

        // 3. Keep the index in sync with the shared memory tables.
        if (this.autoIndex) {
            this._installSourceTriggers();
        }

        // 4. Backfill history already on disk, and self-heal a stale FTS index
        //    (e.g. rows written while a previous process ran in fallback mode).
        try {
            const indexed = this._count(INDEX_TABLE);
            if (this.autoIndex && indexed === 0 && this._sourceRowCount() > 0) {
                this.reindexAll();
            } else if (this.ftsAvailable && indexed !== this._ftsRowCount()) {
                this._rebuildFtsIndex();
            }
            const row = this._get(`SELECT MAX(indexed_at) AS t FROM ${INDEX_TABLE}`);
            this.lastIndexedAt = (row && row.t) || 0;
        } catch (err) {
            console.warn(`[MemorySearch] initial index sync failed: ${err.message}`);
        }
    }

    _probeFts5() {
        if (this.forceFallback) {
            this.ftsAvailable = false;
            this.ftsError = 'forced fallback';
            this._dropTriggers(FTS_TRIGGERS);
            return;
        }
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
                    ${FTS_COLUMNS.join(',\n                    ')},
                    content='${INDEX_TABLE}',
                    content_rowid='id',
                    tokenize='unicode61'
                );
            `);
            // Probe the vtable too: a table row can survive without a working
            // module (recovered DB, missing tokenizer).
            this.db.prepare(`SELECT 1 FROM ${FTS_TABLE} LIMIT 0`).all();
            this._installFtsTriggers();
            this.ftsAvailable = true;
            this.ftsError = null;
        } catch (err) {
            this.ftsAvailable = false;
            this.ftsError = err.message;
            console.warn(
                `[MemorySearch] FTS5 unavailable (${err.message}); ` +
                'cross-session recall falls back to LIKE ranking.'
            );
            // An index without a live vtable must not keep triggers that write
            // to it — every write would fail at trigger time.
            this._dropTriggers(FTS_TRIGGERS);
        }
    }

    _installFtsTriggers() {
        const cols = FTS_COLUMNS.join(', ');
        const newVals = FTS_COLUMNS.map((c) => `new.${c}`).join(', ');
        const oldVals = FTS_COLUMNS.map((c) => `old.${c}`).join(', ');
        this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON ${INDEX_TABLE} BEGIN
                INSERT INTO ${FTS_TABLE}(rowid, ${cols}) VALUES (new.id, ${newVals});
            END;
            CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON ${INDEX_TABLE} BEGIN
                INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, ${cols})
                VALUES ('delete', old.id, ${oldVals});
            END;
            CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON ${INDEX_TABLE} BEGIN
                INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, ${cols})
                VALUES ('delete', old.id, ${oldVals});
                INSERT INTO ${FTS_TABLE}(rowid, ${cols}) VALUES (new.id, ${newVals});
            END;
        `);
    }

    /**
     * Triggers that mirror `memories` and `hive_mind` into the index. They are
     * plain SQL (no FTS5 reference), so they are safe in both modes — the
     * memory_index -> memory_fts triggers above are the FTS-only layer.
     */
    _installSourceTriggers() {
        const now = "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
        try {
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS memory_index_mem_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO ${INDEX_TABLE}
                        (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                         importance, salience, created_at, indexed_at)
                    VALUES
                        ('memory', new.id, new.chat_id, COALESCE(new.source, ''),
                         COALESCE(new.source, 'conversation'), new.raw_text,
                         COALESCE(new.summary, ''), new.importance, new.salience,
                         new.created_at, ${now})
                    ON CONFLICT(ref_type, ref_id) DO UPDATE SET
                        chat_id    = excluded.chat_id,
                        agent_id   = excluded.agent_id,
                        source     = excluded.source,
                        text       = excluded.text,
                        summary    = excluded.summary,
                        importance = excluded.importance,
                        salience   = excluded.salience,
                        created_at = excluded.created_at,
                        indexed_at = excluded.indexed_at;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_index_mem_au AFTER UPDATE ON memories BEGIN
                    UPDATE ${INDEX_TABLE} SET
                        chat_id    = new.chat_id,
                        agent_id   = COALESCE(new.source, ''),
                        source     = COALESCE(new.source, 'conversation'),
                        text       = new.raw_text,
                        summary    = COALESCE(new.summary, ''),
                        importance = new.importance,
                        salience   = new.salience,
                        indexed_at = ${now}
                    WHERE ref_type = 'memory' AND ref_id = old.id;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_index_mem_ad AFTER DELETE ON memories BEGIN
                    DELETE FROM ${INDEX_TABLE} WHERE ref_type = 'memory' AND ref_id = old.id;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_index_hive_ai AFTER INSERT ON hive_mind BEGIN
                    INSERT INTO ${INDEX_TABLE}
                        (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                         importance, salience, created_at, indexed_at)
                    VALUES
                        ('hive', new.id, new.chat_id, new.agent_id, 'hive_mind',
                         new.summary, new.action, 0.5, 0.8, new.created_at, ${now})
                    ON CONFLICT(ref_type, ref_id) DO UPDATE SET
                        chat_id    = excluded.chat_id,
                        agent_id   = excluded.agent_id,
                        text       = excluded.text,
                        summary    = excluded.summary,
                        created_at = excluded.created_at,
                        indexed_at = excluded.indexed_at;
                END;

                CREATE TRIGGER IF NOT EXISTS memory_index_hive_ad AFTER DELETE ON hive_mind BEGIN
                    DELETE FROM ${INDEX_TABLE} WHERE ref_type = 'hive' AND ref_id = old.id;
                END;
            `);
        } catch (err) {
            console.warn(`[MemorySearch] source trigger install failed: ${err.message}`);
        }
    }

    _dropTriggers(names) {
        for (const name of names) {
            try {
                this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
            } catch (err) {
                console.warn(`[MemorySearch] could not drop trigger ${name}: ${err.message}`);
            }
        }
    }

    // =========================================================================
    //  INDEXING
    // =========================================================================

    /**
     * Index (or re-index) a single entry.
     * @returns {number|null} the memory_index rowid, or null on failure.
     */
    index(entry = {}) {
        const now = Date.now();
        const text = this._str(entry.text || entry.raw_text || entry.summary);
        if (!text.trim()) return null;

        const refType = this._str(entry.refType || entry.ref_type || 'custom') || 'custom';
        const rawRef = entry.refId !== undefined ? entry.refId : entry.ref_id;
        const refId = rawRef === undefined || rawRef === null || rawRef === '' ? null : Number(rawRef);
        const source = this._str(entry.source || 'conversation') || 'conversation';
        const row = {
            refType,
            refId: Number.isFinite(refId) ? refId : null,
            chatId: this._str(entry.chatId || entry.chat_id || 'global') || 'global',
            agentId: this._str(entry.agentId || entry.agent_id || ''),
            source,
            text,
            summary: this._str(entry.summary) || text.slice(0, 120),
            importance: this._num(entry.importance, 0.5),
            salience: this._num(entry.salience, 1.0),
            createdAt: this._num(entry.createdAt || entry.created_at, now),
            indexedAt: now,
        };

        try {
            if (row.refId === null) {
                // No source row to collide with — a plain insert (SQLite treats
                // NULLs in a UNIQUE index as distinct).
                const stmt = this.db.prepare(`
                    INSERT INTO ${INDEX_TABLE}
                        (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                         importance, salience, created_at, indexed_at)
                    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const info = stmt.run(
                    row.refType, row.chatId, row.agentId, row.source, row.text,
                    row.summary, row.importance, row.salience, row.createdAt, row.indexedAt
                );
                this.lastIndexedAt = now;
                return Number(info.lastInsertRowid);
            }
            const stmt = this.db.prepare(`
                INSERT INTO ${INDEX_TABLE}
                    (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                     importance, salience, created_at, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ref_type, ref_id) DO UPDATE SET
                    chat_id = excluded.chat_id, agent_id = excluded.agent_id,
                    source = excluded.source, text = excluded.text,
                    summary = excluded.summary, importance = excluded.importance,
                    salience = excluded.salience, created_at = excluded.created_at,
                    indexed_at = excluded.indexed_at
            `);
            stmt.run(
                row.refType, row.refId, row.chatId, row.agentId, row.source, row.text,
                row.summary, row.importance, row.salience, row.createdAt, row.indexedAt
            );
            this.lastIndexedAt = now;
            const found = this._get(
                `SELECT id FROM ${INDEX_TABLE} WHERE ref_type = ? AND ref_id = ?`,
                [row.refType, row.refId]
            );
            return found ? Number(found.id) : null;
        } catch (err) {
            console.warn(`[MemorySearch] index() failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Rebuild the index from the shared memory tables so history already on
     * disk becomes searchable. Manually-indexed ('custom') rows are preserved.
     * @returns {{memories:number, hive:number, total:number, mode:string}}
     */
    reindexAll() {
        const now = Date.now();
        const result = { memories: 0, hive: 0, total: 0, mode: this.mode };
        let inTx = false;
        try {
            this.db.exec('BEGIN');
            inTx = true;
            this.db.exec(`DELETE FROM ${INDEX_TABLE} WHERE ref_type IN ('memory', 'hive')`);

            result.memories = this._copyRows(`
                INSERT INTO ${INDEX_TABLE}
                    (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                     importance, salience, created_at, indexed_at)
                SELECT 'memory', id, chat_id, COALESCE(source, ''),
                       COALESCE(source, 'conversation'), raw_text, COALESCE(summary, ''),
                       importance, salience, created_at, ?
                FROM memories
            `, [now]);

            result.hive = this._copyRows(`
                INSERT INTO ${INDEX_TABLE}
                    (ref_type, ref_id, chat_id, agent_id, source, text, summary,
                     importance, salience, created_at, indexed_at)
                SELECT 'hive', id, chat_id, agent_id, 'hive_mind',
                       summary, action, 0.5, 0.8, created_at, ?
                FROM hive_mind
            `, [now]);

            this.db.exec('COMMIT');
            inTx = false;
        } catch (err) {
            console.warn(`[MemorySearch] reindexAll failed: ${err.message}`);
            if (inTx) {
                try { this.db.exec('ROLLBACK'); } catch (_) {}
            }
            return result;
        }

        // The insert triggers already fed the FTS index, but a full rebuild is
        // the only way to guarantee no drift after a fallback-mode stretch.
        if (this.ftsAvailable) this._rebuildFtsIndex();

        this.lastIndexedAt = now;
        result.total = this._count(INDEX_TABLE);
        return result;
    }

    _copyRows(sql, params) {
        try {
            const info = this.db.prepare(sql).run(...params);
            return Number(info.changes || 0);
        } catch (err) {
            // A source table may not exist in a stripped-down DB.
            console.warn(`[MemorySearch] reindex step skipped: ${err.message}`);
            return 0;
        }
    }

    _rebuildFtsIndex() {
        try {
            this.db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('rebuild')`);
        } catch (err) {
            console.warn(`[MemorySearch] FTS rebuild failed: ${err.message}`);
        }
    }

    // =========================================================================
    //  QUERY SANITIZATION (Hermes _sanitize_fts5_query, simplified)
    // =========================================================================

    /**
     * Turn arbitrary user input into a query FTS5 will accept.
     * Every non-operator token is emitted double-quoted, which neutralises the
     * whole special-character grammar. Balanced "phrases" survive as phrases.
     * @returns {{match:string, orMatch:string, terms:string[]}}
     */
    _sanitizeQuery(raw) {
        const empty = { match: '', orMatch: '', terms: [] };
        const input = raw === null || raw === undefined ? '' : String(raw);
        if (!input.trim()) return empty;

        // 1. Protect balanced quoted phrases behind NUL placeholders.
        const phrases = [];
        let work = input.replace(/"([^"]*)"/g, (_m, inner) => {
            const cleaned = inner.replace(/\s+/g, ' ').trim();
            if (!cleaned) return ' ';
            phrases.push(cleaned);
            return `  P${phrases.length - 1}  `;
        });
        // 2. A leftover unmatched quote is noise, not an operator.
        work = work.replace(/"/g, ' ');

        const pieces = [];
        const terms = [];
        for (const token of work.split(/\s+/)) {
            if (!token) continue;

            const held = token.match(/^ P(\d+) $/);
            if (held) {
                const phrase = phrases[Number(held[1])];
                if (!this._hasWordChar(phrase)) continue;
                pieces.push({ op: false, sql: `"${phrase.replace(/"/g, '""')}"` });
                terms.push(phrase);
                continue;
            }

            const upper = token.toUpperCase();
            if (FTS_OPERATORS.has(upper)) {
                pieces.push({ op: true, sql: upper });
                continue;
            }

            // A trailing '*' is the one operator worth keeping: prefix search.
            const prefix = /\*+$/.test(token);
            const bare = token.replace(/\*+$/, '');
            if (!this._hasWordChar(bare)) continue;
            const quoted = `"${bare.replace(/"/g, '""')}"`;
            pieces.push({ op: false, sql: prefix ? `${quoted}*` : quoted });
            terms.push(bare);
        }

        if (!terms.length) return empty;

        // 3. Drop leading/trailing operators and collapse runs of them; FTS5
        //    rejects a query that starts or ends on AND/OR/NOT.
        const cleaned = [];
        for (const piece of pieces) {
            if (piece.op) {
                if (!cleaned.length) continue;
                if (cleaned[cleaned.length - 1].op) continue;
            }
            cleaned.push(piece);
        }
        while (cleaned.length && cleaned[cleaned.length - 1].op) cleaned.pop();
        if (!cleaned.length) return empty;

        const match = cleaned.map((p) => p.sql).join(' ');
        // OR retry: the same terms, any-of instead of all-of.
        const orMatch = cleaned.filter((p) => !p.op).map((p) => p.sql).join(' OR ');
        return { match, orMatch, terms };
    }

    _hasWordChar(value) {
        return /[\p{L}\p{N}]/u.test(String(value || ''));
    }

    // =========================================================================
    //  SEARCH
    // =========================================================================

    /**
     * Ranked cross-session recall over the shared memory.
     * @param {string} query
     * @param {object} [opts]
     * @param {string} [opts.chatId]        restrict to one chat
     * @param {boolean}[opts.includeGlobal=true] also match chat_id='global'
     * @param {string} [opts.agentId]       restrict to one agent
     * @param {number} [opts.limit=20]
     * @param {number|Date} [opts.since]    only memories created at/after this
     * @param {number} [opts.minSalience]
     * @returns {Array<object>} ranked results (higher `score` = better match)
     */
    search(query, { chatId, includeGlobal = true, agentId, limit = DEFAULT_LIMIT, since, minSalience } = {}) {
        const cap = this._limit(limit);
        if (cap <= 0) return [];

        const { match, orMatch, terms } = this._sanitizeQuery(query);
        // An empty / whitespace / punctuation-only query is not a full-table
        // dump — it is simply no query at all.
        if (!terms.length) return [];

        const filters = this._filters({ chatId, includeGlobal, agentId, since, minSalience });

        if (this.ftsAvailable) {
            let rows = this._ftsSearch(match, filters, cap, 'fts5');
            if (!rows.length && orMatch && orMatch !== match) {
                rows = this._ftsSearch(orMatch, filters, cap, 'fts5-or');
            }
            if (rows.length) return rows.map((r) => this._shape(r, terms, r.route, r.score));
        }
        return this._likeSearch(terms, filters, cap);
    }

    _ftsSearch(matchExpr, filters, cap, route) {
        if (!matchExpr) return [];
        const weights = BM25_WEIGHTS.join(', ');
        const sql = `
            SELECT mi.*, bm25(${FTS_TABLE}, ${weights}) AS rank
            FROM ${FTS_TABLE}
            JOIN ${INDEX_TABLE} mi ON mi.id = ${FTS_TABLE}.rowid
            WHERE ${FTS_TABLE} MATCH ?${filters.sql}
            ORDER BY rank ASC, mi.created_at DESC, mi.id DESC
            LIMIT ?
        `;
        try {
            const rows = this.db.prepare(sql).all(matchExpr, ...filters.params, cap);
            // bm25() is negative and ascending-best; expose it as higher-is-better.
            return rows.map((row) => Object.assign(row, {
                route,
                score: this._round(-Number(row.rank || 0)),
            }));
        } catch (err) {
            console.warn(`[MemorySearch] FTS query failed (${err.message}); using LIKE route.`);
            return [];
        }
    }

    _likeSearch(terms, filters, cap) {
        const candidates = Math.min(cap * LIKE_CANDIDATE_FACTOR, LIKE_CANDIDATE_CAP);
        const clauses = [];
        const params = [];
        for (const term of terms) {
            clauses.push("(mi.text LIKE ? ESCAPE '\\' OR mi.summary LIKE ? ESCAPE '\\')");
            const like = `%${this._escapeLike(term)}%`;
            params.push(like, like);
        }
        const sql = `
            SELECT mi.* FROM ${INDEX_TABLE} mi
            WHERE (${clauses.join(' OR ')})${filters.sql}
            ORDER BY mi.created_at DESC, mi.id DESC
            LIMIT ?
        `;
        let rows;
        try {
            rows = this.db.prepare(sql).all(...params, ...filters.params, candidates);
        } catch (err) {
            console.warn(`[MemorySearch] LIKE query failed: ${err.message}`);
            return [];
        }
        const scored = [];
        for (const row of rows) {
            const score = this._relevance(row, terms);
            if (score > 0) scored.push({ row, score });
        }
        scored.sort((a, b) => (
            b.score - a.score ||
            Number(b.row.created_at) - Number(a.row.created_at) ||
            Number(b.row.id) - Number(a.row.id)
        ));
        return scored.slice(0, cap).map((s) => this._shape(s.row, terms, 'like', s.score));
    }

    /**
     * Deterministic bm25-flavoured relevance for the no-FTS5 route: term
     * frequency, a summary boost, whole-word bonus, length normalisation and a
     * salience nudge. Pure function of the row + terms, so ranking is stable.
     */
    _relevance(row, terms) {
        const text = String(row.text || '').toLowerCase();
        const summary = String(row.summary || '').toLowerCase();
        let score = 0;
        let matched = 0;
        for (const rawTerm of terms) {
            const term = String(rawTerm).toLowerCase();
            if (!term) continue;
            const inText = this._countOccurrences(text, term);
            const inSummary = this._countOccurrences(summary, term);
            if (!inText && !inSummary) continue;
            matched += 1;
            score += Math.min(inText, 8) * 1.0;
            score += Math.min(inSummary, 4) * 2.0;
            if (new RegExp(`(^|\\W)${this._escapeRegex(term)}(\\W|$)`).test(text)) score += 1.5;
        }
        if (!matched) return 0;
        score *= 1 + matched / terms.length;                       // coverage
        score /= 1 + Math.log(1 + text.length / 500);              // length norm
        score *= 1 + 0.05 * this._num(row.salience, 0);            // salience nudge
        return this._round(score);
    }

    /** Most recent salient memories, shaped for prompt injection. */
    recentContext(chatId, limit = 5, { minSalience = 0.1, agentId, includeGlobal = true } = {}) {
        const cap = this._limit(limit);
        if (cap <= 0) return [];
        const filters = this._filters({ chatId, includeGlobal, agentId, minSalience });
        const sql = `
            SELECT mi.* FROM ${INDEX_TABLE} mi
            WHERE 1 = 1${filters.sql}
            ORDER BY mi.created_at DESC, mi.id DESC
            LIMIT ?
        `;
        try {
            return this.db.prepare(sql).all(...filters.params, cap)
                .map((row) => this._shape(row, [], 'recent', 0));
        } catch (err) {
            console.warn(`[MemorySearch] recentContext failed: ${err.message}`);
            return [];
        }
    }

    _filters({ chatId, includeGlobal = true, agentId, since, minSalience }) {
        const parts = [];
        const params = [];
        const chat = this._str(chatId);
        if (chat) {
            if (includeGlobal && chat !== 'global') {
                parts.push('mi.chat_id IN (?, ?)');
                params.push(chat, 'global');
            } else {
                parts.push('mi.chat_id = ?');
                params.push(chat);
            }
        }
        const agent = this._str(agentId);
        if (agent) {
            parts.push('mi.agent_id = ?');
            params.push(agent);
        }
        const sinceMs = since instanceof Date ? since.getTime() : Number(since);
        if (Number.isFinite(sinceMs) && sinceMs > 0) {
            parts.push('mi.created_at >= ?');
            params.push(Math.floor(sinceMs));
        }
        if (minSalience !== undefined && minSalience !== null && Number.isFinite(Number(minSalience))) {
            parts.push('mi.salience >= ?');
            params.push(Number(minSalience));
        }
        return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
    }

    _shape(row, terms, route, score) {
        const text = String(row.text || '');
        return {
            id: Number(row.id),
            refType: String(row.ref_type || 'custom'),
            refId: row.ref_id === null || row.ref_id === undefined ? null : Number(row.ref_id),
            chatId: String(row.chat_id || ''),
            agentId: String(row.agent_id || ''),
            source: String(row.source || ''),
            text,
            summary: String(row.summary || ''),
            snippet: this._snippet(text, terms),
            importance: this._num(row.importance, 0.5),
            salience: this._num(row.salience, 1.0),
            createdAt: this._num(row.created_at, 0),
            indexedAt: this._num(row.indexed_at, 0),
            score: this._round(score),
            route,
        };
    }

    _snippet(text, terms) {
        if (text.length <= SNIPPET_WINDOW) return text;
        const lower = text.toLowerCase();
        let at = -1;
        for (const term of terms) {
            const found = lower.indexOf(String(term).toLowerCase());
            if (found !== -1 && (at === -1 || found < at)) at = found;
        }
        if (at === -1) return `${text.slice(0, SNIPPET_WINDOW)}…`;
        const start = Math.max(0, at - Math.floor(SNIPPET_WINDOW / 3));
        const end = Math.min(text.length, start + SNIPPET_WINDOW);
        return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
    }

    // =========================================================================
    //  MAINTENANCE
    // =========================================================================

    /** Index size, active mode and freshness. */
    stats() {
        const out = {
            mode: this.mode,
            ftsAvailable: this.ftsAvailable,
            ftsError: this.ftsError,
            indexed: 0,
            byRefType: {},
            chats: 0,
            agents: 0,
            oldestAt: null,
            newestAt: null,
            lastIndexedAt: this.lastIndexedAt || null,
        };
        try {
            const agg = this._get(`
                SELECT COUNT(*) AS n,
                       COUNT(DISTINCT chat_id) AS chats,
                       COUNT(DISTINCT agent_id) AS agents,
                       MIN(created_at) AS oldest,
                       MAX(created_at) AS newest,
                       MAX(indexed_at) AS indexed
                FROM ${INDEX_TABLE}
            `);
            if (agg) {
                out.indexed = Number(agg.n || 0);
                out.chats = Number(agg.chats || 0);
                out.agents = Number(agg.agents || 0);
                out.oldestAt = agg.oldest === null ? null : Number(agg.oldest);
                out.newestAt = agg.newest === null ? null : Number(agg.newest);
                out.lastIndexedAt = Number(agg.indexed || this.lastIndexedAt || 0) || null;
            }
            for (const row of this.db.prepare(
                `SELECT ref_type, COUNT(*) AS n FROM ${INDEX_TABLE} GROUP BY ref_type`
            ).all()) {
                out.byRefType[String(row.ref_type)] = Number(row.n || 0);
            }
        } catch (err) {
            console.warn(`[MemorySearch] stats failed: ${err.message}`);
        }
        return out;
    }

    /**
     * Keep the index bounded. A row is removed when it is older than
     * `olderThanMs`, OR its salience dropped below `minSalience`. With
     * `maxRows`, the newest `maxRows` entries are kept and the rest dropped.
     * @returns {number} rows removed
     */
    prune({ olderThanMs, minSalience, maxRows } = {}) {
        let removed = 0;
        try {
            const clauses = [];
            const params = [];
            const age = Number(olderThanMs);
            if (Number.isFinite(age) && age > 0) {
                clauses.push('created_at < ?');
                params.push(Date.now() - age);
            }
            const floor = Number(minSalience);
            if (Number.isFinite(floor)) {
                clauses.push('salience < ?');
                params.push(floor);
            }
            if (clauses.length) {
                const info = this.db
                    .prepare(`DELETE FROM ${INDEX_TABLE} WHERE ${clauses.join(' OR ')}`)
                    .run(...params);
                removed += Number(info.changes || 0);
            }
            const cap = Number(maxRows);
            if (Number.isFinite(cap) && cap > 0) {
                const info = this.db.prepare(`
                    DELETE FROM ${INDEX_TABLE} WHERE id NOT IN (
                        SELECT id FROM ${INDEX_TABLE}
                        ORDER BY created_at DESC, id DESC LIMIT ?
                    )
                `).run(Math.floor(cap));
                removed += Number(info.changes || 0);
            }
            if (removed && this.ftsAvailable) {
                try {
                    this.db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('optimize')`);
                } catch (_) { /* optimize is advisory */ }
            }
        } catch (err) {
            console.warn(`[MemorySearch] prune failed: ${err.message}`);
        }
        return removed;
    }

    /** Drop every index row (and the FTS shadow content). Sources are untouched. */
    clear() {
        try {
            this.db.exec(`DELETE FROM ${INDEX_TABLE}`);
            if (this.ftsAvailable) this._rebuildFtsIndex();
            return true;
        } catch (err) {
            console.warn(`[MemorySearch] clear failed: ${err.message}`);
            return false;
        }
    }

    // =========================================================================
    //  HELPERS
    // =========================================================================

    _get(sql, params = []) {
        try {
            return this.db.prepare(sql).get(...params) || null;
        } catch (err) {
            console.warn(`[MemorySearch] query failed: ${err.message}`);
            return null;
        }
    }

    _count(table) {
        const row = this._get(`SELECT COUNT(*) AS n FROM ${table}`);
        return row ? Number(row.n || 0) : 0;
    }

    _ftsRowCount() {
        try {
            const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get();
            return row ? Number(row.n || 0) : 0;
        } catch (err) {
            return -1;
        }
    }

    _sourceRowCount() {
        let total = 0;
        for (const table of ['memories', 'hive_mind']) {
            try {
                total += this._count(table);
            } catch (_) { /* table may not exist */ }
        }
        return total;
    }

    _limit(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return DEFAULT_LIMIT;
        return Math.max(0, Math.min(Math.floor(n), 500));
    }

    _num(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    _str(value) {
        if (value === null || value === undefined) return '';
        return String(value).trim();
    }

    _round(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
    }

    _escapeLike(value) {
        return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
    }

    _escapeRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _countOccurrences(haystack, needle) {
        if (!needle) return 0;
        let count = 0;
        let at = haystack.indexOf(needle);
        while (at !== -1) {
            count += 1;
            at = haystack.indexOf(needle, at + needle.length);
        }
        return count;
    }
}

module.exports = MemorySearch;
module.exports.MemorySearch = MemorySearch;
