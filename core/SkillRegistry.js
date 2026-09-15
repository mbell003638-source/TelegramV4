// =============================================================================
//  core/SkillRegistry.js — Shareable Skill Registry (portable, agent-scoped)
//
//  A "skill" is a reusable procedure the system learned from experience or a
//  human wrote by hand, stored as ONE markdown file with YAML-ish frontmatter
//  under <baseDir>/skills/. This is the durable store that core/SelfImprovement
//  drafts graduate into: that module already writes candidates to
//  <baseDir>/skills/drafts/, and promote() lifts one of those drafts up into
//  the registry (bumping version when it replaces an existing skill).
//
//  Design notes:
//    * Layout follows the agentskills.io / Hermes Agent convention — one file
//      per skill, frontmatter carries routing metadata, the body IS the
//      procedure. No index file to drift out of sync; the directory is truth.
//    * The frontmatter parser is hand-rolled (Node builtins only, no YAML
//      dependency) and deliberately forgiving. Anything it cannot understand
//      degrades to "body-only, name derived from the filename". It NEVER
//      throws — a corrupt skill file must not take the bot down.
//    * `name` becomes a filename, so it is this module's one real attack
//      surface. Two independent gates must both pass before any write or
//      delete: a strict [a-z0-9-] allowlist, AND a re-check that the resolved
//      absolute path still lives directly inside the intended directory.
//      Neither gate is trusted on its own.
//    * export()/import() are the portable form for syncing between machines.
//      import() is idempotent and version-aware: re-importing the same payload
//      is a no-op, and a newer local copy is never clobbered unless the caller
//      explicitly passes { overwrite: true }. Every skip is reported with a
//      reason so the caller can show the user what did not land.
// =============================================================================
const fs = require('fs');
const path = require('path');

const SKILL_EXT = '.md';

// A name must start alphanumeric and contain only [a-z0-9-]. This single
// pattern is what rejects `..`, `/`, `\`, `:`, NUL, leading dots and leading
// dashes — the containment check below is the independent second gate.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;

// Win32 treats these as device names regardless of extension, so `nul.md`
// would silently swallow a write. Refuse them everywhere, on every platform,
// so a registry stays portable between machines.
const RESERVED_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const VALID_SOURCES = new Set(['learned', 'manual', 'imported']);

// renderForPrompt budget. ~8000 chars is roughly 2k tokens — enough for a
// handful of procedures without evicting the actual conversation.
const DEFAULT_PROMPT_BUDGET = 8000;
const MIN_PROMPT_BUDGET = 200;
const PROMPT_HEADER = '# Available Skills\n\n';
const MARKER_RESERVE = 160;      // headroom kept free for the truncation marker
const MIN_BLOCK_CHARS = 160;     // below this a partial skill block is useless
const BODY_MARKER = '\n[... skill body truncated ...]';

class SkillRegistry {
    /**
     * @param {object}  opts
     * @param {string}  opts.baseDir   project root; skills live in <baseDir>/skills
     * @param {object} [opts.database] retained for callers that want to index
     *                                 skills elsewhere; never required.
     */
    constructor({ baseDir, database } = {}) {
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        this.skillsDir = path.join(this.baseDir, 'skills');
        this.draftsDir = path.join(this.skillsDir, 'drafts');
        this.database = database || null;
        this._warnedFiles = new Set();

        this._ensureDirs();
    }

    _ensureDirs() {
        try {
            // Creating drafts/ recursively creates skills/ too — same shape
            // core/SelfImprovement.js expects.
            if (!fs.existsSync(this.draftsDir)) {
                fs.mkdirSync(this.draftsDir, { recursive: true });
            }
        } catch (err) {
            console.warn(`[SkillRegistry] Failed to create skills directory: ${err.message}`);
        }
    }

    // =========================================================================
    //  NAME SAFETY — the whole module's security posture lives here
    // =========================================================================

    /**
     * Normalise and validate a skill name. Returns null for anything that is
     * not a plain [a-z0-9-] slug: traversal (`../../etc/passwd`), absolute
     * paths (`/etc/passwd`, `C:\x`), separators of either flavour, dotfiles,
     * NUL bytes and Win32 device names are all rejected outright rather than
     * "cleaned", because silently rewriting a hostile name into a valid one
     * hides the attempt from the caller.
     */
    sanitizeName(raw) {
        try {
            const name = String(raw == null ? '' : raw).trim().toLowerCase();
            if (!name || name.length > MAX_NAME_LENGTH) return null;
            if (name.includes('\0')) return null;
            if (name.includes('/') || name.includes('\\')) return null;
            if (name.includes('..') || name.startsWith('.')) return null;
            if (!NAME_PATTERN.test(name)) return null;
            if (RESERVED_NAMES.has(name)) return null;
            return name;
        } catch (err) {
            return null;
        }
    }

