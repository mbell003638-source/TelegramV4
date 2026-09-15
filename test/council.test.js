const test = require('node:test');
const assert = require('node:assert/strict');

const Council = require('../core/Council');
const { COUNCIL_SWITCH } = Council;

// ---------------------------------------------------------------------------
//  Hermetic fakes — no network, no filesystem, no real agents.
//
//  Every fake agent below exposes only `execute(prompt, sessionId)` (Council's
//  transport #2 — see core/MissionControl.js), so no eventBus/actionExecutor
//  is needed and nothing here ever touches a live CLI process.
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {string|string[]|function} script  a canned reply, an array of canned
 *   replies (one per call, last one repeats), or (prompt, callIndex) => string.
 */
function makeAgent(name, script) {
    const calls = [];
    return {
        name,
        calls,
        async execute(prompt) {
            calls.push(prompt);
            const i = calls.length;
            if (typeof script === 'function') return script(prompt, i);
            if (Array.isArray(script)) return script[Math.min(i - 1, script.length - 1)];
            return script;
        },
    };
}

function makeFailingAgent(name, message) {
    return {
        name,
        async execute() { throw new Error(message); },
    };
}

function makeSlowAgent(name, delayMs, text) {
    return {
        name,
        async execute() { await sleep(delayMs); return text; },
    };
}

/** An agent with neither sendMessage() nor execute() — genuinely unreachable. */
function makeUnreachableAgent(name) {
    return { name };
}

/** Tracks true concurrent in-flight execute() calls across a set of agents. */
function makeTracingAgents(names, delayMs) {
    let inFlight = 0;
    let peak = 0;
    const agents = {};
    for (const name of names) {
        agents[name] = {
            name,
            async execute() {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                try {
                    await sleep(delayMs);
                    return `${name} sentinel position`;
                } finally {
                    inFlight -= 1;
                }
            },
        };
    }
    return { agents, get peak() { return peak; } };
}

function makeCouncil(opts = {}) {
    return new Council({ concurrency: 3, timeoutMs: 5000, ...opts });
}

// ===========================================================================
//  The invariant: no agent speech is fabricated by the module itself
// ===========================================================================

test('deliberate: every position and quote is the exact sentinel string the fake agent returned, nothing more', async () => {
    const agents = {
        claude: makeAgent('Claude', 'SENTINEL-CLAUDE-7f3a: I think we should ship it.'),
        codex: makeAgent('Codex', 'SENTINEL-CODEX-9b21: I disagree, it needs more tests.'),
    };
    const council = makeCouncil({ agents });

    const result = await council.deliberate('should we ship?');

    assert.equal(result.ok, true);
    assert.equal(result.positions.length, 2);
    assert.ok(result.positions.every(p => p.ok === true));

    const claudePos = result.positions.find(p => p.agentKey === 'claude');
    const codexPos = result.positions.find(p => p.agentKey === 'codex');
    assert.equal(claudePos.text, 'SENTINEL-CLAUDE-7f3a: I think we should ship it.');
    assert.equal(codexPos.text, 'SENTINEL-CODEX-9b21: I disagree, it needs more tests.');

    // No router injected -> mechanical synthesis. Its quotes must be the exact
    // sentinels, and nothing besides the sentinels and Council-labelled prose
    // may appear anywhere in the serialised result.
    assert.equal(result.synthesis.fallback, true);
    const json = JSON.stringify(result);
    assert.ok(json.includes('SENTINEL-CLAUDE-7f3a'));
    assert.ok(json.includes('SENTINEL-CODEX-9b21'));

    const check = council.verifyAttribution(result);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
    assert.ok(check.checked > 0);
});

