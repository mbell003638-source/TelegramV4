// =============================================================================
//  test/meeting-bot.test.js — Recall.ai meeting-bot driver
//
//  Hermetic: injectable transport, no sockets, no store/ writes. The module
//  never joins a call itself; these tests lock that honesty in (no fake
//  success, no invented transcript lines).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const MeetingBot = require('../core/MeetingBot');
const {
    validateMeetUrl,
    isSupportedMeetingHost,
    normalizeTranscript,
    transcriptToText,
    timingSafeStringEqual,
} = MeetingBot;

const GOOD_MEET_URL = 'https://meet.google.com/abc-defg-hij';
const WEBHOOK_SECRET = 'recall-webhook-secret-for-tests';

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Snapshot + restore process.env keys so fromEnv tests cannot leak. */
function withEnv(overrides, fn) {
    const keys = Object.keys(overrides);
    const prev = {};
    for (const k of keys) {
        prev[k] = Object.prototype.hasOwnProperty.call(process.env, k)
            ? process.env[k]
            : undefined;
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    try {
        return fn();
    } finally {
        for (const k of keys) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
    }
}

/** Records every transport call. `handler` may be a fn, a value, or an Error. */
function recordingTransport(handler) {
    const calls = [];
    async function transport(req) {
        calls.push({
            method: req.method,
            url: req.url,
            path: req.path,
            body: req.body,
            apiKey: req.apiKey,
        });
        if (handler instanceof Error) throw handler;
        if (typeof handler === 'function') return handler(req);
        return handler;
    }
    transport.calls = calls;
    return transport;
}

function hmacHex(rawBody, secret = WEBHOOK_SECRET) {
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function assertEmptyTranscript(lines, label) {
    assert.ok(Array.isArray(lines), `${label}: transcript must be an array`);
    assert.equal(lines.length, 0, `${label}: empty/unknown input must not invent lines`);
    const blob = JSON.stringify(lines);
    assert.equal(
        /placeholder|waiting for|no transcript yet|lorem ipsum/i.test(blob),
        false,
        `${label}: must not contain placeholder text`
    );
}

// ===========================================================================
//  validateMeetUrl
// ===========================================================================

test('validateMeetUrl rejects empty values', () => {
    for (const bad of ['', '   ', null, undefined, 0, false]) {
        const result = validateMeetUrl(bad);
        assert.equal(result.ok, false, `expected empty-ish ${JSON.stringify(bad)} to fail`);
        assert.equal(result.reason, 'meetUrl is required');
        assert.equal(result.url, undefined);
    }
});

test('validateMeetUrl rejects strings that are not URLs', () => {
    for (const bad of ['not a url', 'meet.google.com/abc-defg-hij', '://missing', '   nope  ']) {
        const result = validateMeetUrl(bad);
        assert.equal(result.ok, false, `expected "${bad}" to fail`);
        assert.match(result.reason, /not a valid URL/);
    }
});

test('validateMeetUrl rejects non-http(s) schemes', () => {
    for (const bad of ['ftp://meet.google.com/abc', 'file:///tmp/meet', 'javascript:alert(1)']) {
        const result = validateMeetUrl(bad);
        assert.equal(result.ok, false, `expected "${bad}" to fail`);
        assert.match(result.reason, /must be http\(s\)/);
    }
});

test('validateMeetUrl rejects hostnames with no dot', () => {
    for (const bad of ['http://localhost/meet', 'https://zoom/join', 'http://meet/abc']) {
        const result = validateMeetUrl(bad);
        assert.equal(result.ok, false, `expected "${bad}" to fail`);
        assert.match(result.reason, /no public hostname/);
    }
});

test('validateMeetUrl accepts a good https meeting URL', () => {
    const result = validateMeetUrl(`  ${GOOD_MEET_URL}  `);
    assert.equal(result.ok, true);
    assert.equal(result.host, 'meet.google.com');
    assert.equal(result.url, GOOD_MEET_URL);
    assert.equal(result.reason, undefined);
});

// ===========================================================================
//  isSupportedMeetingHost
// ===========================================================================

test('isSupportedMeetingHost is true for Zoom / Meet / Teams / Daily', () => {
    for (const host of [
        'zoom.us',
        'us06web.zoom.us',
        'meet.google.com',
        'teams.microsoft.com',
        'teams.live.com',
        'daily.co',
        'room.daily.co',
    ]) {
        assert.equal(isSupportedMeetingHost(host), true, host);
    }
});

test('isSupportedMeetingHost is false for MiroTalk and random hosts', () => {
    for (const host of [
        'mirotalk.com',
        'p2p.mirotalk.com',
        'example.com',
        'meet.google.com.evil.com',
        '',
        null,
        undefined,
    ]) {
        assert.equal(isSupportedMeetingHost(host), false, String(host));
    }
});

// ===========================================================================
//  normalizeTranscript / transcriptToText
// ===========================================================================

test('normalizeTranscript flattens a words array with participant name', () => {
    const lines = normalizeTranscript([{
        participant: { name: 'Ada' },
        words: [
            { text: 'Hello', start_timestamp: { absolute: '2026-01-01T00:00:00Z' } },
            { text: 'world' },
        ],
    }]);
    assert.deepEqual(lines, [
        { speaker: 'Ada', text: 'Hello world', at: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(transcriptToText(lines), 'Ada: Hello world');
});

test('normalizeTranscript accepts an already-flat speaker/text entry', () => {
    const lines = normalizeTranscript([
        { speaker: 'Bob', text: 'Hi there', timestamp: 1.5 },
    ]);
    assert.deepEqual(lines, [{ speaker: 'Bob', text: 'Hi there', at: 1.5 }]);
    assert.equal(transcriptToText(lines), 'Bob: Hi there');
});

test('normalizeTranscript unwraps { transcript: [...] } and { results: [...] }', () => {
    assert.deepEqual(
        normalizeTranscript({ transcript: [{ speaker: 'Cara', text: 'Yes' }] }),
        [{ speaker: 'Cara', text: 'Yes', at: null }]
    );
    assert.deepEqual(
        normalizeTranscript({ results: [{ speaker: 'Dan', text: 'No', at: 3 }] }),
        [{ speaker: 'Dan', text: 'No', at: 3 }]
    );
});

test('normalizeTranscript returns [] for empty/unknown input and never placeholder text', () => {
    for (const raw of [undefined, null, '', 42, {}, { transcript: [] }, { results: null }, []]) {
        assertEmptyTranscript(normalizeTranscript(raw), JSON.stringify(raw));
    }
    // Entries with no usable text are dropped, not replaced with filler.
    assertEmptyTranscript(
        normalizeTranscript([{ speaker: 'Ghost', words: [] }, { speaker: 'Also', text: '' }, 'nope']),
        'empty entries'
    );
    assert.equal(transcriptToText([]), '');
    assert.equal(transcriptToText(null), '');
    assert.equal(transcriptToText(undefined), '');
});

test('transcriptToText joins normalised lines as speaker: text', () => {
    assert.equal(
        transcriptToText([
            { speaker: 'Ada', text: 'Hello' },
            { speaker: 'Bob', text: 'Hi' },
        ]),
        'Ada: Hello\nBob: Hi'
    );
});

// ===========================================================================
//  timingSafeStringEqual
// ===========================================================================

test('timingSafeStringEqual is true only for equal strings', () => {
    assert.equal(timingSafeStringEqual('abc', 'abc'), true);
    assert.equal(timingSafeStringEqual('', ''), true);
    assert.equal(timingSafeStringEqual('abc', 'abd'), false);
    assert.equal(timingSafeStringEqual('abc', 'abcd'), false);
    assert.equal(timingSafeStringEqual('abcd', 'abc'), false);
    assert.equal(timingSafeStringEqual('abc', ''), false);
});

test('timingSafeStringEqual is false for non-strings', () => {
    for (const bad of [null, undefined, 1, true, {}, [], Buffer.from('abc')]) {
        assert.equal(timingSafeStringEqual(bad, 'abc'), false, `left ${typeof bad}`);
        assert.equal(timingSafeStringEqual('abc', bad), false, `right ${typeof bad}`);
        assert.equal(timingSafeStringEqual(bad, bad), false, `both ${typeof bad}`);
    }
});

// ===========================================================================
//  fromEnv / constructor configuration
// ===========================================================================

test('constructor with no key is unconfigured and names RECALL_API_KEY', () => {
    const bot = new MeetingBot();
    assert.equal(bot.isConfigured, false);
    assert.deepEqual(bot.missingConfig(), ['RECALL_API_KEY']);
    assert.equal(bot.describe().configured, false);
    assert.deepEqual(bot.describe().missing, ['RECALL_API_KEY']);
    assert.equal(bot.describe().capabilities.speakInCall, false);
    assert.equal(bot.describe().capabilities.joinCall, false);
});

test('fromEnv with no RECALL_API_KEY is unconfigured', () => {
    withEnv({
        RECALL_API_KEY: undefined,
        RECALL_API_BASE: undefined,
        RECALL_WEBHOOK_SECRET: undefined,
        RECALL_BOT_NAME: undefined,
    }, () => {
        const bot = MeetingBot.fromEnv();
        assert.equal(bot.isConfigured, false);
        assert.ok(bot.missingConfig().includes('RECALL_API_KEY'));
        assert.deepEqual(bot.missingConfig(), ['RECALL_API_KEY']);
    });
});

test('fromEnv with a key is configured and reports speakInCall', () => {
    withEnv({ RECALL_API_KEY: 'rk-test-key' }, () => {
        const bot = MeetingBot.fromEnv();
        assert.equal(bot.isConfigured, true);
        assert.deepEqual(bot.missingConfig(), []);
        assert.equal(bot.describe().capabilities.speakInCall, true);
        assert.equal(bot.describe().capabilities.joinCall, true);
    });
});

// ===========================================================================
//  join() — refusal paths (no fake success, no transport)
// ===========================================================================

test('join() without a key returns not_configured and never claims success', async () => {
    const transport = recordingTransport(() => { throw new Error('network must not be touched'); });
    const bot = new MeetingBot({ transport });
    const result = await bot.join({ meetUrl: GOOD_MEET_URL });

    assert.equal(result.ok, false);
    assert.equal(result.joined, false);
    assert.equal(result.configured, false);
    assert.equal(result.code, 'not_configured');
    assert.deepEqual(result.missing, ['RECALL_API_KEY']);
    assert.equal(result.botId, undefined);
    assert.equal(result.capabilities, undefined);
    assert.equal(transport.calls.length, 0, 'unconfigured join must not call transport');
});

test('join() with an invalid URL returns invalid_meet_url before any transport call', async () => {
    const transport = recordingTransport(() => ({ id: 'should-not-exist' }));
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });

    for (const bad of ['', 'not a url', 'ftp://meet.google.com/x', 'http://localhost/meet']) {
        transport.calls.length = 0;
        const result = await bot.join({ meetUrl: bad });
        assert.equal(result.ok, false, bad);
        assert.equal(result.joined, false, bad);
        assert.equal(result.code, 'invalid_meet_url', bad);
        assert.equal(transport.calls.length, 0, `transport must not run for "${bad}"`);
    }
});

// ===========================================================================
//  join() — injected transport
// ===========================================================================

test('join() POSTs /bot with automatic_audio_output and capabilities.speaks true', async () => {
    const transport = recordingTransport(() => ({
        id: 'bot-xyz',
        status: { code: 'joining' },
    }));
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });
    const result = await bot.join({ meetUrl: GOOD_MEET_URL });

    assert.equal(result.ok, true);
    assert.equal(result.joined, true);
    assert.equal(result.configured, true);
    assert.equal(result.botId, 'bot-xyz');
    assert.equal(result.provider, 'recall');
    assert.equal(result.meetUrl, GOOD_MEET_URL);
    assert.equal(result.supportedPlatform, true);
    assert.deepEqual(result.capabilities, {
        joinsCall: true,
        transcribes: true,
        speaks: true,
    });

    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/bot');
    assert.match(call.url, /\/bot$/);
    assert.equal(call.apiKey, 'rk-test-key');
    assert.equal(call.body.meeting_url, GOOD_MEET_URL);
    assert.equal(call.body.transcription_options.provider, 'meeting_captions');
    const audioOut = call.body.automatic_audio_output;
    assert.ok(audioOut, 'Create Bot must include automatic_audio_output');
    assert.equal(audioOut.in_call_recording.data.kind, 'mp3');
    assert.equal(typeof audioOut.in_call_recording.data.b64_data, 'string');
    assert.ok(audioOut.in_call_recording.data.b64_data.length > 0);
});

test('join() maps a transport failure to provider_error', async () => {
    const err = new Error('Recall.ai HTTP 500: boom');
    err.statusCode = 500;
    const transport = recordingTransport(err);
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });
    const result = await bot.join({ meetUrl: GOOD_MEET_URL });

    assert.equal(result.ok, false);
    assert.equal(result.joined, false);
    assert.equal(result.configured, true);
    assert.equal(result.code, 'provider_error');
    assert.match(result.error, /boom/);
    assert.equal(result.status, 500);
    assert.equal(result.botId, undefined);
    assert.equal(transport.calls.length, 1);
});

