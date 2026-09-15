// =============================================================================
//  core/SwarmRoutes.js — Swarm HTTP Routes (delegation, council, skills, sync)
//
//  Mounted by MissionControl next to RouterRoutes. Four modules were already
//  wired into MissionControlServer but had no way in from the outside; this is
//  that layer. The UI, Telegram, WhatsApp and the Android app all reach the
//  swarm through these paths.
//
//  Routes:
//    GET/POST    /api/delegation/tasks            — list / create a hand-off
//    POST        /api/delegation/tasks/<id>/run   — execute a pending hand-off
//    DELETE      /api/delegation/tasks/<id>       — cancel a pending hand-off
//    GET         /api/delegation/pending?agent=   — an agent's inbox
//    POST        /api/council/deliberate          — multi-agent deliberation
//    POST        /api/council/standup             — round-robin standup
//    GET         /api/council/participants        — resolvable council members
//    GET/POST    /api/skills                      — list / save a skill
//    GET/DELETE  /api/skills/<name>               — fetch / delete one skill
//    GET         /api/skills/search?q=            — ranked search
//    POST        /api/skills/<name>/promote       — draft -> registry
//    GET         /api/skills/export               — portable snapshot
//    POST        /api/skills/import               — merge a snapshot
//    GET/POST    /api/instance/peers              — list / add a peer
//    PATCH       /api/instance/peers/<id>         — re-grant scopes
//    DELETE      /api/instance/peers/<id>         — forget a peer
//    POST        /api/instance/pull|push          — operator-driven sync
//    GET         /api/instance/status             — sync overview tile
//    GET         /api/instance/export      * peer-authenticated *
//    POST        /api/instance/import      * peer-authenticated *
//
//  Every collaborator (ctx.delegation, ctx.council, ctx.skills,
//  ctx.instanceSync) is OPTIONAL. An absent one is a 503 with a message that
//  names it — never a crash, and never a silent 404.
//
//  SECURITY — the peer-authenticated pair:
//    /api/instance/export and /api/instance/import are called by ANOTHER
//    INSTANCE, not by the dashboard. They are gated ONLY by that peer's own
//    token (peerForToken) or by the shared secret (verifySharedSecret), both
//    read from the X-Instance-Token / X-Instance-Secret headers that
//    InstanceSync._request() sends. The dashboard token is deliberately NOT
//    consulted and is never a fallback: accepting it would let anyone holding
//    a dashboard link pull another machine's whole memory vault. A failed
//    check is a flat 401.
//
//    The shared secret is a bootstrap credential, not an invitation.
//    An unknown X-Instance-Id is refused even when the secret is correct —
//    the caller must already be a registered peer, and they receive only
//    that peer's opt-in scopes.
// =============================================================================

const { SCOPES } = require('./InstanceSync');

/** Never 500 on a module that simply rejected the input. */
const BAD_REQUEST = 400;

/**
 * Run a collaborator call and turn a thrown error into a 400 carrying the real
 * message. A module method that throws is a rejected request, not a server
 * fault, and the operator needs the actual reason — so the message is passed
 * through verbatim rather than flattened to "Bad request".
 *
 * @returns {Promise<{ok: boolean, value?: any}>}
 */
async function attempt(ctx, res, fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        ctx._sendJson(res, BAD_REQUEST, { error: err && err.message ? err.message : String(err) });
        return { ok: false };
    }
}

/** 503 when a collaborator was never wired in. Returns true when it fired. */
function missing(ctx, res, collaborator, label) {
    if (collaborator) return false;
    ctx._sendJson(res, 503, { error: `${label} not configured` });
    return true;
}

/** Percent-decoded path segment; a malformed escape yields the raw text. */
function decodeSegment(raw) {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/** First non-empty trimmed string among the candidates, else ''. */
function firstString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
}