test('verifyAttribution REJECTS a sentence the agent never actually said', async () => {
    const agents = { claude: makeAgent('Claude', 'REAL-WORDS-abc123: this is what I actually said.') };
    const council = makeCouncil({ agents });
    const result = await council.deliberate('question?');

    // Sanity: the untouched result passes.
    assert.equal(council.verifyAttribution(result).ok, true);

    // Tamper with the position as if something upstream had rewritten it.
    const tampered = JSON.parse(JSON.stringify(result));
    tampered.positions[0].text = 'FABRICATED-xyz999: I never said this.';
    const check = council.verifyAttribution(tampered);

    assert.equal(check.ok, false);
    assert.ok(check.violations.some(v => v.agentKey === 'claude' && /not in the transport ledger/.test(v.reason)));
});

test('utterancesOf returns exactly what a given agent said, verbatim, and nothing for an unknown key', async () => {
    const agents = { claude: makeAgent('Claude', 'UTTER-ONE: hello') };
    const council = makeCouncil({ agents });
    await council.deliberate('q');

    assert.deepEqual(council.utterancesOf('claude'), ['UTTER-ONE: hello']);
    assert.deepEqual(council.utterancesOf('nobody-ever-spoke'), []);
});

// ===========================================================================
//  Every participant asked, all real positions returned
// ===========================================================================

test('deliberate asks every participant and returns all of their real positions', async () => {
    const agents = {
        claude: makeAgent('Claude', 'POS-CLAUDE-1'),
        codex: makeAgent('Codex', 'POS-CODEX-1'),
        grok: makeAgent('Grok', 'POS-GROK-1'),
    };
    const council = makeCouncil({ agents });
    const result = await council.deliberate('what should we build?');

    assert.deepEqual(result.participants.sort(), ['claude', 'codex', 'grok'].sort());
    assert.equal(result.positions.length, 3);
    for (const key of ['claude', 'codex', 'grok']) {
        assert.equal(agents[key].calls.length, 1, `${key} must be asked exactly once`);
        const pos = result.positions.find(p => p.agentKey === key);
        assert.equal(pos.ok, true);
        assert.equal(pos.text, `POS-${key.toUpperCase()}-1`);
    }
    assert.equal(result.stats.heard, 3);
    assert.equal(result.stats.failed, 0);
});

// ===========================================================================
//  Failure isolation
// ===========================================================================

test('a failing agent yields ok:false with its real error, is excluded from synthesis, others still complete', async () => {
    const agents = {
        claude: makeAgent('Claude', 'GOOD-CLAUDE-POSITION'),
        codex: makeFailingAgent('Codex', 'codex exploded: real transport error 502'),
        grok: makeAgent('Grok', 'GOOD-GROK-POSITION'),
    };
    const council = makeCouncil({ agents });
    const result = await council.deliberate('anything');

    const codexPos = result.positions.find(p => p.agentKey === 'codex');
    assert.equal(codexPos.ok, false);
    assert.match(codexPos.error, /codex exploded: real transport error 502/);
    assert.equal(codexPos.text, '');

    assert.ok(result.errored.some(e => e.agentKey === 'codex'));

    const claudePos = result.positions.find(p => p.agentKey === 'claude');
    const grokPos = result.positions.find(p => p.agentKey === 'grok');
    assert.equal(claudePos.ok, true);
    assert.equal(grokPos.ok, true);

    // The synthesis must never quote the failed agent.
    assert.ok(!result.synthesis.quotes.some(q => q.agentKey === 'codex'));
    assert.ok(result.synthesis.missing.some(m => m.agentKey === 'codex'));
    assert.ok(result.synthesis.quotes.some(q => q.agentKey === 'claude'));
    assert.ok(result.synthesis.quotes.some(q => q.agentKey === 'grok'));

    const check = council.verifyAttribution(result);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
});

// ===========================================================================
//  Timeout handling
// ===========================================================================

