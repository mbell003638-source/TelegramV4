const test = require('node:test');
const assert = require('node:assert/strict');

const TaskPlanner = require('../core/TaskPlanner');

// ---------------------------------------------------------------------------
//  Hermetic fakes — no network, no filesystem, no real agents.
// ---------------------------------------------------------------------------

/**
 * @param {string[]|function} script  canned assistant replies, in call order
 *   (the last one repeats), or a function (body, callIndex) => string.
 */
function makeRouter(script, { models = [], fail = false } = {}) {
    const calls = [];
    return {
        calls,
        async chatCompletion(body) {
            calls.push(body);
            if (fail) {
                const err = new Error('[ProviderRouter] All 2 candidate(s) failed');
                err.name = 'ProviderRouterError';
                err.attempts = [{ providerId: 'fake', model: body.model, ok: false, status: 502 }];
                throw err;
            }
            const content = typeof script === 'function'
                ? script(body, calls.length)
                : script[Math.min(calls.length - 1, script.length - 1)];
            return {
                ok: true,
                data: { choices: [{ index: 0, message: { role: 'assistant', content } }] },
                providerId: 'fake',
                model: body.model,
                attempts: [{ providerId: 'fake', model: body.model, ok: true, status: 200 }],
                usage: { requests: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.0001 },
            };
        },
        async listModels() { return models; },
    };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A task runner that records exact start/end ordering and in-flight peak. */
function makeTracingRunner({ delayMs = 10, failIds = [], outputs = {} } = {}) {
    const events = [];
    let inFlight = 0;
    let peak = 0;
    const runner = async ({ task, upstream }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        events.push({ type: 'start', id: task.id, at: events.length });
        try {
            await sleep(delayMs);
            if (failIds.includes(task.id)) throw new Error(`boom:${task.id}`);
            return {
                output: outputs[task.id] != null ? outputs[task.id] : `done:${task.id}`,
                upstreamIds: Object.keys(upstream),
            };
        } finally {
            inFlight -= 1;
            events.push({ type: 'end', id: task.id, at: events.length });
        }
    };
    return {
        runner,
        events,
        get peak() { return peak; },
        indexOf(type, id) { return events.findIndex(e => e.type === type && e.id === id); },
    };
}

// ===========================================================================
//  Stage #1 — planning & robust parsing
// ===========================================================================

test('TaskPlanner parses a clean JSON plan into normalized tasks', async () => {
    const router = makeRouter([JSON.stringify({
        rationale: 'Split research from writing.',
        tasks: [
            { id: 'a', type: 'research', description: 'Find the facts', dependsOn: [], suggestedAgent: 'grok', args: { text: 'facts' } },
            { id: 'b', type: 'writing', description: 'Write the summary', dependsOn: ['a'], suggestedAgent: null, args: {} },
        ],
    })]);
    const planner = new TaskPlanner({ router, agents: { grok: {}, claude: {} } });

    const plan = await planner.plan('Research X then write it up');

    assert.ok(!plan.fallback, 'a clean plan is not a fallback');
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.tasks.map(t => t.id), ['a', 'b']);
    assert.equal(plan.tasks[0].type, 'research');
    assert.deepEqual(plan.tasks[0].dependsOn, []);
    assert.equal(plan.tasks[0].suggestedAgent, 'grok');
    assert.deepEqual(plan.tasks[1].dependsOn, ['a']);
    assert.equal(plan.rationale, 'Split research from writing.');
    assert.equal(plan.usage.totalTokens, 15);
    assert.equal(router.calls.length, 1);
    assert.equal(router.calls[0].messages.length, 2);
});

test('TaskPlanner parses a plan wrapped in a ```json fence', async () => {
    const router = makeRouter(['```json\n' + JSON.stringify({
        tasks: [{ id: 't1', type: 'coding', description: 'Patch the bug', dependsOn: [] }],
    }, null, 2) + '\n```']);
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('fix the bug');

    assert.ok(!plan.fallback, 'fenced JSON must not degrade to the fallback plan');
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].type, 'coding');
    assert.equal(plan.tasks[0].description, 'Patch the bug');
});

