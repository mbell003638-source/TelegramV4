// =============================================================================
//  test/router-routes.test.js — HTTP surface for OmniRouter, agent overrides,
//  memory search, planner, scheduler, self-improve, upstream watch and
//  Syncthing.
//
//  Hermetic by construction: no server is booted, no socket is opened and the
//  real store/ directory is never touched. Collaborators are recording fakes,
//  so every assertion is about the ROUTE layer — which method it calls, with
//  which arguments, and which status code comes back.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleRouterRoutes, runImprovement, IMPROVE_AGENT_ID } = require('../core/RouterRoutes');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

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

function makeProviderRegistry(overrides = {}) {
    return recorder({
        maskedView: () => [{ id: 'openai', keys: 1, enabled: true }],
        addKey: () => true,
        removeKey: () => true,
        setEnabled: () => true,
        upsert: () => true,
        save: () => true,
        ...overrides,
    });
}

function makeProviderRouter(overrides = {}) {
    return recorder({
        resetUsage: () => undefined,
        getUsageReport: () => ({ totalTokens: 42, cost: 0.01 }),
        listModels: async () => [{ id: 'gpt-4' }],
        getHealth: () => ({ openai: 'ok' }),
        getKeyUsage: () => ({ openai: 3 }),
        getMasterKey: () => 'master-key-abc',
        ...overrides,
    });
}

function makeAgentOverrides(overrides = {}) {
    return recorder({
        describeAll: () => [{ agentKey: 'codex', enabled: true }],
        enable: (agentKey, opts) => ({ agentKey, enabled: true, ...opts }),
        disable: (agentKey) => ({ agentKey, enabled: false }),
        ...overrides,
    });
}

function makeMemorySearch(overrides = {}) {
    return recorder({
        search: () => [{ id: 1, text: 'hello' }],
        stats: () => ({ count: 1 }),
        reindexAll: () => 12,
        ...overrides,
    });
}

function makeTaskPlanner(overrides = {}) {
    return recorder({
        plan: async () => ({ tasks: [{ id: 't1' }] }),
        run: async () => ({ plan: { tasks: [{ id: 't1' }] } }),
        ...overrides,
    });
}

function makeScheduler(overrides = {}) {
    return recorder({
        parseCron: () => ({ ok: true }),
        scheduleTask: (spec) => ({
            id: 'sched-1',
            schedule: spec.schedule,
            agent_id: spec.agentId,
            prompt: spec.prompt,
            next_run: 99,
            status: 'active',
        }),
        ...overrides,
    });
}

function makeUpstreamWatch(overrides = {}) {
    const sources = overrides.sources === undefined
        ? [{ id: 'openclaw', repo: 'openclaw/openclaw', note: 'Gateway' }]
        : overrides.sources;
    const fake = recorder({
        localClonePath: () => '/tmp/clone',
        checkAll: async () => ({
            total: 1,
            withUpdates: 0,
            reports: [{
                id: 'openclaw', error: null, upToDate: true, newCount: 0,
                lastSeenSha: 'abc', mode: 'local', newCommits: [],
            }],
        }),
        acknowledge: () => ['openclaw'],
        ...overrides,
    });
    // `sources` is read as a data property (`.sources.map`), not called.
    fake.sources = sources;
    return fake;
}

function makeSyncthing(overrides = {}) {
    return recorder({
        overview: async () => ({ running: true, devices: 1 }),
        addDevice: async () => ({ id: 'DEV1' }),
        shareFolder: async () => ({ shared: true }),
        rescan: async () => ({ rescanned: true }),
        setPaused: async (folderId, paused) => ({ folderId, paused }),
        ...overrides,
    });
}

function makeSelfImprovement(overrides = {}) {
    return recorder({
        evaluateAndLearn: async () => ({ promotedRules: [{ id: 'r1' }] }),
        ...overrides,
    });
}