test('an agent that never answers in time is reported as a timeout, not a fabricated answer', async () => {
    const agents = {
        slow: makeSlowAgent('Slow', 300, 'too-late-to-matter'),
        fast: makeAgent('Fast', 'FAST-POSITION'),
    };
    const council = makeCouncil({ agents, timeoutMs: 30 });
    const result = await council.deliberate('q', { timeoutMs: 30 });

    const slowPos = result.positions.find(p => p.agentKey === 'slow');
    assert.equal(slowPos.ok, false);
    assert.equal(slowPos.timedOut, true);
    assert.match(slowPos.error, /timed out/);
    assert.equal(slowPos.text, '', 'a timeout must never carry fabricated text');

    const fastPos = result.positions.find(p => p.agentKey === 'fast');
    assert.equal(fastPos.ok, true);
});

// ===========================================================================
//  Concurrency cap
// ===========================================================================

test('deliberate genuinely caps concurrency: peak in-flight never exceeds the limit', async () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const { agents, peak } = makeTracingAgents(names, 20);
    const council = makeCouncil({ agents });

    const result = await council.deliberate('q', { concurrency: 2 });

    assert.equal(result.stats.peakConcurrency <= 2, true, `peak was ${result.stats.peakConcurrency}`);
    assert.ok(peak <= 2, `observed peak was ${peak}`);
    assert.equal(result.positions.length, names.length);
    assert.equal(result.positions.every(p => p.ok), true);
});

// ===========================================================================
//  Multi-round deliberation
// ===========================================================================

test('rounds: 2 feeds round-1 positions into the round-2 prompt for every other agent', async () => {
    const agents = {
        claude: makeAgent('Claude', ['ROUND1-CLAUDE-said-this', 'ROUND2-CLAUDE-final']),
        codex: makeAgent('Codex', ['ROUND1-CODEX-said-that', 'ROUND2-CODEX-final']),
    };
    const council = makeCouncil({ agents });

    const result = await council.deliberate('q', { rounds: 2 });

    assert.equal(result.transcript.length, 2);
    assert.equal(agents.claude.calls.length, 2);
    assert.equal(agents.codex.calls.length, 2);

    // Claude's round-2 prompt must quote Codex's round-1 position verbatim, and
    // vice versa — that IS the "feeding forward" the spec requires.
    const claudeRound2Prompt = agents.claude.calls[1];
    const codexRound2Prompt = agents.codex.calls[1];
    assert.match(claudeRound2Prompt, /ROUND1-CODEX-said-that/);
    assert.match(codexRound2Prompt, /ROUND1-CLAUDE-said-this/);

    // Final positions are round 2's, not stale round-1 text.
    const finalClaude = result.positions.find(p => p.agentKey === 'claude');
    assert.equal(finalClaude.text, 'ROUND2-CLAUDE-final');
});

// ===========================================================================
//  Kill switch
// ===========================================================================

test('WARROOM_TEXT_ENABLED off returns a refusal instead of running any agent', async () => {
    const agents = { claude: makeAgent('Claude', 'SHOULD-NEVER-BE-CALLED') };
    const council = makeCouncil({
        agents,
        killSwitches: { isEnabled: (name) => name !== COUNCIL_SWITCH },
    });

    const result = await council.deliberate('q');

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.error, new RegExp(COUNCIL_SWITCH));
    assert.equal(result.positions.length, 0);
    assert.equal(agents.claude.calls.length, 0, 'the kill switch must prevent the agent from ever being asked');
});

// ===========================================================================
//  Synthesis without a router
// ===========================================================================

test('synthesize with no router falls back to a clearly-labelled mechanical summary and invents no consensus', async () => {
    const council = makeCouncil({ agents: {} }); // no router at all
    const positions = [
        { agentKey: 'claude', name: 'Claude', ok: true, text: 'RAW-CLAUDE-VIEW: I like option A.' },
        { agentKey: 'codex', name: 'Codex', ok: true, text: 'RAW-CODEX-VIEW: I like option B.' },
    ];

    const out = await council.synthesize('which option?', positions);

    assert.equal(out.fallback, true);
    assert.equal(out.synthesizedBy, null);
    assert.match(out.text, /^\[Council\]/, 'the fallback must open by clearly labelling itself');
    assert.match(out.text, /No model was available to synthesise/);
    assert.match(out.text, /No consensus was reached, computed or implied/);
    assert.match(out.text, /RAW-CLAUDE-VIEW: I like option A\./);
    assert.match(out.text, /RAW-CODEX-VIEW: I like option B\./);

    // The mechanical summary must be exactly the deterministic re-render —
    // that is the guarantee that no prose slipped in between the quotes.
    const expected = Council.renderMechanicalSynthesis('which option?', out.quotes, out.missing);
    assert.equal(out.text, expected);
});

