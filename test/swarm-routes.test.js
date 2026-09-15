// =============================================================================
//  test/swarm-routes.test.js — HTTP surface for delegation, council, skills
//  and instance sync.
//
//  Hermetic by construction: no server is booted, no socket is opened and the
//  real store/ directory is never touched. The four collaborators are recording
//  fakes, so every assertion is about the ROUTE layer — which method it calls,
//  with which arguments, and which status code comes back.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleSwarmRoutes } = require('../core/SwarmRoutes');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const PEER_TOKEN = 'peer-token-abcdefghijklmnop';
const DASH_TOKEN = 'dashboard-token-zyxwvutsrq';
const SHARED_SECRET = 'shared-secret-0123456789';

/** Records every call as [method, ...args] so argument shape is assertable. */
function recorder(impl = {}) {
    const calls = [];
    const fake = { calls };
    for (const [name, fn] of Object.entries(impl)) {
        fake[name] = (...args) => {
            calls.push([name, ...args]);
            return typeof fn === 'function' ? fn(...args) : fn;
        };
    }
    /** Last recorded call to `name`, or undefined. */
    fake.lastCall = (name) => [...calls].reverse().find((c) => c[0] === name);
    return fake;
}

function makeDelegation(overrides = {}) {
    return recorder({
        getTasks: () => [{ id: 't1' }],
        delegate: () => ({ id: 't1', status: 'pending' }),
        delegateAndRun: async () => ({ id: 't1', status: 'completed' }),
        run: async () => ({ id: 't1', status: 'completed' }),
        getTask: () => ({ id: 't1' }),
        cancel: () => ({ id: 't1', status: 'cancelled' }),
        pending: () => [{ id: 't1' }],
        agentKeys: () => ['codex', 'grok'],
        ...overrides,
    });
}

function makeCouncil(overrides = {}) {
    return recorder({
        deliberate: async () => ({ ok: true, participants: ['codex', 'grok'], synthesis: 'yes' }),
        standup: async () => ({ ok: true, participants: ['codex'], reports: [] }),
        resolveParticipants: () => ['codex', 'grok'],
        ...overrides,
    });
}

function makeSkills(overrides = {}) {
    return recorder({
        list: () => [{ name: 'deploy-vps' }],
        listDrafts: () => [{ name: 'draft-one' }],
        get: () => ({ name: 'deploy-vps', body: 'do it' }),
        save: () => ({ name: 'deploy-vps' }),
        remove: () => true,
        search: () => [{ name: 'deploy-vps', score: 9 }],
        promote: () => ({ promoted: true, name: 'deploy-vps' }),
        export: () => [{ name: 'deploy-vps' }],
        import: () => ({ imported: ['deploy-vps'], updated: [], skipped: [], errors: [], total: 1 }),
        stats: () => ({ count: 1 }),
        ...overrides,
    });
}

/**
 * InstanceSync fake. listPeers() masks its token exactly as the real module
 * does, so a leak in the route layer is what the token assertions catch.
 */
function makeInstanceSync(overrides = {}) {
    return recorder({
        status: () => ({ selfId: 'local', peerCount: 1, peers: [maskedPeer()] }),
        listPeers: () => [maskedPeer()],
        addPeer: () => maskedPeer(),
        removePeer: () => true,
        setPeerScopes: () => maskedPeer(['memories']),
        peerForToken: (presented) => (presented === PEER_TOKEN
            ? { id: 'laptop', url: 'http://laptop:3141', scopes: ['memories', 'skills'] }
            : null),
        verifySharedSecret: (presented) => presented === SHARED_SECRET,
        export: () => ({ instanceId: 'local', counts: { memories: 0, skills: 0, config: 0 } }),
        import: () => ({ ok: true, from: 'laptop' }),
        pull: async () => ({ ok: true, direction: 'pull' }),
        push: async () => ({ ok: true, direction: 'push' }),
        ...overrides,
    });
}

function maskedPeer(scopes = ['memories', 'skills']) {
    return {
        id: 'laptop',
        url: 'http://laptop:3141',
        label: '',
        scopes,
        sharing: scopes.length > 0,
        tokenMasked: 'peer-to...mnop',
        hasToken: true,
    };
}

/**
 * Fake MissionControlServer. `sent` captures the single response; `res` records
 * whether it was touched at all, which is how the "returns false without
 * touching res" contract is verified.
 */
