const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const GoalEngine = require('../core/GoalEngine');
const { GOAL_STATUS } = require('../core/GoalEngine');
const { AssistantDatabase } = require('../core/Database');

// -----------------------------------------------------------------------------
//  Helpers — hermetic. Every collaborator is a fake; the real store/ is never
//  touched. SQLite keeps file handles open on Windows, so cleanup is
//  best-effort: an EPERM on rmSync must never fail a test.
// -----------------------------------------------------------------------------

function makeEngine(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-'));
    const database = new AssistantDatabase(path.join(dir, 'goals.db'));
    const engine = new GoalEngine({ database, ...opts });
    const handles = [database];
    return {
        engine,
        database,
        dir,
        /** Reopen the same file, to prove state is durable rather than in-memory. */
        reopen(extra = {}) {
            const db2 = new AssistantDatabase(path.join(dir, 'goals.db'));
            handles.push(db2);
            return new GoalEngine({ database: db2, ...opts, ...extra });
        },
        cleanup() {
            for (const db of handles) {
                try { if (db.db && typeof db.db.close === 'function') db.db.close(); } catch (e) { /* already closed */ }
            }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

/** A taskRunner that records every invocation and can be told to fail. */
function makeRunner({ fail = false, output = 'done' } = {}) {
    const calls = [];
    const runner = async (ctx) => {
        calls.push(ctx);
        if (fail) throw new Error('step exploded');
        return output;
    };
    return { runner, calls, get count() { return calls.length; } };
}

/** Planner producing a fixed two-step plan. */
function makePlanner(tasks) {
    return {
        plan: async () => ({
            tasks: tasks || [
                { id: 'a', type: 'research', description: 'first', dependsOn: [] },
                { id: 'b', type: 'writing', description: 'second', dependsOn: ['a'] },
            ],
        }),
    };
}

// ===========================================================================
//  Persistence
// ===========================================================================

test('create, get and list round-trip, and survive a reopen', () => {
    const box = makeEngine();
    try {
        const goal = box.engine.create({ title: 'Ship the VPS deploy', description: 'nginx + certbot', chatId: 'c1' });
        assert.ok(goal.id);
        assert.equal(goal.status, GOAL_STATUS.PENDING);

        const fetched = box.engine.get(goal.id);
        assert.equal(fetched.title, 'Ship the VPS deploy');

        assert.equal(box.engine.list({ chatId: 'c1' }).length, 1);

        // The point of a goal is that it outlives the process.
        const revived = box.reopen();
        const after = revived.get(goal.id);
        assert.equal(after.title, 'Ship the VPS deploy');
        assert.equal(after.status, GOAL_STATUS.PENDING);
    } finally { box.cleanup(); }
});

test('an empty or whitespace title is rejected', () => {
    const box = makeEngine();
    try {
        for (const bad of ['', '   ', null, undefined]) {
            assert.throws(() => box.engine.create({ title: bad }), /title/i);
        }
        assert.equal(box.engine.list({}).length, 0, 'nothing may be persisted');
    } finally { box.cleanup(); }
});

test('list filters by status', () => {
    const box = makeEngine();
    try {
        const a = box.engine.create({ title: 'one' });
        box.engine.create({ title: 'two' });
        box.engine.abandon(a.id, 'not needed');

        const abandoned = box.engine.list({ status: GOAL_STATUS.ABANDONED });
        assert.equal(abandoned.length, 1);
        assert.equal(abandoned[0].id, a.id);
        assert.equal(box.engine.list({ status: GOAL_STATUS.PENDING }).length, 1);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Planning
// ===========================================================================

test('planGoal persists the planner output and leaves the goal runnable', async () => {
    const box = makeEngine({ planner: makePlanner() });
    try {
        const goal = box.engine.create({ title: 'two step job' });
        const planned = await box.engine.planGoal(goal.id);
        assert.ok(planned, 'planGoal must return the goal');

        const stored = box.engine.get(goal.id);
        assert.notEqual(stored.status, GOAL_STATUS.PENDING, 'status must advance past pending');
        assert.ok(stored.plan_json, 'the plan must be persisted, not held in memory');
        const plan = JSON.parse(stored.plan_json);
        assert.ok(Array.isArray(plan.steps), 'persisted plan uses steps, not the planner-shaped tasks array');
        assert.equal(plan.steps.length, 2);

        const revived = box.reopen();
        const after = revived.get(goal.id);
        assert.equal(after.status, stored.status);
        assert.equal(after.plan_json, stored.plan_json);
    } finally { box.cleanup(); }
});

test('planGoal with NO planner degrades to a single step instead of throwing', async () => {
    const box = makeEngine(); // no planner injected
    try {
        const goal = box.engine.create({ title: 'unplanned', description: 'just do the thing' });
        await assert.doesNotReject(() => box.engine.planGoal(goal.id));

        const stored = box.engine.get(goal.id);
        assert.ok(stored.plan_json, 'a fallback plan must still be persisted');
        const plan = JSON.parse(stored.plan_json);
        assert.equal(plan.steps.length, 1, 'degrades to one step carrying the request');
    } finally { box.cleanup(); }
});

// ===========================================================================
//  step() — one unit of work, and the retry ceiling
// ===========================================================================

test('step performs exactly ONE unit of work per call', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'two step job' });
        await box.engine.planGoal(goal.id);

        await box.engine.step(goal.id);
        assert.equal(r.count, 1, 'one call must run one step, not loop to completion');

        await box.engine.step(goal.id);
        assert.equal(r.count, 2, 'the second call advances one more step');
    } finally { box.cleanup(); }
});

test('progress rises monotonically and never exceeds its ceiling', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'two step job' });
        await box.engine.planGoal(goal.id);

        let previous = -1;
        for (let i = 0; i < 4; i++) {
            const res = await box.engine.step(goal.id);
            assert.ok(res.progress >= previous, `progress went backwards: ${previous} -> ${res.progress}`);
            assert.ok(res.progress <= 100, `progress exceeded 100: ${res.progress}`);
            previous = res.progress;
        }
    } finally { box.cleanup(); }
});

