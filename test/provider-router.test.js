const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ProviderRegistry = require('../core/ProviderRegistry');
const ProviderRouter = require('../core/ProviderRouter');

// -----------------------------------------------------------------------------
//  Helpers — everything here is hermetic: no sockets, no real network.
// -----------------------------------------------------------------------------

function makeTmpDir(label) {
    const dir = path.join(__dirname, `tmp_omnirouter_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Registry with no seeded defaults and no ambient env keys. */
function makeRegistry(dir) {
    return new ProviderRegistry(dir, { env: {}, seed: false });
}

/** Two synthetic upstreams: alpha (priority 10) then beta (priority 20). */
function seedPair(registry) {
    registry.upsert('alpha', { label: 'Alpha', baseUrl: 'https://alpha.test/v1', priority: 10, models: ['test-model'] });
    registry.addKey('alpha', 'sk-alpha-000000000000001');
    registry.upsert('beta', { label: 'Beta', baseUrl: 'https://beta.test/v1', priority: 20, models: ['test-model'] });
    registry.addKey('beta', 'sk-beta-0000000000000001');
    return registry;
}

/** Transport stub: per-provider scripted responses + a call log. */
function makeTransport(script) {
    const calls = [];
    const transport = async (request) => {
        calls.push(request);
        const entry = script[request.providerId];
        const value = typeof entry === 'function' ? entry(request, calls) : entry;
        if (!value) throw new Error(`no script for ${request.providerId}`);
        if (value.throw) throw new Error(value.throw);
        return value;
    };
    transport.calls = calls;
    return transport;
}

function okResponse(providerId, usage) {
    return {
        status: 200,
        headers: {},
        data: {
            id: `chatcmpl-${providerId}`,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: `hi from ${providerId}` }, finish_reason: 'stop' }],
            usage: usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
    };
}

function fakeRes() {
    const res = {
        headersSent: false,
        statusCode: 0,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(chunk) { if (chunk) this.body += chunk; },
    };
    return res;
}

// -----------------------------------------------------------------------------
//  ProviderRegistry
// -----------------------------------------------------------------------------

test('ProviderRegistry masks keys and never leaks raw key material', () => {
    const dir = makeTmpDir('mask');
    try {
        const rawKey = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
        const registry = new ProviderRegistry(dir, { env: { OPENROUTER_API_KEY: rawKey } });

        const openrouter = registry.get('openrouter');
        assert.equal(openrouter.keys.length, 1);
        assert.equal(openrouter.enabled, true, 'a provider with a key is enabled');

        // Providers without a key stay disabled; ollama is key-exempt.
        assert.equal(registry.get('openai').enabled, false);
        assert.equal(registry.get('ollama').enabled, true);

        const masked = registry.maskedView();
        const serialized = JSON.stringify(masked);
        assert.ok(!serialized.includes(rawKey), 'maskedView() must not contain the raw key');

        const maskedOr = masked.find(p => p.id === 'openrouter');
        assert.equal(maskedOr.keys[0], rawKey.slice(0, 7) + '...' + rawKey.slice(-4));
        assert.equal(maskedOr.keyCount, 1);

        // Short keys must be blanked rather than half-revealed.
        registry.addKey('openai', 'tiny');
        const maskedShort = registry.maskedView().find(p => p.id === 'openai');
        assert.equal(maskedShort.keys[0], '****');
        assert.ok(!JSON.stringify(registry.maskedView()).includes('tiny'));

        // Persisted and reloadable.
        assert.ok(fs.existsSync(path.join(dir, 'store', 'providers.json')));
        const reloaded = new ProviderRegistry(dir, { env: {} });
        assert.deepEqual(reloaded.get('openrouter').keys, [rawKey], 'env keys survive a restart without env');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ProviderRegistry resolves provider/model slugs', () => {
    const dir = makeTmpDir('slug');
    try {
        const registry = new ProviderRegistry(dir, { env: {} });

        assert.deepEqual(registry.resolveModel('anthropic/claude-sonnet-4'), { providerId: 'anthropic', model: 'claude-sonnet-4' });
        assert.deepEqual(registry.resolveModel('openrouter/anthropic/claude-sonnet-4'), { providerId: 'openrouter', model: 'anthropic/claude-sonnet-4' });
        assert.deepEqual(registry.resolveModel('kimi/moonshot-v1-8k'), { providerId: 'moonshot', model: 'moonshot-v1-8k' }, 'aliases resolve');

        assert.equal(registry.resolveModel('gpt-4o'), null, 'no prefix → null');
        assert.equal(registry.resolveModel('meta-llama/llama-3.1-70b'), null, 'unknown prefix → null');
        assert.equal(registry.resolveModel(''), null);
        assert.equal(registry.resolveModel(undefined), null);

        // Key lifecycle.
        registry.addKey('groq', 'gsk_aaaaaaaaaaaaaaaaaaaa');
        assert.equal(registry.get('groq').enabled, true);
        registry.setEnabled('groq', false);
        assert.equal(registry.get('groq').enabled, false, 'manual disable wins over having a key');
        registry.setEnabled('groq', true);
        assert.equal(registry.get('groq').enabled, true);
        registry.removeKey('groq', 'gsk_aaaaaaaaaaaaaaaaaaaa');
        assert.equal(registry.get('groq').enabled, false, 'losing the last key disables the provider');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Failover + circuit breaker
// -----------------------------------------------------------------------------

test('ProviderRouter fails over when the first provider returns 429', async () => {
    const dir = makeTmpDir('failover');
    try {
        const registry = seedPair(makeRegistry(dir));
        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        const transport = makeTransport({
            alpha: { status: 429, headers: {}, data: { error: { message: 'rate limited' } } },
            beta: okResponse('beta'),
        });

        const result = await router.chatCompletion(
            { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
            { transport },
        );

        assert.equal(result.ok, true);
        assert.equal(result.providerId, 'beta', 'the surviving provider is reported');
        assert.equal(result.model, 'test-model');
        assert.equal(result.data.choices[0].message.content, 'hi from beta');

        assert.equal(result.attempts.length, 2);
        assert.equal(result.attempts[0].providerId, 'alpha');
        assert.equal(result.attempts[0].ok, false);
        assert.equal(result.attempts[0].status, 429);
        assert.equal(result.attempts[1].providerId, 'beta');
        assert.equal(result.attempts[1].ok, true);

        assert.equal(transport.calls.length, 2);
        assert.equal(transport.calls[0].url, 'https://alpha.test/v1/chat/completions');
        assert.equal(transport.calls[1].headers.Authorization, 'Bearer sk-beta-0000000000000001');
        assert.equal(transport.calls[1].body.models, undefined, 'the fallback list is never forwarded upstream');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ProviderRouter honours an explicit provider/model pin and body.models fallbacks', async () => {
    const dir = makeTmpDir('pin');
    try {
        const registry = seedPair(makeRegistry(dir));
        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        const transport = makeTransport({ alpha: okResponse('alpha'), beta: okResponse('beta') });

        const pinned = await router.chatCompletion({ model: 'beta/test-model', messages: [] }, { transport });
        assert.equal(pinned.providerId, 'beta', 'the slug prefix pins the provider even at lower priority');
        assert.equal(pinned.model, 'test-model', 'the provider prefix is stripped before going upstream');

        // body.models[] fallbacks are tried in order after the primary model.
        const chain = router.buildCandidates({ model: 'beta/test-model', models: ['alpha/test-model'] });
        assert.equal(chain[0].providerId, 'beta');
        assert.equal(chain[0].source, 'slug');
        assert.equal(chain[1].providerId, 'alpha');
        assert.equal(chain[1].source, 'fallback-slug');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ProviderRouter circuit breaker opens on failure and skips the provider while cooling down', async () => {
    const dir = makeTmpDir('breaker');
    try {
        const registry = seedPair(makeRegistry(dir));
        let clock = 1_000_000;
        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key', now: () => clock });
        const transport = makeTransport({
            alpha: { status: 500, headers: {}, data: { error: { message: 'boom' } } },
            beta: okResponse('beta'),
        });

        const first = await router.chatCompletion({ model: 'test-model', messages: [] }, { transport });
        assert.equal(first.providerId, 'beta');
        assert.equal(router._isHealthy('alpha', 'sk-alpha-000000000000001'), false, 'breaker is open after one failure');
        assert.equal(router._isHealthy('beta', 'sk-beta-0000000000000001'), true, 'success keeps the breaker closed');

        // While cooling down alpha is skipped without any upstream call.
        const callsBefore = transport.calls.length;
        const second = await router.chatCompletion({ model: 'test-model', messages: [] }, { transport });
        assert.equal(second.providerId, 'beta');
        assert.equal(second.attempts[0].providerId, 'alpha');
        assert.equal(second.attempts[0].skipped, true);
        assert.equal(second.attempts[0].reason, 'cooling-down');
        assert.equal(transport.calls.length, callsBefore + 1, 'the cooling provider is not dialled');

        // Cooldown starts at 5s; after it elapses alpha is retried.
        clock += 5001;
        assert.equal(router._isHealthy('alpha', 'sk-alpha-000000000000001'), true, 'breaker closes once the cooldown elapses');
        const third = await router.chatCompletion({ model: 'test-model', messages: [] }, { transport });
        assert.equal(third.attempts[0].providerId, 'alpha');
        assert.equal(third.attempts[0].skipped, undefined, 'alpha is dialled again after the cooldown');
        assert.equal(third.providerId, 'beta');

        // Backoff is exponential: the second failure doubles the window to 10s.
        assert.equal(router.breakers.get('alpha::sk-alpha-000000000000001').cooldownMs, 10000);

        // Every candidate failing produces an aggregate error carrying the attempts.
        const allDown = makeTransport({
            alpha: { status: 503, headers: {}, data: { error: { message: 'down' } } },
            beta: { throw: 'ECONNREFUSED' },
        });
        clock += 600000; // let every breaker cool off
        await assert.rejects(
            () => router.chatCompletion({ model: 'test-model', messages: [] }, { transport: allDown }),
            (err) => {
                assert.equal(err.name, 'ProviderRouterError');
                assert.equal(err.attempts.length, 2);
                assert.match(err.message, /All 2 candidate\(s\) failed/);
                assert.match(err.message, /ECONNREFUSED/);
                return true;
            },
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Key pool rotation
// -----------------------------------------------------------------------------

test('ProviderRouter round-robin key rotation cycles the key pool', () => {
    const dir = makeTmpDir('rotation');
    try {
        const registry = makeRegistry(dir);
        registry.upsert('pool', { baseUrl: 'https://pool.test/v1', priority: 10, models: ['test-model'] });
        registry.addKey('pool', 'key-aaaaaaaaaaaaaaaa');
        registry.addKey('pool', 'key-bbbbbbbbbbbbbbbb');
        registry.addKey('pool', 'key-cccccccccccccccc');

        const rr = new ProviderRouter({ registry, masterKey: 'omni-test-key', strategy: 'round-robin' });
        const provider = registry.get('pool');
        const picked = [rr._nextKey(provider), rr._nextKey(provider), rr._nextKey(provider), rr._nextKey(provider)];
        assert.deepEqual(picked, [
            'key-aaaaaaaaaaaaaaaa',
            'key-bbbbbbbbbbbbbbbb',
            'key-cccccccccccccccc',
            'key-aaaaaaaaaaaaaaaa',
        ], 'round-robin wraps back to the first key');

        // 'priority' always prefers the first healthy key.
        const pri = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        assert.equal(pri._nextKey(provider), 'key-aaaaaaaaaaaaaaaa');
        assert.equal(pri._nextKey(provider), 'key-aaaaaaaaaaaaaaaa');

        // 'least-used' spreads load across the pool.
        const lu = new ProviderRouter({ registry, masterKey: 'omni-test-key', strategy: 'least-used' });
        const spread = new Set([lu._nextKey(provider), lu._nextKey(provider), lu._nextKey(provider)]);
        assert.equal(spread.size, 3, 'least-used touches every key before repeating');

        // An unhealthy key drops out of the pool; an all-unhealthy pool yields undefined.
        const br = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        br._tripBreaker('pool', 'key-aaaaaaaaaaaaaaaa', new Error('429'));
        assert.equal(br._nextKey(provider), 'key-bbbbbbbbbbbbbbbb', 'cooling keys are skipped');
        for (const key of provider.keys) br._tripBreaker('pool', key, new Error('429'));
        assert.equal(br._nextKey(provider), undefined, 'no healthy key → provider is skippable');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Auth translation
// -----------------------------------------------------------------------------

test('ProviderRouter translates auth headers per provider', () => {
    const dir = makeTmpDir('headers');
    try {
        const registry = new ProviderRegistry(dir, { env: {} });
        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key', appUrl: 'https://omni.test', appTitle: 'OmniTest' });

        const anthropic = router._buildHeaders(registry.get('anthropic'), 'sk-ant-123');
        assert.equal(anthropic['x-api-key'], 'sk-ant-123');
        assert.equal(anthropic['anthropic-version'], '2023-06-01');
        assert.equal(anthropic.Authorization, undefined, 'Anthropic never gets a bearer token');

        const openrouter = router._buildHeaders(registry.get('openrouter'), 'sk-or-123');
        assert.equal(openrouter.Authorization, 'Bearer sk-or-123');
        assert.equal(openrouter['HTTP-Referer'], 'https://omni.test');
        assert.equal(openrouter['X-Title'], 'OmniTest');

        const openai = router._buildHeaders(registry.get('openai'), 'sk-oai-123');
        assert.equal(openai.Authorization, 'Bearer sk-oai-123');
        assert.equal(openai['HTTP-Referer'], undefined);

        const ollama = router._buildHeaders(registry.get('ollama'), null);
        assert.equal(ollama.Authorization, undefined, 'keyless providers get no auth header');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Master key gate
// -----------------------------------------------------------------------------

test('ProviderRouter master key verification is constant-time and length safe', () => {
    const dir = makeTmpDir('masterkey');
    try {
        const registry = makeRegistry(dir);
        const router = new ProviderRouter({ registry, masterKey: 'omni-correct-master-key' });

        assert.equal(router.getMasterKey(), 'omni-correct-master-key');
        assert.equal(router.verifyMasterKey('omni-correct-master-key'), true);

        // Same length, different bytes.
        assert.equal(router.verifyMasterKey('omni-incorrect-mastr-key'.slice(0, 23)), false);
        // Wrong length must not throw (crypto.timingSafeEqual would).
        assert.doesNotThrow(() => router.verifyMasterKey('short'));
        assert.equal(router.verifyMasterKey('short'), false);
        assert.equal(router.verifyMasterKey('omni-correct-master-key-with-extra'), false);
        assert.equal(router.verifyMasterKey(''), false);
        assert.equal(router.verifyMasterKey(null), false);
        assert.equal(router.verifyMasterKey(undefined), false);
        assert.equal(router.verifyMasterKey({ toString: () => 'omni-correct-master-key' }), false);

        // With no key supplied one is generated so the gate is never open.
        const generated = new ProviderRouter({ registry, masterKey: null });
        assert.ok(generated.getMasterKey().length > 20);
        assert.equal(generated.verifyMasterKey(generated.getMasterKey()), true);
        assert.equal(generated.verifyMasterKey('omni-correct-master-key'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Usage ledger
// -----------------------------------------------------------------------------

test('ProviderRouter usage ledger accumulates tokens and cost across calls', async () => {
    const dir = makeTmpDir('usage');
    try {
        const registry = makeRegistry(dir);
        registry.upsert('openai', { baseUrl: 'https://api.openai.test/v1', priority: 10, models: ['gpt-4o-mini'] });
        registry.addKey('openai', 'sk-oai-0000000000000001');

        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        const transport = makeTransport({
            openai: okResponse('openai', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }),
        });

        await router.chatCompletion({ model: 'gpt-4o-mini', messages: [] }, { transport });
        await router.chatCompletion({ model: 'gpt-4o-mini', messages: [] }, { transport });

        const report = router.getUsageReport();
        assert.equal(report.totals.requests, 2);
        assert.equal(report.totals.promptTokens, 2000);
        assert.equal(report.totals.completionTokens, 1000);
        assert.equal(report.totals.totalTokens, 3000);
        // gpt-4o-mini: $0.15/1M in, $0.60/1M out → 2*(0.00015 + 0.0003)
        assert.equal(report.totals.costUsd, 0.0009);

        assert.equal(report.byProvider.openai.requests, 2);
        assert.equal(report.byModel['openai/gpt-4o-mini'].totalTokens, 3000);

        // Unknown models are still counted, just costed at zero.
        assert.deepEqual(router._priceFor('some-unlisted-model'), { input: 0, output: 0 });

        const cleared = router.resetUsage();
        assert.equal(cleared.totals.requests, 0);
        assert.equal(cleared.totals.totalTokens, 0);
        assert.deepEqual(router.getUsageReport().byProvider, {});
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
//  Model catalogue + HTTP surface
// -----------------------------------------------------------------------------

test('ProviderRouter listModels aggregates, caches and never throws', async () => {
    const dir = makeTmpDir('models');
    try {
        const registry = seedPair(makeRegistry(dir));
        registry.upsert('gamma', { baseUrl: 'https://gamma.test/v1', priority: 30 });
        registry.addKey('gamma', 'sk-gamma-000000000001');

        let gammaCalls = 0;
        const router = new ProviderRouter({ registry, masterKey: 'omni-test-key' });
        const transport = makeTransport({
            gamma: () => { gammaCalls += 1; return { status: 500, headers: {}, data: { error: { message: 'catalogue down' } } }; },
        });

        const models = await router.listModels({ transport });
        assert.deepEqual(models.map(m => m.id), ['alpha/test-model', 'beta/test-model'], 'a failing provider is skipped, not fatal');
        assert.equal(models[0].provider, 'alpha');
        assert.equal(models[0].model, 'test-model');
        assert.equal(gammaCalls, 1);

        const cached = await router.listModels({ transport });
        assert.equal(gammaCalls, 1, 'the 5 minute cache prevents a second round trip');
        assert.equal(cached.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ProviderRouter HTTP handler gates on the master key and only claims its own routes', async () => {
    const dir = makeTmpDir('http');
    try {
        const registry = seedPair(makeRegistry(dir));
        const router = new ProviderRouter({ registry, masterKey: 'omni-correct-master-key' });
        const handle = router.createHttpHandler();

        // Unknown paths are left alone for the host server.
        const passthrough = fakeRes();
        assert.equal(handle({ url: '/api/agents', method: 'GET', headers: {} }, passthrough), false);
        assert.equal(passthrough.headersSent, false, 'the handler must not touch responses it does not own');

        // Missing / wrong key → 401.
        const noAuth = fakeRes();
        assert.equal(handle({ url: '/v1/models', method: 'GET', headers: {} }, noAuth), true);
        assert.equal(noAuth.statusCode, 401);

        const badAuth = fakeRes();
        handle({ url: '/v1/models', method: 'GET', headers: { authorization: 'Bearer nope' } }, badAuth);
        assert.equal(badAuth.statusCode, 401);
        assert.equal(JSON.parse(badAuth.body).error.code, 'invalid_api_key');

        // Correct key → 200 usage report.
        const ok = fakeRes();
        assert.equal(handle({ url: '/v1/usage', method: 'GET', headers: { authorization: 'Bearer omni-correct-master-key' } }, ok), true);
        assert.equal(ok.statusCode, 200);
        assert.equal(JSON.parse(ok.body).totals.requests, 0);

        // Wrong verb on a claimed route → 405, still handled.
        const wrongVerb = fakeRes();
        assert.equal(handle({ url: '/v1/usage', method: 'POST', headers: { authorization: 'Bearer omni-correct-master-key' } }, wrongVerb), true);
        assert.equal(wrongVerb.statusCode, 405);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