/** A comma string or an array, normalised to a string array. */
function toList(value) {
    if (Array.isArray(value)) {
        return value.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
    return [];
}

/** Best-effort audit row. A broken audit table must not fail the request. */
function audit(ctx, agentId, chatId, action, detail) {
    try {
        if (ctx.db && typeof ctx.db.logAudit === 'function') {
            ctx.db.logAudit(agentId, chatId, action, detail, false);
        }
    } catch (err) {
        console.warn('[SwarmRoutes] Audit log failed:', err.message);
    }
}

/**
 * Handle a delegation, council, skill-registry or instance-sync route.
 *
 * @param {object} ctx      MissionControlServer instance
 * @param {object} req      Node request
 * @param {object} res      Node response
 * @param {string} pathname Parsed pathname
 * @param {object} query    Parsed query params
 * @returns {Promise<boolean>} true when the request was handled
 */
async function handleSwarmRoutes(ctx, req, res, pathname, query) {
    // Cheap prefix gate so an unrelated path never walks the whole table and
    // never touches `res`.
    if (!pathname.startsWith('/api/delegation')
        && !pathname.startsWith('/api/council')
        && !pathname.startsWith('/api/skills')
        && !pathname.startsWith('/api/instance')) {
        return false;
    }

    const method = req.method || 'GET';
    const q = query || {};

    // =========================================================================
    //  Agent delegation — one agent handing work to another
    // =========================================================================

    if (pathname === '/api/delegation/tasks') {
        if (missing(ctx, res, ctx.delegation, 'Agent delegation')) return true;

        if (method === 'GET') {
            const got = await attempt(ctx, res, () => ctx.delegation.getTasks({
                chatId: q.chatId || null,
                agentId: q.agentId || q.agent || null,
                status: q.status || null,
                limit: Number(q.limit) || 50,
            }));
            if (got.ok) ctx._sendJson(res, 200, { tasks: got.value });
            return true;
        }

        if (method === 'POST') {
            const body = await ctx._readBody(req);
            const fromAgent = firstString(body.fromAgent, body.from);
            const toAgent = firstString(body.toAgent, body.to);
            const prompt = firstString(body.prompt, body.message, body.task);

            // Name exactly what is missing — a generic 400 sends the caller
            // guessing across three fields.
            const absent = [];
            if (!fromAgent) absent.push('fromAgent');
            if (!toAgent) absent.push('toAgent');
            if (!prompt) absent.push('prompt');
            if (absent.length) {
                ctx._sendJson(res, BAD_REQUEST, { error: `Missing required field(s): ${absent.join(', ')}` });
                return true;
            }

            const input = { fromAgent, toAgent, prompt, chatId: body.chatId || '' };
            const run = body.run === true || body.run === 'true';
            const got = await attempt(ctx, res, () => (run
                ? ctx.delegation.delegateAndRun(input)
                : ctx.delegation.delegate(input)));
            if (!got.ok) return true;

            audit(ctx, fromAgent, String(body.chatId || ''), 'delegation_created',
                `Delegated to ${toAgent}${run ? ' (immediate run)' : ''}`);
            ctx.broadcast('delegation.created', { fromAgent, toAgent, ran: run, task: got.value });
            ctx._sendJson(res, 200, { ok: true, ran: run, task: got.value });
            return true;
        }
    }

    // POST /api/delegation/tasks/<id>/run  and  DELETE /api/delegation/tasks/<id>
    if (pathname.startsWith('/api/delegation/tasks/')) {
        if (missing(ctx, res, ctx.delegation, 'Agent delegation')) return true;

        const tail = pathname.slice('/api/delegation/tasks/'.length);
        const isRun = tail.endsWith('/run');
        const id = decodeSegment(isRun ? tail.slice(0, -'/run'.length) : tail);

        if (!id) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): task id' });
            return true;
        }

        if (isRun && (method === 'POST' || method === 'PATCH')) {
            const got = await attempt(ctx, res, () => ctx.delegation.run(id));
            if (!got.ok) return true;
            audit(ctx, 'delegation', id, 'delegation_run', `Delegation ${id} executed`);
            ctx.broadcast('delegation.ran', { id, task: got.value });
            ctx._sendJson(res, 200, { ok: true, task: got.value });
            return true;
        }

        if (!isRun && method === 'DELETE') {
            const got = await attempt(ctx, res, () => ctx.delegation.cancel(id));
            if (!got.ok) return true;
            // cancel() returns null for an unknown or already-started task.
            if (!got.value) {
                ctx._sendJson(res, 404, { error: `No pending delegation to cancel: ${id}` });
                return true;
            }
            audit(ctx, 'delegation', id, 'delegation_cancelled', `Delegation ${id} cancelled`);
            ctx.broadcast('delegation.cancelled', { id, task: got.value });
            ctx._sendJson(res, 200, { ok: true, task: got.value });
            return true;
        }

        if (!isRun && method === 'GET') {
            const got = await attempt(ctx, res, () => ctx.delegation.getTask(id));
            if (!got.ok) return true;
            if (!got.value) {
                ctx._sendJson(res, 404, { error: `No such delegation: ${id}` });
                return true;
            }
            ctx._sendJson(res, 200, { task: got.value });
            return true;
        }
    }

    if (pathname === '/api/delegation/pending' && method === 'GET') {
        if (missing(ctx, res, ctx.delegation, 'Agent delegation')) return true;
        const agent = firstString(q.agent, q.agentKey, q.agentId) || null;
        const got = await attempt(ctx, res, () => ctx.delegation.pending(agent));
        if (got.ok) ctx._sendJson(res, 200, { agent, pending: got.value });
        return true;
    }

    if (pathname === '/api/delegation/agents' && method === 'GET') {
        if (missing(ctx, res, ctx.delegation, 'Agent delegation')) return true;
        const got = await attempt(ctx, res, () => ctx.delegation.agentKeys());
        if (got.ok) ctx._sendJson(res, 200, { agents: got.value });
        return true;
    }

    // =========================================================================
    //  Council — the whole swarm answering one question
    // =========================================================================

    if (pathname === '/api/council/deliberate' && method === 'POST') {
        if (missing(ctx, res, ctx.council, 'Council')) return true;
        const body = await ctx._readBody(req);
        const question = firstString(body.question, body.prompt, body.message);
        if (!question) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): question' });
            return true;
        }
        const participants = toList(body.participants);
        const got = await attempt(ctx, res, () => ctx.council.deliberate(question, {
            participants: participants.length ? participants : undefined,
            rounds: Number(body.rounds) > 0 ? Number(body.rounds) : undefined,
            concurrency: Number(body.concurrency) > 0 ? Number(body.concurrency) : undefined,
            timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
            chatId: body.chatId || undefined,
            // Stream each round to the dashboard instead of making the UI wait
            // for the synthesis.
            onProgress: (evt) => ctx.broadcast('council.progress', evt),
        }));
        if (!got.ok) return true;
        audit(ctx, 'council', String(body.chatId || ''), 'council_deliberate',
            `Deliberated: ${question.slice(0, 160)}`);
        ctx.broadcast('council.deliberated', {
            question,
            participants: got.value && got.value.participants,
        });
        ctx._sendJson(res, 200, got.value);
        return true;
    }

    if (pathname === '/api/council/standup' && method === 'POST') {
        if (missing(ctx, res, ctx.council, 'Council')) return true;
        const body = await ctx._readBody(req);
        const participants = toList(body.participants);
        const got = await attempt(ctx, res, () => ctx.council.standup({
            participants: participants.length ? participants : undefined,
            concurrency: Number(body.concurrency) > 0 ? Number(body.concurrency) : undefined,
            timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
            chatId: body.chatId || undefined,
            onProgress: (evt) => ctx.broadcast('council.progress', evt),
        }));
        if (!got.ok) return true;
        audit(ctx, 'council', String(body.chatId || ''), 'council_standup', 'Standup round collected');
        ctx.broadcast('council.standup', { participants: got.value && got.value.participants });
        ctx._sendJson(res, 200, got.value);
        return true;
    }

    if (pathname === '/api/council/participants' && method === 'GET') {
        if (missing(ctx, res, ctx.council, 'Council')) return true;
        const requested = toList(q.participants);
        const got = await attempt(ctx, res,
            () => ctx.council.resolveParticipants(requested.length ? requested : undefined));
        if (got.ok) ctx._sendJson(res, 200, { participants: got.value });
        return true;
    }

    // =========================================================================
    //  Skill registry
    // =========================================================================

    // Exact paths first: /api/skills/search and /api/skills/export|import must
    // not be mistaken for a skill NAMED "search".
    if (pathname === '/api/skills/search' && method === 'GET') {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;
        const queryText = typeof q.q === 'string' ? q.q : (typeof q.query === 'string' ? q.query : '');
        const got = await attempt(ctx, res, () => ctx.skills.search(queryText, {
            agentKey: q.agent || q.agentKey || undefined,
            tag: q.tag || undefined,
            limit: Number(q.limit) > 0 ? Number(q.limit) : undefined,
        }));
        if (got.ok) ctx._sendJson(res, 200, { query: queryText, results: got.value });
        return true;
    }

    if (pathname === '/api/skills/export' && method === 'GET') {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;
        const got = await attempt(ctx, res, () => ctx.skills.export({
            tags: q.tag || q.tags || undefined,
            agentKey: q.agent || q.agentKey || undefined,
            names: toList(q.names).length ? toList(q.names) : undefined,
        }));
        if (!got.ok) return true;
        ctx._sendJson(res, 200, { skills: got.value, count: (got.value || []).length });
        return true;
    }

    if (pathname === '/api/skills/import' && method === 'POST') {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;
        const body = await ctx._readBody(req);
        const incoming = Array.isArray(body) ? body : body.skills;
        if (!Array.isArray(incoming)) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): skills (array)' });
            return true;
        }
        const got = await attempt(ctx, res,
            () => ctx.skills.import(incoming, { overwrite: body.overwrite === true }));
        if (!got.ok) return true;
        audit(ctx, 'skills', 'import', 'skills_imported', `Imported ${incoming.length} skill(s)`);
        ctx.broadcast('skills.imported', { total: incoming.length });
        ctx._sendJson(res, 200, { ok: true, result: got.value });
        return true;
    }

    if (pathname === '/api/skills/drafts' && method === 'GET') {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;
        const got = await attempt(ctx, res, () => ctx.skills.listDrafts({
            agentKey: q.agent || q.agentKey || undefined,
            tag: q.tag || undefined,
        }));
        if (got.ok) ctx._sendJson(res, 200, { drafts: got.value });
        return true;
    }

    if (pathname === '/api/skills') {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;

        if (method === 'GET') {
            const got = await attempt(ctx, res, () => ctx.skills.list({
                agentKey: q.agent || q.agentKey || undefined,
                tag: q.tag || undefined,
            }));
            if (got.ok) ctx._sendJson(res, 200, { skills: got.value, stats: safeStats(ctx.skills) });
            return true;
        }

        if (method === 'POST') {
            const body = await ctx._readBody(req);
            const name = firstString(body.name);
            const hasBody = typeof body.body === 'string' && body.body.trim();
            const absent = [];
            if (!name) absent.push('name');
            if (!hasBody) absent.push('body');
            if (absent.length) {
                ctx._sendJson(res, BAD_REQUEST, { error: `Missing required field(s): ${absent.join(', ')}` });
                return true;
            }
            const got = await attempt(ctx, res, () => ctx.skills.save({
                name,
                description: body.description || '',
                body: body.body,
                tags: body.tags,
                agents: body.agents,
                source: body.source || 'dashboard',
            }));
            if (!got.ok) return true;
            audit(ctx, 'skills', name, 'skill_saved', `Skill ${name} saved`);
            ctx.broadcast('skills.saved', { name });
            ctx._sendJson(res, 200, { ok: true, skill: got.value });
            return true;
        }
    }

    // /api/skills/<name>  and  /api/skills/<name>/promote
    if (pathname.startsWith('/api/skills/')) {
        if (missing(ctx, res, ctx.skills, 'Skill registry')) return true;

        const tail = pathname.slice('/api/skills/'.length);
        const isPromote = tail.endsWith('/promote');
        // Skill names travel in the path, so "my skill" arrives as "my%20skill".
        const name = decodeSegment(isPromote ? tail.slice(0, -'/promote'.length) : tail);

        if (!name) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): skill name' });
            return true;
        }

        if (isPromote && method === 'POST') {
            const got = await attempt(ctx, res, () => ctx.skills.promote(name));
            if (!got.ok) return true;
            audit(ctx, 'skills', name, 'skill_promoted', `Draft ${name} promoted`);
            ctx.broadcast('skills.promoted', { name, result: got.value });
            ctx._sendJson(res, 200, { ok: true, result: got.value });
            return true;
        }

        if (!isPromote && method === 'GET') {
            const got = await attempt(ctx, res, () => ctx.skills.get(name));
            if (!got.ok) return true;
            if (!got.value) {
                ctx._sendJson(res, 404, { error: `No such skill: ${name}` });
                return true;
            }
            ctx._sendJson(res, 200, { skill: got.value });
            return true;
        }

        if (!isPromote && method === 'DELETE') {
            const got = await attempt(ctx, res, () => ctx.skills.remove(name));
            if (!got.ok) return true;
            if (!got.value) {
                ctx._sendJson(res, 404, { error: `No such skill: ${name}` });
                return true;
            }
            audit(ctx, 'skills', name, 'skill_removed', `Skill ${name} deleted`);
            ctx.broadcast('skills.removed', { name });
            ctx._sendJson(res, 200, { ok: true, name });
            return true;
        }
    }

    // =========================================================================
    //  Instance sync — PEER-AUTHENTICATED PAIR
    //
    //  These two are the wire between two machines. They are gated by the
    //  peer's own token or the shared secret ONLY; the dashboard token is
    //  never read here and never a fallback.
    // =========================================================================

    if (pathname === '/api/instance/export' && method === 'GET') {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;

        const caller = authenticatePeer(ctx, req);
        if (!caller) {
            audit(ctx, 'instance', 'export', 'instance_auth_failed',
                'Rejected /api/instance/export: peer token or shared secret did not verify');
            ctx._sendJson(res, 401, { error: 'Invalid peer token' });
            return true;
        }

        // A peer may never widen its own grant: what it asks for is intersected
        // with what this instance granted it. A missing grant (should not
        // happen — authenticatePeer refuses unknown devices) shares nothing.
        const asked = toList(q.scopes);
        const allowed = Array.isArray(caller.scopes)
            ? (asked.length ? asked.filter((s) => caller.scopes.includes(s)) : caller.scopes.slice())
            : [];

        const got = await attempt(ctx, res, () => ctx.instanceSync.export({
            scopes: allowed,
            since: Number(q.since) || 0,
        }));
        if (!got.ok) return true;
        audit(ctx, 'instance', caller.id, 'instance_exported',
            `Peer ${caller.id} pulled scopes [${allowed.join(', ') || 'none'}]`);
        ctx._sendJson(res, 200, got.value);
        return true;
    }

    if (pathname === '/api/instance/import' && method === 'POST') {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;

        const caller = authenticatePeer(ctx, req);
        if (!caller) {
            audit(ctx, 'instance', 'import', 'instance_auth_failed',
                'Rejected /api/instance/import: peer token or shared secret did not verify');
            ctx._sendJson(res, 401, { error: 'Invalid peer token' });
            return true;
        }

        // The payload is untrusted input from another machine: it is handed to
        // import() as data, scope-clamped to what this peer was granted, and
        // nothing from it is used to pick scopes or identity. Unknown devices
        // never reach here; a missing grant shares nothing.
        const body = await ctx._readBody(req);
        const claimed = toList(body && body.scopes);
        const allowed = Array.isArray(caller.scopes)
            ? claimed.filter((s) => caller.scopes.includes(s))
            : [];

        const got = await attempt(ctx, res,
            () => ctx.instanceSync.import(body, { scopes: allowed, peerId: caller.id }));
        if (!got.ok) return true;
        audit(ctx, 'instance', caller.id, 'instance_imported',
            `Peer ${caller.id} pushed scopes [${allowed.join(', ') || 'none'}]`);
        ctx.broadcast('instance.imported', { from: caller.id, scopes: allowed });
        ctx._sendJson(res, 200, { ok: true, report: got.value });
        return true;
    }

    // =========================================================================
    //  Instance sync — dashboard-token routes (the operator's own console)
    // =========================================================================

    if (pathname === '/api/instance/status' && method === 'GET') {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;
        const got = await attempt(ctx, res, () => ctx.instanceSync.status());
        if (got.ok) ctx._sendJson(res, 200, got.value);
        return true;
    }

    if (pathname === '/api/instance/peers') {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;

        if (method === 'GET') {
            // listPeers() already masks the token; the masked view is returned
            // verbatim so nothing here can undo that.
            const got = await attempt(ctx, res, () => ctx.instanceSync.listPeers());
            if (got.ok) ctx._sendJson(res, 200, { peers: got.value, scopes: SCOPES.slice() });
            return true;
        }

        if (method === 'POST') {
            const body = await ctx._readBody(req);
            const id = firstString(body.id, body.peerId);
            const url = firstString(body.url);
            const absent = [];
            if (!id) absent.push('id');
            if (!url) absent.push('url');
            if (absent.length) {
                ctx._sendJson(res, BAD_REQUEST, { error: `Missing required field(s): ${absent.join(', ')}` });
                return true;
            }
            const got = await attempt(ctx, res, () => ctx.instanceSync.addPeer({
                id,
                url,
                token: body.token,
                scopes: body.scopes,
                label: body.label,
            }));
            if (!got.ok) return true;
            // addPeer() returns the masked peer — the token supplied in the
            // body is never echoed back.
            audit(ctx, 'instance', id, 'peer_added', `Peer ${id} registered at ${url}`);
            ctx.broadcast('instance.peer_added', { id });
            ctx._sendJson(res, 200, { ok: true, peer: got.value, peers: ctx.instanceSync.listPeers() });
            return true;
        }
    }

    if (pathname.startsWith('/api/instance/peers/')) {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;

        // Peer ids can be hostnames with characters that need escaping.
        const id = decodeSegment(pathname.slice('/api/instance/peers/'.length));
        if (!id) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): peer id' });
            return true;
        }

        if (method === 'DELETE') {
            const got = await attempt(ctx, res, () => ctx.instanceSync.removePeer(id));
            if (!got.ok) return true;
            if (!got.value) {
                ctx._sendJson(res, 404, { error: `Unknown peer: ${id}` });
                return true;
            }
            audit(ctx, 'instance', id, 'peer_removed', `Peer ${id} forgotten`);
            ctx.broadcast('instance.peer_removed', { id });
            ctx._sendJson(res, 200, { ok: true, id, peers: ctx.instanceSync.listPeers() });
            return true;
        }

        if (method === 'PATCH' || method === 'POST') {
            const body = await ctx._readBody(req);
            if (body.scopes === undefined) {
                ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): scopes' });
                return true;
            }
            const got = await attempt(ctx, res, () => ctx.instanceSync.setPeerScopes(id, body.scopes));
            if (!got.ok) return true;
            audit(ctx, 'instance', id, 'peer_scopes_set',
                `Peer ${id} scopes set to [${toList(body.scopes).join(', ') || 'none'}]`);
            ctx.broadcast('instance.peer_updated', { id });
            ctx._sendJson(res, 200, { ok: true, peer: got.value });
            return true;
        }
    }

    if ((pathname === '/api/instance/pull' || pathname === '/api/instance/push') && method === 'POST') {
        if (missing(ctx, res, ctx.instanceSync, 'Instance sync')) return true;
        const direction = pathname.endsWith('pull') ? 'pull' : 'push';
        const body = await ctx._readBody(req);
        const peerId = firstString(body.peerId, body.id, body.peer, q.peerId, q.peer);
        if (!peerId) {
            ctx._sendJson(res, BAD_REQUEST, { error: 'Missing required field(s): peerId' });
            return true;
        }
        const opts = {};
        if (body.since !== undefined) opts.since = Number(body.since) || 0;
        if (body.scopes !== undefined) opts.scopes = body.scopes;

        const got = await attempt(ctx, res, () => ctx.instanceSync[direction](peerId, opts));
        if (!got.ok) return true;
        audit(ctx, 'instance', peerId, `instance_${direction}`, `Operator ran ${direction} with ${peerId}`);
        ctx.broadcast(`instance.${direction}`, { peerId, result: got.value });
        ctx._sendJson(res, 200, { ok: true, direction, result: got.value });
        return true;
    }

    return false;
}