    /**
     * Second, independent gate: resolve the file path and prove it is a direct
     * child of `dir`. Even if sanitizeName() were ever weakened, nothing
     * outside the skills tree can be written or deleted.
     * @returns {string|null} absolute path, or null when unsafe
     */
    _safePath(dir, name) {
        const safe = this.sanitizeName(name);
        if (!safe) return null;
        try {
            const root = path.resolve(dir);
            const target = path.resolve(root, `${safe}${SKILL_EXT}`);
            const prefix = root.endsWith(path.sep) ? root : root + path.sep;
            if (!target.startsWith(prefix)) return null;       // escaped the root
            if (path.dirname(target) !== root) return null;     // not a direct child
            if (path.basename(target) !== `${safe}${SKILL_EXT}`) return null;
            return target;
        } catch (err) {
            console.warn(`[SkillRegistry] Path resolution failed for ${JSON.stringify(String(name))}: ${err.message}`);
            return null;
        }
    }

    /** True when `name` is usable as a skill filename. */
    isValidName(name) {
        return this.sanitizeName(name) !== null;
    }

    // =========================================================================
    //  FRONTMATTER — hand-rolled, forgiving, never throws
    // =========================================================================

    /**
     * Split a skill file into metadata + body.
     *
     *   ---
     *   name: deploy-vps
     *   description: One-line summary used to decide relevance
     *   tags: [deploy, ops]
     *   agents: [claude, codex]
     *   version: 1
     *   source: learned
     *   ---
     *   <the procedure body>
     *
     * Tolerated: absent frontmatter, an unclosed `---` fence, `#` comments,
     * `key:` followed by `- item` block lists, quoted scalars, and junk lines.
     * Any of those degrade to body-only rather than raising.
     */
    _parseFrontmatter(raw) {
        const out = { meta: {}, body: '', malformed: false };
        try {
            const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
            out.body = text;
            const lines = text.split(/\r?\n/);
            if (!lines.length || lines[0].trim() !== '---') {
                // Plain markdown with no frontmatter is legitimate, not broken.
                return out;
            }

            let fence = -1;
            for (let i = 1; i < lines.length; i += 1) {
                const t = lines[i].trim();
                if (t === '---' || t === '...') { fence = i; break; }
            }
            if (fence === -1) {
                // Opened a fence it never closed — treat the whole file as body.
                out.malformed = true;
                return out;
            }

            const head = lines.slice(1, fence);
            out.body = lines.slice(fence + 1).join('\n');

            let bad = 0;
            for (let i = 0; i < head.length; i += 1) {
                const trimmed = head[i].trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                if (trimmed.startsWith('-')) { bad += 1; continue; }   // orphan list item
                const idx = trimmed.indexOf(':');
                if (idx <= 0) { bad += 1; continue; }
                const key = trimmed.slice(0, idx).trim().toLowerCase();
                const value = trimmed.slice(idx + 1).trim();
                if (!key) { bad += 1; continue; }

                if (!value) {
                    const items = [];
                    while (i + 1 < head.length && /^\s*-\s*\S/.test(head[i + 1])) {
                        items.push(head[i + 1].replace(/^\s*-\s*/, '').trim());
                        i += 1;
                    }
                    if (items.length) { out.meta[key] = items; continue; }
                }
                out.meta[key] = value;
            }
            if (bad > 0) out.malformed = true;
            return out;
        } catch (err) {
            console.warn(`[SkillRegistry] Frontmatter parse failed, falling back to body-only: ${err.message}`);
            out.meta = {};
            out.malformed = true;
            return out;
        }
    }

    /** Serialise a shaped skill back into the on-disk markdown form. */
    _serialize(skill) {
        const lines = ['---'];
        lines.push(`name: ${skill.name}`);
        if (skill.description) lines.push(`description: ${skill.description}`);
        lines.push(`tags: [${skill.tags.join(', ')}]`);
        lines.push(`agents: [${skill.agents.join(', ')}]`);
        lines.push(`version: ${skill.version}`);
        lines.push(`source: ${skill.source}`);
        lines.push(`updated: ${skill.updated}`);
        lines.push('---');
        const body = String(skill.body || '').replace(/\s+$/, '');
        return `${lines.join('\n')}\n${body}\n`;
    }

