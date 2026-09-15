const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const ProviderRegistry = require('../core/ProviderRegistry');
const ProviderRouter = require('../core/ProviderRouter');

// -----------------------------------------------------------------------------
//  Helpers — hermetic: fake transport, no sockets, no network.
// -----------------------------------------------------------------------------

function makeTmpDir(label) {
    const dir = path.join(__dirname, `tmp_openai_compat_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeRegistry(dir) {
    return new ProviderRegistry(dir, { env: {}, seed: false });
}

function seedPair(registry) {
    registry.upsert('alpha', { label: 'Alpha', baseUrl: 'https://alpha.test/v1', priority: 10, models: ['test-model'] });
    registry.addKey('alpha', 'sk-alpha-000000000000001');
    registry.upsert('beta', { label: 'Beta', baseUrl: 'https://beta.test/v1', priority: 20, models: ['test-model'] });
    registry.addKey('beta', 'sk-beta-0000000000000001');
    return registry;
}

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

function fakeReq({ url, method = 'GET', headers = {}, body }) {
    const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = Readable.from([Buffer.from(payload, 'utf8')]);
    req.url = url;
    req.method = method;
    req.headers = headers;
    return req;
}

function fakeRes() {
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const res = {
        headersSent: false,
        statusCode: 0,
        headers: null,
        body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        write(chunk) { this.body += chunk; return true; },
        end(chunk) { if (chunk) this.body += chunk; resolveDone(this); },
        done,
    };
    return res;
}

async function invoke(handle, opts) {
    const req = fakeReq(opts);
    const res = fakeRes();
    const claimed = handle(req, res);
    if (!claimed) return { claimed, res };
    await res.done;
    return { claimed, res };
}

const MASTER = 'omni-compat-master-key';

function makeRouter(dir, transport) {
    const registry = seedPair(makeRegistry(dir));
    return new ProviderRouter({ registry, masterKey: MASTER, transport });
}

// -----------------------------------------------------------------------------
//  HTTP surface
// -----------------------------------------------------------------------------

test('HTTP handler leaves unknown paths unclaimed', () => {
    const dir = makeTmpDir('unknown');
    try {
        const router = makeRouter(dir, makeTransport({ alpha: okResponse('alpha') }));
        const handle = router.createHttpHandler();
        const res = fakeRes();
        assert.equal(handle({ url: '/api/agents', method: 'GET', headers: {} }, res), false);
        assert.equal(res.headersSent, false);
        assert.equal(handle({ url: '/v1/foo', method: 'POST', headers: { authorization: `Bearer ${MASTER}` } }, res), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/messages and /v1/responses reject a bad key with 401', () => {
    const dir = makeTmpDir('auth');
    try {
        const router = makeRouter(dir, makeTransport({ alpha: okResponse('alpha') }));
        const handle = router.createHttpHandler();

        const bearer = fakeRes();
        assert.equal(handle({ url: '/v1/messages', method: 'POST', headers: { authorization: 'Bearer nope' } }, bearer), true);
        assert.equal(bearer.statusCode, 401);
        assert.equal(JSON.parse(bearer.body).error.code, 'invalid_api_key');

        const xApiKey = fakeRes();
        assert.equal(handle({ url: '/v1/messages', method: 'POST', headers: { 'x-api-key': 'nope' } }, xApiKey), true);
        assert.equal(xApiKey.statusCode, 401);

        const missing = fakeRes();
        assert.equal(handle({ url: '/v1/responses', method: 'POST', headers: {} }, missing), true);
        assert.equal(missing.statusCode, 401);

        const responsesBad = fakeRes();
        handle({ url: '/v1/responses', method: 'POST', headers: { authorization: 'Bearer nope' } }, responsesBad);
        assert.equal(responsesBad.statusCode, 401);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/messages round-trips Anthropic → chatCompletion → Anthropic (x-api-key)', async () => {
    const dir = makeTmpDir('messages-xkey');
    try {
        const transport = makeTransport({ alpha: okResponse('alpha') });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const { claimed, res } = await invoke(handle, {
            url: '/v1/messages',
            method: 'POST',
            headers: { 'x-api-key': MASTER, 'content-type': 'application/json' },
            body: {
                model: 'test-model',
                max_tokens: 128,
                system: 'You are a test.',
                messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            },
        });

        assert.equal(claimed, true);
        assert.equal(res.statusCode, 200);
        assert.equal(transport.calls.length, 1);
        assert.equal(transport.calls[0].url, 'https://alpha.test/v1/chat/completions');
        assert.equal(transport.calls[0].body.stream, false);
        assert.equal(transport.calls[0].body.max_tokens, 128);
        assert.deepEqual(transport.calls[0].body.messages, [
            { role: 'system', content: 'You are a test.' },
            { role: 'user', content: 'hello' },
        ]);

        const payload = JSON.parse(res.body);
        assert.equal(payload.type, 'message');
        assert.equal(payload.role, 'assistant');
        assert.ok(Array.isArray(payload.content));
        assert.equal(payload.content[0].type, 'text');
        assert.equal(payload.content[0].text, 'hi from alpha');
        assert.equal(payload.stop_reason, 'end_turn');
        assert.equal(payload.usage.input_tokens, 10);
        assert.equal(payload.usage.output_tokens, 5);
        assert.equal(res.headers['x-omnirouter-provider'], 'alpha');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/messages also accepts Authorization Bearer', async () => {
    const dir = makeTmpDir('messages-bearer');
    try {
        const transport = makeTransport({ alpha: okResponse('alpha') });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const { claimed, res } = await invoke(handle, {
            url: '/v1/messages',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: {
                model: 'test-model',
                max_tokens: 32,
                messages: [{ role: 'user', content: 'hi' }],
            },
        });

        assert.equal(claimed, true);
        assert.equal(res.statusCode, 200);
        const payload = JSON.parse(res.body);
        assert.equal(payload.role, 'assistant');
        assert.equal(payload.content[0].text, 'hi from alpha');
        assert.equal(transport.calls.length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/responses round-trips input/model → chatCompletion → output/status', async () => {
    const dir = makeTmpDir('responses');
    try {
        const transport = makeTransport({ alpha: okResponse('alpha') });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const stringIn = await invoke(handle, {
            url: '/v1/responses',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: { model: 'test-model', input: 'hello from codex' },
        });

        assert.equal(stringIn.claimed, true);
        assert.equal(stringIn.res.statusCode, 200);
        assert.equal(transport.calls.length, 1);
        assert.equal(transport.calls[0].url, 'https://alpha.test/v1/chat/completions');
        assert.equal(transport.calls[0].body.stream, false);
        assert.deepEqual(transport.calls[0].body.messages, [{ role: 'user', content: 'hello from codex' }]);

        const payload = JSON.parse(stringIn.res.body);
        assert.equal(payload.status, 'completed');
        assert.equal(payload.object, 'response');
        assert.ok(Array.isArray(payload.output));
        assert.equal(payload.output[0].type, 'message');
        assert.equal(payload.output[0].role, 'assistant');
        assert.equal(payload.output[0].content[0].type, 'output_text');
        assert.equal(payload.output[0].content[0].text, 'hi from alpha');
        assert.equal(payload.usage.input_tokens, 10);
        assert.equal(payload.usage.output_tokens, 5);

        const arrayIn = await invoke(handle, {
            url: '/v1/responses',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: {
                model: 'test-model',
                instructions: 'Be brief.',
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
            },
        });
        assert.equal(arrayIn.res.statusCode, 200);
        assert.deepEqual(transport.calls[1].body.messages, [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'ping' },
        ]);
        assert.equal(JSON.parse(arrayIn.res.body).status, 'completed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/chat/completions still returns an OpenAI chat.completion', async () => {
    const dir = makeTmpDir('chat');
    try {
        const transport = makeTransport({ alpha: okResponse('alpha') });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const { claimed, res } = await invoke(handle, {
            url: '/v1/chat/completions',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        });

        assert.equal(claimed, true);
        assert.equal(res.statusCode, 200);
        const payload = JSON.parse(res.body);
        assert.equal(payload.object, 'chat.completion');
        assert.equal(payload.choices[0].message.role, 'assistant');
        assert.equal(payload.choices[0].message.content, 'hi from alpha');
        assert.equal(payload.usage.prompt_tokens, 10);
        assert.equal(transport.calls[0].url, 'https://alpha.test/v1/chat/completions');
        assert.deepEqual(transport.calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
        assert.equal(transport.calls[0].body.stream, undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function openaiSseStream(pieces) {
    const frames = [];
    frames.push(`data: ${JSON.stringify({
        id: 'chatcmpl-stream1',
        object: 'chat.completion.chunk',
        model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`);
    for (const piece of pieces) {
        frames.push(`data: ${JSON.stringify({
            id: 'chatcmpl-stream1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`);
    }
    frames.push(`data: ${JSON.stringify({
        id: 'chatcmpl-stream1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    frames.push('data: [DONE]\n\n');
    return Readable.from(frames);
}

test('POST /v1/messages stream:true re-emits Anthropic text_delta events token-by-token', async () => {
    const dir = makeTmpDir('messages-sse');
    try {
        const transport = makeTransport({
            alpha: (request) => {
                assert.equal(request.stream, true);
                return { status: 200, headers: {}, stream: openaiSseStream(['Hel', 'lo']) };
            },
        });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const { res } = await invoke(handle, {
            url: '/v1/messages',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        });

        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /text\/event-stream/);
        assert.match(res.body, /event: content_block_delta/);
        const deltas = [...res.body.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
        assert.deepEqual(deltas, ['Hel', 'lo'], 'each upstream token must become its own Anthropic delta');
        assert.match(res.body, /event: message_stop/);
        assert.equal(transport.calls[0].body.stream, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('POST /v1/responses stream:true re-emits output_text.delta events token-by-token', async () => {
    const dir = makeTmpDir('responses-sse');
    try {
        const transport = makeTransport({
            alpha: (request) => {
                assert.equal(request.stream, true);
                return { status: 200, headers: {}, stream: openaiSseStream(['Hi', ' there']) };
            },
        });
        const router = makeRouter(dir, transport);
        const handle = router.createHttpHandler();

        const { res } = await invoke(handle, {
            url: '/v1/responses',
            method: 'POST',
            headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
            body: { model: 'test-model', stream: true, input: 'hi' },
        });

        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /text\/event-stream/);
        const deltas = [...res.body.matchAll(/"type":"response\.output_text\.delta"[^}]*"delta":"([^"]*)"/g)].map((m) => m[1]);
        // JSON key order is type then delta in our writer.
        const simple = [...res.body.matchAll(/"delta":"(Hi| there)"/g)].map((m) => m[1]);
        assert.deepEqual(simple, ['Hi', ' there']);
        assert.match(res.body, /event: response\.completed/);
        assert.equal(transport.calls[0].body.stream, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
