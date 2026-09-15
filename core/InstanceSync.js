// =============================================================================
//  core/InstanceSync.js — Opt-In State Sharing Between Agent OS Instances
//
//  The operator runs this Agent OS on more than one machine (desktop, laptop,
//  VPS) and wants those instances to share a brain *if they wish to* — never
//  automatically, never wholesale.
//
//  How this differs from what already exists:
//    - core/SatelliteHub.js    — remote *control* (5 fixed actions over a
//                                long-poll). It moves commands, not state.
//    - core/SyncthingBridge.js — file-level replication of whole folders,
//                                all-or-nothing, driven by an external daemon.
//    - core/InstanceSync.js    — selective, database-level state sharing:
//                                memories, skills and a safe config subset,
//                                each gated by a per-peer opt-in scope.
//
//  The opt-in mechanism is `scopes`. A peer is granted a subset of
//  ['memories', 'skills', 'config'] and gets *nothing* outside it. A peer with
//  no scopes — the default for a freshly added peer — shares nothing at all.
//
//  Secrets never leave the machine. Config export is driven by an explicit
//  ALLOW-LIST of resolver functions (CONFIG_ALLOWLIST below): there is no code
//  path that reads an arbitrary key, an arbitrary env var, or .env. A second,
//  independent sanitiser then drops anything whose key or value looks like a
//  credential, so even a future careless addition to the allow-list cannot
//  leak one.
//
//  Conflict rule: LAST-WRITE-WINS BY TIMESTAMP. When both instances hold the
//  same item (identical stable content hash) the copy with the newer timestamp
//  wins. A local item that is newer than the incoming one is kept and reported
//  as `keptLocalNewer` — it is never silently dropped or overwritten.
//
//  Node builtins only. No new npm dependencies.
// =============================================================================
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** The complete set of shareable scopes. Anything else is ignored. */
const SCOPES = Object.freeze(['memories', 'skills', 'config']);

/** Skill files we are willing to replicate. Data, never executables. */
const SKILL_EXTENSIONS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml']);

const MAX_EXPORT_MEMORIES = 500;
const MAX_EXPORT_SKILLS = 200;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_DEPTH = 6;
const REQUEST_TIMEOUT_MS = 20000;
const NUL = String.fromCharCode(0);

/**
 * The ONLY config keys this instance will ever hand to another instance.
 *
 * An allow-list (not a deny-list) is the whole point: a key that is not
 * spelled out here has no resolver, so no request — however it is phrased —
 * can produce a value for it. Every entry is a user *preference*: cosmetic or
 * operational, and useless to an attacker.
 */
const CONFIG_ALLOWLIST = Object.freeze({
    agentVoices: {
        why: 'War Room TTS voice per agent. Cosmetic.',
        read: (self) => self._tryRead(
            () => (self.db && typeof self.db.getAgentVoices === 'function' ? self.db.getAgentVoices() : {}),
            {}
        ),
    },
    defaultAgent: {
        why: 'Which CLI engine answers by default. A name, not a credential.',
        read: (self) => self._tryRead(() => self._globalPrefs().activeAgent || null, null),
    },
    maxConcurrentAgents: {
        why: 'Agent pool size. A small integer tuned to the machine.',
        read: () => {
            const n = Number(process.env.MAX_CONCURRENT_AGENTS);
            return Number.isFinite(n) && n >= 1 ? n : 4;
        },
    },
    killSwitches: {
        why: 'Boolean feature gates (LLM_SPAWN_ENABLED etc). Booleans only.',
        read: (self) => self._tryRead(() => {
            const ks = self.killSwitches;
            return ks && typeof ks.getAll === 'function' ? ks.getAll() : {};
        }, {}),
    },
    voiceMode: {
        why: 'Whether replies are spoken. A UX toggle.',
        read: (self) => self._tryRead(() => Boolean(self._globalPrefs().voiceMode), false),
    },
    reasoningEffort: {
        why: 'Preferred reasoning effort (low/medium/high). A label.',
        read: (self) => self._tryRead(() => self._globalPrefs().reasoningEffort || null, null),
    },
});

/**
 * Second gate. Even for an allow-listed key, refuse anything that *looks* like
 * a credential — by key name or by value shape. Belt and braces: the allow-list
 * is the guarantee, this is the tripwire if someone widens it carelessly.
 */
const SECRET_KEY_RE = /(key|token|secret|password|passwd|pwd|auth|credential|cookie|bearer|passphrase|signature|private|\.env)/i;
const SECRET_VALUE_RE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA|hf_|glpat-|dop_v1_|Bearer\s|Basic\s|eyJ[A-Za-z0-9_-]{8,}\.)/;
const MAX_CONFIG_STRING = 512;

/** Repo-standard secret mask: first 7 + '...' + last 4. */
function maskToken(token) {
    if (!token) return '';
    const str = String(token);
    if (str.length <= 12) return '*'.repeat(str.length);
    return str.slice(0, 7) + '...' + str.slice(-4);
}

/**
 * Stable, content-only hash. Timestamps are deliberately excluded so the same
 * item re-exported later still resolves to the same identity — that is what
 * makes import() idempotent.
 */
function contentHash(kind, parts) {
    const h = crypto.createHash('sha256');
    h.update(String(kind));
    for (const part of parts) {
        h.update(NUL);
        h.update(part === undefined || part === null ? '' : String(part));
    }
    return h.digest('hex');
}