test('a goal eventually completes and then consumes no more work', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'two step job' });
        await box.engine.planGoal(goal.id);

        for (let i = 0; i < 6; i++) await box.engine.step(goal.id);
        const done = box.engine.get(goal.id);
        assert.equal(done.status, GOAL_STATUS.COMPLETED);

        const runsAtCompletion = r.count;
        await box.engine.step(goal.id);
        assert.equal(r.count, runsAtCompletion, 'a completed goal must not run more work');
    } finally { box.cleanup(); }
});

test('a failing step is retried, then BLOCKED — never retried forever', async () => {
    // This is the load-bearing safety property. An unbounded retry loop would
    // burn the user's subscription, which is exactly the failure mode this
    // whole app is meant to avoid.
    const r = makeRunner({ fail: true });
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner, maxAttempts: 3 });
    try {
        const goal = box.engine.create({ title: 'doomed', maxAttempts: 3 });
        await box.engine.planGoal(goal.id);

        for (let i = 0; i < 12; i++) await box.engine.step(goal.id);

        const stored = box.engine.get(goal.id);
        assert.equal(stored.status, GOAL_STATUS.BLOCKED, 'must end blocked, not still running');
        assert.ok(stored.last_error, 'the real error must be recorded');

        const runsWhenBlocked = r.count;
        assert.ok(runsWhenBlocked <= 6, `retried ${runsWhenBlocked} times for maxAttempts 3 — unbounded`);

        await box.engine.step(goal.id);
        assert.equal(r.count, runsWhenBlocked, 'a blocked goal must stop consuming work');
    } finally { box.cleanup(); }
});

test('step never throws, even when every collaborator rejects', async () => {
    const hostile = {
        plan: async () => { throw new Error('planner down'); },
        run: async () => { throw new Error('planner run down'); },
    };
    const box = makeEngine({
        planner: hostile,
        delegation: { delegate: async () => { throw new Error('delegation down'); } },
        council: { deliberate: async () => { throw new Error('council down'); } },
        memorySearch: { search: () => { throw new Error('memory down'); } },
        skills: { search: () => { throw new Error('skills down'); } },
    });
    try {
        const goal = box.engine.create({ title: 'hostile environment' });
        await assert.doesNotReject(() => box.engine.planGoal(goal.id));
        for (let i = 0; i < 3; i++) {
            await assert.doesNotReject(() => box.engine.step(goal.id));
        }
    } finally { box.cleanup(); }
});

test('step on an unknown goal reports it rather than throwing', async () => {
    const box = makeEngine();
    try {
        const res = await box.engine.step('does-not-exist');
        assert.equal(res.done, true);
        assert.match(String(res.error), /no such goal/i);
    } finally { box.cleanup(); }
});

test('step skips a goal that is already in flight', { timeout: 5000 }, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const enteredP = new Promise((resolve) => { entered = resolve; });
    const runner = async () => {
        entered();
        await gate;
        return 'done';
    };
    const box = makeEngine({ planner: makePlanner(), taskRunner: runner });
    try {
        const goal = box.engine.create({ title: 'one at a time' });
        await box.engine.planGoal(goal.id);

        const first = box.engine.step(goal.id);
        await enteredP;
        const second = await box.engine.step(goal.id);
        assert.match(String(second.error), /already in flight/i);
        assert.equal(second.ok, false);

        release();
        const firstResult = await first;
        assert.equal(firstResult.ok, true);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Council escalation
// ===========================================================================

test('the council is consulted on repeated failure, and only once', async () => {
    const deliberations = [];
    const council = {
        deliberate: async (question) => {
            deliberations.push(question);
            return { question, positions: [{ agentKey: 'claude', text: 'try a different approach', ok: true }], synthesis: 'change tack' };
        },
    };
    const r = makeRunner({ fail: true });
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner, council, maxAttempts: 3 });
    try {
        const goal = box.engine.create({ title: 'needs advice', maxAttempts: 3 });
        await box.engine.planGoal(goal.id);
        for (let i = 0; i < 12; i++) await box.engine.step(goal.id);

        assert.ok(deliberations.length >= 1, 'guidance must be sought on repeated failure');
        assert.equal(deliberations.length, 1, 'asked once, not on every retry');
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Bounded convenience loop
// ===========================================================================

test('runUntilBlocked honours maxSteps', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner([
        { id: 'a', type: 'research', description: '1', dependsOn: [] },
        { id: 'b', type: 'research', description: '2', dependsOn: [] },
        { id: 'c', type: 'research', description: '3', dependsOn: [] },
        { id: 'd', type: 'research', description: '4', dependsOn: [] },
        { id: 'e', type: 'research', description: '5', dependsOn: [] },
    ]), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'five steps' });
        await box.engine.planGoal(goal.id);

        const res = await box.engine.runUntilBlocked(goal.id, { maxSteps: 2 });
        assert.equal(res.stepsRun, 2, 'the cap must be respected even though work remains');
        assert.ok(r.count <= 2);
    } finally { box.cleanup(); }
});