test('TaskPlanner parses JSON surrounded by prose', async () => {
    const router = makeRouter([
        'Sure! Here is how I would break that down for you.\n\n' +
        '{"rationale":"two steps","tasks":[' +
        '{"id":"one","type":"analysis","description":"Analyse the logs","dependsOn":[]},' +
        '{"id":"two","type":"writing","description":"Report it","dependsOn":["one"]}]}' +
        '\n\nLet me know if you want me to adjust anything!',
    ]);
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('analyse my logs');

    assert.ok(!plan.fallback);
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.rationale, 'two steps');
    assert.deepEqual(plan.tasks[1].dependsOn, ['one']);
});

test('TaskPlanner tolerates trailing commas, comments and unquoted keys', async () => {
    const router = makeRouter([
        '```json\n' +
        '{\n' +
        '  // the plan\n' +
        '  tasks: [\n' +
        '    { "id": "x", "type": "math", "description": "Do the sum", "dependsOn": [], },\n' +
        '    { "id": "y", "type": "writing", "description": "Explain it", "dependsOn": ["x",], },\n' +
        '  ],\n' +
        '  "rationale": "compute then explain",\n' +
        '}\n' +
        '```',
    ]);
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('add these numbers and explain');

    assert.ok(!plan.fallback, 'trailing commas must be repaired, not fatal');
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.tasks[0].type, 'math');
    assert.deepEqual(plan.tasks[1].dependsOn, ['x']);
    assert.equal(plan.rationale, 'compute then explain');
});

test('TaskPlanner accepts a bare HuggingGPT-style array and derives <GENERATED> deps', async () => {
    const router = makeRouter([
        '[{"task":"research","id":0,"dep":[-1],"args":{"text":"gather sources"}},' +
        '{"task":"summarization","id":1,"dep":[-1],"args":{"text":"<GENERATED>-0"}}]',
    ]);
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('summarise the sources');

    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.tasks[0].id, '0');
    assert.equal(plan.tasks[0].type, 'research');
    assert.deepEqual(plan.tasks[0].dependsOn, [], 'dep [-1] means "no dependency"');
    assert.equal(plan.tasks[1].type, 'summarization');
    assert.deepEqual(plan.tasks[1].dependsOn, ['0'], '<GENERATED>-0 implies a dependency on task 0');
});

test('TaskPlanner degrades to a single-task fallback on garbage output', async () => {
    const router = makeRouter(['I am terribly sorry, but I cannot help with that request.']);
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('please counsel me');

    assert.equal(plan.fallback, true);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].id, 't1');
    assert.equal(plan.tasks[0].description, 'please counsel me');
    assert.deepEqual(plan.tasks[0].dependsOn, []);
    assert.match(plan.fallbackReason, /unparseable/);
});

test('TaskPlanner never throws when the router itself fails', async () => {
    const router = makeRouter([], { fail: true });
    const planner = new TaskPlanner({ router });

    const plan = await planner.plan('anything at all');

    assert.equal(plan.fallback, true);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].description, 'anything at all');
    assert.match(plan.fallbackReason, /planner unavailable/);
});

// ===========================================================================
//  Stage #2 — model selection
// ===========================================================================

