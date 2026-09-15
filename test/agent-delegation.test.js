const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const AgentDelegation = require('../core/AgentDelegation');
const { AssistantDatabase } = require('../core/Database');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const AGENTS = { main: {}, claude: {}, codex: {}, hermes: {}, grok: {} };

/**
 * Fresh sqlite-backed delegation engine in a temp dir. SQLite keeps file
 * handles open on Windows, so cleanup is best-effort — an EPERM on rmSync must
 * never fail a test. The real store/ directory is never touched.
 */
function makeDelegation(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-'));
    const dbPath = path.join(dir, 'test.db');
    const database = new AssistantDatabase(dbPath);
    const events = [];
    const delegation = new AgentDelegation({
        database,
        agents: AGENTS,
        eventBus: { emit: (event, payload) => events.push({ event, payload }) },
        runner: async (task) => `done:${task.prompt}`,
        ...opts,
    });
    return {
        delegation,
        database,
        events,
        dir,
        dbPath,
        cleanup() {
            try { database.db.close(); } catch (e) { /* already closed */ }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

/** Minimal stand-in for ActionExecutor's queue/idle contract. */
function makeFakeExecutor(reply) {
    const executor = {
        agents: AGENTS,
        sessionStore: {
            pinned: [],
            setActiveAgent(agentKey, chatId) { executor.sessionStore.pinned.push([agentKey, chatId]); },
        },
        queues: new Map(),
        active: new Map(),
        lastResponses: new Map(),
        enqueued: [],
        _enqueue(message) {
            executor.enqueued.push(message);
            executor.active.set(message.chatId, true);
            setImmediate(async () => {
                await message.raw.reply('Thinking...');            // must be ignored
                await message.raw.reply(reply(message));
                executor.active.delete(message.chatId);
            });
        },
    };
    return executor;
}

// ===========================================================================
//  Round trip
// ===========================================================================

test('a delegation round-trip persists as pending then completes', async () => {
    const { delegation, database, events, cleanup } = makeDelegation();
    try {
        const task = delegation.delegate({
            fromAgent: 'main', toAgent: 'claude', prompt: 'summarise the log', chatId: 'c1',
        });

        assert.ok(task.id, 'a task id must be assigned');
        assert.equal(task.status, 'pending');
        assert.equal(task.from_agent, 'main');
        assert.equal(task.to_agent, 'claude');
        assert.equal(task.chat_id, 'c1');
        assert.equal(task.prompt, 'summarise the log');
        assert.equal(task.result, null);
        assert.equal(task.completed_at, null);
        assert.ok(task.created_at > 0);
        assert.equal(task.depth, 1);
        assert.deepEqual(task.chain, ['main', 'claude']);

        // It really is in the table nothing used to touch.
        const raw = database.db.prepare('SELECT * FROM inter_agent_tasks WHERE id = ?').get(task.id);
        assert.ok(raw, 'the row must exist in inter_agent_tasks');
        assert.equal(raw.status, 'pending');

        const done = await delegation.run(task.id);
        assert.equal(done.status, 'completed');
        assert.equal(done.result, 'done:summarise the log');
        assert.ok(done.completed_at >= done.created_at, 'completed_at must be stamped');

        // And the stored row agrees with what run() returned.
        assert.equal(delegation.getTask(task.id).status, 'completed');

        const names = events.map((e) => e.event);
        assert.deepEqual(names, [
            AgentDelegation.Events.CREATED,
            AgentDelegation.Events.STARTED,
            AgentDelegation.Events.COMPLETED,
        ]);
        assert.equal(events[2].payload.task.result, 'done:summarise the log');
    } finally { cleanup(); }
});

test('an empty result is still recorded as completed', async () => {
    const { delegation, cleanup } = makeDelegation({ runner: async () => '' });
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'quiet' });
        const done = await delegation.run(task.id);
        assert.equal(done.status, 'completed');
        assert.match(String(done.result), /Completed with no output/);
    } finally { cleanup(); }
});

// ===========================================================================
//  Validation
// ===========================================================================