test('join() maps a response with no bot id to no_bot_id', async () => {
    const transport = recordingTransport(() => ({ status: { code: 'joining' } }));
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });
    const result = await bot.join({ meetUrl: GOOD_MEET_URL });

    assert.equal(result.ok, false);
    assert.equal(result.joined, false);
    assert.equal(result.code, 'no_bot_id');
    assert.equal(result.botId, undefined);
    assert.equal(transport.calls.length, 1);
});

// ===========================================================================
//  leave() / status()
// ===========================================================================

test('leave() and status() require a botId', async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });

    for (const id of [undefined, null, '', '   ']) {
        const left = await bot.leave(id);
        assert.equal(left.ok, false);
        assert.equal(left.code, 'invalid_bot_id');

        const st = await bot.status(id);
        assert.equal(st.ok, false);
        assert.equal(st.code, 'invalid_bot_id');
    }
    assert.equal(transport.calls.length, 0);
});

test('leave() without a key returns not_configured', async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    const bot = new MeetingBot({ transport });
    const result = await bot.leave('bot-xyz');

    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.code, 'not_configured');
    assert.deepEqual(result.missing, ['RECALL_API_KEY']);
    assert.equal(transport.calls.length, 0);
});

test('status() without a key returns not_configured', async () => {
    const bot = new MeetingBot();
    const result = await bot.status('bot-xyz');
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.code, 'not_configured');
});