/** stats() is a nice-to-have on the list response; never let it break one. */
function safeStats(skills) {
    try {
        return typeof skills.stats === 'function' ? skills.stats() : null;
    } catch (err) {
        console.warn('[SwarmRoutes] Skill stats failed:', err.message);
        return null;
    }
}

/**
 * Authenticate an INBOUND INSTANCE (not the dashboard).
 *
 * Only the peer-sync headers are consulted — X-Instance-Token (what
 * InstanceSync._request sends) and X-Instance-Secret. The dashboard's
 * Authorization header and ?token= are deliberately ignored, so a leaked
 * dashboard link can never be used to drain another machine's vault.
 *
 * The shared secret is a bootstrap *credential*, not a grant and not an
 * invitation: the caller must already be a registered peer, identified by
 * X-Instance-Id. An unknown device ID is refused even when the secret is
 * correct — the same rule Syncthing uses for pairing.
 *
 * @returns {{id: string, scopes: string[]}|null}
 *          A known peer (with its granted opt-in scopes), or null.
 */
function authenticatePeer(ctx, req) {
    const headers = (req && req.headers) || {};
    const presented = headers['x-instance-token'];
    const secret = headers['x-instance-secret'];
    const sync = ctx.instanceSync;

    if (typeof presented === 'string' && presented) {
        const peer = typeof sync.peerForToken === 'function' ? sync.peerForToken(presented) : null;
        if (peer) {
            return { id: String(peer.id || ''), scopes: Array.isArray(peer.scopes) ? peer.scopes.slice() : [] };
        }
    }

    // Bootstrap path, before either side has exchanged a per-peer token.
    // Constant-time check lives in InstanceSync; we still require a known id.
    let secretOk = false;
    for (const candidate of [secret, presented]) {
        if (typeof candidate === 'string' && candidate
            && typeof sync.verifySharedSecret === 'function'
            && sync.verifySharedSecret(candidate)) {
            secretOk = true;
            break;
        }
    }
    if (!secretOk) return null;

    const claimedId = headers['x-instance-id'];
    if (typeof claimedId !== 'string' || !claimedId.trim()) return null;
    const known = typeof sync.peerForId === 'function' ? sync.peerForId(claimedId) : null;
    if (!known) return null;
    return {
        id: String(known.id || claimedId),
        scopes: Array.isArray(known.scopes) ? known.scopes.slice() : [],
    };
}

module.exports = { handleSwarmRoutes, authenticatePeer };