function makeDb(overrides = {}) {
    return recorder({
        logAudit: () => undefined,
        getScheduledTasks: () => [],
        deleteScheduledTask: () => true,
        setScheduledTaskStatus: () => true,
        recordHiveMind: () => undefined,
        ...overrides,
    });
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

    const db = overrides.db === undefined
        ? makeDb({
            logAudit: (...args) => { audits.push(args); },
            ...(overrides.dbMethods || {}),
        })
        : overrides.db;

    const ctx = {
        port: overrides.port === undefined ? 3141 : overrides.port,
        providerRegistry: overrides.providerRegistry === undefined ? makeProviderRegistry() : overrides.providerRegistry,
        providerRouter: overrides.providerRouter === undefined ? makeProviderRouter() : overrides.providerRouter,
        agentOverrides: overrides.agentOverrides === undefined ? makeAgentOverrides() : overrides.agentOverrides,
        memorySearch: overrides.memorySearch === undefined ? makeMemorySearch() : overrides.memorySearch,
        taskPlanner: overrides.taskPlanner === undefined ? makeTaskPlanner() : overrides.taskPlanner,
        scheduler: overrides.scheduler === undefined ? makeScheduler() : overrides.scheduler,
        upstreamWatch: overrides.upstreamWatch === undefined ? makeUpstreamWatch() : overrides.upstreamWatch,
        syncthing: overrides.syncthing === undefined ? makeSyncthing() : overrides.syncthing,
        selfImprovement: overrides.selfImprovement === undefined ? makeSelfImprovement() : overrides.selfImprovement,
        db,
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
    const handled = await handleRouterRoutes(ctx, makeReq(method, headers), res, pathname, query);
    return { handled, ctx, res, sent };
}

// ===========================================================================
//  Exports
// ===========================================================================

test('IMPROVE_AGENT_ID is the reserved scheduler marker', () => {
    assert.equal(IMPROVE_AGENT_ID, '__improve__');
});

// ===========================================================================
//  Unowned paths
// ===========================================================================

test('returns false for an unrelated path without touching res', async () => {
    for (const p of ['/api/info', '/api/status', '/', '/api/delegation/tasks', '/api/chat', '/api/skills']) {
        const { handled, res, sent } = await hit(p);
        assert.equal(handled, false, `${p} should not be handled`);
        assert.equal(res.touched, false, `${p} must not touch res`);
        assert.equal(sent.count, 0);
    }
});

test('returns false for an owned prefix with an unsupported method', async () => {
    const cases = [
        ['/api/router/providers', 'PUT'],
        ['/api/router/providers', 'DELETE'],
        ['/api/router/key', 'POST'],
        ['/api/planner/plan', 'GET'],
        ['/api/planner/run', 'GET'],
        ['/api/memories/reindex', 'GET'],
        ['/api/improve', 'DELETE'],
        ['/api/upstream', 'DELETE'],
        ['/api/sync', 'PUT'],
        ['/api/scheduler/tasks', 'PUT'],
        ['/api/scheduler/tasks/t1', 'GET'],
    ];
    for (const [pathname, method] of cases) {
        const { handled, res } = await hit(pathname, { method });
        assert.equal(handled, false, `${method} ${pathname} should not be handled`);
        assert.equal(res.touched, false, `${method} ${pathname} must not touch res`);
    }
});

// ===========================================================================
//  503 for every route when its collaborator is absent
// ===========================================================================

const ABSENT_CASES = [
    // [collaborator key, label, pathname, method]
    ['providerRegistry', 'Provider registry', '/api/router/providers', 'GET'],
    ['providerRegistry', 'Provider registry', '/api/router/providers', 'POST'],
    ['providerRegistry', 'Provider registry', '/api/router/providers', 'PATCH'],
    ['providerRouter', 'Router', '/api/router/usage', 'GET'],
    ['providerRouter', 'Router', '/api/router/usage', 'DELETE'],
    ['providerRouter', 'Router', '/api/router/models', 'GET'],
    ['providerRouter', 'Router', '/api/router/health', 'GET'],
    ['providerRouter', 'Router', '/api/router/key', 'GET'],
    ['agentOverrides', 'Agent overrides', '/api/agents/override', 'GET'],
    ['agentOverrides', 'Agent overrides', '/api/agents/override', 'POST'],
    ['memorySearch', 'Memory search', '/api/memories/search', 'GET'],
    ['memorySearch', 'Memory search', '/api/memories/reindex', 'POST'],
    ['taskPlanner', 'Task planner', '/api/planner/plan', 'POST'],
    ['taskPlanner', 'Task planner', '/api/planner/run', 'POST'],
    ['scheduler', 'Scheduler', '/api/scheduler/tasks', 'GET'],
    ['scheduler', 'Scheduler', '/api/scheduler/tasks', 'POST'],
    ['scheduler', 'Scheduler', '/api/scheduler/tasks/t1', 'DELETE'],
    ['scheduler', 'Scheduler', '/api/scheduler/tasks/t1', 'PATCH'],
    ['upstreamWatch', 'Upstream watch', '/api/upstream', 'GET'],
    ['upstreamWatch', 'Upstream watch', '/api/upstream', 'POST'],
    ['syncthing', 'Syncthing bridge', '/api/sync', 'GET'],
    ['syncthing', 'Syncthing bridge', '/api/sync', 'POST'],
];

test('every route answers 503 when its collaborator is absent', async () => {
    for (const [key, label, pathname, method] of ABSENT_CASES) {
        const { handled, sent } = await hit(pathname, {
            method,
            [key]: null,
            body: {
                id: 'openai', addKey: 'sk-x', agentKey: 'codex', enabled: true,
                request: 'do it', schedule: '* * * * *', prompt: 'p',
                action: 'rescan',
            },
        });
        assert.equal(handled, true, `${method} ${pathname} should be handled`);
        assert.equal(sent.status, 503, `${method} ${pathname} should be 503, got ${sent.status}`);
        assert.match(sent.body.error, new RegExp(label), `${method} ${pathname} should name ${label}`);
    }
});

test('POST /api/improve without runNow answers 503 when the scheduler is absent', async () => {
    const { handled, sent } = await hit('/api/improve', {
        method: 'POST',
        scheduler: null,
        body: { enabled: true },
    });
    assert.equal(handled, true);
    assert.equal(sent.status, 503);
    assert.match(sent.body.error, /Scheduler/);
});

// ===========================================================================
//  Provider registry
// ===========================================================================

test('GET /api/router/providers returns maskedView()', async () => {
    const { sent, ctx } = await hit('/api/router/providers');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.providers, [{ id: 'openai', keys: 1, enabled: true }]);
    assert.ok(ctx.providerRegistry.lastCall('maskedView'));
});