test('speak() with injected tts POSTs /bot/{id}/output_audio as mp3', async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    const ttsCalls = [];
    const bot = new MeetingBot({
        apiKey: 'rk-test-key',
        transport,
        tts: async (text, lang) => {
            ttsCalls.push({ text, lang });
            return [{ b64: 'dGVzdA==', kind: 'mp3' }];
        },
    });

    const result = await bot.speak('bot-xyz', 'Hello there', { lang: 'en' });
    assert.equal(result.ok, true);
    assert.equal(result.spoken, true);
    assert.equal(result.botId, 'bot-xyz');
    assert.equal(result.chars, 'Hello there'.length);

    assert.equal(ttsCalls.length, 1);
    assert.equal(ttsCalls[0].text, 'Hello there');
    assert.equal(ttsCalls[0].lang, 'en');

    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(call.method, 'POST');
    assert.match(call.path, /\/bot\/bot-xyz\/output_audio\/?$/);
    assert.equal(call.body.kind, 'mp3');
    assert.equal(call.body.b64_data, 'dGVzdA==');
});

test('speak() without a key returns not_configured and never calls transport', async () => {
    const transport = recordingTransport(() => { throw new Error('network must not be touched'); });
    let ttsCalled = false;
    const bot = new MeetingBot({
        transport,
        tts: async () => {
            ttsCalled = true;
            return [{ b64: 'xx', kind: 'mp3' }];
        },
    });
    const result = await bot.speak('bot-xyz', 'Hello');

    assert.equal(result.ok, false);
    assert.equal(result.spoken, false);
    assert.equal(result.code, 'not_configured');
    assert.equal(transport.calls.length, 0, 'unconfigured speak must not call transport');
    assert.equal(ttsCalled, false, 'unconfigured speak must not call tts');
});