test('an unknown toAgent is rejected and the error names the valid keys', () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        assert.throws(
            () => delegation.delegate({ fromAgent: 'main', toAgent: 'nope', prompt: 'x' }),
            (err) => {
                assert.match(err.message, /Unknown target agent "nope"/);
                assert.match(err.message, /claude/);
                assert.match(err.message, /codex/);
                return true;
            }
        );
        assert.equal(delegation.getTasks().length, 0, 'a rejected delegation must not be persisted');
    } finally { cleanup(); }
});

test('self-delegation is refused', () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        assert.throws(
            () => delegation.delegate({ fromAgent: 'claude', toAgent: 'claude', prompt: 'x' }),
            /cannot delegate to itself/
        );
        assert.equal(delegation.getTasks().length, 0);
    } finally { cleanup(); }
});

test('an empty prompt is refused', () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        for (const prompt of ['', '   ', null, undefined]) {
            assert.throws(
                () => delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt }),
                /non-empty prompt/,
                `expected ${JSON.stringify(prompt)} to be rejected`
            );
        }
        assert.throws(
            () => delegation.delegate({ fromAgent: '', toAgent: 'claude', prompt: 'x' }),
            /requires a fromAgent/
        );
        assert.equal(delegation.getTasks().length, 0);
    } finally { cleanup(); }
});

// ===========================================================================
//  Loop safety — the guard that keeps a delegation storm off the bill
// ===========================================================================

test('max depth is enforced along a real delegation chain', () => {
    const { delegation, cleanup } = makeDelegation({ maxDepth: 3 });
    try {
        const t1 = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'a', chatId: 'c1' });
        const t2 = delegation.delegate({ fromAgent: 'claude', toAgent: 'codex', prompt: 'b', chatId: 'c1', parentId: t1.id });
        const t3 = delegation.delegate({ fromAgent: 'codex', toAgent: 'hermes', prompt: 'c', chatId: 'c1', parentId: t2.id });

        assert.equal(t1.depth, 1);
        assert.equal(t2.depth, 2);
        assert.equal(t3.depth, 3);
        assert.equal(t2.parent_id, t1.id);
        assert.equal(t3.origin_id, t1.id, 'every hop keeps the same origin');
        assert.deepEqual(delegation.chainOf(t3.id), ['main', 'claude', 'codex', 'hermes']);

        // The fourth hop is over the limit, even though grok is a valid agent.
        assert.throws(
            () => delegation.delegate({ fromAgent: 'hermes', toAgent: 'grok', prompt: 'd', chatId: 'c1', parentId: t3.id }),
            /Delegation depth limit reached \(max 3\)/
        );
        assert.equal(delegation.getTasks({ chatId: 'c1' }).length, 3, 'the refused hop is not persisted');
    } finally { cleanup(); }
});

test('max depth can also be carried by an explicit depth counter', () => {
    const { delegation, cleanup } = makeDelegation({ maxDepth: 3 });
    try {
        // depth = hops already travelled, so 2 leaves room for exactly one more.
        const ok = delegation.delegate({ fromAgent: 'codex', toAgent: 'hermes', prompt: 'x', depth: 2 });
        assert.ok(ok.id);
        assert.throws(
            () => delegation.delegate({ fromAgent: 'codex', toAgent: 'hermes', prompt: 'x', depth: 3 }),
            /Delegation depth limit reached/
        );
        // A lower custom limit bites sooner.
        const shallow = makeDelegation({ maxDepth: 1 });
        try {
            const root = shallow.delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'x' });
            assert.throws(
                () => shallow.delegation.delegate({ fromAgent: 'claude', toAgent: 'codex', prompt: 'x', parentId: root.id }),
                /Delegation depth limit reached \(max 1\)/
            );
        } finally { shallow.cleanup(); }
    } finally { cleanup(); }
});