test('POST /api/router/providers without id is 400', async () => {
    const { sent, ctx } = await hit('/api/router/providers', { method: 'POST', body: { addKey: 'sk-x' } });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /id/);
    assert.equal(ctx.providerRegistry.lastCall('save'), undefined);
    assert.equal(ctx.events.length, 0);
});

test('POST /api/router/providers addKey saves, audits and broadcasts', async () => {
    const { sent, ctx } = await hit('/api/router/providers', {
        method: 'POST',
        body: { id: 'openai', addKey: 'sk-new' },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.deepEqual(ctx.providerRegistry.lastCall('addKey'), ['addKey', 'openai', 'sk-new']);
    assert.ok(ctx.providerRegistry.lastCall('save'));
    assert.equal(ctx.providerRegistry.lastCall('upsert'), undefined);
    assert.ok(ctx.events.some(([e, d]) => e === 'router.providers_updated' && d.id === 'openai'));
    assert.ok(ctx.audits.some((a) => a[2] === 'provider_updated'));
    assert.deepEqual(sent.body.providers, [{ id: 'openai', keys: 1, enabled: true }]);
});

test('POST /api/router/providers removeKey / enabled / upsert pick the matching mutator', async () => {
    const remove = await hit('/api/router/providers', {
        method: 'POST', body: { id: 'openai', removeKey: 0 },
    });
    assert.equal(remove.sent.status, 200);
    assert.deepEqual(remove.ctx.providerRegistry.lastCall('removeKey'), ['removeKey', 'openai', 0]);
    assert.ok(remove.ctx.providerRegistry.lastCall('save'));

    const enabled = await hit('/api/router/providers', {
        method: 'PATCH', body: { id: 'openai', enabled: false },
    });
    assert.equal(enabled.sent.status, 200);
    assert.deepEqual(enabled.ctx.providerRegistry.lastCall('setEnabled'), ['setEnabled', 'openai', false]);

    const upsert = await hit('/api/router/providers', {
        method: 'POST', body: { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com' },
    });
    assert.equal(upsert.sent.status, 200);
    const [, upsertId, upsertBody] = upsert.ctx.providerRegistry.lastCall('upsert');
    assert.equal(upsertId, 'openai');
    assert.equal(upsertBody.name, 'OpenAI');
    assert.ok(upsert.ctx.events.some(([e]) => e === 'router.providers_updated'));
});

test('a throwing provider mutator becomes a 400 with the real message', async () => {
    const boom = makeProviderRegistry({
        addKey: () => { throw new Error('duplicate key'); },
    });
    const { sent } = await hit('/api/router/providers', {
        method: 'POST', providerRegistry: boom, body: { id: 'openai', addKey: 'sk-x' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'duplicate key');
});

// ===========================================================================
//  Usage / models / health / key
// ===========================================================================

test('GET /api/router/usage returns the usage report', async () => {
    const { sent, ctx } = await hit('/api/router/usage');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { totalTokens: 42, cost: 0.01 });
    assert.ok(ctx.providerRouter.lastCall('getUsageReport'));
    assert.equal(ctx.providerRouter.lastCall('resetUsage'), undefined);
});

test('DELETE /api/router/usage resets usage and broadcasts', async () => {
    const { sent, ctx } = await hit('/api/router/usage', { method: 'DELETE' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.ok(ctx.providerRouter.lastCall('resetUsage'));
    assert.ok(ctx.events.some(([e]) => e === 'router.usage_reset'));
});

test('GET /api/router/models forwards the force query', async () => {
    const forced = await hit('/api/router/models', { query: { force: 'true' } });
    assert.equal(forced.sent.status, 200);
    assert.deepEqual(forced.sent.body.models, [{ id: 'gpt-4' }]);
    assert.deepEqual(forced.ctx.providerRouter.lastCall('listModels')[1], { force: true });

    const cached = await hit('/api/router/models', { query: { force: '1' } });
    assert.deepEqual(cached.ctx.providerRouter.lastCall('listModels')[1], { force: false });
});

test('GET /api/router/health returns circuit and key usage', async () => {
    const { sent, ctx } = await hit('/api/router/health');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.health, { openai: 'ok' });
    assert.deepEqual(sent.body.keys, { openai: 3 });
    assert.ok(ctx.providerRouter.lastCall('getHealth'));
    assert.ok(ctx.providerRouter.lastCall('getKeyUsage'));
});

test('GET /api/router/key returns the master key and local baseUrl', async () => {
    const { sent, ctx } = await hit('/api/router/key', { port: 3141 });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.masterKey, 'master-key-abc');
    assert.equal(sent.body.baseUrl, 'http://127.0.0.1:3141/v1');
    assert.ok(ctx.providerRouter.lastCall('getMasterKey'));
});

// ===========================================================================
//  Agent overrides
// ===========================================================================

test('GET /api/agents/override returns describeAll()', async () => {
    const { sent, ctx } = await hit('/api/agents/override');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.overrides, [{ agentKey: 'codex', enabled: true }]);
    assert.ok(ctx.agentOverrides.lastCall('describeAll'));
});

test('POST /api/agents/override enable requires agentKey', async () => {
    const { sent, ctx } = await hit('/api/agents/override', {
        method: 'POST', body: { enabled: true },
    });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /agentKey/);
    assert.equal(ctx.agentOverrides.lastCall('enable'), undefined);
});

test('POST /api/agents/override enable without apiKey and no router is 400', async () => {
    const { sent, ctx } = await hit('/api/agents/override', {
        method: 'POST',
        providerRouter: null,
        body: { agentKey: 'codex', enabled: true },
    });
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /apiKey/);
    assert.equal(ctx.agentOverrides.lastCall('enable'), undefined);
});

test('POST /api/agents/override enable uses the router master key by default', async () => {
    const { sent, ctx } = await hit('/api/agents/override', {
        method: 'POST',
        body: { agentKey: 'codex', enabled: true, model: 'gpt-4' },
    });
    assert.equal(sent.status, 200);
    const [, agentKey, opts] = ctx.agentOverrides.lastCall('enable');
    assert.equal(agentKey, 'codex');
    assert.equal(opts.providerId, 'omnirouter');
    assert.equal(opts.apiKey, 'master-key-abc');
    assert.equal(opts.baseUrl, 'http://127.0.0.1:3141/v1');
    assert.equal(opts.model, 'gpt-4');
    assert.ok(ctx.events.some(([e, d]) => e === 'router.override_updated' && d.enabled === true));
    assert.ok(ctx.audits.some((a) => a[2] === 'agent_override'));
});

test('POST /api/agents/override accepts agentId as an alias and an explicit apiKey', async () => {
    const { ctx } = await hit('/api/agents/override', {
        method: 'POST',
        providerRouter: null,
        body: { agentId: 'grok', enabled: true, apiKey: 'sk-explicit', providerId: 'xai' },
    });
    const [, agentKey, opts] = ctx.agentOverrides.lastCall('enable');
    assert.equal(agentKey, 'grok');
    assert.equal(opts.apiKey, 'sk-explicit');
    assert.equal(opts.providerId, 'xai');
});

test('POST /api/agents/override disable calls disable()', async () => {
    const { sent, ctx } = await hit('/api/agents/override', {
        method: 'POST', body: { agentKey: 'codex', enabled: false },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.agentOverrides.lastCall('disable'), ['disable', 'codex']);
    assert.equal(ctx.agentOverrides.lastCall('enable'), undefined);
    assert.ok(ctx.events.some(([e, d]) => e === 'router.override_updated' && d.enabled === false));
});

test('a throwing enable() becomes a 400 with the real message', async () => {
    const boom = makeAgentOverrides({
        enable: () => { throw new Error('unknown agent: ghost'); },
    });
    const { sent } = await hit('/api/agents/override', {
        method: 'POST', agentOverrides: boom, body: { agentKey: 'ghost', enabled: true, apiKey: 'k' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'unknown agent: ghost');
});

// ===========================================================================
//  Memory search
// ===========================================================================

test('GET /api/memories/search uses query.q and forwards filters', async () => {
    const { sent, ctx } = await hit('/api/memories/search', {
        query: { q: 'deploy', chatId: 'c1', agentId: 'codex', limit: '5' },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.query, 'deploy');
    assert.deepEqual(sent.body.results, [{ id: 1, text: 'hello' }]);
    const [, text, opts] = ctx.memorySearch.lastCall('search');
    assert.equal(text, 'deploy');
    assert.deepEqual(opts, { chatId: 'c1', agentId: 'codex', limit: 5 });
    assert.ok(ctx.memorySearch.lastCall('stats'));
});

test('GET /api/memories/search falls back to query.query and a default limit', async () => {
    const { ctx, sent } = await hit('/api/memories/search', { query: { query: 'recall' } });
    assert.equal(sent.body.query, 'recall');
    const [, text, opts] = ctx.memorySearch.lastCall('search');
    assert.equal(text, 'recall');
    assert.equal(opts.limit, 20);
});

test('POST /api/memories/reindex reindexes and broadcasts', async () => {
    const { sent, ctx } = await hit('/api/memories/reindex', { method: 'POST' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.indexed, 12);
    assert.ok(ctx.memorySearch.lastCall('reindexAll'));
    assert.ok(ctx.events.some(([e, d]) => e === 'memory.reindexed' && d.indexed === 12));
});

// ===========================================================================
//  Task planner
// ===========================================================================

test('POST /api/planner/plan and /run require a request', async () => {
    for (const pathname of ['/api/planner/plan', '/api/planner/run']) {
        for (const body of [{}, { request: '   ' }, { message: '' }]) {
            const { sent, ctx } = await hit(pathname, { method: 'POST', body });
            assert.equal(sent.status, 400, `${pathname} ${JSON.stringify(body)} should be 400`);
            assert.match(sent.body.error, /request/);
            assert.equal(ctx.taskPlanner.lastCall('plan'), undefined);
            assert.equal(ctx.taskPlanner.lastCall('run'), undefined);
        }
    }
});

test('POST /api/planner/plan calls plan() and accepts message as an alias', async () => {
    const { sent, ctx } = await hit('/api/planner/plan', {
        method: 'POST',
        body: { message: 'split this', context: 'ctx' },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    const [, request, opts] = ctx.taskPlanner.lastCall('plan');
    assert.equal(request, 'split this');
    assert.deepEqual(opts, { context: 'ctx' });
    assert.deepEqual(sent.body.plan, { tasks: [{ id: 't1' }] });
});

test('POST /api/planner/run calls run() with concurrency and onProgress', async () => {
    const planner = makeTaskPlanner({
        run: async (request, opts) => {
            opts.onProgress({ stage: 'start' });
            return { plan: { tasks: [{ id: 't1' }, { id: 't2' }] } };
        },
    });
    const { sent, ctx } = await hit('/api/planner/run', {
        method: 'POST',
        taskPlanner: planner,
        body: { request: 'do the thing', concurrency: 5 },
    });
    assert.equal(sent.status, 200);
    const [, request, opts] = ctx.taskPlanner.lastCall('run');
    assert.equal(request, 'do the thing');
    assert.equal(opts.concurrency, 5);
    assert.equal(typeof opts.onProgress, 'function');
    assert.ok(ctx.events.some(([e]) => e === 'planner.progress'));
    assert.ok(ctx.audits.some((a) => a[2] === 'plan_executed'));
    assert.equal(sent.body.ok, true);
});

test('a throwing plan()/run() becomes a 500 with the real message', async () => {
    const boomPlan = makeTaskPlanner({ plan: async () => { throw new Error('planner switch is off'); } });
    const p = await hit('/api/planner/plan', {
        method: 'POST', taskPlanner: boomPlan, body: { request: 'x' },
    });
    assert.equal(p.sent.status, 500);
    assert.equal(p.sent.body.error, 'planner switch is off');

    const boomRun = makeTaskPlanner({ run: async () => { throw new Error('no models'); } });
    const r = await hit('/api/planner/run', {
        method: 'POST', taskPlanner: boomRun, body: { request: 'x' },
    });
    assert.equal(r.sent.status, 500);
    assert.equal(r.sent.body.error, 'no models');
});

// ===========================================================================
//  Scheduler
// ===========================================================================

test('GET /api/scheduler/tasks forwards chatId to the db', async () => {
    const { sent, ctx } = await hit('/api/scheduler/tasks', {
        query: { chatId: 'c9' },
        dbMethods: { getScheduledTasks: () => [{ id: 'sched-1' }] },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body.tasks, [{ id: 'sched-1' }]);
    assert.deepEqual(ctx.db.lastCall('getScheduledTasks'), ['getScheduledTasks', 'c9']);
});

test('POST /api/scheduler/tasks requires schedule and prompt', async () => {
    const missing = await hit('/api/scheduler/tasks', { method: 'POST', body: {} });
    assert.equal(missing.sent.status, 400);
    assert.match(missing.sent.body.error, /schedule/);
    assert.match(missing.sent.body.error, /prompt/);

    const noPrompt = await hit('/api/scheduler/tasks', {
        method: 'POST', body: { schedule: '* * * * *' },
    });
    assert.equal(noPrompt.sent.status, 400);
    assert.equal(noPrompt.ctx.scheduler.lastCall('scheduleTask'), undefined);
});

test('POST /api/scheduler/tasks validates cron then schedules', async () => {
    const { sent, ctx } = await hit('/api/scheduler/tasks', {
        method: 'POST',
        body: { schedule: '0 3 * * *', prompt: 'daily digest', chatId: 'c1', agentId: 'codex' },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.scheduler.lastCall('parseCron'), ['parseCron', '0 3 * * *']);
    assert.deepEqual(ctx.scheduler.lastCall('scheduleTask')[1], {
        chatId: 'c1', agentId: 'codex', prompt: 'daily digest', schedule: '0 3 * * *',
    });
    assert.ok(ctx.events.some(([e]) => e === 'scheduler.task_created'));
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.task.id, 'sched-1');
});

test('POST /api/scheduler/tasks bubbles an invalid cron as 400', async () => {
    const boom = makeScheduler({
        parseCron: () => { throw new Error('invalid cron: nope'); },
    });
    const { sent, ctx } = await hit('/api/scheduler/tasks', {
        method: 'POST',
        scheduler: boom,
        body: { schedule: 'nope', prompt: 'x' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error, 'invalid cron: nope');
    assert.equal(ctx.scheduler.lastCall('scheduleTask'), undefined);
});

test('DELETE /api/scheduler/tasks/:id percent-decodes the id', async () => {
    const { sent, ctx } = await hit('/api/scheduler/tasks/task%3A42', { method: 'DELETE' });
    assert.equal(sent.status, 200);
    assert.deepEqual(ctx.db.lastCall('deleteScheduledTask'), ['deleteScheduledTask', 'task:42']);
    assert.ok(ctx.events.some(([e, d]) => e === 'scheduler.task_deleted' && d.id === 'task:42'));
});

test('PATCH /api/scheduler/tasks/:id maps status to paused or active', async () => {
    const paused = await hit('/api/scheduler/tasks/t1', {
        method: 'PATCH', body: { status: 'paused' },
    });
    assert.equal(paused.sent.status, 200);
    assert.deepEqual(paused.ctx.db.lastCall('setScheduledTaskStatus'), ['setScheduledTaskStatus', 't1', 'paused']);
    assert.equal(paused.sent.body.status, 'paused');
    assert.ok(paused.ctx.events.some(([e]) => e === 'scheduler.task_updated'));

    const active = await hit('/api/scheduler/tasks/t1', {
        method: 'POST', body: { status: 'anything-else' },
    });
    assert.equal(active.sent.status, 200);
    assert.deepEqual(active.ctx.db.lastCall('setScheduledTaskStatus'), ['setScheduledTaskStatus', 't1', 'active']);
});

// ===========================================================================
//  Self-improvement
// ===========================================================================

test('GET /api/improve reports a disarmed sweep when no task exists', async () => {
    const { sent } = await hit('/api/improve', { upstreamWatch: null });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.enabled, false);
    assert.equal(sent.body.schedule, null);
    assert.deepEqual(sent.body.sources, []);
});

test('GET /api/improve is armed only while the reserved task is active', async () => {
    const active = await hit('/api/improve', {
        dbMethods: {
            getScheduledTasks: () => [{
                id: 'imp-1', agent_id: IMPROVE_AGENT_ID, status: 'active',
                schedule: '0 3 * * *', next_run: 99, last_run: 1, last_result: 'ok',
            }],
        },
    });
    assert.equal(active.sent.status, 200);
    assert.equal(active.sent.body.enabled, true);
    assert.equal(active.sent.body.schedule, '0 3 * * *');
    assert.equal(active.sent.body.nextRun, 99);
    assert.equal(active.sent.body.sources[0].id, 'openclaw');
    assert.equal(active.sent.body.sources[0].local, true);

    const paused = await hit('/api/improve', {
        dbMethods: {
            getScheduledTasks: () => [{
                id: 'imp-1', agent_id: IMPROVE_AGENT_ID, status: 'paused',
                schedule: '0 3 * * *', next_run: 99, last_run: null, last_result: null,
            }],
        },
        upstreamWatch: null,
    });
    assert.equal(paused.sent.body.enabled, false);
});

test('POST /api/improve runNow returns the sweep report without needing a scheduler', async () => {
    const { sent, ctx } = await hit('/api/improve', {
        method: 'POST',
        scheduler: null,
        body: { runNow: true, acknowledge: true },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.ok, true);
    assert.equal(sent.body.learning.promotedRules.length, 1);
    assert.equal(sent.body.upstream.total, 1);
    assert.equal(typeof sent.body.digest, 'string');
    assert.deepEqual(sent.body.acknowledged, ['openclaw']);
    assert.ok(ctx.selfImprovement.lastCall('evaluateAndLearn'));
    assert.ok(ctx.upstreamWatch.lastCall('acknowledge'));
    assert.ok(ctx.db.lastCall('recordHiveMind'));
});

test('POST /api/improve runNow still 200s when learning or upstream throw', async () => {
    const { sent } = await hit('/api/improve', {
        method: 'POST',
        body: { runNow: true },
        selfImprovement: makeSelfImprovement({
            evaluateAndLearn: async () => { throw new Error('no turns'); },
        }),
        upstreamWatch: makeUpstreamWatch({
            checkAll: async () => { throw new Error('github down'); },
        }),
    });
    assert.equal(sent.status, 200);
    assert.ok(sent.body.errors.some((e) => /learning: no turns/.test(e)));
    assert.ok(sent.body.errors.some((e) => /upstream: github down/.test(e)));
});

test('POST /api/improve arms a daily sweep on the reserved agent id', async () => {
    const { sent, ctx } = await hit('/api/improve', {
        method: 'POST',
        body: { enabled: true },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.enabled, true);
    assert.equal(sent.body.schedule, '0 3 * * *');
    assert.deepEqual(ctx.scheduler.lastCall('parseCron'), ['parseCron', '0 3 * * *']);
    assert.deepEqual(ctx.scheduler.lastCall('scheduleTask')[1], {
        chatId: '',
        agentId: IMPROVE_AGENT_ID,
        prompt: 'Self-improvement sweep and upstream update check',
        schedule: '0 3 * * *',
    });
    assert.ok(ctx.events.some(([e]) => e === 'improve.armed'));
    assert.ok(ctx.audits.some((a) => a[2] === 'improve_armed'));
});

test('POST /api/improve arming replaces an existing reserved task and rejects bad cron', async () => {
    const replaced = await hit('/api/improve', {
        method: 'POST',
        body: { enabled: true, schedule: '0 4 * * *' },
        dbMethods: {
            getScheduledTasks: () => [{ id: 'old-imp', agent_id: IMPROVE_AGENT_ID, status: 'active' }],
        },
    });
    assert.equal(replaced.sent.status, 200);
    assert.deepEqual(replaced.ctx.db.lastCall('deleteScheduledTask'), ['deleteScheduledTask', 'old-imp']);

    const boom = makeScheduler({
        parseCron: () => { throw new Error('invalid cron: xyz'); },
    });
    const bad = await hit('/api/improve', {
        method: 'POST', scheduler: boom, body: { enabled: true, schedule: 'xyz' },
    });
    assert.equal(bad.sent.status, 400);
    assert.equal(bad.sent.body.error, 'invalid cron: xyz');
    assert.equal(bad.ctx.scheduler.lastCall('scheduleTask'), undefined);
});

test('POST /api/improve disable deletes the reserved task', async () => {
    const { sent, ctx } = await hit('/api/improve', {
        method: 'POST',
        body: { enabled: false },
        dbMethods: {
            getScheduledTasks: () => [{ id: 'imp-1', agent_id: IMPROVE_AGENT_ID, status: 'active' }],
        },
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.enabled, false);
    assert.deepEqual(ctx.db.lastCall('deleteScheduledTask'), ['deleteScheduledTask', 'imp-1']);
    assert.ok(ctx.events.some(([e]) => e === 'improve.disarmed'));
    assert.ok(ctx.audits.some((a) => a[2] === 'improve_disarmed'));
});

test('runImprovement is exported and records a hive-mind row', async () => {
    const { ctx } = makeCtx();
    const out = await runImprovement(ctx, { acknowledge: false });
    assert.equal(out.learning.promotedRules.length, 1);
    assert.equal(out.upstream.total, 1);
    assert.equal(typeof out.digest, 'string');
    assert.equal(out.acknowledged, undefined);
    assert.ok(ctx.db.lastCall('recordHiveMind'));
});

// ===========================================================================
//  Upstream + Syncthing
// ===========================================================================

test('GET /api/upstream returns checkAll plus a digest', async () => {
    const { sent, ctx } = await hit('/api/upstream');
    assert.equal(sent.status, 200);
    assert.equal(sent.body.total, 1);
    assert.match(sent.body.digest, /openclaw/);
    assert.ok(ctx.upstreamWatch.lastCall('checkAll'));
});

test('POST /api/upstream acknowledges only when asked', async () => {
    const acked = await hit('/api/upstream', { method: 'POST', body: { acknowledge: true } });
    assert.equal(acked.sent.status, 200);
    assert.deepEqual(acked.sent.body.acknowledged, ['openclaw']);
    assert.ok(acked.ctx.upstreamWatch.lastCall('acknowledge'));

    const skipped = await hit('/api/upstream', { method: 'POST', body: {} });
    assert.deepEqual(skipped.sent.body.acknowledged, []);
    assert.equal(skipped.ctx.upstreamWatch.lastCall('acknowledge'), undefined);
});

test('GET /api/sync returns the syncthing overview', async () => {
    const { sent, ctx } = await hit('/api/sync');
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { running: true, devices: 1 });
    assert.ok(ctx.syncthing.lastCall('overview'));
});

test('POST /api/sync dispatches known actions and 400s on an unknown one', async () => {
    const add = await hit('/api/sync', {
        method: 'POST',
        body: { action: 'add-device', deviceId: 'DEV1', name: 'laptop', addresses: ['dynamic'] },
    });
    assert.equal(add.sent.status, 200);
    assert.deepEqual(add.ctx.syncthing.lastCall('addDevice'), ['addDevice', 'DEV1', 'laptop', ['dynamic']]);
    assert.ok(add.ctx.events.some(([e]) => e === 'sync.changed'));
    assert.ok(add.ctx.audits.some((a) => a[2] === 'syncthing_action'));

    const share = await hit('/api/sync', {
        method: 'POST', body: { action: 'share-folder', folderId: 'vault', deviceId: 'DEV1' },
    });
    assert.deepEqual(share.ctx.syncthing.lastCall('shareFolder'), ['shareFolder', 'vault', 'DEV1']);

    const rescan = await hit('/api/sync', { method: 'POST', body: { action: 'rescan' } });
    assert.deepEqual(rescan.ctx.syncthing.lastCall('rescan'), ['rescan', null]);

    const pause = await hit('/api/sync', {
        method: 'PATCH', body: { action: 'pause', folderId: 'vault' },
    });
    assert.deepEqual(pause.ctx.syncthing.lastCall('setPaused'), ['setPaused', 'vault', true]);

    const resume = await hit('/api/sync', {
        method: 'POST', body: { action: 'resume', folderId: 'vault' },
    });
    assert.deepEqual(resume.ctx.syncthing.lastCall('setPaused'), ['setPaused', 'vault', false]);

    const unknown = await hit('/api/sync', { method: 'POST', body: { action: 'explode' } });
    assert.equal(unknown.sent.status, 400);
    assert.match(unknown.sent.body.error, /explode/);
    assert.match(unknown.sent.body.error, /add-device/);
});

test('a throwing syncthing action becomes a 400 carrying the real message', async () => {
    const boom = makeSyncthing({
        addDevice: async () => { throw new Error('invalid device id'); },
    });
    const { sent } = await hit('/api/sync', {
        method: 'POST', syncthing: boom, body: { action: 'add-device', deviceId: 'nope' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.ok, false);
    assert.equal(sent.body.action, 'add-device');
    assert.equal(sent.body.error, 'invalid device id');
});

// ===========================================================================
//  Response-count contract
// ===========================================================================

test('exactly one response is sent per handled request', async () => {
    const cases = [
        ['/api/router/providers', { method: 'GET' }],
        ['/api/router/providers', { method: 'POST', body: {} }],
        ['/api/router/usage', { method: 'GET' }],
        ['/api/router/usage', { method: 'DELETE' }],
        ['/api/router/models', { method: 'GET' }],
        ['/api/router/health', { method: 'GET' }],
        ['/api/router/key', { method: 'GET' }],
        ['/api/agents/override', { method: 'GET' }],
        ['/api/agents/override', { method: 'POST', body: { enabled: true } }],
        ['/api/memories/search', { method: 'GET', query: { q: 'x' } }],
        ['/api/memories/reindex', { method: 'POST' }],
        ['/api/planner/plan', { method: 'POST', body: { request: 'x' } }],
        ['/api/planner/plan', { method: 'POST', body: {} }],
        ['/api/scheduler/tasks', { method: 'GET' }],
        ['/api/scheduler/tasks', { method: 'POST', body: { schedule: '* * * * *', prompt: 'p' } }],
        ['/api/scheduler/tasks/t1', { method: 'DELETE' }],
        ['/api/improve', { method: 'GET' }],
        ['/api/improve', { method: 'POST', body: { runNow: true } }],
        ['/api/upstream', { method: 'GET' }],
        ['/api/sync', { method: 'GET' }],
        ['/api/sync', { method: 'POST', body: { action: 'nope' } }],
    ];
    for (const [pathname, opts] of cases) {
        const { handled, sent } = await hit(pathname, opts);
        assert.equal(handled, true, `${pathname} should be handled`);
        assert.equal(sent.count, 1, `${opts.method || 'GET'} ${pathname} sent ${sent.count} responses`);
    }
});