function makeCtx(overrides = {}) {
    const sent = { status: null, body: null, count: 0 };
    const res = {
        touched: false,
        writeHead() { res.touched = true; },
        end() { res.touched = true; },
    };
    const audits = [];
    const events = [];

    const ctx = {
        port: 3141,
        token: DASH_TOKEN,
        delegation: overrides.delegation === undefined ? makeDelegation() : overrides.delegation,
        council: overrides.council === undefined ? makeCouncil() : overrides.council,
        skills: overrides.skills === undefined ? makeSkills() : overrides.skills,
        instanceSync: overrides.instanceSync === undefined ? makeInstanceSync() : overrides.instanceSync,
        db: { logAudit: (...args) => audits.push(args) },
        broadcast: (event, data) => events.push([event, data]),
        _sendJson(r, status, obj) {
            r.touched = true;
            sent.status = status;
            sent.body = obj;
            sent.count += 1;
        },
        _readBody: async () => (overrides.body === undefined ? {} : overrides.body),
        audits,
        events,
    };
    return { ctx, res, sent };
}

/** Minimal request object. */
function makeReq(method, headers = {}) {
    return { method, headers, url: '/' };
}

/** One call through the handler. */
async function hit(pathname, { method = 'GET', query = {}, headers = {}, ...overrides } = {}) {
    const { ctx, res, sent } = makeCtx(overrides);
    const handled = await handleSwarmRoutes(ctx, makeReq(method, headers), res, pathname, query);
    return { handled, ctx, res, sent };
}

/** Deep scan of a response body for a forbidden literal. */
function containsSecret(value, secret) {
    return JSON.stringify(value === undefined ? null : value).includes(secret);
}

// ===========================================================================
//  Unowned paths
// ===========================================================================

test('returns false for an unrelated path without touching res', async () => {
    for (const p of ['/api/info', '/api/status', '/', '/api/router/providers', '/api/chat']) {
        const { handled, res, sent } = await hit(p);
        assert.equal(handled, false, `${p} should not be handled`);
        assert.equal(res.touched, false, `${p} must not touch res`);
        assert.equal(sent.count, 0);
    }
});

test('returns false for an owned prefix with an unsupported method', async () => {
    const { handled, res } = await hit('/api/council/participants', { method: 'PUT' });
    assert.equal(handled, false);
    assert.equal(res.touched, false);
});

// ===========================================================================
//  503 for every route when its collaborator is absent
// ===========================================================================

const ABSENT_CASES = [
    // [collaborator key, label, pathname, method]
    ['delegation', 'Agent delegation', '/api/delegation/tasks', 'GET'],
    ['delegation', 'Agent delegation', '/api/delegation/tasks', 'POST'],
    ['delegation', 'Agent delegation', '/api/delegation/tasks/t1/run', 'POST'],
    ['delegation', 'Agent delegation', '/api/delegation/tasks/t1', 'DELETE'],
    ['delegation', 'Agent delegation', '/api/delegation/tasks/t1', 'GET'],
    ['delegation', 'Agent delegation', '/api/delegation/pending', 'GET'],
    ['delegation', 'Agent delegation', '/api/delegation/agents', 'GET'],
    ['council', 'Council', '/api/council/deliberate', 'POST'],
    ['council', 'Council', '/api/council/standup', 'POST'],
    ['council', 'Council', '/api/council/participants', 'GET'],
    ['skills', 'Skill registry', '/api/skills', 'GET'],
    ['skills', 'Skill registry', '/api/skills', 'POST'],
    ['skills', 'Skill registry', '/api/skills/deploy-vps', 'GET'],
    ['skills', 'Skill registry', '/api/skills/deploy-vps', 'DELETE'],
    ['skills', 'Skill registry', '/api/skills/deploy-vps/promote', 'POST'],
    ['skills', 'Skill registry', '/api/skills/search', 'GET'],
    ['skills', 'Skill registry', '/api/skills/export', 'GET'],
    ['skills', 'Skill registry', '/api/skills/import', 'POST'],
    ['skills', 'Skill registry', '/api/skills/drafts', 'GET'],
    ['instanceSync', 'Instance sync', '/api/instance/peers', 'GET'],
    ['instanceSync', 'Instance sync', '/api/instance/peers', 'POST'],
    ['instanceSync', 'Instance sync', '/api/instance/peers/laptop', 'DELETE'],
    ['instanceSync', 'Instance sync', '/api/instance/peers/laptop', 'PATCH'],
    ['instanceSync', 'Instance sync', '/api/instance/pull', 'POST'],
    ['instanceSync', 'Instance sync', '/api/instance/push', 'POST'],
    ['instanceSync', 'Instance sync', '/api/instance/status', 'GET'],
    ['instanceSync', 'Instance sync', '/api/instance/export', 'GET'],
    ['instanceSync', 'Instance sync', '/api/instance/import', 'POST'],
];