function normaliseScopes(input) {
    let list = input;
    if (typeof list === 'string') list = list.split(',');
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        const scope = String(raw || '').trim().toLowerCase();
        if (SCOPES.includes(scope) && !out.includes(scope)) out.push(scope);
    }
    return out;
}

class InstanceSync {
    /**
     * @param {object}   opts
     * @param {object}   opts.database       AssistantDatabase (raw handle at .db)
     * @param {string}   opts.baseDir        repo root; peers live in <baseDir>/store
     * @param {string}   opts.selfId         this instance's id (defaults to hostname)
     * @param {string}   opts.sharedSecret   secret an inbound peer must present
     * @param {function} opts.transport      injectable HTTP; tests never touch the network.
     *                                       ({ method, url, body, headers, token }) => Promise<object>
     * @param {object}   [opts.killSwitches] optional KillSwitches for the config export
     */
    constructor({ database, baseDir, selfId, sharedSecret, transport, killSwitches } = {}) {
        this.db = database || null;
        this.raw = database && database.db ? database.db : null;
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.storeDir = path.join(this.baseDir, 'store');
        this.peersPath = path.join(this.storeDir, 'instance-peers.json');
        this.skillsDir = path.join(this.baseDir, 'skills');
        this.selfIdExplicit = Boolean(selfId);
        this.selfId = String(selfId || process.env.INSTANCE_ID || os.hostname() || 'instance').trim();
        this.sharedSecret = sharedSecret || process.env.INSTANCE_SYNC_SECRET || null;
        this.transport = typeof transport === 'function' ? transport : null;
        this.killSwitches = killSwitches || this._loadKillSwitches();
        this.peers = new Map();

        this._ensureTables();
        this._load();
    }

    // --- Introspection ------------------------------------------------------

    static get SCOPES() { return SCOPES; }

    /** The exact config keys this instance can ever export, with the reason. */
    static configAllowList() {
        return Object.entries(CONFIG_ALLOWLIST).map(([key, spec]) => ({ key, why: spec.why }));
    }

    static maskToken(token) { return maskToken(token); }

    static contentHash(kind, parts) { return contentHash(kind, parts); }

    /** One call for a dashboard tile. Never throws, never leaks a token. */
    status() {
        const peers = this.listPeers();
        return {
            selfId: this.selfId,
            secretConfigured: Boolean(this.sharedSecret),
            peerCount: peers.length,
            sharingPeerCount: peers.filter((p) => p.scopes.length > 0).length,
            scopes: SCOPES.slice(),
            configAllowList: Object.keys(CONFIG_ALLOWLIST),
            peers,
        };
    }

    // --- Persistence --------------------------------------------------------

    _loadKillSwitches() {
        try {
            const KillSwitches = require('./KillSwitches');
            return new KillSwitches(this.baseDir);
        } catch (err) {
            console.warn('[InstanceSync] Kill switches unavailable for config export:', err.message);
            return null;
        }
    }