    /** Coerce raw parsed metadata + body into the canonical skill object. */
    _shape({ meta = {}, body = '', malformed = false, fallbackName, file }) {
        const name = this.sanitizeName(meta.name) || this.sanitizeName(fallbackName) || '';
        const text = String(body == null ? '' : body).replace(/^\n+/, '').replace(/\s+$/, '');
        return {
            name,
            description: this._oneLine(meta.description),
            tags: this._tokens(meta.tags),
            agents: this._tokens(meta.agents),
            version: this._version(meta.version),
            source: this._source(meta.source),
            updated: this._num(meta.updated, 0),
            body: text,
            malformed: Boolean(malformed) || !this.sanitizeName(meta.name),
            file: file || null,
            bytes: text.length,
        };
    }

    // =========================================================================
    //  READ
    // =========================================================================

    /** Load one skill by name. Returns null when absent or the name is unsafe. */
    get(name) {
        const file = this._safePath(this.skillsDir, name);
        if (!file) return null;
        return this._read(file);
    }

    /** Load one draft by name (from skills/drafts). */
    getDraft(name) {
        const file = this._safePath(this.draftsDir, name);
        if (!file) return null;
        return this._read(file);
    }

    _read(file) {
        try {
            if (!fs.existsSync(file)) return null;
            const raw = fs.readFileSync(file, 'utf8');
            const parsed = this._parseFrontmatter(raw);
            const fallbackName = path.basename(file, SKILL_EXT);
            const shaped = this._shape({ ...parsed, fallbackName, file });
            return shaped.name ? shaped : null;
        } catch (err) {
            console.warn(`[SkillRegistry] Failed to read ${file}: ${err.message}`);
            return null;
        }
    }

    /**
     * All registry skills, optionally narrowed.
     * @param {string} [opts.agentKey] keep skills with no `agents` restriction
     *                                 or whose list contains this agent.
     * @param {string} [opts.tag]      keep skills carrying this tag.
     */
    list({ agentKey, tag } = {}) {
        return this._listDir(this.skillsDir, { agentKey, tag });
    }

    /** Ungraduated candidates sitting in skills/drafts. */
    listDrafts({ agentKey, tag } = {}) {
        return this._listDir(this.draftsDir, { agentKey, tag });
    }