test('speak() refuses empty text', async () => {
    const transport = recordingTransport(() => ({ ok: true }));
    let ttsCalled = false;
    const bot = new MeetingBot({
        apiKey: 'rk-test-key',
        transport,
        tts: async () => {
            ttsCalled = true;
            return [{ b64: 'xx', kind: 'mp3' }];
        },
    });

    for (const bad of ['', '   ', null, undefined]) {
        const result = await bot.speak('bot-xyz', bad);
        assert.equal(result.ok, false, JSON.stringify(bad));
        assert.equal(result.code, 'empty_text', JSON.stringify(bad));
        assert.equal(result.spoken, false, JSON.stringify(bad));
    }
    assert.equal(transport.calls.length, 0);
    assert.equal(ttsCalled, false);
});

test('leave() and status() call the provider when configured', async () => {
    const transport = recordingTransport((req) => {
        if (req.method === 'GET') return { id: 'bot-xyz', status: { code: 'in_call' } };
        return { id: 'bot-xyz' };
    });
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });

    const st = await bot.status('bot-xyz');
    assert.equal(st.ok, true);
    assert.equal(st.botId, 'bot-xyz');
    assert.equal(st.status, 'in_call');
    assert.equal(transport.calls[0].method, 'GET');
    assert.equal(transport.calls[0].path, '/bot/bot-xyz');

    const left = await bot.leave('bot-xyz');
    assert.equal(left.ok, true);
    assert.equal(left.left, true);
    assert.equal(left.botId, 'bot-xyz');
    assert.equal(transport.calls[1].method, 'POST');
    assert.equal(transport.calls[1].path, '/bot/bot-xyz/leave_call');
});