test('a cycle A -> B -> A is refused', () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        // A delegates to B...
        const ab = delegation.delegate({ fromAgent: 'claude', toAgent: 'codex', prompt: 'work', chatId: 'c1' });
        // ...and B must not hand it straight back to A.
        assert.throws(
            () => delegation.delegate({ fromAgent: 'codex', toAgent: 'claude', prompt: 'back', chatId: 'c1', parentId: ab.id }),
            (err) => {
                assert.match(err.message, /Delegation cycle refused: "claude" is already in the chain/);
                assert.match(err.message, /claude -> codex/);
                return true;
            }
        );

        // The longer loop A -> B -> C -> A is refused too.
        const bc = delegation.delegate({ fromAgent: 'codex', toAgent: 'hermes', prompt: 'more', chatId: 'c1', parentId: ab.id });
        assert.throws(
            () => delegation.delegate({ fromAgent: 'hermes', toAgent: 'claude', prompt: 'loop', chatId: 'c1', parentId: bc.id }),
            /Delegation cycle refused/
        );

        // An explicit chain works the same way, for callers that track it themselves.
        assert.throws(
            () => delegation.delegate({ fromAgent: 'hermes', toAgent: 'main', prompt: 'loop', chain: ['main', 'claude', 'hermes'] }),
            /Delegation cycle refused: "main" is already in the chain/
        );

        assert.equal(delegation.getTasks({ chatId: 'c1' }).length, 2, 'only the two legal hops exist');
    } finally { cleanup(); }
});

test('an unrelated sibling delegation is not mistaken for a cycle', () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        const a = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'a' });
        const b = delegation.delegate({ fromAgent: 'main', toAgent: 'codex', prompt: 'b' });
        assert.notEqual(a.origin_id, b.origin_id, 'two top-level delegations are separate chains');
        // claude may still ask codex, because codex is not in claude's own chain.
        const nested = delegation.delegate({ fromAgent: 'claude', toAgent: 'codex', prompt: 'c', parentId: a.id });
        assert.equal(nested.depth, 2);
    } finally { cleanup(); }
});

// ===========================================================================
//  Failure handling
// ===========================================================================

test('a failing target records failed with the error and never throws', async () => {
    const { delegation, events, cleanup } = makeDelegation({
        runner: async () => { throw new Error('agent exploded'); },
    });
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'boom', chatId: 'c1' });
        const settled = await delegation.run(task.id);   // must not reject

        assert.equal(settled.status, 'failed');
        assert.match(String(settled.result), /Error: agent exploded/);
        assert.ok(settled.completed_at > 0, 'a failure is still a completion timestamp');

        const failure = events.find((e) => e.event === AgentDelegation.Events.FAILED);
        assert.ok(failure, 'a failure event must be emitted');
        assert.match(String(failure.payload.error), /agent exploded/);
    } finally { cleanup(); }
});

test('a hung target is timed out rather than blocking forever', async () => {
    const { delegation, cleanup } = makeDelegation({
        runTimeoutMs: 25,
        runner: () => new Promise(() => {}),   // never settles
    });
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'hang' });
        const settled = await delegation.run(task.id);
        assert.equal(settled.status, 'failed');
        assert.match(String(settled.result), /Timed out after 25 ms/);
    } finally { cleanup(); }
});

test('run() on an unknown or already-settled task is a no-op', async () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        assert.equal(await delegation.run('does-not-exist'), null);

        let calls = 0;
        delegation.runner = async () => { calls += 1; return 'once'; };
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'x' });
        await delegation.run(task.id);
        await delegation.run(task.id);   // already completed
        assert.equal(calls, 1, 'a settled task must not run twice');
    } finally { cleanup(); }
});

// ===========================================================================
//  Queries
// ===========================================================================