test('tick advances at most maxGoals active goals', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        for (let i = 0; i < 5; i++) {
            const g = box.engine.create({ title: `g${i}` });
            await box.engine.planGoal(g.id);
        }

        const report = await box.engine.tick({ maxGoals: 2 });
        assert.match(String(report), /advanced 2/);
        assert.equal(r.count, 2, 'the cap is a hard ceiling, not a suggestion');

        await box.engine.tick();
        assert.equal(r.count, 5, 'default tick cap is 3 (2 already stepped + 3 more)');
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Human input and abandonment
// ===========================================================================

test('needsInput pauses the goal until an answer arrives', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'ambiguous' });
        await box.engine.planGoal(goal.id);

        box.engine.needsInput(goal.id, 'Which domain should it deploy to?');
        assert.equal(box.engine.get(goal.id).status, GOAL_STATUS.NEEDS_INPUT);
        assert.match(String(box.engine.pendingQuestion(goal.id)), /domain/i);

        const before = r.count;
        await box.engine.step(goal.id);
        assert.equal(r.count, before, 'a goal awaiting input must not guess and proceed');

        box.engine.provideInput(goal.id, 'example.com');
        assert.notEqual(box.engine.get(goal.id).status, GOAL_STATUS.NEEDS_INPUT);
        await box.engine.step(goal.id);
        assert.ok(r.count > before, 'it resumes once answered');
    } finally { box.cleanup(); }
});

test('provideInput on an unknown id does not throw', () => {
    const box = makeEngine();
    try {
        let result;
        assert.doesNotThrow(() => { result = box.engine.provideInput('does-not-exist', 'hello'); });
        assert.equal(result, null);
    } finally { box.cleanup(); }
});

test('abandon stops all further progress; resume reinstates a blocked goal', async () => {
    const r = makeRunner();
    const box = makeEngine({ planner: makePlanner(), taskRunner: r.runner });
    try {
        const goal = box.engine.create({ title: 'cancel me' });
        await box.engine.planGoal(goal.id);

        box.engine.abandon(goal.id, 'no longer relevant');
        assert.equal(box.engine.get(goal.id).status, GOAL_STATUS.ABANDONED);

        const before = r.count;
        await box.engine.step(goal.id);
        assert.equal(r.count, before, 'an abandoned goal is a no-op');

        box.engine.resume(goal.id);
        assert.notEqual(box.engine.get(goal.id).status, GOAL_STATUS.ABANDONED);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Degenerate construction and reporting
// ===========================================================================

test('the engine works with only a database injected', async () => {
    const box = makeEngine(); // nothing else
    try {
        const goal = box.engine.create({ title: 'bare' });
        await assert.doesNotReject(() => box.engine.planGoal(goal.id));
        await assert.doesNotReject(() => box.engine.step(goal.id));
        assert.ok(box.engine.summary());
    } finally { box.cleanup(); }
});

test('a database is required', () => {
    assert.throws(() => new GoalEngine({}), /database/i);
});

test('summary counts by status', () => {
    const box = makeEngine();
    try {
        const a = box.engine.create({ title: 'a' });
        box.engine.create({ title: 'b' });
        box.engine.create({ title: 'c' });
        box.engine.abandon(a.id, 'x');

        const s = box.engine.summary();
        assert.equal(s.total, 3);
        assert.equal(s.byStatus[GOAL_STATUS.ABANDONED], 1);
        assert.equal(s.byStatus[GOAL_STATUS.PENDING], 2);
    } finally { box.cleanup(); }
});

test('registerWithScheduler installs a handler without touching the scheduler internals', () => {
    const registered = [];
    const fakeScheduler = {
        registerTaskHandler(agentId, handler) { registered.push({ agentId, handler }); return this; },
        scheduleTask(spec) { registered.push({ scheduled: spec }); return { id: 'task_1', ...spec }; },
        parseCron() { return true; },
    };
    const box = makeEngine();
    try {
        box.engine.registerWithScheduler(fakeScheduler);
        assert.ok(registered.length >= 1, 'a handler must be registered');
        const handler = registered.find((r) => typeof r.handler === 'function');
        assert.ok(handler, 'the registered value must be callable');
    } finally { box.cleanup(); }
});