// ===========================================================================
//  Webhook signature
// ===========================================================================

test('handleWebhook with a secret rejects an invalid signature', () => {
    const bot = new MeetingBot({ apiKey: 'rk-test-key', webhookSecret: WEBHOOK_SECRET });
    const payload = { event: 'bot.status_change', data: { bot_id: 'bot-1' } };
    const rawBody = JSON.stringify(payload);

    const rejected = bot.handleWebhook(payload, { signature: 'deadbeef', rawBody });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'invalid_signature');
    assert.equal(rejected.lines, undefined);

    const missing = bot.handleWebhook(payload, { rawBody });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'invalid_signature');
});

test('handleWebhook with a secret accepts a valid HMAC and records real transcript lines', () => {
    const bot = new MeetingBot({ apiKey: 'rk-test-key', webhookSecret: WEBHOOK_SECRET });
    const payload = {
        event: 'transcript.data',
        data: {
            bot_id: 'bot-1',
            data: {
                participant: { name: 'Eve' },
                words: [{ text: 'The real utterance' }],
            },
        },
    };
    const rawBody = JSON.stringify(payload);
    const accepted = bot.handleWebhook(payload, {
        signature: `sha256=${hmacHex(rawBody)}`,
        rawBody,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.botId, 'bot-1');
    assert.equal(accepted.lines, 1);
    assert.deepEqual(bot.liveLines.get('bot-1'), [
        { speaker: 'Eve', text: 'The real utterance', at: null },
    ]);
});

test('handleWebhook with no secret accepts but does not fabricate transcript lines', async () => {
    const bot = new MeetingBot();
    const payload = { event: 'bot.status_change', data: { bot_id: 'bot-1', status: { code: 'joining' } } };
    const result = bot.handleWebhook(payload);

    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.botId, 'bot-1');
    assert.equal(result.lines, 0);
    assert.equal(bot.liveLines.has('bot-1'), false);

    const tx = await bot.transcript('bot-1');
    assertEmptyTranscript(tx.transcript, 'unsigned status webhook');
    assert.equal(tx.count, 0);
});

test('handleWebhook with no secret still does not invent lines from an empty transcript event', async () => {
    const bot = new MeetingBot();
    const result = bot.handleWebhook({
        event: 'transcript.data',
        data: { bot_id: 'bot-1', data: { words: [], participant: { name: 'Ada' } } },
    });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.lines, 0);

    const tx = await bot.transcript('bot-1');
    assertEmptyTranscript(tx.transcript, 'empty unsigned transcript event');
    assert.equal(tx.count, 0);
});

// ===========================================================================
//  Never invent transcript content
// ===========================================================================

test('transcript() returns an empty array, never placeholder text, when nothing was said', async () => {
    const transport = recordingTransport(() => ({ transcript: [] }));
    const bot = new MeetingBot({ apiKey: 'rk-test-key', transport });

    const missingId = await bot.transcript('');
    assert.equal(missingId.ok, false);
    assertEmptyTranscript(missingId.transcript, 'missing botId');
    assert.equal(missingId.count, 0);

    const empty = await bot.transcript('bot-empty');
    assert.equal(empty.ok, true);
    assert.equal(empty.status, 'empty');
    assert.equal(empty.count, 0);
    assertEmptyTranscript(empty.transcript, 'api empty');
});

test('saveTranscriptToMemory does not write a placeholder when the transcript is empty', async () => {
    const memories = [];
    const indexed = [];
    const transport = recordingTransport(() => []);
    const bot = new MeetingBot({
        apiKey: 'rk-test-key',
        transport,
        database: { addMemory: (...args) => memories.push(args) },
        memorySearch: { index: (row) => { indexed.push(row); return 1; } },
    });

    const result = await bot.saveTranscriptToMemory('bot-empty');
    assert.equal(result.ok, true);
    assert.equal(result.saved, false);
    assert.equal(result.lines, 0);
    assert.equal(memories.length, 0, 'empty transcript must not call addMemory');
    assert.equal(indexed.length, 0, 'empty transcript must not be indexed');
});

test('unconfigured transcript() is empty rather than invented', async () => {
    const bot = new MeetingBot();
    const result = await bot.transcript('bot-1');
    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_configured');
    assert.equal(result.count, 0);
    assertEmptyTranscript(result.transcript, 'unconfigured transcript()');
});