    _listDir(dir, { agentKey, tag } = {}) {
        const out = [];
        try {
            if (!fs.existsSync(dir)) return out;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                // drafts/ is a directory inside skills/ — skipped for free here.
                if (!entry.isFile()) continue;
                if (!entry.name.toLowerCase().endsWith(SKILL_EXT)) continue;
                const base = path.basename(entry.name, path.extname(entry.name));
                if (!this.sanitizeName(base)) {
                    this._warnOnce(path.join(dir, entry.name), 'filename is not a [a-z0-9-] slug');
                    continue;
                }
                const skill = this._read(path.join(dir, entry.name));
                if (!skill) continue;
                if (!this._matchesAgent(skill, agentKey)) continue;
                if (!this._matchesTag(skill, tag)) continue;
                out.push(skill);
            }
        } catch (err) {
            console.warn(`[SkillRegistry] Failed to list ${dir}: ${err.message}`);
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    /** An empty/absent `agents` list means "available to every agent". */
    _matchesAgent(skill, agentKey) {
        if (!agentKey) return true;
        if (!skill.agents || skill.agents.length === 0) return true;
        return skill.agents.includes(String(agentKey).trim().toLowerCase());
    }

    _matchesTag(skill, tag) {
        if (!tag) return true;
        const wanted = Array.isArray(tag) ? tag : [tag];
        const norm = wanted.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
        if (!norm.length) return true;
        return norm.some((t) => skill.tags.includes(t));
    }

    // =========================================================================
    //  WRITE
    // =========================================================================

    /**
     * Create or replace a skill. Throws on an unsafe name — a rejected write is
     * a security event and must be loud, not a silent no-op.
     * @returns {object} the stored skill
     */
    save({ name, description, body, tags, agents, source, version, updated } = {}) {
        return this._write(this.skillsDir, { name, description, body, tags, agents, source, version, updated });
    }

    /** Same contract as save(), but lands in skills/drafts awaiting promote(). */
    saveDraft({ name, description, body, tags, agents, source, version, updated } = {}) {
        return this._write(this.draftsDir, {
            name, description, body, tags, agents,
            source: source || 'learned',
            version, updated,
        });
    }

    _write(dir, input) {
        const safe = this.sanitizeName(input && input.name);
        if (!safe) {
            throw new Error(`[SkillRegistry] Invalid skill name: ${JSON.stringify(String(input && input.name))}`);
        }
        const file = this._safePath(dir, safe);
        if (!file) {
            throw new Error(`[SkillRegistry] Refusing to write outside the skills directory: ${JSON.stringify(safe)}`);
        }

        const skill = this._shape({
            meta: {
                name: safe,
                description: input.description,
                tags: input.tags,
                agents: input.agents,
                version: input.version,
                source: input.source,
                updated: this._num(input.updated, 0) || Date.now(),
            },
            body: input.body,
            fallbackName: safe,
            file,
        });
        skill.malformed = false;

        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, this._serialize(skill), 'utf8');
        } catch (err) {
            console.warn(`[SkillRegistry] Failed to write ${file}: ${err.message}`);
            throw err;
        }
        return skill;
    }

    /** Delete a skill. Unsafe names return false instead of touching the disk. */
    remove(name) {
        return this._unlink(this.skillsDir, name);
    }

    /** Delete a draft. */
    removeDraft(name) {
        return this._unlink(this.draftsDir, name);
    }

    _unlink(dir, name) {
        const file = this._safePath(dir, name);
        if (!file) {
            console.warn(`[SkillRegistry] Refusing to delete unsafe skill name: ${JSON.stringify(String(name))}`);
            return false;
        }
        try {
            if (!fs.existsSync(file)) return false;
            fs.unlinkSync(file);
            return true;
        } catch (err) {
            console.warn(`[SkillRegistry] Failed to delete ${file}: ${err.message}`);
            return false;
        }
    }

    // =========================================================================
    //  SEARCH
    // =========================================================================

    /**
     * Rank skills against a free-text query. Name beats tag beats description
     * beats body, so "deploy" finds the skill CALLED deploy-vps ahead of one
     * that merely mentions deploying. Case-insensitive; deterministic ties.
     * @returns {Array<object>} matches with a `score`, best first
     */
    search(query, { agentKey, tag, limit = 20 } = {}) {
        const terms = this._terms(query);
        const slug = this.sanitizeName(String(query == null ? '' : query).trim().replace(/\s+/g, '-'));
        if (!terms.length) return [];

        const scored = [];
        try {
            for (const skill of this.list({ agentKey, tag })) {
                const name = skill.name;
                const description = skill.description.toLowerCase();
                const body = skill.body.toLowerCase();
                const segments = name.split('-');
                let score = 0;
                let matched = 0;

                if (slug && slug === name) score += 100;

                for (const term of terms) {
                    let hit = 0;
                    if (name.includes(term)) hit += 20;
                    if (segments.includes(term)) hit += 10;
                    for (const t of skill.tags) {
                        if (t === term) hit += 15;
                        else if (t.includes(term)) hit += 6;
                    }
                    if (description.includes(term)) {
                        hit += 8;
                        if (new RegExp(`(^|\\W)${this._escapeRegex(term)}(\\W|$)`).test(description)) hit += 3;
                    }
                    const inBody = Math.min(this._countOccurrences(body, term), 5);
                    if (inBody) hit += inBody * 1.5;
                    if (skill.agents.includes(term)) hit += 2;
                    if (hit > 0) matched += 1;
                    score += hit;
                }

                if (!matched) continue;
                score *= 1 + matched / terms.length;                 // coverage bonus
                scored.push({ ...skill, score: Math.round(score * 100) / 100, matched });
            }
        } catch (err) {
            console.warn(`[SkillRegistry] search failed: ${err.message}`);
            return [];
        }

        scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
        const cap = this._num(limit, 20);
        return cap > 0 ? scored.slice(0, cap) : scored;
    }

    // =========================================================================
    //  PROMOTION — where SelfImprovement drafts graduate
    // =========================================================================

    /**
     * Move skills/drafts/<name>.md into the registry. When a skill of that name
     * already exists its version is bumped past the incumbent, so a promotion
     * always reads as newer to every other machine's import().
     * @returns {object} { promoted, name, version, previousVersion, reason }
     */
    promote(draftName) {
        const result = { promoted: false, name: null, version: 0, previousVersion: 0, reason: null };
        const safe = this.sanitizeName(draftName);
        if (!safe) {
            result.reason = 'invalid-name';
            console.warn(`[SkillRegistry] Refusing to promote unsafe draft name: ${JSON.stringify(String(draftName))}`);
            return result;
        }
        result.name = safe;

        const draftFile = this._safePath(this.draftsDir, safe);
        if (!draftFile || !fs.existsSync(draftFile)) {
            result.reason = 'draft-not-found';
            return result;
        }

        try {
            const draft = this._read(draftFile);
            if (!draft) {
                result.reason = 'draft-unreadable';
                return result;
            }
            const existing = this.get(safe);
            result.previousVersion = existing ? existing.version : 0;
            const version = existing
                ? Math.max(existing.version, draft.version) + 1
                : Math.max(1, draft.version);

            const saved = this.save({
                name: safe,
                description: draft.description,
                body: draft.body,
                tags: draft.tags,
                agents: draft.agents,
                source: draft.source === 'imported' ? 'imported' : 'learned',
                version,
                updated: Date.now(),
            });

            // Only drop the draft once the registry copy is safely on disk.
            try {
                fs.unlinkSync(draftFile);
            } catch (err) {
                console.warn(`[SkillRegistry] Promoted ${safe} but failed to remove the draft: ${err.message}`);
            }

            result.promoted = true;
            result.version = saved.version;
            return result;
        } catch (err) {
            console.warn(`[SkillRegistry] promote(${safe}) failed: ${err.message}`);
            result.reason = err.message;
            return result;
        }
    }

    // =========================================================================
    //  PORTABILITY — the form that travels between machines
    // =========================================================================

    /**
     * Plain-object snapshot suitable for JSON transport. Deliberately drops
     * machine-local fields (absolute path, byte count, malformed flag) so the
     * payload is identical on both ends of a sync.
     */
    export({ tags, agentKey, names } = {}) {
        let skills;
        if (Array.isArray(names) && names.length) {
            skills = names.map((n) => this.get(n)).filter(Boolean);
        } else {
            skills = this.list({ agentKey, tag: tags });
        }
        return skills.map((s) => ({
            name: s.name,
            description: s.description,
            tags: [...s.tags],
            agents: [...s.agents],
            version: s.version,
            source: s.source,
            updated: s.updated,
            body: s.body,
        }));
    }

    /**
     * Merge an exported payload into this registry.
     *
     * Idempotent: re-importing an unchanged payload writes nothing. Version
     * aware: a strictly newer incoming skill wins, an identical one is a no-op,
     * and anything that would move the local copy BACKWARDS is skipped with a
     * reason unless `overwrite` is set.
     *
     * @returns {object} { imported, updated, skipped: [{name, reason, ...}], errors, total }
     */
    import(skills, { overwrite = false } = {}) {
        const result = { imported: [], updated: [], skipped: [], errors: [], total: 0 };
        const incoming = Array.isArray(skills) ? skills : (skills ? [skills] : []);
        result.total = incoming.length;

        for (const raw of incoming) {
            let name = null;
            try {
                name = this.sanitizeName(raw && raw.name);
                if (!name) {
                    result.skipped.push({
                        name: String((raw && raw.name) || ''),
                        reason: 'invalid-name',
                        detail: 'name must match [a-z0-9-] and stay inside the skills directory',
                    });
                    continue;
                }

                const candidate = this._shape({
                    meta: {
                        name,
                        description: raw.description,
                        tags: raw.tags,
                        agents: raw.agents,
                        version: raw.version,
                        source: raw.source || 'imported',
                        updated: raw.updated,
                    },
                    body: raw.body,
                    fallbackName: name,
                });

                const local = this.get(name);
                if (local && !overwrite) {
                    if (this._sameSkill(local, candidate)) {
                        result.skipped.push({
                            name,
                            reason: 'identical',
                            detail: `local v${local.version} already matches the incoming copy`,
                            localVersion: local.version,
                            incomingVersion: candidate.version,
                        });
                        continue;
                    }
                    if (candidate.version < local.version) {
                        result.skipped.push({
                            name,
                            reason: 'local-newer',
                            detail: `local v${local.version} is newer than incoming v${candidate.version}; pass overwrite:true to force`,
                            localVersion: local.version,
                            incomingVersion: candidate.version,
                        });
                        continue;
                    }
                    if (candidate.version === local.version) {
                        result.skipped.push({
                            name,
                            reason: 'same-version-differs',
                            detail: `local and incoming are both v${local.version} but differ; pass overwrite:true to force`,
                            localVersion: local.version,
                            incomingVersion: candidate.version,
                        });
                        continue;
                    }
                }

                this.save({
                    name,
                    description: candidate.description,
                    body: candidate.body,
                    tags: candidate.tags,
                    agents: candidate.agents,
                    source: candidate.source,
                    version: candidate.version,
                    updated: candidate.updated || Date.now(),
                });
                if (local) result.updated.push(name);
                else result.imported.push(name);
            } catch (err) {
                console.warn(`[SkillRegistry] import of ${JSON.stringify(String(name || ''))} failed: ${err.message}`);
                result.errors.push({ name: String(name || (raw && raw.name) || ''), error: err.message });
            }
        }
        return result;
    }

    /** Content equality, ignoring machine-local fields and the timestamp. */
    _sameSkill(a, b) {
        return a.version === b.version
            && a.description === b.description
            && a.source === b.source
            && a.body === b.body
            && a.tags.join(',') === b.tags.join(',')
            && a.agents.join(',') === b.agents.join(',');
    }

    // =========================================================================
    //  PROMPT INJECTION
    // =========================================================================

    /**
     * Concatenate selected skills into a block for an agent prompt.
     *
     *   renderForPrompt(['deploy-vps', 'rotate-keys'])
     *   renderForPrompt({ agentKey: 'claude', tag: 'ops', budget: 4000 })
     *
     * The character budget is a hard ceiling — the returned string is never
     * longer than it, and any omission is marked in-band so the model can see
     * that it is looking at a partial list rather than the whole registry.
     * @returns {string} '' when nothing is selected
     */
    renderForPrompt(selector = {}, options = {}) {
        let opts = options && typeof options === 'object' ? { ...options } : {};
        let skills = [];
        try {
            if (Array.isArray(selector)) {
                skills = selector.map((n) => this.get(n)).filter(Boolean);
            } else if (typeof selector === 'string') {
                const one = this.get(selector);
                skills = one ? [one] : [];
            } else if (selector && typeof selector === 'object') {
                opts = { ...selector, ...opts };
                if (Array.isArray(opts.names)) {
                    skills = opts.names.map((n) => this.get(n)).filter(Boolean);
                } else {
                    skills = this.list({ agentKey: opts.agentKey, tag: opts.tag });
                }
            }
        } catch (err) {
            console.warn(`[SkillRegistry] renderForPrompt selection failed: ${err.message}`);
            return '';
        }
        if (!skills.length) return '';

        const requested = opts.budget != null ? opts.budget : opts.maxChars;
        const budget = Math.max(MIN_PROMPT_BUDGET, this._num(requested, DEFAULT_PROMPT_BUDGET));

        const blocks = [];
        let used = PROMPT_HEADER.length;
        let omitted = 0;
        let truncated = false;

        for (let i = 0; i < skills.length; i += 1) {
            const room = budget - used - MARKER_RESERVE;
            const block = this._renderBlock(skills[i]);
            if (block.length <= room) {
                blocks.push(block);
                used += block.length;
                continue;
            }
            // Does not fit whole. Include a body-truncated version if there is
            // enough room left for it to still carry information.
            const partial = room >= MIN_BLOCK_CHARS ? this._renderBlock(skills[i], room) : null;
            if (partial) {
                blocks.push(partial);
                used += partial.length;
                omitted = skills.length - (i + 1);
            } else {
                omitted = skills.length - i;
            }
            truncated = true;
            break;
        }

        let out = PROMPT_HEADER + blocks.join('');
        if (truncated) {
            out += omitted > 0
                ? `\n[... skill list truncated: ${omitted} of ${skills.length} skill(s) omitted to stay within the ${budget}-character budget ...]\n`
                : `\n[... skill content truncated to stay within the ${budget}-character budget ...]\n`;
        }
        // Belt and braces: the ceiling holds even if a marker ran long.
        if (out.length > budget) out = out.slice(0, budget);
        return out;
    }

    /**
     * One skill as a prompt block. With `maxChars` the body is clipped so the
     * whole block fits; returns null when even the heading would not fit.
     */
    _renderBlock(skill, maxChars = 0) {
        let head = `## ${skill.name}`;
        if (skill.version > 1) head += ` (v${skill.version})`;
        head += '\n';
        if (skill.description) head += `${skill.description}\n`;
        if (skill.tags.length) head += `tags: ${skill.tags.join(', ')}\n`;

        let body = String(skill.body || '').trim();
        if (maxChars > 0) {
            const overhead = head.length + BODY_MARKER.length + 3;   // '\n' + body + '\n\n'
            if (overhead >= maxChars) return null;
            const room = maxChars - overhead;
            if (body.length > room) body = `${body.slice(0, room)}${BODY_MARKER}`;
        }
        return `${head}\n${body}\n\n`;
    }

    // =========================================================================
    //  STATS
    // =========================================================================

    /** Registry shape: totals, tag histogram and per-agent reach. */
    stats() {
        const out = {
            count: 0,
            drafts: 0,
            shared: 0,          // skills with no `agents` restriction
            bytes: 0,
            tags: {},
            agents: {},
            sources: {},
            malformed: 0,
            skillsDir: this.skillsDir,
            draftsDir: this.draftsDir,
        };
        try {
            const skills = this.list();
            out.count = skills.length;
            for (const skill of skills) {
                out.bytes += skill.bytes;
                if (skill.malformed) out.malformed += 1;
                out.sources[skill.source] = (out.sources[skill.source] || 0) + 1;
                for (const tag of skill.tags) out.tags[tag] = (out.tags[tag] || 0) + 1;
                if (!skill.agents.length) out.shared += 1;
                for (const agent of skill.agents) out.agents[agent] = (out.agents[agent] || 0) + 1;
            }
            out.drafts = this.listDrafts().length;
        } catch (err) {
            console.warn(`[SkillRegistry] stats failed: ${err.message}`);
        }
        return out;
    }

    // =========================================================================
    //  HELPERS
    // =========================================================================

    /** Frontmatter descriptions are single-line by contract. */
    _oneLine(value) {
        if (value == null) return '';
        const text = Array.isArray(value) ? value.join(' ') : String(value);
        return this._unquote(text).replace(/\s+/g, ' ').trim();
    }

    /**
     * Normalise `tags` / `agents` from any of: array, `[a, b]`, `a, b`, `a`.
     * Tokens are lowercased and reduced to [a-z0-9._-] so serialising them back
     * into a `[...]` list can never break the format.
     */
    _tokens(value) {
        let parts = [];
        try {
            if (value == null) return [];
            if (Array.isArray(value)) {
                parts = value.map((v) => String(v));
            } else {
                let text = this._unquote(String(value)).trim();
                if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
                parts = text.split(',');
            }
            const seen = new Set();
            const out = [];
            for (const part of parts) {
                const token = this._unquote(String(part))
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9._-]+/g, '-')
                    .replace(/^-+|-+$/g, '');
                if (!token || seen.has(token)) continue;
                seen.add(token);
                out.push(token);
            }
            return out;
        } catch (err) {
            return [];
        }
    }

    _unquote(value) {
        const text = String(value == null ? '' : value).trim();
        if (text.length >= 2) {
            const first = text[0];
            const last = text[text.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                return text.slice(1, -1);
            }
        }
        return text;
    }

    _version(value) {
        const n = Math.floor(this._num(value, 1));
        return n >= 1 ? n : 1;
    }

    _source(value) {
        const text = this._unquote(String(value == null ? '' : value)).trim().toLowerCase();
        return VALID_SOURCES.has(text) ? text : 'manual';
    }

    _terms(query) {
        return String(query == null ? '' : query)
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .map((t) => t.trim())
            .filter(Boolean);
    }

    _num(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    _escapeRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _countOccurrences(haystack, needle) {
        if (!needle) return 0;
        let count = 0;
        let idx = haystack.indexOf(needle);
        while (idx !== -1) {
            count += 1;
            idx = haystack.indexOf(needle, idx + needle.length);
        }
        return count;
    }

    _warnOnce(key, message) {
        if (this._warnedFiles.has(key)) return;
        this._warnedFiles.add(key);
        console.warn(`[SkillRegistry] Ignoring ${key}: ${message}`);
    }
}

module.exports = SkillRegistry;
module.exports.SkillRegistry = SkillRegistry;
