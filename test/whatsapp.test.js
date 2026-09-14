const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const WhatsAppGateway = require('../core/WhatsAppGateway');
const {
    normalizeNumber,
    splitWhatsAppMessage,
    telegramHtmlToWhatsApp,
    WHATSAPP_MESSAGE_LIMIT,
} = require('../core/WhatsAppGateway');

const APP_SECRET = 'test_app_secret';
const VERIFY_TOKEN = 'test_verify_token';

// -----------------------------------------------------------------------------
//  Hermetic helpers — no network, no real http server.
// -----------------------------------------------------------------------------

function makeGateway(overrides = {}) {
    const sent = [];
    const received = [];
    const gateway = new WhatsAppGateway({
        accessToken: 'test_access_token',
        phoneNumberId: '1234567890',
        verifyToken: VERIFY_TOKEN,
        appSecret: APP_SECRET,
        allowedNumbers: '15550100',
        messageHandler: async (msg) => { received.push(msg); },
        transport: async (payload) => { sent.push(payload); return { messages: [{ id: 'wamid.sent' }] }; },
        ...overrides,
    });
    return { gateway, sent, received };
}

function makeRes() {
    const res = {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
        end(chunk) { res.body = chunk === undefined ? '' : String(chunk); },
    };
    return res;
}

function makeReq(method, url, { body = null, headers = {} } = {}) {
    const req = new PassThrough();
    req.method = method;
    req.url = url;
    req.headers = { host: 'bridge.example.com', ...headers };
    if (body !== null) {
        req.write(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
    }
    req.end();
    return req;
}

function sign(rawBody, secret = APP_SECRET) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
}

function textPayload(from, text, id = 'wamid.HBgLMTU1NTAxMDA=') {
    return JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
            id: '102290129340398',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15550199', phone_number_id: '1234567890' },
                    contacts: [{ profile: { name: 'Ada Lovelace' }, wa_id: normalizeNumber(from) }],
                    messages: [{
                        from: normalizeNumber(from),
                        id,
                        timestamp: '1712345678',
                        type: 'text',
                        text: { body: text },
                    }],
                },
            }],
        }],
    });
}

/** Deliver a POST through the real webhook handler and wait for processing. */
async function post(gateway, rawBody, { signature, headers } = {}) {
    const handler = gateway.createWebhookHandler();
    const res = makeRes();
    const req = makeReq('POST', gateway.webhookPath, {
        body: rawBody,
        headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signature === undefined ? sign(rawBody) : signature,
            ...headers,
        },
    });
    const handled = handler(req, res);
    await gateway.whenIdle();
    return { handled, res };
}

/** Keep expected warn/log noise out of the test output. */
async function quiet(fn) {
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.warn = warn;
        console.log = log;
    }
}

// -----------------------------------------------------------------------------
//  Webhook verification handshake (GET)
// -----------------------------------------------------------------------------