test('getTasks filters by agent, status and chat id', async () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        const one = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: '1', chatId: 'c1' });
        const two = delegation.delegate({ fromAgent: 'main', toAgent: 'codex', prompt: '2', chatId: 'c1' });
        const three = delegation.delegate({ fromAgent: 'hermes', toAgent: 'claude', prompt: '3', chatId: 'c2' });
        await delegation.run(one.id);

        assert.equal(delegation.getTasks().length, 3);
        assert.deepEqual(delegation.getTasks({ chatId: 'c2' }).map((t) => t.id), [three.id]);
        assert.equal(delegation.getTasks({ chatId: 'c1' }).length, 2);

        // agentId matches either side of the hand-off.
        const claudeSide = delegation.getTasks({ agentId: 'claude' }).map((t) => t.id);
        assert.equal(claudeSide.length, 2);
        assert.ok(claudeSide.includes(one.id) && claudeSide.includes(three.id));
        assert.deepEqual(delegation.getTasks({ agentId: 'hermes' }).map((t) => t.id), [three.id]);
        assert.deepEqual(delegation.getTasks({ toAgent: 'codex' }).map((t) => t.id), [two.id]);
        assert.equal(delegation.getTasks({ fromAgent: 'main' }).length, 2);

        assert.deepEqual(delegation.getTasks({ status: 'completed' }).map((t) => t.id), [one.id]);
        assert.equal(delegation.getTasks({ status: 'pending' }).length, 2);
        assert.deepEqual(
            delegation.getTasks({ chatId: 'c1', status: 'pending', agentId: 'codex' }).map((t) => t.id),
            [two.id]
        );

        assert.equal(delegation.getTasks({ limit: 1 }).length, 1, 'limit is honoured');
        assert.equal(delegation.getTasks({ chatId: 'nobody' }).length, 0);
    } finally { cleanup(); }
});

test('pending() is the inbox of a single agent, oldest first', async () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        const first = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'first', chatId: 'c1' });
        const second = delegation.delegate({ fromAgent: 'hermes', toAgent: 'claude', prompt: 'second', chatId: 'c2' });
        delegation.delegate({ fromAgent: 'main', toAgent: 'codex', prompt: 'other', chatId: 'c1' });

        assert.deepEqual(delegation.pending('claude').map((t) => t.id), [first.id, second.id]);
        assert.equal(delegation.pending('grok').length, 0, 'an idle agent has an empty inbox');
        assert.equal(delegation.pending().length, 3, 'no key means every pending delegation');

        await delegation.run(first.id);
        assert.deepEqual(delegation.pending('claude').map((t) => t.id), [second.id]);
    } finally { cleanup(); }
});

test('cancel() retires a pending delegation and refuses a settled one', async () => {
    const { delegation, events, cleanup } = makeDelegation();
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'never mind', chatId: 'c1' });
        const cancelled = delegation.cancel(task.id);

        assert.equal(cancelled.status, 'cancelled');
        assert.ok(cancelled.completed_at > 0);
        assert.equal(delegation.pending('claude').length, 0, 'a cancelled task leaves the inbox');
        assert.ok(events.some((e) => e.event === AgentDelegation.Events.CANCELLED));

        // A cancelled task never runs.
        let calls = 0;
        delegation.runner = async () => { calls += 1; return 'x'; };
        await delegation.run(task.id);
        assert.equal(calls, 0);

        assert.equal(delegation.cancel(task.id), null, 'cancelling twice is refused');
        assert.equal(delegation.cancel('does-not-exist'), null);

        const done = delegation.delegate({ fromAgent: 'main', toAgent: 'codex', prompt: 'go', chatId: 'c1' });
        await delegation.run(done.id);
        assert.equal(delegation.cancel(done.id), null, 'a completed task cannot be cancelled');
        assert.equal(delegation.getTask(done.id).status, 'completed');
    } finally { cleanup(); }
});

// ===========================================================================
//  Persistence
// ===========================================================================