test('every route answers 503 when its collaborator is absent', async () => {
    for (const [key, label, pathname, method] of ABSENT_CASES) {
        const { handled, sent } = await hit(pathname, {
            method,
            [key]: null,
            // Present credentials anyway: a missing module must not be probed
            // for auth, it must simply report itself unavailable.
            headers: { 'x-instance-token': PEER_TOKEN },
            body: { fromAgent: 'a', toAgent: 'b', prompt: 'p', question: 'q', name: 'n', body: 'b', id: 'x', url: 'http://x', peerId: 'laptop', scopes: [], skills: [] },
        });
        assert.equal(handled, true, `${method} ${pathname} should be handled`);
        assert.equal(sent.status, 503, `${method} ${pathname} should be 503, got ${sent.status}`);
        assert.match(sent.body.error, new RegExp(label), `${method} ${pathname} should name ${label}`);
    }
});

test('a 503 never reveals whether a peer token would have been valid', async () => {
    const { sent } = await hit('/api/instance/export', {
        instanceSync: null,
        headers: { 'x-instance-token': 'totally-wrong' },
    });
    assert.equal(sent.status, 503);
    assert.equal(sent.body.error, 'Instance sync not configured');
});

// ===========================================================================
//  Delegation
// ===========================================================================

test('GET /api/delegation/tasks forwards the filters to getTasks', async () => {
    const { sent, ctx } = await hit('/api/delegation/tasks', {
        query: { chatId: 'c9', agentId: 'grok', status: 'pending', limit: '7' },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.tasks, [{ id: 't1' }]);
    assert.deepEqual(ctx.delegation.lastCall('getTasks')[1], {
        chatId: 'c9', agentId: 'grok', status: 'pending', limit: 7,
    });
});

test('POST /api/delegation/tasks calls delegate with the exact hand-off shape', async () => {
    const { sent, ctx } = await hit('/api/delegation/tasks', {
        method: 'POST',
        body: { fromAgent: 'codex', toAgent: 'grok', prompt: 'review this', chatId: 'c1' },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ran, false);
    assert.deepEqual(ctx.delegation.lastCall('delegate')[1], {
        fromAgent: 'codex', toAgent: 'grok', prompt: 'review this', chatId: 'c1',
    });
    assert.equal(ctx.delegation.lastCall('delegateAndRun'), undefined);
    assert.ok(ctx.events.some(([e]) => e === 'delegation.created'));
    assert.ok(ctx.audits.some((a) => a[2] === 'delegation_created'));
});

test('POST /api/delegation/tasks with run:true uses delegateAndRun instead', async () => {
    const { sent, ctx } = await hit('/api/delegation/tasks', {
        method: 'POST',
        body: { fromAgent: 'codex', toAgent: 'grok', prompt: 'do it', run: true },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ran, true);
    assert.ok(ctx.delegation.lastCall('delegateAndRun'));
    assert.equal(ctx.delegation.lastCall('delegate'), undefined);
});

test('POST /api/delegation/tasks names every missing field', async () => {
    const { sent } = await hit('/api/delegation/tasks', { method: 'POST', body: {} });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /fromAgent/);
    assert.match(sent.body.error, /toAgent/);
    assert.match(sent.body.error, /prompt/);
});

test('POST /api/delegation/tasks names only the field that is missing', async () => {
    const { sent } = await hit('/api/delegation/tasks', {
        method: 'POST',
        body: { fromAgent: 'codex', prompt: 'x' },
    });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /toAgent/);
    assert.doesNotMatch(sent.body.error, /fromAgent/);
});

test('a throwing delegate() becomes a 400 carrying the real message', async () => {
    const boom = makeDelegation({
        delegate: () => { throw new Error('[AgentDelegation] delegate() requires a toAgent'); },
    });
    const { sent } = await hit('/api/delegation/tasks', {
        method: 'POST',
        delegation: boom,
        body: { fromAgent: 'codex', toAgent: 'ghost', prompt: 'x' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, '[AgentDelegation] delegate() requires a toAgent');
});

test('a rejecting delegateAndRun() becomes a 400, not an unhandled rejection', async () => {
    const boom = makeDelegation({
        delegateAndRun: async () => { throw new Error('depth limit reached'); },
    });
    const { sent } = await hit('/api/delegation/tasks', {
        method: 'POST',
        delegation: boom,
        body: { fromAgent: 'a', toAgent: 'b', prompt: 'c', run: true },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'depth limit reached');
});

test('POST /api/delegation/tasks/<id>/run runs that id', async () => {
    const { sent, ctx } = await hit('/api/delegation/tasks/task%3A42/run', { method: 'POST' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.delegation.lastCall('run'), ['run', 'task:42']);
});

test('a throwing run() becomes a 400 with the real message', async () => {
    const boom = makeDelegation({ run: async () => { throw new Error('no such task: t9'); } });
    const { sent } = await hit('/api/delegation/tasks/t9/run', { method: 'POST', delegation: boom });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'no such task: t9');
});

test('DELETE /api/delegation/tasks/<id> cancels, and 404s when nothing was pending', async () => {
    const { sent, ctx } = await hit('/api/delegation/tasks/t1', { method: 'DELETE' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.delegation.lastCall('cancel'), ['cancel', 't1']);

    const none = await hit('/api/delegation/tasks/t1', {
        method: 'DELETE',
        delegation: makeDelegation({ cancel: () => null }),
    });
    assert.equal(none.sent.status, 404);
});

test('GET /api/delegation/pending passes the agent through and 404-free defaults to all', async () => {
    const withAgent = await hit('/api/delegation/pending', { query: { agent: 'grok' } });
    assert.equal(withAgent.sent.status, 200);
    assert.equal(withAgent.sent.body.agent, 'grok');
    assert.deepEqual(withAgent.ctx.delegation.lastCall('pending'), ['pending', 'grok']);

    const all = await hit('/api/delegation/pending');
    assert.equal(all.sent.status, 200);
    assert.deepEqual(all.ctx.delegation.lastCall('pending'), ['pending', null]);
});

test('GET /api/delegation/agents lists the delegation targets', async () => {
    const { sent } = await hit('/api/delegation/agents');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.agents, ['codex', 'grok']);
});

// ===========================================================================
//  Council
// ===========================================================================

test('POST /api/council/deliberate passes question, participants and rounds', async () => {
    const { sent, ctx } = await hit('/api/council/deliberate', {
        method: 'POST',
        body: { question: 'ship it?', participants: ['codex', 'grok'], rounds: 2 },
    });
    assert.equal(sent.status, 200);
    const [, question, opts] = ctx.council.lastCall('deliberate');
    assert.equal(question, 'ship it?');
    assert.deepEqual(opts.participants, ['codex', 'grok']);
    assert.equal(opts.rounds, 2);
    assert.equal(typeof opts.onProgress, 'function');
});

test('POST /api/council/deliberate accepts a comma-separated participant list', async () => {
    const { ctx } = await hit('/api/council/deliberate', {
        method: 'POST',
        body: { question: 'q', participants: 'codex, grok ,pi' },
    });
    assert.deepEqual(ctx.council.lastCall('deliberate')[2].participants, ['codex', 'grok', 'pi']);
});

test('POST /api/council/deliberate 400s when the question is missing', async () => {
    const { sent } = await hit('/api/council/deliberate', { method: 'POST', body: { rounds: 3 } });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /question/);
});

test('a throwing deliberate() becomes a 400 with the real message', async () => {
    const boom = makeCouncil({ deliberate: async () => { throw new Error('council switch is off'); } });
    const { sent } = await hit('/api/council/deliberate', {
        method: 'POST', council: boom, body: { question: 'q' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'council switch is off');
});

test('POST /api/council/standup calls standup with the participants', async () => {
    const { sent, ctx } = await hit('/api/council/standup', {
        method: 'POST',
        body: { participants: ['codex'] },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.council.lastCall('standup')[1].participants, ['codex']);
});

test('GET /api/council/participants resolves the roster', async () => {
    const { sent, ctx } = await hit('/api/council/participants');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.participants, ['codex', 'grok']);
    assert.deepEqual(ctx.council.lastCall('resolveParticipants'), ['resolveParticipants', undefined]);
});

// ===========================================================================
//  Skills
// ===========================================================================

test('GET /api/skills lists with the agent and tag filters', async () => {
    const { sent, ctx } = await hit('/api/skills', { query: { agent: 'codex', tag: 'deploy' } });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.skills, [{ name: 'deploy-vps' }]);
    assert.deepEqual(ctx.skills.lastCall('list')[1], { agentKey: 'codex', tag: 'deploy' });
});

test('POST /api/skills saves and 400s on a missing name or body', async () => {
    const ok = await hit('/api/skills', {
        method: 'POST',
        body: { name: 'deploy-vps', body: 'steps', description: 'd', tags: ['ops'] },
    });
    assert.equal(ok.sent.status, 200);
    const saved = ok.ctx.skills.lastCall('save')[1];
    assert.equal(saved.name, 'deploy-vps');
    assert.equal(saved.body, 'steps');
    assert.deepEqual(saved.tags, ['ops']);

    const bad = await hit('/api/skills', { method: 'POST', body: {} });
    assert.equal(bad.sent.status, 400);
    assert.match(bad.sent.body.error, /name/);
    assert.match(bad.sent.body.error, /body/);
});

test('a throwing save() becomes a 400 with the real message', async () => {
    const boom = makeSkills({
        save: () => { throw new Error('[SkillRegistry] Invalid skill name: "../etc"'); },
    });
    const { sent } = await hit('/api/skills', {
        method: 'POST', skills: boom, body: { name: '../etc', body: 'x' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, '[SkillRegistry] Invalid skill name: "../etc"');
});

test('GET /api/skills/<name> percent-decodes the skill name', async () => {
    const { sent, ctx } = await hit('/api/skills/deploy%20to%20vps', {});
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.skills.lastCall('get'), ['get', 'deploy to vps']);
});

test('GET /api/skills/<name> 404s for an unknown skill', async () => {
    const { sent } = await hit('/api/skills/ghost', { skills: makeSkills({ get: () => null }) });
    assert.equal(sent.status, 404);
});

test('DELETE /api/skills/<name> decodes and removes, 404 when absent', async () => {
    const { sent, ctx } = await hit('/api/skills/my%2Fskill', { method: 'DELETE' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.skills.lastCall('remove'), ['remove', 'my/skill']);

    const none = await hit('/api/skills/ghost', {
        method: 'DELETE', skills: makeSkills({ remove: () => false }),
    });
    assert.equal(none.sent.status, 404);
});

test('GET /api/skills/search forwards q', async () => {
    const { sent, ctx } = await hit('/api/skills/search', { query: { q: 'deploy', limit: '5' } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.query, 'deploy');
    const [, text, opts] = ctx.skills.lastCall('search');
    assert.equal(text, 'deploy');
    assert.equal(opts.limit, 5);
});

test('/api/skills/search is not mistaken for a skill named "search"', async () => {
    const { ctx } = await hit('/api/skills/search', { query: { q: 'x' } });
    assert.ok(ctx.skills.lastCall('search'));
    assert.equal(ctx.skills.lastCall('get'), undefined);
});

test('POST /api/skills/<name>/promote promotes the decoded draft name', async () => {
    const { sent, ctx } = await hit('/api/skills/my%20draft/promote', { method: 'POST' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.skills.lastCall('promote'), ['promote', 'my draft']);
});

test('GET /api/skills/export returns the snapshot and its count', async () => {
    const { sent, ctx } = await hit('/api/skills/export', { query: { tag: 'ops' } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.count, 1);
    assert.equal(ctx.skills.lastCall('export')[1].tags, 'ops');
    assert.equal(ctx.skills.lastCall('get'), undefined);
});

test('POST /api/skills/import requires an array and passes overwrite', async () => {
    const ok = await hit('/api/skills/import', {
        method: 'POST',
        body: { skills: [{ name: 'a', body: 'b' }], overwrite: true },
    });
    assert.equal(ok.sent.status, 200);
    const [, incoming, opts] = ok.ctx.skills.lastCall('import');
    assert.equal(incoming.length, 1);
    assert.deepEqual(opts, { overwrite: true });

    const bad = await hit('/api/skills/import', { method: 'POST', body: {} });
    assert.equal(bad.sent.status, 400);
    assert.match(bad.sent.body.error, /skills/);
});

test('GET /api/skills survives a stats() that throws', async () => {
    const { sent } = await hit('/api/skills', {
        skills: makeSkills({ stats: () => { throw new Error('stats broke'); } }),
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.stats, null);
});

// ===========================================================================
//  Instance sync — dashboard-token routes
// ===========================================================================

test('GET /api/instance/status returns the overview', async () => {
    const { sent } = await hit('/api/instance/status');
    assert.equal(sent.status, 200);
    assert.equal(sent.body.selfId, 'local');
});

test('GET /api/instance/peers returns the masked list plus the scope vocabulary', async () => {
    const { sent } = await hit('/api/instance/peers');
    assert.equal(sent.status, 200);
    assert.equal(sent.body.peers.length, 1);
    assert.deepEqual(sent.body.scopes, ['memories', 'skills', 'config']);
    assert.equal(sent.body.peers[0].tokenMasked, 'peer-to...mnop');
});

test('POST /api/instance/peers adds a peer and 400s without id or url', async () => {
    const ok = await hit('/api/instance/peers', {
        method: 'POST',
        body: { id: 'laptop', url: 'http://laptop:3141', token: PEER_TOKEN, scopes: ['memories'] },
    });
    assert.equal(ok.sent.status, 200);
    assert.deepEqual(ok.ctx.instanceSync.lastCall('addPeer')[1], {
        id: 'laptop', url: 'http://laptop:3141', token: PEER_TOKEN, scopes: ['memories'], label: undefined,
    });

    const bad = await hit('/api/instance/peers', { method: 'POST', body: {} });
    assert.equal(bad.sent.status, 400);
    assert.match(bad.sent.body.error, /id/);
    assert.match(bad.sent.body.error, /url/);
});

test('a throwing addPeer() becomes a 400 with the real message', async () => {
    const boom = makeInstanceSync({
        addPeer: () => { throw new Error('Peer url must be http(s), got file:'); },
    });
    const { sent } = await hit('/api/instance/peers', {
        method: 'POST', instanceSync: boom, body: { id: 'x', url: 'file:///etc' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'Peer url must be http(s), got file:');
});

test('DELETE /api/instance/peers/<id> percent-decodes the peer id', async () => {
    const { sent, ctx } = await hit('/api/instance/peers/my%20laptop%2F1', { method: 'DELETE' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.instanceSync.lastCall('removePeer'), ['removePeer', 'my laptop/1']);

    const none = await hit('/api/instance/peers/ghost', {
        method: 'DELETE', instanceSync: makeInstanceSync({ removePeer: () => false }),
    });
    assert.equal(none.sent.status, 404);
});

test('PATCH /api/instance/peers/<id> sets scopes, and 400s when scopes are absent', async () => {
    const ok = await hit('/api/instance/peers/laptop', {
        method: 'PATCH', body: { scopes: ['memories'] },
    });
    assert.equal(ok.sent.status, 200);
    assert.deepEqual(ok.ctx.instanceSync.lastCall('setPeerScopes'), ['setPeerScopes', 'laptop', ['memories']]);

    const bad = await hit('/api/instance/peers/laptop', { method: 'PATCH', body: {} });
    assert.equal(bad.sent.status, 400);
    assert.match(bad.sent.body.error, /scopes/);
});

test('a throwing setPeerScopes() becomes a 400 with the real message', async () => {
    const boom = makeInstanceSync({
        setPeerScopes: () => { throw new Error('Unknown peer: ghost'); },
    });
    const { sent } = await hit('/api/instance/peers/ghost', {
        method: 'PATCH', instanceSync: boom, body: { scopes: [] },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'Unknown peer: ghost');
});

test('POST /api/instance/pull and /push call the matching direction', async () => {
    const pull = await hit('/api/instance/pull', { method: 'POST', body: { peerId: 'laptop' } });
    assert.equal(pull.sent.status, 200);
    assert.equal(pull.sent.body.direction, 'pull');
    assert.deepEqual(pull.ctx.instanceSync.lastCall('pull'), ['pull', 'laptop', {}]);
    assert.equal(pull.ctx.instanceSync.lastCall('push'), undefined);

    const push = await hit('/api/instance/push', {
        method: 'POST', body: { peerId: 'laptop', since: 42, scopes: ['memories'] },
    });
    assert.equal(push.sent.status, 200);
    assert.deepEqual(push.ctx.instanceSync.lastCall('push'), ['push', 'laptop', { since: 42, scopes: ['memories'] }]);
});

test('POST /api/instance/pull 400s without a peerId', async () => {
    const { sent } = await hit('/api/instance/pull', { method: 'POST', body: {} });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /peerId/);
});

test('a rejecting pull() becomes a 400 with the real message', async () => {
    const boom = makeInstanceSync({ pull: async () => { throw new Error('Peer unreachable at http://laptop:3141'); } });
    const { sent } = await hit('/api/instance/pull', {
        method: 'POST', instanceSync: boom, body: { peerId: 'laptop' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'Peer unreachable at http://laptop:3141');
});

// ===========================================================================
//  Instance sync — THE PEER-AUTHENTICATED PAIR (security critical)
// ===========================================================================

test('GET /api/instance/export accepts a valid peer token', async () => {
    const { sent, ctx } = await hit('/api/instance/export', {
        headers: { 'x-instance-token': PEER_TOKEN },
        query: { scopes: 'memories', since: '100' },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.instanceSync.lastCall('export')[1], { scopes: ['memories'], since: 100 });
});

test('GET /api/instance/export clamps a peer to the scopes it was granted', async () => {
    // The peer is granted memories+skills; it asks for config too.
    const { ctx } = await hit('/api/instance/export', {
        headers: { 'x-instance-token': PEER_TOKEN },
        query: { scopes: 'memories,config' },
    });
    assert.deepEqual(ctx.instanceSync.lastCall('export')[1].scopes, ['memories']);
});

test('GET /api/instance/export 401s on a bad peer token', async () => {
    for (const headers of [
        {},
        { 'x-instance-token': '' },
        { 'x-instance-token': 'wrong-token' },
        { 'x-instance-token': 'peer-token-abcdefghijklmno' }, // one char short
    ]) {
        const { handled, sent, ctx } = await hit('/api/instance/export', { headers });
        assert.equal(handled, true);
        assert.equal(sent.status, 401, `headers ${JSON.stringify(headers)} should 401`);
        assert.equal(ctx.instanceSync.lastCall('export'), undefined, 'export must not run');
    }
});

test('GET /api/instance/export does NOT accept the dashboard token', async () => {
    for (const headers of [
        { authorization: `Bearer ${DASH_TOKEN}` },
        { 'x-instance-token': DASH_TOKEN },
    ]) {
        const { sent, ctx } = await hit('/api/instance/export', { headers });
        assert.equal(sent.status, 401, `dashboard token via ${Object.keys(headers)[0]} must 401`);
        assert.equal(ctx.instanceSync.lastCall('export'), undefined);
    }
    // ...not even when it is also passed as ?token=, the dashboard's own form.
    const viaQuery = await hit('/api/instance/export', { query: { token: DASH_TOKEN } });
    assert.equal(viaQuery.sent.status, 401);
    assert.equal(viaQuery.ctx.instanceSync.lastCall('export'), undefined);
});

test('GET /api/instance/export accepts the shared secret as the bootstrap path', async () => {
    const { sent, ctx } = await hit('/api/instance/export', {
        headers: { 'x-instance-secret': SHARED_SECRET, 'x-instance-id': 'desktop' },
        query: { scopes: 'memories,skills' },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.instanceSync.lastCall('export')[1].scopes, ['memories', 'skills']);
});

test('POST /api/instance/import accepts a valid peer token and clamps the scopes', async () => {
    const { sent, ctx } = await hit('/api/instance/import', {
        method: 'POST',
        headers: { 'x-instance-token': PEER_TOKEN },
        body: { instanceId: 'laptop', scopes: ['memories', 'config'], memories: [{ id: 1 }] },
    });
    assert.equal(sent.status, 200);
    const [, payload, opts] = ctx.instanceSync.lastCall('import');
    // The payload is forwarded verbatim as untrusted DATA...
    assert.equal(payload.instanceId, 'laptop');
    // ...but the scopes come from the peer's grant, not from the payload.
    assert.deepEqual(opts.scopes, ['memories']);
    assert.equal(opts.peerId, 'laptop');
});

test('POST /api/instance/import 401s on a bad peer token and never imports', async () => {
    for (const headers of [{}, { 'x-instance-token': 'nope' }, { authorization: `Bearer ${DASH_TOKEN}` }]) {
        const { sent, ctx } = await hit('/api/instance/import', {
            method: 'POST',
            headers,
            body: { instanceId: 'attacker', memories: [{ id: 1 }] },
        });
        assert.equal(sent.status, 401, `headers ${JSON.stringify(headers)} should 401`);
        assert.equal(ctx.instanceSync.lastCall('import'), undefined, 'import must not run');
    }
});

test('POST /api/instance/import does NOT accept the dashboard token in any position', async () => {
    const viaHeader = await hit('/api/instance/import', {
        method: 'POST', headers: { 'x-instance-token': DASH_TOKEN }, body: {},
    });
    assert.equal(viaHeader.sent.status, 401);

    const viaQuery = await hit('/api/instance/import', {
        method: 'POST', query: { token: DASH_TOKEN }, body: {},
    });
    assert.equal(viaQuery.sent.status, 401);
    assert.equal(viaQuery.ctx.instanceSync.lastCall('import'), undefined);
});

test('an untrusted import payload cannot name its own peerId', async () => {
    const { ctx } = await hit('/api/instance/import', {
        method: 'POST',
        headers: { 'x-instance-token': PEER_TOKEN },
        body: { instanceId: 'spoofed', peerId: 'admin', scopes: ['skills'] },
    });
    assert.equal(ctx.instanceSync.lastCall('import')[2].peerId, 'laptop');
});

test('a throwing export()/import() becomes a 400, still behind peer auth', async () => {
    const boomExport = makeInstanceSync({ export: () => { throw new Error('export failed hard'); } });
    const e = await hit('/api/instance/export', {
        instanceSync: boomExport, headers: { 'x-instance-token': PEER_TOKEN },
    });
    assert.equal(e.sent.status, 400);
    assert.equal(e.sent.body.error, 'export failed hard');

    const boomImport = makeInstanceSync({ import: () => { throw new Error('Payload is not an object'); } });
    const i = await hit('/api/instance/import', {
        method: 'POST', instanceSync: boomImport, headers: { 'x-instance-token': PEER_TOKEN }, body: {},
    });
    assert.equal(i.sent.status, 400);
    assert.equal(i.sent.body.error, 'Payload is not an object');
});

// ===========================================================================
//  No secret ever reaches a response body
// ===========================================================================

test('no response body ever contains a raw peer token or the shared secret', async () => {
    const cases = [
        ['/api/instance/peers', { method: 'GET' }],
        ['/api/instance/status', { method: 'GET' }],
        ['/api/instance/peers', {
            method: 'POST',
            body: { id: 'laptop', url: 'http://laptop:3141', token: PEER_TOKEN, scopes: ['memories'] },
        }],
        ['/api/instance/peers/laptop', { method: 'PATCH', body: { scopes: ['memories'] } }],
        ['/api/instance/pull', { method: 'POST', body: { peerId: 'laptop' } }],
        ['/api/instance/push', { method: 'POST', body: { peerId: 'laptop' } }],
        ['/api/instance/export', { method: 'GET', headers: { 'x-instance-token': PEER_TOKEN } }],
        ['/api/instance/export', { method: 'GET', headers: { 'x-instance-token': 'bad' } }],
        ['/api/instance/import', {
            method: 'POST',
            headers: { 'x-instance-token': PEER_TOKEN, 'x-instance-secret': SHARED_SECRET },
            body: { instanceId: 'laptop', scopes: ['memories'] },
        }],
        ['/api/instance/import', { method: 'POST', headers: { 'x-instance-token': 'bad' }, body: {} }],
    ];

    for (const [pathname, opts] of cases) {
        const { sent } = await hit(pathname, opts);
        assert.equal(containsSecret(sent.body, PEER_TOKEN), false,
            `${opts.method} ${pathname} leaked the peer token`);
        assert.equal(containsSecret(sent.body, SHARED_SECRET), false,
            `${opts.method} ${pathname} leaked the shared secret`);
        assert.equal(containsSecret(sent.body, DASH_TOKEN), false,
            `${opts.method} ${pathname} leaked the dashboard token`);
    }
});

test('a 401 body carries no detail about why the token failed', async () => {
    const { sent } = await hit('/api/instance/export', { headers: { 'x-instance-token': 'wrong' } });
    assert.equal(sent.status, 401);
    assert.equal(containsSecret(sent.body, 'wrong'), false);
    assert.deepEqual(Object.keys(sent.body), ['error']);
});

test('addPeer echoes only the masked peer even if the module returned a raw token', async () => {
    // Defence in depth: the route must not become a leak if a future addPeer()
    // stops masking. This asserts the route does not synthesise a token field
    // of its own from the request body.
    const { sent } = await hit('/api/instance/peers', {
        method: 'POST',
        body: { id: 'laptop', url: 'http://laptop:3141', token: PEER_TOKEN },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.peer.hasToken, true);
    assert.equal(sent.body.peer.token, undefined);
    assert.equal(containsSecret(sent.body, PEER_TOKEN), false);
});

// ===========================================================================
//  Audit + broadcast conventions
// ===========================================================================

test('mutating routes log an audit row and broadcast an SSE event', async () => {
    const cases = [
        ['/api/delegation/tasks', { method: 'POST', body: { fromAgent: 'a', toAgent: 'b', prompt: 'c' } }, 'delegation.created'],
        ['/api/skills', { method: 'POST', body: { name: 'n', body: 'b' } }, 'skills.saved'],
        ['/api/skills/n', { method: 'DELETE' }, 'skills.removed'],
        ['/api/skills/n/promote', { method: 'POST' }, 'skills.promoted'],
        ['/api/instance/peers', { method: 'POST', body: { id: 'laptop', url: 'http://l:1' } }, 'instance.peer_added'],
        ['/api/instance/peers/laptop', { method: 'DELETE' }, 'instance.peer_removed'],
        ['/api/instance/pull', { method: 'POST', body: { peerId: 'laptop' } }, 'instance.pull'],
    ];
    for (const [pathname, opts, event] of cases) {
        const { ctx, sent } = await hit(pathname, opts);
        assert.equal(sent.status, 200, `${pathname} should succeed`);
        assert.ok(ctx.events.some(([e]) => e === event), `${pathname} should broadcast ${event}`);
        assert.ok(ctx.audits.length > 0, `${pathname} should write an audit row`);
    }
});

test('a broken audit table does not fail the request', async () => {
    const sent = { status: null, body: null, count: 0 };
    const res = { touched: false, writeHead() {}, end() {} };
    const ctx = {
        delegation: makeDelegation(),
        council: null,
        skills: null,
        instanceSync: null,
        db: { logAudit() { throw new Error('audit table missing'); } },
        broadcast() {},
        _sendJson(r, status, obj) { sent.status = status; sent.body = obj; sent.count += 1; },
        _readBody: async () => ({ fromAgent: 'a', toAgent: 'b', prompt: 'c' }),
    };
    const handled = await handleSwarmRoutes(ctx, makeReq('POST'), res, '/api/delegation/tasks', {});
    assert.equal(handled, true);
    assert.equal(sent.status, 200);
});

test('exactly one response is sent per handled request', async () => {
    const cases = [
        ['/api/delegation/tasks', { method: 'GET' }],
        ['/api/delegation/tasks', { method: 'POST', body: {} }],
        ['/api/council/deliberate', { method: 'POST', body: { question: 'q' } }],
        ['/api/skills', { method: 'GET' }],
        ['/api/skills/x', { method: 'GET' }],
        ['/api/instance/peers', { method: 'GET' }],
        ['/api/instance/export', { method: 'GET', headers: { 'x-instance-token': PEER_TOKEN } }],
        ['/api/instance/export', { method: 'GET' }],
    ];
    for (const [pathname, opts] of cases) {
        const { handled, sent } = await hit(pathname, opts);
        assert.equal(handled, true, `${pathname} should be handled`);
        assert.equal(sent.count, 1, `${pathname} sent ${sent.count} responses`);
    }
});
