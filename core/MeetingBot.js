// =============================================================================
//  core/MeetingBot.js — Put an agent IN the call (Recall.ai meeting bot)
//
//  WHAT THIS CLOSES
//  ----------------
//  Today the stack CREATES meetings (Daily.co rooms, a Google Meet link, or a
//  MiroTalk P2P fallback), persists the session (Database.addMeetingSession)
//  and syncs notes to Obsidian. What it could not do was put an agent IN the
//  call as a real audio participant. This module does that.
//
//  HONEST CAPABILITY STATEMENT — READ BEFORE TRUSTING THIS
//  ------------------------------------------------------
//  A plain Node process CANNOT join a WebRTC call on its own. Joining means
//  negotiating ICE/DTLS/SRTP, decoding Opus, and rendering video — a whole
//  media stack (libwebrtc / a headless Chromium) that this repo does not ship
//  and cannot fake. So this module does NOT join calls itself.
//
//  Instead it DRIVES a third-party meeting-bot service that genuinely does:
//  Recall.ai. Recall runs the browser/media plumbing in their infrastructure,
//  walks the bot into the meeting as a named participant, and streams back
//  transcription.
//
//  Concretely, what the targeted Recall.ai v1 API DOES support:
//    * Joining Zoom / Google Meet / Microsoft Teams / Webex / Slack huddles
//      and other supported platforms as a visible participant.
//    * Real-time and post-call transcription, pulled or pushed by webhook.
//    * Recording, participant events, leaving the call on command.
//
//  What this module DOES NOT do — and does not pretend to do:
//    * It does NOT make the agent SPEAK in the call. Nothing here sends audio
//      into the meeting. Recall does offer separate output-media features on
//      some plans, but this module deliberately does not drive them, so do not
//      claim the agent talks. It listens and transcribes. That is all.
//    * It does NOT work on MiroTalk P2P or an arbitrary custom WebRTC room —
//      Recall supports a fixed list of platforms. A MiroTalk fallback room
//      remains human-only.
//    * It does NOT work at all without a paid RECALL_API_KEY. With no key,
//      join() returns an explicit not-configured result naming what is
//      missing. It never returns a fake success and never silently no-ops.
//    * It NEVER fabricates a transcript. No data yet means an empty array and
//      a status, not placeholder text.
//
//  Env vars:
//    RECALL_API_KEY          Recall.ai API key (required to join anything)
//    RECALL_API_BASE         optional region base, default us-west-2 v1
//    RECALL_WEBHOOK_SECRET   optional HMAC secret for inbound webhooks
//    RECALL_BOT_NAME         optional default display name in the call
//
//  No new npm dependency: node:https + node:crypto only. `transport` is
//  injectable so tests never touch the network.
// =============================================================================
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://us-west-2.recall.ai/api/v1';
const DEFAULT_BOT_NAME = 'ClaudeClaw Agent';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_SEEN_EVENTS = 1000;
const MAX_BUFFERED_LINES = 500;
const PROVIDER = 'recall';

// Platforms Recall.ai can actually walk a bot into. Anything else (notably the
// MiroTalk P2P fallback) is rejected up front rather than billed and failed.
const SUPPORTED_HOST_RE = /(zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|gotomeet(ing)?\.me|gotomeeting\.com|slack\.com|chime\.aws|daily\.co|whereby\.com)$/i;

// -----------------------------------------------------------------------------
//  Pure helpers (exported for tests)
// -----------------------------------------------------------------------------

/**
 * Is this a plausible http(s) meeting URL? Checked BEFORE any network call so
 * a typo never becomes a billed provider request.
 * @returns {{ ok: boolean, url?: string, host?: string, reason?: string }}
 */
function validateMeetUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return { ok: false, reason: 'meetUrl is required' };
    if (raw.length > 2048) return { ok: false, reason: 'meetUrl is implausibly long' };

    let parsed;
    try {
        parsed = new URL(raw);
    } catch (e) {
        return { ok: false, reason: `meetUrl is not a valid URL: ${raw.slice(0, 80)}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: `meetUrl must be http(s), got "${parsed.protocol}"` };
    }
    // A hostname with no dot is either localhost or nonsense — never a meeting.
    if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) {
        return { ok: false, reason: `meetUrl has no public hostname: "${parsed.hostname}"` };
    }
    return { ok: true, url: parsed.toString(), host: parsed.hostname };
}

/** True when Recall.ai is known to support this meeting host. */
function isSupportedMeetingHost(host) {
    return SUPPORTED_HOST_RE.test(String(host || ''));
}

/** Constant-time string compare that never throws on a length mismatch. */
function timingSafeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false; // timingSafeEqual throws otherwise
    try {
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
        return false;
    }
}

/**
 * Normalise every transcript shape Recall.ai has shipped into
 * [{ speaker, text, at }].
 *
 * Handles:
 *   [{ participant: { name }, words: [{ text, start_timestamp: {...} }] }]
 *   [{ speaker, words: [{ text, start_timestamp: 1.5 }] }]
 *   [{ speaker, text, timestamp }]            (already flat)
 *   { transcript: [...] } / { results: [...] } (wrapped)
 *
 * `at` is the absolute ISO timestamp when the provider gives one, otherwise
 * the relative offset in seconds, otherwise null. Never invented.
 */
function normalizeTranscript(raw) {
    let list = raw;
    if (list && !Array.isArray(list)) {
        list = list.transcript || list.results || list.data || list.words || null;
    }
    if (!Array.isArray(list)) return [];

    const out = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;

        const speaker = String(
            entry.speaker
            || entry.participant?.name
            || entry.participant?.id
            || entry.speaker_name
            || 'Unknown'
        );

        let text = '';
        let at = pickTimestamp(entry.start_timestamp ?? entry.timestamp ?? entry.at);

        if (Array.isArray(entry.words) && entry.words.length) {
            const parts = [];
            for (const word of entry.words) {
                if (!word) continue;
                const piece = typeof word === 'string' ? word : String(word.text ?? '');
                if (piece) parts.push(piece);
                if (at === null && typeof word === 'object') {
                    at = pickTimestamp(word.start_timestamp ?? word.timestamp);
                }
            }
            text = parts.join(' ').replace(/\s+/g, ' ').trim();
        } else if (entry.text !== undefined) {
            text = String(entry.text ?? '').trim();
        }

        if (!text) continue; // never emit a placeholder line
        out.push({ speaker, text, at });
    }
    return out;
}

/** Recall timestamps are either a number or { relative, absolute }. */
function pickTimestamp(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return value || null;
    if (typeof value === 'object') {
        if (value.absolute) return String(value.absolute);
        if (typeof value.relative === 'number' && Number.isFinite(value.relative)) return value.relative;
    }
    return null;
}

/** Render normalised lines as the plain text stored in memory. */
function transcriptToText(lines) {
    return (Array.isArray(lines) ? lines : [])
        .map((l) => `${l.speaker}: ${l.text}`)
        .join('\n');
}

// -----------------------------------------------------------------------------
//  MeetingBot
// -----------------------------------------------------------------------------
class MeetingBot {
    /**
     * @param {object}   options
     * @param {string}   [options.apiKey]        RECALL_API_KEY
     * @param {object}   [options.database]      core/Database instance
     * @param {object}   [options.memorySearch]  core/MemorySearch instance
     * @param {Function} [options.transport]     async ({method,url,body,headers}) => parsed — injected in tests
     * @param {string}   [options.baseUrl]       RECALL_API_BASE
     * @param {string}   [options.webhookSecret] RECALL_WEBHOOK_SECRET
     * @param {string}   [options.botName]       RECALL_BOT_NAME
     * @param {number}   [options.maxSeenEvents] dedupe cache cap (default 1000)
     */
    constructor(options = {}) {
        const {
            apiKey,
            database,
            memorySearch,
            transport,
            baseUrl,
            webhookSecret,
            botName,
            maxSeenEvents,
        } = options;

        this.provider = PROVIDER;
        this.apiKey = apiKey ? String(apiKey).trim() : '';
        this.database = database || null;
        this.memorySearch = memorySearch || null;
        // Injectable for tests; defaults to a builtin https request.
        this.transport = typeof transport === 'function' ? transport : null;
        this.baseUrl = String(baseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
        this.webhookSecret = webhookSecret ? String(webhookSecret) : '';
        this.botName = String(botName || DEFAULT_BOT_NAME);
        this.maxSeenEvents = Number.isFinite(maxSeenEvents) && maxSeenEvents > 0
            ? maxSeenEvents
            : MAX_SEEN_EVENTS;

        /** botId -> { botId, sessionId, meetUrl, botName, joinedAt, status } */
        this.active = new Map();
        /** Bounded dedupe of webhook event ids. */
        this.seenEventIds = new Set();
        /** botId -> normalised lines pushed by webhook (bounded). */
        this.liveLines = new Map();

        this._warnedUnsigned = false;
    }

    /** True when a provider API key is present, i.e. a bot can actually join. */
    get isConfigured() {
        return Boolean(this.apiKey);
    }

    /** Build from process.env; safe to call with nothing configured. */
    static fromEnv(extra = {}) {
        return new MeetingBot({
            apiKey: process.env.RECALL_API_KEY,
            baseUrl: process.env.RECALL_API_BASE,
            webhookSecret: process.env.RECALL_WEBHOOK_SECRET,
            botName: process.env.RECALL_BOT_NAME,
            ...extra,
        });
    }

    /**
     * Exactly what is missing, so join() can say so instead of guessing.
     * @returns {string[]}
     */
    missingConfig() {
        const missing = [];
        if (!this.apiKey) missing.push('RECALL_API_KEY');
        return missing;
    }

    // =========================================================================
    //  Joining / leaving
    // =========================================================================

    /**
     * Dispatch a provider bot into a live call and remember its id against the
     * meeting session.
     *
     * With no RECALL_API_KEY this returns
     *   { ok:false, joined:false, configured:false, missing:['RECALL_API_KEY'], error, hint }
     * — an explicit refusal. It does NOT claim a bot joined.
     *
     * @param {object} args
     * @param {string} args.meetUrl             the meeting link to join
     * @param {string} [args.sessionId]         live_meetings row to attach the bot id to
     * @param {string} [args.botName]           display name shown in the call
     * @param {boolean} [args.transcription]    request transcription (default true)
     * @returns {Promise<object>} never throws
     */
    async join({ meetUrl, sessionId, botName, transcription = true } = {}) {
        // 1. Validate the URL BEFORE calling out.
        const check = validateMeetUrl(meetUrl);
        if (!check.ok) {
            console.warn(`[MeetingBot] Refusing to join: ${check.reason}`);
            return {
                ok: false,
                joined: false,
                configured: this.isConfigured,
                provider: this.provider,
                error: check.reason,
                code: 'invalid_meet_url',
            };
        }

        // 2. Refuse loudly when the provider is not configured.
        const missing = this.missingConfig();
        if (missing.length) {
            const error = `Cannot put an agent in the call: ${missing.join(', ')} is not configured.`;
            console.warn(`[MeetingBot] ${error}`);
            return {
                ok: false,
                joined: false,
                configured: false,
                provider: this.provider,
                missing,
                meetUrl: check.url,
                sessionId: sessionId || null,
                error,
                code: 'not_configured',
                hint: 'Room creation and note syncing work without any paid service. Putting a bot INSIDE the call needs a Recall.ai key in RECALL_API_KEY — a Node process cannot join a WebRTC call by itself. See docs/MEETINGS.md.',
            };
        }

        const supported = isSupportedMeetingHost(check.host);
        if (!supported) {
            console.warn(`[MeetingBot] ${check.host} is not a platform Recall.ai supports — attempting anyway.`);
        }

        const name = String(botName || this.botName);
        const body = {
            meeting_url: check.url,
            bot_name: name,
        };
        if (transcription) {
            // meeting_captions needs no extra STT vendor account.
            body.transcription_options = { provider: 'meeting_captions' };
        }

        // 3. Dispatch. A provider error is returned, not swallowed.
        let created;
        try {
            created = await this._request('POST', '/bot', body);
        } catch (err) {
            console.warn(`[MeetingBot] join failed: ${err.message}`);
            return {
                ok: false,
                joined: false,
                configured: true,
                provider: this.provider,
                meetUrl: check.url,
                sessionId: sessionId || null,
                error: err.message,
                code: 'provider_error',
                status: err.statusCode || null,
            };
        }

        const botId = created && (created.id || created.bot_id || created.botId);
        if (!botId) {
            const error = 'Provider accepted the request but returned no bot id.';
            console.warn(`[MeetingBot] ${error}`);
            return {
                ok: false,
                joined: false,
                configured: true,
                provider: this.provider,
                meetUrl: check.url,
                error,
                code: 'no_bot_id',
            };
        }

        const record = {
            botId: String(botId),
            sessionId: sessionId || null,
            meetUrl: check.url,
            botName: name,
            transcription: !!transcription,
            joinedAt: Date.now(),
            status: this._statusCode(created) || 'joining',
        };
        this.active.set(record.botId, record);
        this._persistBotId(record);

        return {
            ok: true,
            joined: true,
            configured: true,
            provider: this.provider,
            botId: record.botId,
            sessionId: record.sessionId,
            meetUrl: record.meetUrl,
            botName: name,
            status: record.status,
            supportedPlatform: supported,
            // Be precise about what "joined" buys you.
            capabilities: { joinsCall: true, transcribes: !!transcription, speaks: false },
            raw: created,
        };
    }

    /** Ask the provider to walk the bot out of the call. */
    async leave(botId) {
        const id = String(botId || '').trim();
        if (!id) return { ok: false, error: 'botId is required', code: 'invalid_bot_id' };

        const missing = this.missingConfig();
        if (missing.length) {
            const error = `Cannot leave: ${missing.join(', ')} is not configured.`;
            console.warn(`[MeetingBot] ${error}`);
            return { ok: false, configured: false, missing, error, code: 'not_configured' };
        }

        try {
            const result = await this._request('POST', `/bot/${encodeURIComponent(id)}/leave_call`, {});
            const record = this.active.get(id);
            if (record) {
                record.status = 'left';
                record.leftAt = Date.now();
                this._persistBotId(record);
            }
            this.active.delete(id);
            return { ok: true, botId: id, left: true, raw: result ?? null };
        } catch (err) {
            console.warn(`[MeetingBot] leave(${id}) failed: ${err.message}`);
            return { ok: false, botId: id, error: err.message, code: 'provider_error' };
        }
    }

    /** Current provider-side state of one bot. */
    async status(botId) {
        const id = String(botId || '').trim();
        if (!id) return { ok: false, error: 'botId is required', code: 'invalid_bot_id' };

        const missing = this.missingConfig();
        if (missing.length) {
            const error = `Cannot read status: ${missing.join(', ')} is not configured.`;
            console.warn(`[MeetingBot] ${error}`);
            return { ok: false, configured: false, missing, error, code: 'not_configured' };
        }

        try {
            const result = await this._request('GET', `/bot/${encodeURIComponent(id)}`);
            const code = this._statusCode(result) || 'unknown';
            const record = this.active.get(id);
            if (record) record.status = code;
            return {
                ok: true,
                botId: id,
                status: code,
                meetUrl: record?.meetUrl || null,
                raw: result ?? null,
            };
        } catch (err) {
            console.warn(`[MeetingBot] status(${id}) failed: ${err.message}`);
            return { ok: false, botId: id, error: err.message, code: 'provider_error' };
        }
    }

    // =========================================================================
    //  Transcript
    // =========================================================================

    /**
     * The transcript so far, normalised to [{ speaker, text, at }] in the
     * `transcript` field. Never fabricated: when nothing exists yet you get an
     * empty array plus a status, not placeholder text.
     *
     * @returns {Promise<{ok:boolean, botId:string, status:string, count:number,
     *                    transcript:Array<{speaker:string,text:string,at:*}>}>}
     */
    async transcript(botId) {
        const id = String(botId || '').trim();
        if (!id) {
            return { ok: false, botId: '', status: 'invalid_bot_id', count: 0, transcript: [], error: 'botId is required' };
        }

        const buffered = this.liveLines.get(id) || [];
        const missing = this.missingConfig();
        if (missing.length) {
            // Webhook-pushed lines still count; anything else is honestly empty.
            if (buffered.length) {
                return { ok: true, botId: id, status: 'webhook', source: 'webhook', count: buffered.length, transcript: buffered.slice() };
            }
            const error = `Cannot fetch transcript: ${missing.join(', ')} is not configured.`;
            console.warn(`[MeetingBot] ${error}`);
            return { ok: false, botId: id, status: 'not_configured', configured: false, missing, count: 0, transcript: [], error };
        }

        let raw;
        try {
            raw = await this._request('GET', `/bot/${encodeURIComponent(id)}/transcript`);
        } catch (err) {
            console.warn(`[MeetingBot] transcript(${id}) failed: ${err.message}`);
            if (buffered.length) {
                return { ok: true, botId: id, status: 'webhook', source: 'webhook', count: buffered.length, transcript: buffered.slice(), warning: err.message };
            }
            return { ok: false, botId: id, status: 'error', count: 0, transcript: [], error: err.message, code: 'provider_error' };
        }

        const lines = normalizeTranscript(raw);
        if (!lines.length && buffered.length) {
            return { ok: true, botId: id, status: 'webhook', source: 'webhook', count: buffered.length, transcript: buffered.slice() };
        }
        return {
            ok: true,
            botId: id,
            source: 'api',
            status: lines.length ? 'ready' : 'empty',
            count: lines.length,
            transcript: lines,
        };
    }

    /**
     * Push the transcript into the shared memory store so agents can recall
     * what was said. Writes one salient memory (Database.addMemory) and one
     * search-index row (MemorySearch.index).
     */
    async saveTranscriptToMemory(botId, { chatId } = {}) {
        const id = String(botId || '').trim();
        const chat = String(chatId || 'global') || 'global';
        const result = await this.transcript(id);

        if (!result.ok) {
            return { ok: false, botId: id, saved: false, lines: 0, status: result.status, error: result.error };
        }
        if (!result.count) {
            // Nothing said yet — do NOT write a placeholder into memory.
            return { ok: true, botId: id, saved: false, lines: 0, status: result.status || 'empty' };
        }

        const record = this.active.get(id) || {};
        const header = `Meeting transcript (${this.provider} bot ${id}${record.meetUrl ? ` — ${record.meetUrl}` : ''})`;
        const text = `${header}\n${transcriptToText(result.transcript)}`;
        const summary = `Meeting transcript: ${result.count} turn(s)${record.meetUrl ? ` from ${record.meetUrl}` : ''}`;

        let memoryOk = false;
        let indexId = null;
        try {
            if (this.database && typeof this.database.addMemory === 'function') {
                this.database.addMemory(chat, text, {
                    summary,
                    importance: 0.7,
                    salience: 1.0,
                    source: 'meeting',
                });
                memoryOk = true;
            }
        } catch (err) {
            console.warn(`[MeetingBot] addMemory failed: ${err.message}`);
        }

        try {
            if (this.memorySearch && typeof this.memorySearch.index === 'function') {
                indexId = this.memorySearch.index({
                    text,
                    summary,
                    chatId: chat,
                    agentId: record.botName || '',
                    source: 'meeting',
                    refType: 'meeting',
                    importance: 0.7,
                    salience: 1.0,
                });
            }
        } catch (err) {
            console.warn(`[MeetingBot] memorySearch.index failed: ${err.message}`);
        }

        return {
            ok: memoryOk || indexId !== null,
            botId: id,
            saved: memoryOk || indexId !== null,
            chatId: chat,
            lines: result.count,
            chars: text.length,
            memory: memoryOk,
            indexId,
            status: result.status,
        };
    }

    // =========================================================================
    //  Webhooks
    // =========================================================================

    /**
     * Handle a provider webhook (status changes, live transcript chunks).
     *
     * Signature: HMAC-SHA256 hex of the RAW bytes, keyed with
     * RECALL_WEBHOOK_SECRET. An optional `sha256=` prefix is accepted. When a
     * secret IS configured an unverified payload is rejected outright. When
     * none is configured the payload is accepted and a warning is logged once.
     *
     * Deduped by event id (falling back to a hash of the raw body), so a
     * retried delivery is never processed twice.
     *
     * @param {object} payload            parsed JSON body
     * @param {object} [meta]
     * @param {string} [meta.signature]   signature header value
     * @param {string|Buffer} [meta.rawBody] exact bytes the signature covers
     * @returns {{ok:boolean, accepted:boolean, reason?:string, event?:string,
     *            botId?:string|null, duplicate?:boolean, lines?:number}}
     */
    handleWebhook(payload, { signature, rawBody } = {}) {
        try {
            const bytes = rawBody === undefined || rawBody === null
                ? Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
                : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'));

            if (!this.verifySignature(bytes, signature)) {
                console.warn('[MeetingBot] Rejected webhook payload: invalid signature.');
                return { ok: false, accepted: false, reason: 'invalid_signature' };
            }
            if (!payload || typeof payload !== 'object') {
                return { ok: false, accepted: false, reason: 'invalid_payload' };
            }

            const eventId = this._eventId(payload, bytes);
            if (this.seenEventIds.has(eventId)) {
                return { ok: true, accepted: false, duplicate: true, reason: 'duplicate_event', eventId };
            }
            this._rememberEvent(eventId);

            const event = String(payload.event || payload.type || 'unknown');
            const data = payload.data || {};
            const botId = String(
                data.bot_id
                || data.botId
                || data.bot?.id
                || payload.bot_id
                || ''
            ) || null;

            let lines = 0;
            if (botId && /transcript/i.test(event)) {
                // Recall pushes one utterance as data.data = { words, participant }.
                const candidate = data.data || data.transcript || data;
                const chunk = normalizeTranscript(Array.isArray(candidate) ? candidate : [candidate]);
                if (chunk.length) {
                    lines = this._bufferLines(botId, chunk);
                }
            }

            if (botId) {
                const code = this._statusCode(data) || this._statusCode(payload);
                const record = this.active.get(botId);
                if (record && code) {
                    record.status = code;
                    if (code === 'done' || code === 'call_ended' || code === 'fatal') {
                        record.leftAt = Date.now();
                        this._persistBotId(record);
                        this.active.delete(botId);
                    }
                }
            }

            return { ok: true, accepted: true, duplicate: false, event, botId, eventId, lines };
        } catch (err) {
            console.warn(`[MeetingBot] handleWebhook failed: ${err.message}`);
            return { ok: false, accepted: false, reason: 'error', error: err.message };
        }
    }

    /**
     * Constant-time HMAC check that never throws — including on a
     * wrong-LENGTH signature, where crypto.timingSafeEqual would otherwise
     * raise instead of returning false.
     */
    verifySignature(rawBody, signatureHeader) {
        if (!this.webhookSecret) {
            if (!this._warnedUnsigned) {
                this._warnedUnsigned = true;
                console.warn('[MeetingBot] RECALL_WEBHOOK_SECRET is unset — accepting unsigned webhook payloads.');
            }
            return true;
        }
        try {
            if (typeof signatureHeader !== 'string' || !signatureHeader) return false;
            const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
            const digest = crypto.createHmac('sha256', this.webhookSecret).update(body).digest('hex');
            const offered = signatureHeader.trim();
            // Accept both "sha256=<hex>" and a bare hex digest.
            return timingSafeStringEqual(offered, `sha256=${digest}`)
                || timingSafeStringEqual(offered, digest);
        } catch (err) {
            console.warn(`[MeetingBot] Signature verification error: ${err.message}`);
            return false;
        }
    }

    // =========================================================================
    //  Inventory
    // =========================================================================

    /**
     * Bots currently in calls. In-memory records first, then any persisted
     * meeting session that carries a botId (so a restart does not lose track).
     */
    listActive() {
        const out = [];
        const seen = new Set();
        for (const record of this.active.values()) {
            if (record.status === 'left') continue;
            seen.add(record.botId);
            out.push({ ...record, source: 'memory' });
        }
        try {
            if (this.database && typeof this.database.getMeetingSessions === 'function') {
                for (const session of this.database.getMeetingSessions() || []) {
                    const botId = session && session.botId;
                    if (!botId || seen.has(String(botId))) continue;
                    if (session.botStatus === 'left') continue;
                    seen.add(String(botId));
                    out.push({
                        botId: String(botId),
                        sessionId: session.id || null,
                        meetUrl: session.meetUrl || '',
                        botName: session.botName || '',
                        status: session.botStatus || 'unknown',
                        joinedAt: session.botJoinedAt || session.createdAt || null,
                        source: 'database',
                    });
                }
            }
        } catch (err) {
            console.warn(`[MeetingBot] listActive could not read sessions: ${err.message}`);
        }
        return out;
    }

    /** Diagnostics for the dashboard / a status route. */
    describe() {
        return {
            provider: this.provider,
            configured: this.isConfigured,
            missing: this.missingConfig(),
            baseUrl: this.baseUrl,
            webhookSigned: Boolean(this.webhookSecret),
            active: this.listActive().length,
            capabilities: {
                createRoom: 'handled elsewhere (MissionControl /api/meetings/dispatch)',
                joinCall: this.isConfigured,
                transcribe: this.isConfigured,
                speakInCall: false,
            },
        };
    }

    // =========================================================================
    //  Internals
    // =========================================================================

    /** Attach the provider bot id to the persisted meeting session. */
    _persistBotId(record) {
        if (!record || !record.sessionId) return false;
        if (!this.database || typeof this.database.addMeetingSession !== 'function') return false;
        try {
            const sessions = typeof this.database.getMeetingSessions === 'function'
                ? (this.database.getMeetingSessions(200) || [])
                : [];
            const existing = sessions.find((s) => s && s.id === record.sessionId) || {};
            this.database.addMeetingSession({
                ...existing,
                id: record.sessionId,
                agentId: existing.agentId || 'system',
                provider: existing.provider || this.provider,
                meetUrl: existing.meetUrl || record.meetUrl,
                botId: record.botId,
                botName: record.botName,
                botProvider: this.provider,
                botStatus: record.status,
                botJoinedAt: record.joinedAt,
                createdAt: existing.createdAt || record.joinedAt,
            });
            return true;
        } catch (err) {
            console.warn(`[MeetingBot] Could not persist bot id: ${err.message}`);
            return false;
        }
    }

    /** Recall reports status as { status: { code } } or { status_changes: [...] }. */
    _statusCode(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (typeof obj.status === 'string') return obj.status;
        if (obj.status && typeof obj.status.code === 'string') return obj.status.code;
        if (Array.isArray(obj.status_changes) && obj.status_changes.length) {
            const last = obj.status_changes[obj.status_changes.length - 1];
            if (last && typeof last.code === 'string') return last.code;
        }
        return null;
    }

    _eventId(payload, bytes) {
        const candidate = payload?.id
            || payload?.event_id
            || payload?.data?.event_id
            || payload?.data?.id;
        if (candidate) return String(candidate);
        // Byte-identical retries still dedupe.
        return `sha:${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
    }

    _rememberEvent(eventId) {
        this.seenEventIds.add(eventId);
        while (this.seenEventIds.size > this.maxSeenEvents) {
            const oldest = this.seenEventIds.values().next().value;
            this.seenEventIds.delete(oldest);
        }
    }

    _bufferLines(botId, lines) {
        const existing = this.liveLines.get(botId) || [];
        const merged = existing.concat(lines);
        const trimmed = merged.length > MAX_BUFFERED_LINES
            ? merged.slice(merged.length - MAX_BUFFERED_LINES)
            : merged;
        this.liveLines.set(botId, trimmed);
        return lines.length;
    }

    /**
     * One provider call. Uses the injected transport when present, otherwise a
     * node:https request. Rejects with a descriptive Error on any HTTP >= 400
     * so callers can surface the provider's own message.
     */
    _request(method, apiPath, body = null) {
        const url = `${this.baseUrl}${apiPath}`;
        if (this.transport) {
            return Promise.resolve(this.transport({
                method,
                url,
                path: apiPath,
                body,
                apiKey: this.apiKey,
            }));
        }
        if (!this.apiKey) {
            return Promise.reject(new Error('Recall.ai API key not configured (RECALL_API_KEY)'));
        }

        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        const payload = body === null ? null : JSON.stringify(body);

        return new Promise((resolve, reject) => {
            const req = client.request({
                method,
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: target.pathname + target.search,
                headers: {
                    Authorization: `Token ${this.apiKey}`,
                    Accept: 'application/json',
                    ...(payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                        : {}),
                },
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        const err = new Error(`Recall.ai rejected the API key (HTTP ${res.statusCode})`);
                        err.statusCode = res.statusCode;
                        return reject(err);
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        const err = new Error(`Recall.ai HTTP ${res.statusCode}: ${String(data).slice(0, 300)}`);
                        err.statusCode = res.statusCode;
                        return reject(err);
                    }
                    if (!data) return resolve(null);
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });
            req.on('error', (err) => reject(
                new Error(`Recall.ai unreachable at ${this.baseUrl}: ${err.message}`)
            ));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error(`Recall.ai request timed out after ${REQUEST_TIMEOUT_MS}ms`));
            });
            if (payload) req.write(payload);
            req.end();
        });
    }
}

module.exports = MeetingBot;
module.exports.MeetingBot = MeetingBot;
module.exports.validateMeetUrl = validateMeetUrl;
module.exports.isSupportedMeetingHost = isSupportedMeetingHost;
module.exports.normalizeTranscript = normalizeTranscript;
module.exports.transcriptToText = transcriptToText;
module.exports.timingSafeStringEqual = timingSafeStringEqual;
module.exports.DEFAULT_API_BASE = DEFAULT_API_BASE;
module.exports.DEFAULT_BOT_NAME = DEFAULT_BOT_NAME;
module.exports.MAX_SEEN_EVENTS = MAX_SEEN_EVENTS;