test('WhatsApp webhook GET echoes hub.challenge when the verify token matches', async () => {
    const { gateway } = makeGateway();
    const handler = gateway.createWebhookHandler();
    const res = makeRes();
    const req = makeReq('GET', `${gateway.webhookPath}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);

    const handled = await quiet(() => handler(req, res));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '1158201444');
});

test('WhatsApp webhook GET returns 403 for a wrong verify token', async () => {
    const { gateway } = makeGateway();
    const handler = gateway.createWebhookHandler();
    const res = makeRes();
    const req = makeReq('GET', `${gateway.webhookPath}?hub.mode=subscribe&hub.verify_token=not_the_token&hub.challenge=1158201444`);

    const handled = await quiet(() => handler(req, res));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.notEqual(res.body, '1158201444');
});

test('WhatsApp webhook handler ignores paths it does not own', () => {
    const { gateway } = makeGateway();
    const handler = gateway.createWebhookHandler();
    const res = makeRes();
    const req = makeReq('GET', '/api/agents?token=admin');

    assert.equal(handler(req, res), false);
    assert.equal(res.statusCode, null);
});

// -----------------------------------------------------------------------------
//  X-Hub-Signature-256 verification
// -----------------------------------------------------------------------------

test('WhatsApp webhook accepts a correctly signed payload', async () => {
    const { gateway, received } = makeGateway();
    const body = textPayload('15550100', 'hello from whatsapp');

    const { handled, res } = await post(gateway, body);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'EVENT_RECEIVED');
    assert.equal(received.length, 1);
    assert.equal(received[0].content.text, 'hello from whatsapp');
});

test('WhatsApp webhook rejects a tampered payload with 403', async () => {
    const { gateway, received } = makeGateway();
    const body = textPayload('15550100', 'legitimate message');
    const signature = sign(body);
    const tampered = textPayload('15550100', 'legitimate message!!');

    const { res } = await quiet(() => post(gateway, tampered, { signature }));

    assert.equal(res.statusCode, 403);
    assert.equal(received.length, 0);
});

test('WhatsApp signature check rejects a wrong-length signature without throwing', async () => {
    const { gateway, received } = makeGateway();
    const body = textPayload('15550100', 'short signature attack');

    // Direct unit check: timingSafeEqual throws on unequal lengths, we must not.
    assert.doesNotThrow(() => gateway.verifySignature(Buffer.from(body, 'utf8'), 'sha256=deadbeef'));
    assert.equal(gateway.verifySignature(Buffer.from(body, 'utf8'), 'sha256=deadbeef'), false);
    assert.equal(gateway.verifySignature(Buffer.from(body, 'utf8'), ''), false);
    assert.equal(gateway.verifySignature(Buffer.from(body, 'utf8'), undefined), false);

    // And end-to-end through the webhook.
    const { res } = await quiet(() => post(gateway, body, { signature: 'sha256=deadbeef' }));
    assert.equal(res.statusCode, 403);
    assert.equal(received.length, 0);
});

test('WhatsApp signature is computed over the RAW bytes, not a re-serialized object', async () => {
    const { gateway, received } = makeGateway();
    // Same JSON value, different byte layout (extra whitespace).
    const raw = JSON.stringify(JSON.parse(textPayload('15550100', 'raw bytes matter')), null, 4);

    const { res } = await post(gateway, raw, { signature: sign(raw) });

    assert.equal(res.statusCode, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].content.text, 'raw bytes matter');
});

// -----------------------------------------------------------------------------
//  Allow-list
// -----------------------------------------------------------------------------

test('WhatsApp allow-list blocks an unknown number', async () => {
    const { gateway, received } = makeGateway({ allowedNumbers: '15550100' });
    const body = textPayload('15559999', 'let me in');

    const { res } = await quiet(() => post(gateway, body));

    assert.equal(res.statusCode, 200); // still acked so Meta stops retrying
    assert.equal(received.length, 0);
});

test('WhatsApp allow-list matches differently formatted equivalents', async () => {
    const { gateway, received } = makeGateway({ allowedNumbers: '+1 555-0100, +1 (555) 0199' });

    assert.equal(gateway.isAllowed('15550100'), true);
    assert.equal(gateway.isAllowed('+1 555 0100'), true);
    assert.equal(gateway.isAllowed('+1-555-0199'), true);
    assert.equal(gateway.isAllowed('15550101'), false);

    const { res } = await post(gateway, textPayload('15550100', 'formatted allow-list'));

    assert.equal(res.statusCode, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].user.id, '15550100');
});

test('WhatsApp allow-list accepts an array and normalises both sides', () => {
    const { gateway } = makeGateway({ allowedNumbers: ['15550100', ' +44 7700 900123 '] });
    assert.equal(gateway.isAllowed('447700900123'), true);
    assert.equal(gateway.isAllowed('+44 7700-900123'), true);
    assert.equal(gateway.isAllowed('447700900999'), false);
});

// -----------------------------------------------------------------------------
//  Idempotency
// -----------------------------------------------------------------------------

test('WhatsApp retried delivery with the same message id runs the agent once', async () => {
    const { gateway, received } = makeGateway();
    const body = textPayload('15550100', 'run this once', 'wamid.RETRY_ME');

    await post(gateway, body);
    await quiet(() => post(gateway, body)); // Meta retry, byte-identical
    await quiet(() => post(gateway, body)); // and again

    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'wamid.RETRY_ME');
});

test('WhatsApp dedupe cache stays bounded', async () => {
    const { gateway } = makeGateway({ maxSeenIds: 5 });
    await quiet(async () => {
        for (let i = 0; i < 25; i++) {
            await gateway.handleWebhookPayload(JSON.parse(textPayload('15550100', `msg ${i}`, `wamid.${i}`)));
        }
    });
    assert.equal(gateway.seenMessageIds.size, 5);
    assert.equal(gateway.seenMessageIds.has('wamid.24'), true);
    assert.equal(gateway.seenMessageIds.has('wamid.0'), false);
});

// -----------------------------------------------------------------------------
//  Unified message contract
// -----------------------------------------------------------------------------

test('WhatsApp builds the same unified message shape Gateway.js produces', async () => {
    const { gateway, received } = makeGateway();
    await post(gateway, textPayload('15550100', 'shape check', 'wamid.SHAPE'));

    const msg = received[0];
    assert.equal(msg.id, 'wamid.SHAPE');
    assert.equal(msg.platform, 'whatsapp');
    assert.equal(msg.chatId, '15550100');
    assert.deepEqual(Object.keys(msg).sort(), ['action', 'chatId', 'content', 'id', 'platform', 'raw', 'timestamp', 'user']);
    assert.equal(msg.user.id, '15550100');
    assert.equal(msg.user.displayName, 'Ada Lovelace');
    assert.equal(msg.content.type, 'text');
    assert.equal(msg.content.text, 'shape check');
    assert.deepEqual(msg.content.attachments, []);
    assert.equal(msg.timestamp, 1712345678 * 1000);
    assert.equal(msg.action, null);
    assert.equal(typeof msg.raw.reply, 'function');
    assert.equal(msg.raw.chat.id, '15550100');
});

test('WhatsApp raw context reply() sends through the transport and never rejects', async () => {
    const { gateway, received, sent } = makeGateway();
    await post(gateway, textPayload('15550100', 'reply please', 'wamid.REPLY'));

    const result = await received[0].raw.reply('<b>Done</b> &amp; dusted', { parse_mode: 'HTML' });

    assert.equal(result, undefined); // no message_id ⇒ executor skips placeholder edits
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '15550100');
    assert.equal(sent[0].type, 'text');
    assert.equal(sent[0].text.body, '*Done* & dusted');
});

test('WhatsApp maps slash commands to the same system actions as Telegram', async () => {
    const { gateway, received } = makeGateway();
    await post(gateway, textPayload('15550100', '/new', 'wamid.CMD'));

    assert.equal(received.length, 1);
    assert.equal(received[0].content.type, 'action');
    assert.deepEqual(received[0].action, { type: 'system', name: 'session.new', params: undefined });
});

// -----------------------------------------------------------------------------
//  Outbound chunking
// -----------------------------------------------------------------------------

test('WhatsApp chunking splits at <=4096 and prefers a newline boundary', () => {
    const text = 'A'.repeat(4000) + '\n' + 'B'.repeat(1200);
    const chunks = splitWhatsAppMessage(text);

    assert.equal(chunks.length, 2);
    assert.ok(chunks.every(c => c.length <= WHATSAPP_MESSAGE_LIMIT));
    assert.equal(chunks[0], 'A'.repeat(4000));
    assert.equal(chunks[1], 'B'.repeat(1200));
});

test('WhatsApp chunking hard-cuts text with no natural break point', () => {
    const chunks = splitWhatsAppMessage('X'.repeat(9000));
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every(c => c.length <= WHATSAPP_MESSAGE_LIMIT));
    assert.equal(chunks.join('').length, 9000);
});

test('WhatsApp sendMessage emits one Cloud API payload per chunk', async () => {
    const { gateway, sent } = makeGateway();
    const text = 'L'.repeat(4000) + '\n' + 'R'.repeat(500);

    const results = await gateway.sendMessage('+1 555-0100', text);

    assert.equal(results.length, 2);
    assert.equal(sent.length, 2);
    for (const payload of sent) {
        assert.equal(payload.messaging_product, 'whatsapp');
        assert.equal(payload.to, '15550100');
        assert.equal(payload.type, 'text');
        assert.ok(payload.text.body.length <= WHATSAPP_MESSAGE_LIMIT);
    }
    assert.equal(sent[0].text.body, 'L'.repeat(4000));
    assert.equal(sent[1].text.body, 'R'.repeat(500));
});

test('WhatsApp converts Telegram HTML replies into WhatsApp formatting', () => {
    assert.equal(telegramHtmlToWhatsApp('<b>bold</b> and <i>italic</i>'), '*bold* and _italic_');
    assert.equal(telegramHtmlToWhatsApp('<code>ls -la</code>'), '`ls -la`');
    assert.equal(telegramHtmlToWhatsApp('5 &lt; 7 &amp;&amp; 8 &gt; 6'), '5 < 7 && 8 > 6');
    assert.equal(telegramHtmlToWhatsApp('no tags here'), 'no tags here');
});

// -----------------------------------------------------------------------------
//  Degraded / unconfigured operation
// -----------------------------------------------------------------------------

test('WhatsApp gateway constructs and starts without credentials instead of throwing', async () => {
    await quiet(async () => {
        const gateway = new WhatsAppGateway({});
        assert.equal(gateway.isConfigured, false);
        assert.equal(gateway.canReceive, false);

        const started = await gateway.start();
        assert.equal(started, false);
        assert.equal(gateway.running, false);

        // Outbound is a logged no-op rather than a crash.
        assert.deepEqual(await gateway.sendMessage('15550100', 'hi'), []);

        // The webhook still answers (403) rather than throwing.
        const handler = gateway.createWebhookHandler();
        const res = makeRes();
        assert.equal(handler(makeReq('GET', `${gateway.webhookPath}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=9`), res), true);
        assert.equal(res.statusCode, 403);

        assert.doesNotThrow(() => gateway.stop());
    });
});

test('WhatsApp fromEnv returns null when no WhatsApp env vars are present', async () => {
    const saved = {
        WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    };
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    try {
        assert.equal(WhatsAppGateway.fromEnv(), null);

        process.env.WHATSAPP_VERIFY_TOKEN = 'abc';
        const gateway = WhatsAppGateway.fromEnv();
        assert.ok(gateway instanceof WhatsAppGateway);
        assert.equal(gateway.canReceive, true);
        assert.equal(gateway.isConfigured, false);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('WhatsApp webhook without an app secret accepts unsigned payloads but still allow-lists', async () => {
    const { gateway, received } = makeGateway({ appSecret: '' });

    await quiet(() => post(gateway, textPayload('15550100', 'unsigned ok', 'wamid.UNSIGNED'), { signature: '' }));
    assert.equal(received.length, 1);

    await quiet(() => post(gateway, textPayload('15559999', 'unsigned blocked', 'wamid.UNSIGNED2'), { signature: '' }));
    assert.equal(received.length, 1);
});

test('WhatsApp ignores status receipts and malformed payloads without throwing', async () => {
    const { gateway, received } = makeGateway();
    await quiet(async () => {
        await gateway.handleWebhookPayload({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] } }] }] });
        await gateway.handleWebhookPayload({});
        await gateway.handleWebhookPayload(null);
        await gateway.handleWebhookPayload({ entry: 'nonsense' });
    });
    assert.equal(received.length, 0);
});

test('WhatsApp webhook returns 400 on a signed but non-JSON body', async () => {
    const { gateway, received } = makeGateway();
    const { res } = await quiet(() => post(gateway, 'this is not json'));
    assert.equal(res.statusCode, 400);
    assert.equal(received.length, 0);
});