    _load() {
        try {
            if (!fs.existsSync(this.peersPath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.peersPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return;
            if (parsed.selfId && !this.selfIdExplicit) this.selfId = String(parsed.selfId);
            const peers = parsed.peers;
            if (!peers || typeof peers !== 'object') return;
            for (const [id, entry] of Object.entries(peers)) {
                if (!entry || typeof entry !== 'object') continue;
                this.peers.set(id, {
                    id,
                    url: String(entry.url || '').replace(/\/+$/, ''),
                    token: entry.token ? String(entry.token) : '',
                    scopes: normaliseScopes(entry.scopes),
                    label: entry.label ? String(entry.label) : '',
                    addedAt: Number(entry.addedAt) || Date.now(),
                    updatedAt: Number(entry.updatedAt) || Date.now(),
                });
            }
        } catch (err) {
            console.warn('[InstanceSync] Failed to read instance-peers.json:', err.message);
        }
    }

    _save() {
        try {
            if (!fs.existsSync(this.storeDir)) {
                fs.mkdirSync(this.storeDir, { recursive: true });
            }
            const peers = {};
            for (const [id, peer] of this.peers) peers[id] = { ...peer };
            fs.writeFileSync(
                this.peersPath,
                JSON.stringify({ version: 1, selfId: this.selfId, peers }, null, 2),
                'utf8'
            );
        } catch (err) {
            console.warn('[InstanceSync] Failed to persist instance-peers.json:', err.message);
        }
    }

    /**
     * Our own bookkeeping tables, created through the raw node:sqlite handle so
     * core/Database.js stays untouched.
     */
    _ensureTables() {
        if (!this.raw) {
            console.warn('[InstanceSync] No raw database handle; sync bookkeeping disabled');
            return;
        }
        try {
            this.raw.exec(`
                -- Every item this instance has already imported, keyed by its
                -- stable content hash. This is what makes import() idempotent.
                CREATE TABLE IF NOT EXISTS instance_sync_log (
                    hash        TEXT PRIMARY KEY,
                    kind        TEXT NOT NULL,
                    peer_id     TEXT NOT NULL DEFAULT '',
                    local_ref   TEXT,
                    remote_ts   INTEGER NOT NULL DEFAULT 0,
                    imported_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_instance_sync_log_peer
                    ON instance_sync_log(peer_id, kind);

                -- Per-peer incremental watermarks and last error.
                CREATE TABLE IF NOT EXISTS instance_sync_peer_state (
                    peer_id      TEXT PRIMARY KEY,
                    last_pull_at INTEGER NOT NULL DEFAULT 0,
                    last_push_at INTEGER NOT NULL DEFAULT 0,
                    watermark    INTEGER NOT NULL DEFAULT 0,
                    last_error   TEXT,
                    updated_at   INTEGER NOT NULL DEFAULT 0
                );

                -- Imported config that is NOT auto-applied (see _applyConfig).
                CREATE TABLE IF NOT EXISTS instance_sync_config (
                    key        TEXT PRIMARY KEY,
                    value      TEXT NOT NULL,
                    peer_id    TEXT NOT NULL DEFAULT '',
                    remote_ts  INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
            `);
        } catch (err) {
            console.warn('[InstanceSync] Failed to create sync tables:', err.message);
            this.raw = null;
        }
    }

    _tryRead(fn, fallback) {
        try {
            const value = fn();
            return value === undefined ? fallback : value;
        } catch (err) {
            console.warn('[InstanceSync] Config read failed:', err.message);
            return fallback;
        }
    }

    _globalPrefs() {
        if (!this.db || typeof this.db.getChatPreferences !== 'function') return {};
        return this.db.getChatPreferences('global') || {};
    }

    // --- Peers --------------------------------------------------------------

    /**
     * Register another instance. `scopes` is the opt-in: omit it and the peer
     * is registered but shares nothing until the operator grants a scope.
     */
    addPeer({ id, url, token, scopes, label } = {}) {
        const peerId = String(id || '').trim();
        if (!peerId) throw new Error('Peer id is required');
        if (peerId === this.selfId) throw new Error('A peer cannot be this instance itself');

        const rawUrl = String(url || '').trim().replace(/\/+$/, '');
        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch {
            throw new Error(`Peer url is not a valid URL: ${rawUrl || '(empty)'}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Peer url must be http(s), got ${parsed.protocol}`);
        }

        const requested = Array.isArray(scopes) || typeof scopes === 'string' ? scopes : [];
        const granted = normaliseScopes(requested);
        const ignored = (Array.isArray(requested) ? requested : String(requested).split(','))
            .map((s) => String(s || '').trim())
            .filter((s) => s && !granted.includes(s.toLowerCase()));
        if (ignored.length) {
            // Fail closed: an unrecognised scope grants nothing rather than everything.
            console.warn(`[InstanceSync] Ignored unknown scope(s) for peer ${peerId}: ${ignored.join(', ')}`);
        }

        const now = Date.now();
        const existing = this.peers.get(peerId);
        this.peers.set(peerId, {
            id: peerId,
            url: rawUrl,
            token: token ? String(token) : (existing ? existing.token : ''),
            scopes: granted,
            label: label ? String(label) : (existing ? existing.label : ''),
            addedAt: existing ? existing.addedAt : now,
            updatedAt: now,
        });
        this._save();
        return this._maskPeer(this.peers.get(peerId));
    }

    removePeer(id) {
        const peerId = String(id || '').trim();
        if (!this.peers.has(peerId)) return false;
        this.peers.delete(peerId);
        this._save();
        try {
            if (this.raw) {
                this.raw.prepare('DELETE FROM instance_sync_peer_state WHERE peer_id = ?').run(peerId);
            }
        } catch (err) {
            console.warn('[InstanceSync] Failed clearing peer state:', err.message);
        }
        return true;
    }

    /** Safe, serialisable view. The raw token NEVER appears here. */
    listPeers() {
        return [...this.peers.values()].map((peer) => this._maskPeer(peer));
    }

    /** Update just the opt-in scopes of an existing peer. */
    setPeerScopes(id, scopes) {
        const peer = this.peers.get(String(id || '').trim());
        if (!peer) throw new Error(`Unknown peer: ${id}`);
        peer.scopes = normaliseScopes(scopes);
        peer.updatedAt = Date.now();
        this._save();
        return this._maskPeer(peer);
    }

    /**
     * Identify an inbound caller by its token, comparing in constant time.
     * Returns a token-free descriptor, or null. Use it in the HTTP route to
     * decide which scopes the caller is allowed to ask for.
     */
    peerForToken(presented) {
        const supplied = Buffer.from(String(presented === undefined || presented === null ? '' : presented), 'utf8');
        let found = null;
        for (const peer of this.peers.values()) {
            if (!peer.token) continue;
            const expected = Buffer.from(peer.token, 'utf8');
            if (expected.length !== supplied.length) continue;
            try {
                if (crypto.timingSafeEqual(expected, supplied) && !found) {
                    found = { id: peer.id, url: peer.url, scopes: peer.scopes.slice() };
                }
            } catch (err) {
                console.warn('[InstanceSync] Token comparison failed:', err.message);
            }
        }
        return found;
    }

    /**
     * Identify an inbound caller by the instance id it claims. Token-free, so
     * the HTTP layer can resolve a shared-secret bootstrap to a *registered*
     * peer's opt-in scopes. Unknown ids return null — they are never auto-added.
     */
    peerForId(id) {
        const peer = this.peers.get(String(id || '').trim());
        if (!peer) return null;
        return { id: peer.id, url: peer.url, scopes: peer.scopes.slice() };
    }

    _maskPeer(peer) {
        const state = this._peerState(peer.id);
        return {
            id: peer.id,
            url: peer.url,
            label: peer.label || '',
            scopes: peer.scopes.slice(),
            sharing: peer.scopes.length > 0,
            tokenMasked: maskToken(peer.token),
            hasToken: Boolean(peer.token),
            addedAt: peer.addedAt,
            updatedAt: peer.updatedAt,
            lastPullAt: state.last_pull_at || 0,
            lastPushAt: state.last_push_at || 0,
            lastError: state.last_error || null,
        };
    }

    _peerState(peerId) {
        if (!this.raw) return {};
        try {
            return this.raw.prepare('SELECT * FROM instance_sync_peer_state WHERE peer_id = ?').get(peerId) || {};
        } catch (err) {
            console.warn('[InstanceSync] Failed reading peer state:', err.message);
            return {};
        }
    }

    _setPeerState(peerId, patch) {
        if (!this.raw) return;
        try {
            const prev = this._peerState(peerId);
            const next = {
                lastPullAt: patch.last_pull_at === undefined ? (prev.last_pull_at || 0) : patch.last_pull_at,
                lastPushAt: patch.last_push_at === undefined ? (prev.last_push_at || 0) : patch.last_push_at,
                watermark: patch.watermark === undefined ? (prev.watermark || 0) : patch.watermark,
                lastError: patch.last_error === undefined ? (prev.last_error || null) : patch.last_error,
            };
            this.raw.prepare(`
                INSERT INTO instance_sync_peer_state (peer_id, last_pull_at, last_push_at, watermark, last_error, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(peer_id) DO UPDATE SET
                    last_pull_at = excluded.last_pull_at,
                    last_push_at = excluded.last_push_at,
                    watermark    = excluded.watermark,
                    last_error   = excluded.last_error,
                    updated_at   = excluded.updated_at
            `).run(peerId, next.lastPullAt, next.lastPushAt, next.watermark, next.lastError, Date.now());
        } catch (err) {
            console.warn('[InstanceSync] Failed writing peer state:', err.message);
        }
    }

    // --- Security -----------------------------------------------------------

    /**
     * Constant-time check of the shared secret an inbound instance presents.
     * crypto.timingSafeEqual throws when the buffers differ in length, so the
     * length is guarded first and a wrong-length secret simply returns false.
     */
    verifySharedSecret(presented) {
        try {
            if (!this.sharedSecret) return false;
            if (presented === undefined || presented === null) return false;
            const expected = Buffer.from(String(this.sharedSecret), 'utf8');
            const supplied = Buffer.from(String(presented), 'utf8');
            if (expected.length !== supplied.length) return false;
            return crypto.timingSafeEqual(expected, supplied);
        } catch (err) {
            console.warn('[InstanceSync] Shared secret verification failed:', err.message);
            return false;
        }
    }

    // --- Export -------------------------------------------------------------

    /**
     * Build the payload another instance may pull.
     *
     * Only the sections named in `scopes` are present at all — an out-of-scope
     * key is omitted from the object, not emptied. `since` makes the sync
     * incremental; it is inclusive, so a boundary row is re-sent rather than
     * lost, and import() dedupes it by content hash.
     */
    export({ scopes = [], since = 0, limit = MAX_EXPORT_MEMORIES, configKeys = null } = {}) {
        const granted = normaliseScopes(scopes);
        const from = Number(since) > 0 ? Number(since) : 0;
        const payload = {
            instanceId: this.selfId,
            exportedAt: Date.now(),
            since: from,
            scopes: granted,
            counts: { memories: 0, skills: 0, config: 0 },
        };

        if (granted.includes('memories')) {
            payload.memories = this._exportMemories(from, limit);
            payload.counts.memories = payload.memories.length;
        }
        if (granted.includes('skills')) {
            payload.skills = this._exportSkills(from);
            payload.counts.skills = payload.skills.length;
        }
        if (granted.includes('config')) {
            payload.config = this._exportConfig(configKeys);
            payload.counts.config = Object.keys(payload.config).length;
        }
        return payload;
    }

    _exportMemories(since, limit) {
        if (!this.raw) return [];
        try {
            const asked = Number(limit);
            const cap = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_EXPORT_MEMORIES) : MAX_EXPORT_MEMORIES;
            const rows = this.raw.prepare(`
                SELECT chat_id, source, raw_text, summary, importance, salience, created_at, accessed_at
                FROM memories
                WHERE created_at >= ?
                ORDER BY created_at ASC
                LIMIT ?
            `).all(since, cap) || [];
            return rows.map((row) => ({
                chatId: row.chat_id,
                source: row.source,
                text: row.raw_text,
                summary: row.summary,
                importance: row.importance,
                salience: row.salience,
                createdAt: row.created_at,
                accessedAt: row.accessed_at,
                hash: contentHash('memory', [row.chat_id, row.source, row.raw_text, row.summary]),
            }));
        } catch (err) {
            console.warn('[InstanceSync] Memory export failed:', err.message);
            return [];
        }
    }

    _exportSkills(since) {
        const out = [];
        try {
            if (!fs.existsSync(this.skillsDir)) return out;
            const walk = (dir, depth) => {
                if (depth > MAX_SKILL_DEPTH || out.length >= MAX_EXPORT_SKILLS) return;
                let entries = [];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (err) {
                    console.warn('[InstanceSync] Unreadable skills dir:', err.message);
                    return;
                }
                for (const entry of entries) {
                    if (out.length >= MAX_EXPORT_SKILLS) return;
                    if (entry.name.startsWith('.')) continue;
                    const abs = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(abs, depth + 1);
                        continue;
                    }
                    if (!entry.isFile()) continue;
                    if (!SKILL_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
                    try {
                        const stat = fs.statSync(abs);
                        if (stat.size > MAX_SKILL_BYTES) continue;
                        if (since > 0 && stat.mtimeMs < since) continue;
                        const content = fs.readFileSync(abs, 'utf8');
                        const rel = path.relative(this.skillsDir, abs).replace(/\\/g, '/');
                        out.push({
                            path: rel,
                            content,
                            size: stat.size,
                            modifiedAt: Math.floor(stat.mtimeMs),
                            hash: contentHash('skill', [rel, content]),
                        });
                    } catch (err) {
                        console.warn(`[InstanceSync] Skipping skill ${entry.name}: ${err.message}`);
                    }
                }
            };
            walk(this.skillsDir, 0);
        } catch (err) {
            console.warn('[InstanceSync] Skill export failed:', err.message);
        }
        return out;
    }

    /**
     * Resolve the allow-listed config keys. `requested` can only ever NARROW
     * the result: a key that is not in CONFIG_ALLOWLIST has no resolver, so
     * asking for it yields nothing at all.
     */
    _exportConfig(requested) {
        const wanted = Array.isArray(requested) && requested.length
            ? requested.map((k) => String(k || '').trim()).filter((k) => Object.prototype.hasOwnProperty.call(CONFIG_ALLOWLIST, k))
            : Object.keys(CONFIG_ALLOWLIST);

        const config = {};
        for (const key of wanted) {
            const spec = CONFIG_ALLOWLIST[key];
            if (!spec) continue;
            const value = spec.read(this);
            if (value === undefined || value === null) continue;
            config[key] = value;
        }
        const { clean, dropped } = this._scrubSecrets(config);
        if (dropped.length) {
            console.warn(`[InstanceSync] Refused to export secret-shaped config: ${dropped.join(', ')}`);
        }
        return clean;
    }

    /**
     * Independent second gate over whatever the allow-list produced. Drops any
     * key that reads like a credential and any value shaped like one, at every
     * nesting level. Nothing here should ever fire — if it does, the allow-list
     * has grown something it should not have.
     */
    _scrubSecrets(value, dropped = [], trail = '') {
        if (trail === '') {
            const clean = this._scrubSecrets(value, dropped, 'root');
            return { clean: clean === null ? {} : clean, dropped };
        }
        if (value === null || value === undefined) return value;
        if (typeof value === 'string') {
            if (value.length > MAX_CONFIG_STRING) return null;
            if (SECRET_VALUE_RE.test(value)) return null;
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) {
            return value
                .map((item, i) => this._scrubSecrets(item, dropped, `${trail}[${i}]`))
                .filter((v) => v !== null && v !== undefined);
        }
        if (typeof value === 'object') {
            const out = {};
            for (const [key, inner] of Object.entries(value)) {
                if (SECRET_KEY_RE.test(key)) {
                    dropped.push(`${trail}.${key}`);
                    continue;
                }
                const scrubbed = this._scrubSecrets(inner, dropped, `${trail}.${key}`);
                if (scrubbed === null) {
                    dropped.push(`${trail}.${key}`);
                    continue;
                }
                out[key] = scrubbed;
            }
            return out;
        }
        return null; // functions, symbols, bigints — never exported
    }

    // --- Import -------------------------------------------------------------

    /**
     * Merge a peer's payload locally.
     *
     * Idempotent: every item is identified by a stable sha256 content hash
     * recorded in instance_sync_log, so replaying the same payload imports
     * nothing the second time.
     *
     * Conflict rule: LAST-WRITE-WINS BY TIMESTAMP. If the local copy is newer
     * it is kept and counted in `keptLocalNewer` — never silently dropped.
     */
    import(payload, { scopes = [], peerId = '' } = {}) {
        const granted = normaliseScopes(scopes);
        const report = {
            ok: true,
            from: payload && payload.instanceId ? String(payload.instanceId) : 'unknown',
            scopes: granted,
            memories: { received: 0, imported: 0, updated: 0, skipped: 0, keptLocalNewer: 0, rejected: 0 },
            skills: { received: 0, written: 0, skipped: 0, keptLocalNewer: 0, rejected: 0 },
            config: { received: 0, applied: 0, staged: 0, skipped: 0, rejected: [] },
            errors: [],
        };

        if (!payload || typeof payload !== 'object') {
            report.ok = false;
            report.errors.push('Payload is not an object');
            return report;
        }

        const from = peerId ? String(peerId) : report.from;
        const stamp = Number(payload.exportedAt) || Date.now();

        // Strict scope filtering on the RECEIVING side too: a peer that
        // over-shares (or a tampered payload) still gets nothing applied.
        if (granted.includes('memories')) {
            this._importMemories(payload.memories, from, report);
        } else if (Array.isArray(payload.memories) && payload.memories.length) {
            report.memories.rejected = payload.memories.length;
        }

        if (granted.includes('skills')) {
            this._importSkills(payload.skills, from, report);
        } else if (Array.isArray(payload.skills) && payload.skills.length) {
            report.skills.rejected = payload.skills.length;
        }

        if (granted.includes('config')) {
            this._importConfig(payload.config, from, stamp, report);
        } else if (payload.config && typeof payload.config === 'object') {
            report.config.rejected = Object.keys(payload.config);
        }

        return report;
    }

    _logEntry(hash) {
        if (!this.raw) return null;
        try {
            return this.raw.prepare('SELECT * FROM instance_sync_log WHERE hash = ?').get(hash) || null;
        } catch (err) {
            console.warn('[InstanceSync] Sync log read failed:', err.message);
            return null;
        }
    }

    _recordLog(hash, kind, peerId, localRef, remoteTs) {
        if (!this.raw) return;
        try {
            this.raw.prepare(`
                INSERT INTO instance_sync_log (hash, kind, peer_id, local_ref, remote_ts, imported_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(hash) DO UPDATE SET
                    peer_id     = excluded.peer_id,
                    local_ref   = excluded.local_ref,
                    remote_ts   = MAX(instance_sync_log.remote_ts, excluded.remote_ts),
                    imported_at = excluded.imported_at
            `).run(
                hash,
                kind,
                String(peerId || ''),
                localRef === null || localRef === undefined ? null : String(localRef),
                Number(remoteTs) || 0,
                Date.now()
            );
        } catch (err) {
            console.warn('[InstanceSync] Sync log write failed:', err.message);
        }
    }

    _importMemories(memories, peerId, report) {
        if (!Array.isArray(memories) || !memories.length) return;
        report.memories.received = memories.length;
        if (!this.raw) {
            report.errors.push('No database handle; memories not imported');
            report.memories.rejected = memories.length;
            return;
        }

        for (const item of memories) {
            try {
                if (!item || typeof item !== 'object') { report.memories.rejected += 1; continue; }
                const text = String(item.text === undefined ? (item.raw_text || '') : item.text);
                if (!text.trim()) { report.memories.rejected += 1; continue; }
                const chatId = String(item.chatId === undefined ? (item.chat_id || 'global') : item.chatId);
                const source = String(item.source || 'instance_sync');
                const summary = String(item.summary || text.slice(0, 120));
                const createdAt = Number(item.createdAt === undefined ? item.created_at : item.createdAt) || 0;

                // Never trust the sender's hash — recompute it locally.
                const hash = contentHash('memory', [chatId, source, text, summary]);

                const logged = this._logEntry(hash);
                if (logged && createdAt <= Number(logged.remote_ts || 0)) {
                    report.memories.skipped += 1;   // already imported: idempotent replay
                    continue;
                }

                const existing = this.raw.prepare(`
                    SELECT id, importance, salience, created_at, accessed_at
                    FROM memories
                    WHERE chat_id = ? AND source = ? AND raw_text = ? AND summary = ?
                    ORDER BY created_at DESC LIMIT 1
                `).get(chatId, source, text, summary);

                if (!existing) {
                    this.raw.prepare(`
                        INSERT INTO memories (chat_id, source, raw_text, summary, importance, salience, created_at, accessed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        chatId,
                        source,
                        text,
                        summary,
                        Number(item.importance) >= 0 ? Number(item.importance) : 0.5,
                        Number(item.salience) >= 0 ? Number(item.salience) : 1.0,
                        createdAt || Date.now(),
                        Date.now()
                    );
                    report.memories.imported += 1;
                } else if (createdAt > Number(existing.created_at || 0)) {
                    // Incoming copy is newer — last-write-wins on the mutable
                    // fields. created_at stays put so the local timeline holds.
                    this.raw.prepare(`
                        UPDATE memories SET importance = ?, salience = ?, accessed_at = ? WHERE id = ?
                    `).run(
                        Number(item.importance) >= 0 ? Number(item.importance) : existing.importance,
                        Number(item.salience) >= 0 ? Number(item.salience) : existing.salience,
                        Math.max(Number(existing.accessed_at) || 0, createdAt),
                        existing.id
                    );
                    report.memories.updated += 1;
                } else {
                    // The local copy is the same age or newer. Keep it, and say
                    // so — a newer local memory is never dropped for an older
                    // remote one.
                    report.memories.keptLocalNewer += 1;
                }

                this._recordLog(hash, 'memory', peerId, existing ? existing.id : null, createdAt);
            } catch (err) {
                report.memories.rejected += 1;
                report.errors.push(`memory: ${err.message}`);
                console.warn('[InstanceSync] Memory import failed:', err.message);
            }
        }
    }

    /** Reject absolute paths, drive letters and traversal before touching disk. */
    _safeSkillPath(rel) {
        const cleaned = String(rel || '').replace(/\\/g, '/').trim();
        if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
        const segments = cleaned.split('/').filter(Boolean);
        if (!segments.length || segments.length > MAX_SKILL_DEPTH) return null;
        if (segments.some((s) => s === '.' || s === '..' || s.includes(NUL))) return null;
        if (!SKILL_EXTENSIONS.includes(path.extname(segments[segments.length - 1]).toLowerCase())) return null;

        const root = path.resolve(this.skillsDir);
        const abs = path.resolve(root, segments.join('/'));
        if (abs !== root && !abs.startsWith(root + path.sep)) return null;
        return { rel: segments.join('/'), abs };
    }

    _importSkills(skills, peerId, report) {
        if (!Array.isArray(skills) || !skills.length) return;
        report.skills.received = skills.length;

        for (const item of skills) {
            try {
                if (!item || typeof item !== 'object') { report.skills.rejected += 1; continue; }
                const safe = this._safeSkillPath(item.path);
                const content = typeof item.content === 'string' ? item.content : null;
                if (!safe || content === null || Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
                    report.skills.rejected += 1;
                    continue;
                }
                const modifiedAt = Number(item.modifiedAt) || 0;
                const hash = contentHash('skill', [safe.rel, content]);

                const logged = this._logEntry(hash);
                if (logged && modifiedAt <= Number(logged.remote_ts || 0)) {
                    report.skills.skipped += 1;
                    continue;
                }

                if (fs.existsSync(safe.abs)) {
                    const stat = fs.statSync(safe.abs);
                    const local = fs.readFileSync(safe.abs, 'utf8');
                    if (local === content) {
                        report.skills.skipped += 1;
                        this._recordLog(hash, 'skill', peerId, safe.rel, modifiedAt);
                        continue;
                    }
                    if (stat.mtimeMs > modifiedAt) {
                        // The local edit is newer: last-write-wins keeps it.
                        report.skills.keptLocalNewer += 1;
                        continue;
                    }
                }

                fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
                fs.writeFileSync(safe.abs, content, 'utf8');
                report.skills.written += 1;
                this._recordLog(hash, 'skill', peerId, safe.rel, modifiedAt);
            } catch (err) {
                report.skills.rejected += 1;
                report.errors.push(`skill: ${err.message}`);
                console.warn('[InstanceSync] Skill import failed:', err.message);
            }
        }
    }

    _importConfig(config, peerId, stamp, report) {
        if (!config || typeof config !== 'object') return;
        const keys = Object.keys(config);
        report.config.received = keys.length;

        for (const key of keys) {
            try {
                // The allow-list gates the inbound direction too: a peer cannot
                // push a key we would never have exported ourselves.
                if (!Object.prototype.hasOwnProperty.call(CONFIG_ALLOWLIST, key)) {
                    report.config.rejected.push(key);
                    continue;
                }
                const { clean, dropped } = this._scrubSecrets({ [key]: config[key] });
                if (dropped.length || !(key in clean)) {
                    report.config.rejected.push(key);
                    continue;
                }
                const value = clean[key];
                const hash = contentHash('config', [key, JSON.stringify(value)]);
                const logged = this._logEntry(hash);
                if (logged && stamp <= Number(logged.remote_ts || 0)) {
                    report.config.skipped += 1;
                    continue;
                }

                if (this._applyConfig(key, value)) {
                    report.config.applied += 1;
                } else {
                    this._stageConfig(key, value, peerId, stamp);
                    report.config.staged += 1;
                }
                this._recordLog(hash, 'config', peerId, key, stamp);
            } catch (err) {
                report.config.rejected.push(key);
                report.errors.push(`config(${key}): ${err.message}`);
                console.warn(`[InstanceSync] Config import failed for ${key}:`, err.message);
            }
        }
    }

    /**
     * Apply the config keys that are safe to take effect immediately. The rest
     * (maxConcurrentAgents, killSwitches) are staged instead of applied: kill
     * switches gate dangerous boundaries and the pool size is tuned to this
     * machine's RAM, so a human promotes them via getImportedConfig().
     * Returns true when the value really was applied.
     */
    _applyConfig(key, value) {
        try {
            if (key === 'agentVoices' && this.db && typeof this.db.setAgentVoices === 'function') {
                const voices = {};
                for (const [agentId, voice] of Object.entries(value || {})) {
                    if (agentId && typeof voice === 'string') voices[agentId] = voice;
                }
                if (!Object.keys(voices).length) return false;
                this.db.setAgentVoices(voices);
                return true;
            }
            if ((key === 'defaultAgent' || key === 'voiceMode' || key === 'reasoningEffort')
                && this.db && typeof this.db.setChatPreferences === 'function') {
                const field = key === 'defaultAgent' ? 'activeAgent' : key;
                this.db.setChatPreferences('global', { [field]: value });
                return true;
            }
        } catch (err) {
            console.warn(`[InstanceSync] Failed applying config ${key}:`, err.message);
        }
        return false;
    }

    _stageConfig(key, value, peerId, stamp) {
        if (!this.raw) return;
        try {
            this.raw.prepare(`
                INSERT INTO instance_sync_config (key, value, peer_id, remote_ts, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value      = excluded.value,
                    peer_id    = excluded.peer_id,
                    remote_ts  = excluded.remote_ts,
                    updated_at = excluded.updated_at
                WHERE excluded.remote_ts >= instance_sync_config.remote_ts
            `).run(key, JSON.stringify(value), String(peerId || ''), Number(stamp) || 0, Date.now());
        } catch (err) {
            console.warn('[InstanceSync] Failed staging config:', err.message);
        }
    }

    /** Config a peer sent that was staged rather than auto-applied. */
    getImportedConfig() {
        if (!this.raw) return {};
        try {
            const rows = this.raw.prepare('SELECT key, value, peer_id, remote_ts FROM instance_sync_config').all() || [];
            const out = {};
            for (const row of rows) {
                let parsed = null;
                try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
                out[row.key] = { value: parsed, from: row.peer_id, at: row.remote_ts };
            }
            return out;
        } catch (err) {
            console.warn('[InstanceSync] Failed reading staged config:', err.message);
            return {};
        }
    }

    // --- Transport ----------------------------------------------------------

    _request({ method, url, body = null, token = '' }) {
        const headers = {
            'X-Instance-Token': token || '',
            'X-Instance-Id': this.selfId,
        };
        // Bootstrap path: a registered peer that has not yet exchanged a
        // per-peer token can still authenticate with the shared secret.
        // The remote side still refuses unknown X-Instance-Id values.
        if (this.sharedSecret) {
            headers['X-Instance-Secret'] = String(this.sharedSecret);
        }
        if (this.transport) {
            return Promise.resolve().then(() => this.transport({ method, url, body, headers, token }));
        }

        let parsed;
        try {
            parsed = new URL(url);
        } catch (err) {
            return Promise.reject(new Error(`Invalid peer URL ${url}: ${err.message}`));
        }
        const client = parsed.protocol === 'https:' ? https : http;
        const serialised = body === null ? null : JSON.stringify(body);

        return new Promise((resolve, reject) => {
            const req = client.request({
                method,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers: {
                    ...headers,
                    Accept: 'application/json',
                    ...(serialised
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialised) }
                        : {}),
                },
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        return reject(new Error(`Peer rejected our token (HTTP ${res.statusCode})`));
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`Peer HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                    if (!data) return resolve(null);
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Peer returned non-JSON: ${err.message}`));
                    }
                });
            });
            req.on('error', (err) => reject(new Error(`Peer unreachable at ${parsed.origin}: ${err.message}`)));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error(`Peer timed out after ${REQUEST_TIMEOUT_MS}ms`));
            });
            if (serialised) req.write(serialised);
            req.end();
        });
    }

    // --- Pull / Push --------------------------------------------------------

    /** Fetch a peer's export and merge it, strictly within that peer's scopes. */
    async pull(peerId, { since = null, scopes = null } = {}) {
        const peer = this.peers.get(String(peerId || '').trim());
        if (!peer) throw new Error(`Unknown peer: ${peerId}`);

        const granted = scopes
            ? normaliseScopes(scopes).filter((s) => peer.scopes.includes(s))
            : peer.scopes.slice();
        if (!granted.length) {
            return {
                ok: true,
                peerId: peer.id,
                direction: 'pull',
                skipped: true,
                reason: 'No scopes are shared with this peer (nothing is shared by default)',
            };
        }

        const state = this._peerState(peer.id);
        const watermark = since === null || since === undefined
            ? (Number(state.watermark) || 0)
            : (Number(since) || 0);
        const query = `?scopes=${encodeURIComponent(granted.join(','))}`
            + `&since=${watermark}`
            + `&instance=${encodeURIComponent(this.selfId)}`;

        try {
            const payload = await this._request({
                method: 'GET',
                url: `${peer.url}/api/instance/export${query}`,
                token: peer.token,
            });
            const report = this.import(payload, { scopes: granted, peerId: peer.id });
            const now = Date.now();
            const nextWatermark = Number(payload && payload.exportedAt) || now;
            this._setPeerState(peer.id, { last_pull_at: now, watermark: nextWatermark, last_error: null });
            return { ok: true, peerId: peer.id, direction: 'pull', scopes: granted, report };
        } catch (err) {
            this._setPeerState(peer.id, { last_error: err.message });
            throw err;
        }
    }

    /** Send our export to a peer, strictly within that peer's scopes. */
    async push(peerId, { since = 0, scopes = null } = {}) {
        const peer = this.peers.get(String(peerId || '').trim());
        if (!peer) throw new Error(`Unknown peer: ${peerId}`);

        const granted = scopes
            ? normaliseScopes(scopes).filter((s) => peer.scopes.includes(s))
            : peer.scopes.slice();
        if (!granted.length) {
            return {
                ok: true,
                peerId: peer.id,
                direction: 'push',
                skipped: true,
                reason: 'No scopes are shared with this peer (nothing is shared by default)',
            };
        }

        const payload = this.export({ scopes: granted, since: Number(since) || 0 });
        try {
            const response = await this._request({
                method: 'POST',
                url: `${peer.url}/api/instance/import`,
                body: payload,
                token: peer.token,
            });
            this._setPeerState(peer.id, { last_push_at: Date.now(), last_error: null });
            return {
                ok: true,
                peerId: peer.id,
                direction: 'push',
                scopes: granted,
                counts: payload.counts,
                response,
            };
        } catch (err) {
            this._setPeerState(peer.id, { last_error: err.message });
            throw err;
        }
    }

    /**
     * Pull from every peer. One unreachable machine must not stop the others,
     * so each peer is isolated and its failure reported in its own row.
     */
    async syncAll({ direction = 'pull' } = {}) {
        const results = [];
        for (const peer of [...this.peers.values()]) {
            try {
                const result = direction === 'push' ? await this.push(peer.id) : await this.pull(peer.id);
                results.push(result);
            } catch (err) {
                console.warn(`[InstanceSync] Sync with ${peer.id} failed: ${err.message}`);
                results.push({ ok: false, peerId: peer.id, direction, error: err.message });
            }
        }
        const failed = results.filter((r) => !r.ok);
        return {
            ok: failed.length === 0,
            direction,
            total: results.length,
            succeeded: results.length - failed.length,
            failed: failed.length,
            results,
        };
    }
}

module.exports = InstanceSync;
module.exports.InstanceSync = InstanceSync;
module.exports.SCOPES = SCOPES;
module.exports.CONFIG_ALLOWLIST_KEYS = Object.freeze(Object.keys(CONFIG_ALLOWLIST));
module.exports.SKILL_EXTENSIONS = SKILL_EXTENSIONS;
module.exports.maskToken = maskToken;
module.exports.contentHash = contentHash;