// ===========================================================================
//  Input validation
// ===========================================================================

test('an empty or whitespace-only question is rejected without asking anyone', async () => {
    const agents = { claude: makeAgent('Claude', 'SHOULD-NEVER-RUN') };
    const council = makeCouncil({ agents });

    for (const bad of ['', '   ', '\n\t  ']) {
        const result = await council.deliberate(bad);
        assert.equal(result.ok, false);
        assert.match(result.error, /question/i);
    }
    assert.equal(agents.claude.calls.length, 0);
});

// ===========================================================================
//  Standup
// ===========================================================================

test('standup reports an unreachable agent honestly, with a Council-labelled line and the real error', async () => {
    const agents = {
        claude: makeAgent('Claude', 'STANDUP-CLAUDE: working on the parser.'),
        ghost: makeUnreachableAgent('Ghost'),
    };
    const council = makeCouncil({ agents });

    const result = await council.standup();

    const claudeReport = result.reports.find(r => r.agentKey === 'claude');
    assert.equal(claudeReport.ok, true);
    assert.equal(claudeReport.line, 'STANDUP-CLAUDE: working on the parser.');

    const ghostReport = result.reports.find(r => r.agentKey === 'ghost');
    assert.equal(ghostReport.ok, false);
    assert.match(ghostReport.error, /not reachable/);
    assert.match(ghostReport.line, /^\[Council\] /, 'an unreachable agent must be reported in the Council\'s own labelled voice');
    assert.match(ghostReport.line, /could not be reached/);

    assert.ok(result.errored.some(e => e.agentKey === 'ghost'));

    const check = council.verifyAttribution(result);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
});

// ===========================================================================
//  Total-failure resilience
// ===========================================================================

test('deliberate never throws even when every single fake agent rejects', async () => {
    const agents = {
        a: makeFailingAgent('A', 'a is down'),
        b: makeFailingAgent('B', 'b is down'),
        c: makeFailingAgent('C', 'c is down'),
    };
    const council = makeCouncil({ agents });

    let result;
    await assert.doesNotReject(async () => { result = await council.deliberate('is anyone there?'); });

    assert.equal(result.ok, true);
    assert.equal(result.positions.every(p => p.ok === false), true);
    assert.equal(result.synthesis.empty, true);
    assert.equal(result.synthesis.quotes.length, 0);
    assert.match(result.synthesis.text, /No agent returned a usable position/);

    const check = council.verifyAttribution(result);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
});

// ===========================================================================
//  Roster resolution
// ===========================================================================

test('resolveParticipants orders by the preferred roster and keeps a requested-but-unknown key so it can be reported as failed', () => {
    const council = makeCouncil({ agents: { grok: {}, claude: {}, zeta: {} } });

    // No explicit request: preferred order first, then any extras not in it.
    assert.deepEqual(council.resolveParticipants(), ['claude', 'grok', 'zeta']);

    // An explicit request is honoured in the given order, deduplicated, and an
    // unknown key is KEPT (not silently dropped) so its failure is visible.
    assert.deepEqual(council.resolveParticipants(['zeta', 'zeta', 'ghost-agent']), ['zeta', 'ghost-agent']);
});

test('agentName falls back to the bare key when the agent has no display name', () => {
    const council = makeCouncil({ agents: { claude: { name: 'Claude Sonnet' }, codex: {} } });
    assert.equal(council.agentName('claude'), 'Claude Sonnet');
    assert.equal(council.agentName('codex'), 'codex');
    assert.equal(council.agentName('never-registered'), 'never-registered');
});