test('selectModel prefers a matching local CLI agent and is deterministic', () => {
    const planner = new TaskPlanner({ agents: { claude: {}, pi: {}, grok: {} } });
    const catalog = {
        agents: { claude: {}, pi: {}, grok: {} },
        models: [{ id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' }],
    };
    const task = { id: 't1', type: 'coding', description: 'Refactor the parser', dependsOn: [] };

    const first = planner.selectModel(task, catalog);
    assert.equal(first.kind, 'agent');
    assert.equal(first.id, 'claude');
    assert.ok(first.reasons.includes('type:coding'));

    for (let i = 0; i < 5; i++) {
        assert.deepEqual(planner.selectModel(task, catalog), first, 'selection must be stable across calls');
    }

    // Emotional-support work routes to the counselling-profiled agent instead.
    const counsel = planner.selectModel(
        { id: 't2', type: 'counselling', description: 'I feel overwhelmed', dependsOn: [] },
        catalog,
    );
    assert.equal(counsel.kind, 'agent');
    assert.equal(counsel.id, 'pi');
});

test('selectModel honours the planner suggestion and falls back to a router model', () => {
    const planner = new TaskPlanner({ agents: { claude: {}, codex: {} } });
    const catalog = {
        agents: { claude: {}, codex: {} },
        models: [
            { id: 'openai/gpt-4o-mini', provider: 'openai', model: 'gpt-4o-mini' },
            { id: 'google/gemini-vision-pro', provider: 'google', model: 'gemini-vision-pro' },
        ],
    };

    const suggested = planner.selectModel(
        { id: 't1', type: 'coding', description: 'write a script', suggestedAgent: 'codex', dependsOn: [] },
        catalog,
    );
    assert.equal(suggested.id, 'codex');
    assert.ok(suggested.reasons.includes('planner-suggested'));

    // No local agent profiles vision, so a router model must win.
    const vision = planner.selectModel(
        { id: 't2', type: 'vision', description: 'describe this screenshot', dependsOn: [] },
        catalog,
    );
    assert.equal(vision.kind, 'model');
    assert.equal(vision.id, 'google/gemini-vision-pro');
    assert.equal(vision.providerId, 'google');
    assert.equal(vision.model, 'gemini-vision-pro');

    assert.equal(planner.selectModel({ id: 't3', type: 'chat', description: 'hi' }, { agents: {}, models: [] }), null);
});

// ===========================================================================
//  Stage #3 — topological execution
// ===========================================================================

test('execute runs independent tasks in parallel but never before their dependency', async () => {
    const planner = new TaskPlanner({});
    const tracer = makeTracingRunner({ delayMs: 20 });
    const plan = {
        request: 'two inputs then a merge',
        tasks: [
            { id: 'a', type: 'research', description: 'branch a', dependsOn: [], args: {} },
            { id: 'b', type: 'research', description: 'branch b', dependsOn: [], args: {} },
            { id: 'c', type: 'writing', description: 'merge', dependsOn: ['a', 'b'], args: { text: '<GENERATED>-a and <GENERATED>-b' } },
        ],
    };

    const seenUpstream = {};
    const recordingRunner = async (ctx) => {
        seenUpstream[ctx.task.id] = Object.keys(ctx.upstream || {});
        return tracer.runner(ctx);
    };
    const res = await planner.execute(plan, { taskRunner: recordingRunner, concurrency: 3 });

    assert.equal(res.ok, true);
    assert.equal(Object.keys(res.results).length, 3);
    assert.equal(res.results.c.status, 'ok');

    // a and b both start before either finishes → genuine parallelism.
    const startA = tracer.indexOf('start', 'a');
    const startB = tracer.indexOf('start', 'b');
    const endA = tracer.indexOf('end', 'a');
    const endB = tracer.indexOf('end', 'b');
    assert.ok(startB < endA, 'b must start before a finishes');
    assert.ok(startA < endB, 'a must start before b finishes');

    // c must not start until both dependencies have ended.
    const startC = tracer.indexOf('start', 'c');
    assert.ok(startC > endA, 'c started before a completed');
    assert.ok(startC > endB, 'c started before b completed');

    // Upstream results are handed to the dependent task.
    assert.deepEqual(seenUpstream.c.sort(), ['a', 'b']);
});

test('execute substitutes <GENERATED> placeholders with upstream output', async () => {
    const planner = new TaskPlanner({});
    const seen = {};
    const runner = async ({ task }) => {
        seen[task.id] = task.args && task.args.text;
        return { output: task.id === 'a' ? 'THE-ANSWER' : 'ok' };
    };

    await planner.execute({
        tasks: [
            { id: 'a', type: 'math', description: 'compute', dependsOn: [], args: { text: 'compute it' } },
            { id: 'b', type: 'writing', description: 'explain', dependsOn: ['a'], args: { text: 'Explain <GENERATED>-a please' } },
        ],
    }, { runner, taskRunner: runner, concurrency: 2 });

    assert.equal(seen.b, 'Explain THE-ANSWER please');
});

test('execute detects a dependency cycle and fails fast instead of hanging', async () => {
    const planner = new TaskPlanner({});
    const tracer = makeTracingRunner();
    const started = Date.now();

    await assert.rejects(
        () => planner.execute({
            tasks: [
                { id: 'a', type: 'general', description: 'a', dependsOn: ['c'], args: {} },
                { id: 'b', type: 'general', description: 'b', dependsOn: ['a'], args: {} },
                { id: 'c', type: 'general', description: 'c', dependsOn: ['b'], args: {} },
            ],
        }, { taskRunner: tracer.runner }),
        err => {
            assert.equal(err.name, 'TaskPlannerCycleError');
            assert.match(err.message, /Dependency cycle detected/);
            assert.ok(Array.isArray(err.cycle) && err.cycle.length >= 2, 'the error must name the cycle');
            for (const id of ['a', 'b', 'c']) assert.ok(err.cycle.includes(id), `cycle should mention ${id}`);
            return true;
        },
    );

    assert.ok(Date.now() - started < 2000, 'cycle detection must not hang');
    assert.equal(tracer.events.length, 0, 'no task may run once a cycle is detected');
});

test('execute skips dependents of a failed task but finishes unrelated branches', async () => {
    const planner = new TaskPlanner({});
    const tracer = makeTracingRunner({ delayMs: 5, failIds: ['a'] });
    const progress = [];

    const res = await planner.execute({
        tasks: [
            { id: 'a', type: 'research', description: 'will fail', dependsOn: [], args: {} },
            { id: 'b', type: 'writing', description: 'depends on a', dependsOn: ['a'], args: {} },
            { id: 'c', type: 'writing', description: 'depends on b', dependsOn: ['b'], args: {} },
            { id: 'd', type: 'math', description: 'unrelated branch', dependsOn: [], args: {} },
            { id: 'e', type: 'writing', description: 'depends on d', dependsOn: ['d'], args: {} },
        ],
    }, { taskRunner: tracer.runner, concurrency: 3, onProgress: evt => progress.push(evt) });

    assert.equal(res.ok, false);
    assert.equal(res.results.a.status, 'failed');
    assert.match(res.results.a.error, /boom:a/);

    assert.equal(res.results.b.status, 'skipped');
    assert.deepEqual(res.results.b.skippedBecause, ['a']);
    assert.equal(res.results.c.status, 'skipped', 'skips must cascade transitively');

    assert.equal(res.results.d.status, 'ok');
    assert.equal(res.results.e.status, 'ok', 'an unrelated branch must still complete');

    assert.deepEqual(res.failed, ['a']);
    assert.deepEqual(res.skipped.sort(), ['b', 'c']);
    assert.equal(tracer.indexOf('start', 'b'), -1, 'a skipped task must never be started');

    const statuses = progress.filter(e => e.phase === 'task').map(e => `${e.taskId}:${e.status}`);
    assert.ok(statuses.includes('a:failed'));
    assert.ok(statuses.includes('b:skipped'));
    assert.ok(statuses.includes('e:ok'));
});

test('execute genuinely caps concurrency', async () => {
    const planner = new TaskPlanner({});
    const tracer = makeTracingRunner({ delayMs: 15 });
    const tasks = Array.from({ length: 7 }, (_, i) => ({
        id: `n${i}`, type: 'general', description: `job ${i}`, dependsOn: [], args: {},
    }));

    const res = await planner.execute({ tasks }, { taskRunner: tracer.runner, concurrency: 2 });

    assert.equal(res.ok, true);
    assert.equal(Object.keys(res.results).length, 7);
    assert.ok(tracer.peak <= 2, `peak in-flight was ${tracer.peak}, expected <= 2`);
    assert.equal(res.stats.peakConcurrency, 2);
    assert.equal(res.stats.concurrency, 2);
});

test('execute emits progress events through the injected event bus', async () => {
    const emitted = [];
    const eventBus = {
        emitStatus: (key, msg, requestId) => emitted.push({ kind: 'status', key, msg, requestId }),
        emitError: (key, err, requestId) => emitted.push({ kind: 'error', key, err, requestId }),
    };
    const planner = new TaskPlanner({ eventBus });
    const tracer = makeTracingRunner({ delayMs: 1 });

    await planner.execute(
        { tasks: [{ id: 'solo', type: 'chat', description: 'say hi', dependsOn: [], args: {} }] },
        { taskRunner: tracer.runner, requestId: 'req-42' },
    );

    assert.ok(emitted.length >= 2, 'expected start + completion events');
    assert.ok(emitted.every(e => e.key === 'taskplanner'));
    assert.ok(emitted.every(e => e.requestId === 'req-42'));
    assert.ok(emitted.some(e => e.kind === 'status' && /solo/.test(e.msg)));
});

// ===========================================================================
//  Stage #4 — synthesis
// ===========================================================================

test('synthesize merges every result into one final answer', async () => {
    const router = makeRouter(['Here is your combined answer: X is 4 and it matters because Y.']);
    const planner = new TaskPlanner({ router });

    const out = await planner.synthesize(
        'what is X and why does it matter',
        { rationale: 'compute then explain' },
        {
            a: { id: 'a', type: 'math', description: 'compute X', status: 'ok', output: 'X = 4' },
            b: { id: 'b', type: 'writing', description: 'explain X', status: 'ok', output: 'It matters because Y.' },
        },
    );

    assert.equal(out.fallback, false);
    assert.match(out.answer, /combined answer/);
    assert.equal(out.usage.totalTokens, 15);

    const sent = router.calls[0].messages[1].content;
    assert.match(sent, /X = 4/, 'the execution log must reach the synthesis prompt');
    assert.match(sent, /It matters because Y\./);
    assert.match(sent, /compute then explain/);
});

test('synthesize stitches results locally when the router is unavailable', async () => {
    const planner = new TaskPlanner({ router: makeRouter([], { fail: true }) });

    const out = await planner.synthesize('q', { rationale: 'n/a' }, [
        { id: 'a', type: 'research', description: 'find it', status: 'ok', output: 'FOUND' },
        { id: 'b', type: 'writing', description: 'write it', status: 'failed', error: 'nope' },
    ]);

    assert.equal(out.fallback, true);
    assert.match(out.answer, /FOUND/);
});

// ===========================================================================
//  The whole pipeline
// ===========================================================================

test('run executes the full plan -> select -> execute -> synthesize pipeline', async () => {
    const router = makeRouter((body, call) => {
        if (call === 1) {
            return '```json\n' + JSON.stringify({
                rationale: 'research, then advise',
                tasks: [
                    { id: 'r', type: 'research', description: 'gather context', dependsOn: [], suggestedAgent: 'grok' },
                    { id: 'c', type: 'counselling', description: 'offer guidance', dependsOn: ['r'], suggestedAgent: 'pi' },
                ],
            }) + '\n```';
        }
        return 'Final counselling answer, drawn from every agent.';
    }, { models: [{ id: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o' }] });

    const planner = new TaskPlanner({ router, agents: { grok: {}, pi: {} } });
    const tracer = makeTracingRunner({ delayMs: 2, outputs: { r: 'CONTEXT', c: 'GUIDANCE' } });

    const out = await planner.run('help me think through a career change', { taskRunner: tracer.runner });

    assert.equal(out.ok, true);
    assert.equal(out.plan.tasks.length, 2);
    assert.equal(out.plan.tasks[0].selection.id, 'grok');
    assert.equal(out.plan.tasks[1].selection.id, 'pi');
    assert.equal(out.results.r.output, 'CONTEXT');
    assert.equal(out.results.c.output, 'GUIDANCE');
    assert.deepEqual(out.order, ['r', 'c']);
    assert.match(out.answer, /Final counselling answer/);
    assert.equal(out.usage.requests, 2, 'plan + synthesis router calls are both counted');
    assert.equal(out.usage.totalTokens, 30);
});

test('run still answers when the planner LLM returns garbage', async () => {
    const router = makeRouter((body, call) => (call === 1 ? 'no json here, sorry' : 'Direct answer.'));
    const planner = new TaskPlanner({ router, agents: {} });
    const tracer = makeTracingRunner({ delayMs: 1, outputs: { t1: 'RAW' } });

    const out = await planner.run('just answer me', { taskRunner: tracer.runner });

    assert.equal(out.plan.fallback, true);
    assert.equal(out.plan.tasks.length, 1);
    assert.equal(out.ok, true);
    assert.match(out.answer, /Direct answer/);
});