test('delegations and their results survive a reopen of the database', async () => {
    const { delegation, database, dir, dbPath, cleanup } = makeDelegation();
    let task;
    let queued;
    try {
        task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'persist me', chatId: 'c1' });
        queued = delegation.delegate({ fromAgent: 'claude', toAgent: 'codex', prompt: 'later', chatId: 'c1', parentId: task.id });
        await delegation.run(task.id);
        database.db.close();
    } catch (err) {
        cleanup();
        throw err;
    }

    const reopened = new AssistantDatabase(dbPath);
    try {
        const revived = new AgentDelegation({ database: reopened, agents: AGENTS });
        const stored = revived.getTask(task.id);
        assert.equal(stored.status, 'completed');
        assert.equal(stored.result, 'done:persist me');
        assert.equal(stored.chat_id, 'c1');
        assert.equal(stored.depth, 1);

        // The chain is encoded in the id, so ancestry survives the restart too.
        assert.deepEqual(revived.chainOf(queued.id), ['main', 'claude', 'codex']);
        assert.deepEqual(revived.pending('codex').map((t) => t.id), [queued.id]);
        assert.throws(
            () => revived.delegate({ fromAgent: 'codex', toAgent: 'main', prompt: 'loop', parentId: queued.id }),
            /Delegation cycle refused/
        );
    } finally {
        try { reopened.db.close(); } catch (e) { /* already closed */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
    }
});

// ===========================================================================
//  ActionExecutor dispatch (the default transport)
// ===========================================================================

test('the default dispatch goes through ActionExecutor and captures its reply', async () => {
    const executor = makeFakeExecutor((message) => `handled: ${message.content.text}`);
    const { delegation, cleanup } = makeDelegation({ runner: null, actionExecutor: executor, pollMs: 5 });
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'research X', chatId: 'c1' });
        const done = await delegation.run(task.id);

        assert.equal(done.status, 'completed');
        assert.match(String(done.result), /handled: /);
        assert.match(String(done.result), /research X/, 'the prompt must reach the target agent');
        assert.doesNotMatch(String(done.result), /Thinking\.\.\./, 'placeholder edits must be ignored');

        const sent = executor.enqueued[0];
        assert.equal(sent.platform, 'delegation');
        // Never the user's own chat id: the delegating agent is still busy there,
        // and waiting for that chat to go idle would deadlock.
        assert.notEqual(sent.chatId, 'c1');
        assert.match(sent.chatId, /^delegate:c1:claude$/);
        assert.deepEqual(executor.sessionStore.pinned, [['claude', 'delegate:c1:claude']]);
    } finally { cleanup(); }
});

test('dispatching with no executor and no runner fails the task cleanly', async () => {
    const { delegation, cleanup } = makeDelegation({ runner: null });
    try {
        const task = delegation.delegate({ fromAgent: 'main', toAgent: 'claude', prompt: 'x' });
        const settled = await delegation.run(task.id);
        assert.equal(settled.status, 'failed');
        assert.match(String(settled.result), /No actionExecutor wired into AgentDelegation/);
    } finally { cleanup(); }
});

test('delegateAndRun() is delegate + run in one call', async () => {
    const { delegation, cleanup } = makeDelegation();
    try {
        const settled = await delegation.delegateAndRun({
            fromAgent: 'main', toAgent: 'hermes', prompt: 'one shot', chatId: 'c1',
        });
        assert.equal(settled.status, 'completed');
        assert.equal(settled.result, 'done:one shot');
        // A rejected delegation still throws from delegateAndRun — nothing is queued.
        await assert.rejects(
            () => delegation.delegateAndRun({ fromAgent: 'main', toAgent: 'ghost', prompt: 'x' }),
            /Unknown target agent/
        );
    } finally { cleanup(); }
});

test('the constructor validates its database and works on a Map of agents', () => {
    assert.throws(() => new AgentDelegation({}), /A database instance is required/);
    assert.throws(() => new AgentDelegation({ database: {} }), /node:sqlite handle/);

    const { delegation, cleanup } = makeDelegation({ agents: new Map([['claude', {}], ['codex', {}]]) });
    try {
        assert.deepEqual(delegation.agentKeys(), ['claude', 'codex']);
        assert.ok(delegation.hasAgent('codex'));
        assert.ok(!delegation.hasAgent('hermes'));
        assert.ok(delegation.delegate({ fromAgent: 'main', toAgent: 'codex', prompt: 'x' }).id);
    } finally { cleanup(); }
});
