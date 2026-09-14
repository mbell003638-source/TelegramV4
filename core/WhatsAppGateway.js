// =============================================================================
//  core/WhatsAppGateway.js — WhatsApp Cloud API Gateway Plugin
//
//  Drop-in sibling of core/Gateway.js (Telegram). Speaks Meta's official
//  WhatsApp Cloud API (graph.facebook.com) so it needs NO new npm dependency:
//    - Inbound : a webhook handler mounted into the EXISTING http server
//                (core/MissionControl.js). GET performs the hub.challenge
//                handshake, POST carries signed message payloads.
//    - Outbound: HTTPS POST to /<PHONE_NUMBER_ID>/messages via axios.
//
//  Produces the very same UnifiedIncomingMessage shape core/types.js builds
//  for Telegram, and hands it to the same messageHandler, so the whole agent
//  swarm works over WhatsApp with no changes to ActionExecutor.
//
//  Env vars:
//    WHATSAPP_ACCESS_TOKEN     permanent System User token (Bearer)
//    WHATSAPP_PHONE_NUMBER_ID  numeric id of the sending phone number
//    WHATSAPP_VERIFY_TOKEN     shared secret echoed during webhook setup
//    WHATSAPP_APP_SECRET       Meta app secret, verifies X-Hub-Signature-256
//    WHATSAPP_ALLOWED_NUMBERS  comma-separated allow-list of E.164 numbers
//    WHATSAPP_WEBHOOK_PATH     optional, defaults to /webhook/whatsapp
//    WHATSAPP_API_VERSION      optional, defaults to v21.0
// =============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');
const { splitMessage, parseSlashArgs } = require('./types');

const GRAPH_API_BASE = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = 'v21.0';
const DEFAULT_WEBHOOK_PATH = '/webhook/whatsapp';
const WHATSAPP_MESSAGE_LIMIT = 4096;
const MAX_SEEN_IDS = 1000;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

// -----------------------------------------------------------------------------
//  Pure helpers (exported for tests)
// -----------------------------------------------------------------------------

/**
 * Normalise a phone number for comparison: keep digits only.
 * "+1 555-0100" and "15550100" both become "15550100".
 */
function normalizeNumber(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/[^0-9]/g, '');
}

/**
 * Parse WHATSAPP_ALLOWED_NUMBERS (comma/semicolon/newline separated) or an
 * array into a Set of normalised numbers. Spaces are NOT separators — they are
 * legal inside a written number ("+1 555-0100").
 */
function parseAllowedNumbers(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\r\n]+/);
    const out = new Set();
    for (const entry of list) {
        const normalised = normalizeNumber(entry);
        if (normalised) out.add(normalised);
    }
    return out;
}

/**
 * Split a body to WhatsApp's 4096-char limit, preferring newline breaks.
 * Reuses the shared splitter so Telegram and WhatsApp chunk identically.
 */
function splitWhatsAppMessage(text, limit = WHATSAPP_MESSAGE_LIMIT) {
    return splitMessage(String(text ?? ''), limit);
}

/**
 * ActionExecutor formats replies as Telegram HTML. WhatsApp has no HTML, so
 * translate the small tag set the executor actually emits into WhatsApp's
 * markdown and unescape the entities.
 */
function telegramHtmlToWhatsApp(text) {
    if (typeof text !== 'string') return String(text ?? '');
    if (text.indexOf('<') === -1 && text.indexOf('&') === -1) return text;
    return text
        .replace(/<pre>\s*<code(?:\s[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, body) => '```\n' + body + '\n```')
        .replace(/<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/gi, (_m, body) => '```\n' + body + '\n```')
        .replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_m, body) => '`' + body + '`')
        .replace(/<\/?(?:b|strong)>/gi, '*')
        .replace(/<\/?(?:i|em)>/gi, '_')
        .replace(/<\/?(?:s|del|strike)>/gi, '~')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `${label} (${href})`)
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Direct shell escape, identical to Gateway.js's `!command` handling.
 */
function parseBangCommand(text) {
    if (typeof text !== 'string' || !text.startsWith('!')) return null;
    return text.slice(1).replace(/^\s+/, '');
}

/**
 * Map a leading `/command args` to the same system action Gateway.js dispatches.
 * Returns null for plain text (which is forwarded to the agent verbatim).
 */
function resolveSlashCommand(text) {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const name = (text.slice(1).split(/\s+/)[0] || '').toLowerCase();
    const args = parseSlashArgs(text, name);

    switch (name) {
        case 'start': return { name: 'help.show' };
        case 'agent': return { name: 'agent.show' };
        case 'new': return { name: 'session.new' };
        case 'status': return { name: 'session.status' };
        case 'help': return { name: 'help.show' };
        case 'voice': return { name: 'voice.toggle' };
        case 'model': return args ? { name: 'model.set', params: { modelName: args } } : { name: 'model.show' };
        case 'effort': return { name: args ? 'effort.set' : 'effort.show', params: { effort: args } };
        case 'cost': return { name: 'cost.show' };
        case 'costreset': return { name: 'cost.reset' };
        case 'memory': return { name: 'memory.show' };
        case 'remember': return { name: 'memory.add', params: { text: args } };
        case 'forget': return { name: 'memory.clear' };
        case 'handoff': return { name: 'handoff.show' };
        case 'resume': {
            const lower = args.toLowerCase();
            if (lower === 'last' || lower === 'continue') return { name: 'session.resume.last' };
            return { name: 'session.resume.show', params: { filter: args || undefined } };
        }
        case 'resume_last': return { name: 'session.resume.last' };
        case 'cwd': return args ? { name: 'cwd.set', params: { path: args } } : { name: 'cwd.show' };
        case 'screen': return { name: 'screen.capture' };
        case 'lock': return { name: 'pc.lock' };
        case 'kanban':
        case 'tasks': return { name: 'mission.tasks.show' };
        case 'task': return { name: 'mission.task.create', params: { text: args } };
        case 'hive': return { name: 'hive.show' };
        case 'learn': return { name: 'learn.run' };
        case 'concurrency':
        case 'pool': return { name: args ? 'concurrency.set' : 'concurrency.show', params: { limit: args } };
        case 'win': return { name: 'satellite.exec', params: { command: args } };
        case 'satellite':
        case 'workers': return { name: 'satellite.status' };
        case 'restart': return { name: 'bridge.restart' };
        default: return null;
    }
}

// -----------------------------------------------------------------------------
//  Gateway
// -----------------------------------------------------------------------------
class WhatsAppGateway {
    /**
     * @param {object} options
     * @param {string}   options.accessToken     WHATSAPP_ACCESS_TOKEN
     * @param {string}   options.phoneNumberId   WHATSAPP_PHONE_NUMBER_ID
     * @param {string}   options.verifyToken     WHATSAPP_VERIFY_TOKEN
     * @param {string}   options.appSecret       WHATSAPP_APP_SECRET
     * @param {Function} options.messageHandler  actionExecutor.getMessageHandler()
     * @param {string|string[]} options.allowedNumbers WHATSAPP_ALLOWED_NUMBERS
     * @param {string}   options.uploadsDir      where inbound media is saved
     * @param {string}   [options.webhookPath]   default /webhook/whatsapp
     * @param {string}   [options.apiVersion]    default v21.0
     * @param {Function} [options.transport]     async (payload) => result — injected in tests
     * @param {Function} [options.mediaFetcher]  async (mediaId) => {buffer, mimeType, fileName}
     */
    constructor(options = {}) {
        const {
            accessToken,
            phoneNumberId,
            verifyToken,
            appSecret,
            messageHandler,
            allowedNumbers,
            uploadsDir,
            webhookPath,
            apiVersion,
            transport,
            mediaFetcher,
            maxSeenIds,
        } = options;

        this.accessToken = accessToken || '';
        this.phoneNumberId = phoneNumberId ? String(phoneNumberId) : '';
        this.verifyToken = verifyToken || '';
        this.appSecret = appSecret || '';
        this.messageHandler = typeof messageHandler === 'function' ? messageHandler : null;
        this.allowedNumbers = parseAllowedNumbers(allowedNumbers);
        this.uploadsDir = uploadsDir || path.join(__dirname, '..', 'uploads');
        this.webhookPath = webhookPath || DEFAULT_WEBHOOK_PATH;
        this.apiVersion = apiVersion || DEFAULT_API_VERSION;
        this.transport = typeof transport === 'function' ? transport : null;
        this.mediaFetcher = typeof mediaFetcher === 'function' ? mediaFetcher : null;

        this.messageLimit = WHATSAPP_MESSAGE_LIMIT;
        this.maxSeenIds = Number.isFinite(maxSeenIds) && maxSeenIds > 0 ? maxSeenIds : MAX_SEEN_IDS;
        this.maxBodyBytes = MAX_WEBHOOK_BODY_BYTES;

        this.seenMessageIds = new Set();   // bounded LRU-ish dedupe of wamid values
        this.activeUsers = new Set();
        this.running = false;

        this._inflight = Promise.resolve();
        this._warnedUnsigned = false;
        this._signalsBound = false;
    }

    /** True when enough credentials are present to actually send messages. */
    get isConfigured() {
        return Boolean(this.accessToken && this.phoneNumberId);
    }

    /** True when the inbound webhook can be served (verification handshake). */
    get canReceive() {
        return Boolean(this.verifyToken);
    }

    /**
     * Build a gateway from process.env. Returns null when nothing is configured,
     * so index.js can simply skip WhatsApp the way it skips a missing bot token.
     */
    static fromEnv(extra = {}) {
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
        if (!accessToken && !phoneNumberId && !verifyToken) return null;

        return new WhatsAppGateway({
            accessToken,
            phoneNumberId,
            verifyToken,
            appSecret: process.env.WHATSAPP_APP_SECRET,
            allowedNumbers: process.env.WHATSAPP_ALLOWED_NUMBERS,
            webhookPath: process.env.WHATSAPP_WEBHOOK_PATH,
            apiVersion: process.env.WHATSAPP_API_VERSION,
            uploadsDir: path.join(config.baseDir, 'uploads'),
            ...extra,
        });
    }

    // =========================================================================
    //  Lifecycle — mirrors Gateway.start() / Gateway.stop()
    // =========================================================================

    async start() {
        if (!this.isConfigured && !this.canReceive) {
            console.warn('[WhatsApp] Not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_VERIFY_TOKEN missing) — channel disabled.');
            this.running = false;
            return false;
        }

        if (!this.isConfigured) {
            console.warn('[WhatsApp] Inbound webhook enabled but outbound is not configured — replies will be dropped.');
        }
        if (!this.appSecret) {
            console.warn('[WhatsApp] WHATSAPP_APP_SECRET not set — inbound payload signatures will NOT be verified.');
        }
        if (this.allowedNumbers.size === 0) {
            console.warn('[WhatsApp] WHATSAPP_ALLOWED_NUMBERS is empty — every sender is allowed. Set it to lock the bridge down.');
        }
        if (!this.messageHandler) {
            console.warn('[WhatsApp] No messageHandler wired — inbound messages will be acknowledged and dropped.');
        }

        this.running = true;
        console.log(`🚀 [WhatsApp] Cloud API gateway ready — webhook path ${this.webhookPath}`);

        if (!this._signalsBound) {
            this._signalsBound = true;
            process.once('SIGINT', () => this.stop('SIGINT'));
            process.once('SIGTERM', () => this.stop('SIGTERM'));
        }
        return true;
    }

    stop(reason = 'shutdown') {
        try {
            if (this.running) console.log(`[WhatsApp] Gateway stopped (${reason}).`);
            this.running = false;
        } catch (e) {
            console.warn(`[WhatsApp] Stop failed: ${e.message}`);
        }
    }

    /** Resolves once every in-flight webhook payload has finished processing. */
    whenIdle() {
        return this._inflight;
    }

    // =========================================================================
    //  Inbound — webhook handler to mount inside MissionControl's http server
    // =========================================================================

    /**
     * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => boolean}
     *          true when this gateway owns the request (caller must return),
     *          false when the caller should keep routing.
     */
    createWebhookHandler() {
        const handler = (req, res) => {
            let pathname;
            try {
                pathname = new URL(req.url, `http://${req.headers?.host || 'localhost'}`).pathname;
            } catch (e) {
                return false;
            }
            if (pathname !== this.webhookPath) return false;

            try {
                if (req.method === 'GET') {
                    this._handleVerification(req, res);
                    return true;
                }
                if (req.method === 'POST') {
                    this._track(this._handleWebhookPost(req, res));
                    return true;
                }
                this._respond(res, 405, 'Method Not Allowed');
                return true;
            } catch (e) {
                console.warn(`[WhatsApp] Webhook handler failed: ${e.message}`);
                try { this._respond(res, 500, 'Internal Error'); } catch (_) {}
                return true;
            }
        };
        handler.path = this.webhookPath;
        return handler;
    }

    /** GET handshake: echo hub.challenge when hub.verify_token matches. */
    _handleVerification(req, res) {
        let params;
        try {
            params = new URL(req.url, `http://${req.headers?.host || 'localhost'}`).searchParams;
        } catch (e) {
            return this._respond(res, 400, 'Bad Request');
        }

        const mode = params.get('hub.mode');
        const token = params.get('hub.verify_token');
        const challenge = params.get('hub.challenge') || '';

        if (mode === 'subscribe' && this.verifyToken && timingSafeStringEqual(token, this.verifyToken)) {
            console.log('[WhatsApp] Webhook verification succeeded.');
            return this._respond(res, 200, challenge);
        }

        console.warn('[WhatsApp] Webhook verification rejected (bad mode or verify token).');
        return this._respond(res, 403, 'Forbidden');
    }

    /** POST: verify the raw-body signature, ack fast, then process. */
    async _handleWebhookPost(req, res) {
        let raw;
        try {
            raw = await this._readRawBody(req);
        } catch (e) {
            const status = e && e.statusCode === 413 ? 413 : 400;
            console.warn(`[WhatsApp] Could not read webhook body: ${e.message}`);
            return this._respond(res, status, status === 413 ? 'Payload Too Large' : 'Bad Request');
        }

        const signature = headerValue(req, 'x-hub-signature-256');
        if (!this.verifySignature(raw, signature)) {
            console.warn('[WhatsApp] Rejected webhook payload: invalid X-Hub-Signature-256.');
            return this._respond(res, 403, 'Forbidden');
        }

        let payload = null;
        try {
            payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch (e) {
            console.warn(`[WhatsApp] Webhook body was not valid JSON: ${e.message}`);
            return this._respond(res, 400, 'Bad Request');
        }

        // Meta retries anything that is not acknowledged quickly — ack first,
        // then run the agent. Dedupe (below) makes the retries harmless.
        this._respond(res, 200, 'EVENT_RECEIVED');

        try {
            await this.handleWebhookPayload(payload);
        } catch (e) {
            console.warn(`[WhatsApp] Payload processing failed: ${e.message}`);
        }
    }

    /**
     * HMAC-SHA256 of the RAW request bytes, compared in constant time.
     * Returns true when the app secret is not configured (documented opt-out).
     */
    verifySignature(rawBody, signatureHeader) {
        if (!this.appSecret) {
            if (!this._warnedUnsigned) {
                this._warnedUnsigned = true;
                console.warn('[WhatsApp] WHATSAPP_APP_SECRET is unset — accepting unsigned webhook payloads.');
            }
            return true;
        }

        try {
            if (typeof signatureHeader !== 'string' || !signatureHeader) return false;
            const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
            const expected = 'sha256=' + crypto.createHmac('sha256', this.appSecret).update(body).digest('hex');
            return timingSafeStringEqual(signatureHeader, expected);
        } catch (e) {
            console.warn(`[WhatsApp] Signature verification error: ${e.message}`);
            return false;
        }
    }

    // =========================================================================
    //  Payload → UnifiedIncomingMessage
    // =========================================================================

    /**
     * Walk a Cloud API webhook body and dispatch every inbound message.
     * Safe to call directly (tests, replays).
     */
    async handleWebhookPayload(payload) {
        const entries = Array.isArray(payload?.entry) ? payload.entry : [];
        for (const entry of entries) {
            const changes = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
                const value = change?.value || {};
                // Delivery/read receipts and errors carry no user text.
                if (!Array.isArray(value.messages) || value.messages.length === 0) continue;

                const contacts = Array.isArray(value.contacts) ? value.contacts : [];
                for (const message of value.messages) {
                    try {
                        await this._handleInboundMessage(message, contacts, value);
                    } catch (e) {
                        console.warn(`[WhatsApp] Inbound message failed: ${e.message}`);
                    }
                }
            }
        }
    }

    async _handleInboundMessage(message, contacts, value) {
        const messageId = message?.id ? String(message.id) : '';

        // --- Idempotency: WhatsApp retries aggressively ---
        if (messageId) {
            if (this.seenMessageIds.has(messageId)) {
                console.log(`[WhatsApp] Duplicate delivery ignored (id: ${messageId}).`);
                return;
            }
            this._rememberMessageId(messageId);
        }

        const from = normalizeNumber(message?.from);
        if (!from) {
            console.warn('[WhatsApp] Inbound message had no sender — ignored.');
            return;
        }

        // --- Allow-list (mirrors Telegram's allowedUserId gate) ---
        if (!this.isAllowed(from)) {
            console.warn(`[WhatsApp] Blocked message from non-allow-listed number: ${from}`);
            return;
        }

        this.activeUsers.add(from);

        const contact = contacts.find(c => normalizeNumber(c?.wa_id) === from) || contacts[0] || null;
        const unified = this._toUnifiedIncomingMessage(message, contact, value);
        if (!unified) return;

        // --- Media: download into uploadsDir and reference it like Gateway does ---
        if (unified.content.attachments.length > 0) {
            await this._attachMedia(unified, message);
        }

        const text = unified.content.text || '';

        // Direct shell escape, only when the bridge is locked to known numbers.
        const shellCommand = parseBangCommand(text);
        if (shellCommand !== null) {
            if (this.allowedNumbers.size === 0) {
                await this.sendMessage(from, '⛔ Direct shell is disabled until WHATSAPP_ALLOWED_NUMBERS is configured.');
                return;
            }
            unified.content.type = 'action';
            unified.content.text = 'shell.execute';
            unified.action = { type: 'system', name: 'shell.execute', params: { command: shellCommand } };
            return this._dispatch(unified);
        }

        // Slash commands map onto the same system actions Telegram dispatches.
        const command = resolveSlashCommand(text);
        if (command) {
            unified.content.type = 'action';
            unified.content.text = command.name;
            unified.action = { type: 'system', name: command.name, params: command.params };
            return this._dispatch(unified);
        }

        return this._dispatch(unified);
    }

    _dispatch(unified) {
        if (!this.messageHandler) {
            console.warn('[WhatsApp] No messageHandler configured — message dropped.');
            return Promise.resolve();
        }
        return Promise.resolve()
            .then(() => this.messageHandler(unified))
            .catch(e => console.warn(`[WhatsApp] Message handler failed: ${e.message}`));
    }

    /** Exactly the shape core/types.js toUnifiedIncomingMessage() returns. */
    _toUnifiedIncomingMessage(message, contact, value) {
        const from = normalizeNumber(message?.from);
        const profileName = contact?.profile?.name || '';
        const type = String(message?.type || 'text');

        const unified = {
            id: message?.id ? String(message.id) : Date.now().toString(),
            platform: 'whatsapp',
            chatId: from,
            user: {
                id: from,
                username: profileName || undefined,
                displayName: profileName || 'Unknown',
            },
            content: {
                type: 'text',
                text: '',
                attachments: [],
            },
            timestamp: Number(message?.timestamp) ? Number(message.timestamp) * 1000 : Date.now(),
            action: null,
            raw: null, // replaced below with the reply context
        };

        if (type === 'text') {
            unified.content.text = message?.text?.body || '';
        } else if (type === 'image') {
            unified.content.type = 'photo';
            unified.content.text = message?.image?.caption || '';
            unified.content.attachments.push({
                type: 'photo',
                fileId: message?.image?.id,
                mimeType: message?.image?.mime_type,
            });
        } else if (type === 'document') {
            unified.content.type = 'document';
            unified.content.text = message?.document?.caption || '';
            unified.content.attachments.push({
                type: 'document',
                fileId: message?.document?.id,
                fileName: message?.document?.filename,
                mimeType: message?.document?.mime_type,
            });
        } else if (type === 'audio' || type === 'voice') {
            unified.content.type = 'voice';
            const media = message?.audio || message?.voice || {};
            unified.content.attachments.push({
                type: 'voice',
                fileId: media.id,
                mimeType: media.mime_type,
            });
        } else if (type === 'interactive') {
            const reply = message?.interactive?.button_reply || message?.interactive?.list_reply || {};
            unified.content.text = reply.title || reply.id || '';
        } else if (type === 'button') {
            unified.content.text = message?.button?.text || message?.button?.payload || '';
        } else {
            unified.content.text = message?.text?.body || '';
            console.warn(`[WhatsApp] Unsupported message type "${type}" — forwarded as plain text.`);
        }

        unified.raw = this._createContext(unified, message, value);
        return unified;
    }

    /** Pull media bytes down into uploadsDir and reference them the way Gateway.js does. */
    async _attachMedia(unified, message) {
        const attachment = unified.content.attachments[0];
        if (!attachment || !attachment.fileId) return;

        try {
            const file = await this._downloadMedia(attachment.fileId, attachment.fileName, attachment.mimeType);
            if (!file) return;
            attachment.filePath = file;

            if (unified.content.type === 'photo') {
                unified.content.text = `${unified.content.text || 'Analyze this image.'} @${file}`;
            } else if (unified.content.type === 'voice') {
                unified.content.text = `${unified.content.text || 'Transcribe this voice message and respond to it.'} @${file}`;
            } else {
                const caption = unified.content.text;
                unified.content.text = caption
                    ? `File uploaded to: ${file}\n\nInstruction: "${caption}"`
                    : `File uploaded to: ${file}`;
            }
        } catch (e) {
            console.warn(`[WhatsApp] Media download failed: ${e.message}`);
        }
    }

    async _downloadMedia(mediaId, fileNameHint, mimeTypeHint) {
        let payload = null;

        if (this.mediaFetcher) {
            payload = await this.mediaFetcher(mediaId);
        } else {
            if (!this.isConfigured) {
                console.warn('[WhatsApp] Cannot download media without an access token.');
                return null;
            }
            const meta = await axios.get(`${GRAPH_API_BASE}/${this.apiVersion}/${encodeURIComponent(mediaId)}`, {
                headers: { Authorization: `Bearer ${this.accessToken}` },
                timeout: config.mediaTimeoutMs,
            });
            const url = meta?.data?.url;
            if (!url) throw new Error('media URL missing from Graph response');
            const binary = await axios.get(url, {
                headers: { Authorization: `Bearer ${this.accessToken}` },
                responseType: 'arraybuffer',
                timeout: config.mediaTimeoutMs,
                maxContentLength: config.mediaMaxBytes,
            });
            payload = {
                buffer: Buffer.from(binary.data),
                mimeType: meta?.data?.mime_type || mimeTypeHint,
                fileName: fileNameHint,
            };
        }

        if (!payload || !payload.buffer) return null;

        this._ensureUploadsDir();
        const safeName = path
            .basename(payload.fileName || fileNameHint || `${mediaId}${extensionFor(payload.mimeType || mimeTypeHint)}`)
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        const destPath = path.join(this.uploadsDir, `${mediaId}_${safeName}`);
        fs.writeFileSync(destPath, payload.buffer);
        return destPath;
    }

    _ensureUploadsDir() {
        try {
            if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
        } catch (e) {
            console.warn(`[WhatsApp] Could not create uploads dir: ${e.message}`);
        }
    }

    // =========================================================================
    //  Allow-list & dedupe
    // =========================================================================

    isAllowed(number) {
        if (this.allowedNumbers.size === 0) return true; // open, like a Gateway with no allowedUserId
        return this.allowedNumbers.has(normalizeNumber(number));
    }

    _rememberMessageId(id) {
        this.seenMessageIds.add(id);
        while (this.seenMessageIds.size > this.maxSeenIds) {
            const oldest = this.seenMessageIds.values().next().value;
            this.seenMessageIds.delete(oldest);
        }
    }

    // =========================================================================
    //  Outbound
    // =========================================================================

    /**
     * Send a text message, chunked to WhatsApp's 4096-char body limit.
     * @returns {Promise<Array>} one transport result per chunk
     */
    async sendMessage(to, text, options = {}) {
        const recipient = normalizeNumber(to);
        if (!recipient) {
            console.warn('[WhatsApp] sendMessage called without a recipient.');
            return [];
        }
        if (!this.isConfigured && !this.transport) {
            console.warn('[WhatsApp] Not configured — outbound message dropped.');
            return [];
        }

        const body = options.parse_mode === 'HTML' ? telegramHtmlToWhatsApp(text) : String(text ?? '');
        if (!body.trim()) return [];

        const results = [];
        for (const chunk of splitWhatsAppMessage(body, this.messageLimit)) {
            const result = await this._send({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipient,
                type: 'text',
                text: { preview_url: false, body: chunk },
            });
            results.push(result);
        }
        return results;
    }

    /** Send an already-hosted media URL (used for TTS audio and screenshots). */
    async sendMediaByUrl(to, kind, link, caption) {
        const recipient = normalizeNumber(to);
        if (!recipient || !link) return null;
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: kind,
            [kind]: caption ? { link, caption } : { link },
        };
        return this._send(payload);
    }

    /** Low-level POST to /<PHONE_NUMBER_ID>/messages (or the injected transport). */
    async _send(payload) {
        try {
            if (this.transport) return await this.transport(payload);
            const url = `${GRAPH_API_BASE}/${this.apiVersion}/${encodeURIComponent(this.phoneNumberId)}/messages`;
            const response = await axios.post(url, payload, {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: config.mediaTimeoutMs,
            });
            return response.data;
        } catch (e) {
            const detail = e?.response?.data?.error?.message || e.message;
            console.warn(`[WhatsApp] Send failed: ${detail}`);
            return null;
        }
    }

    // =========================================================================
    //  Telegraf-shaped reply context
    //
    //  ActionExecutor talks to `msg.raw` as if it were a Telegraf ctx
    //  (ctx.reply, ctx.chat, ctx.telegram.*). This shim gives it the same
    //  surface over WhatsApp. reply() intentionally resolves to undefined so
    //  the executor never tries to edit a non-existent placeholder message.
    // =========================================================================
    _createContext(unified, message, value) {
        const gateway = this;
        const chatId = unified.chatId;

        const reply = async (text, options = {}) => {
            try {
                await gateway.sendMessage(chatId, text, options || {});
            } catch (e) {
                console.warn(`[WhatsApp] Reply failed: ${e.message}`);
            }
            return undefined; // no message_id ⇒ no placeholder editing
        };

        return {
            platform: 'whatsapp',
            chat: { id: chatId, type: 'private' },
            from: { id: chatId, username: unified.user.username, first_name: unified.user.displayName },
            message: {
                message_id: unified.id,
                chat: { id: chatId },
                text: unified.content.text,
                date: Math.floor(unified.timestamp / 1000),
            },
            update: { whatsapp: { message, metadata: value?.metadata } },
            reply,
            replyWithHTML: (text, options = {}) => reply(text, { ...options, parse_mode: 'HTML' }),
            replyWithMarkdown: (text, options = {}) => reply(text, options),
            replyWithPhoto: async (photo, extra = {}) => {
                const link = typeof photo === 'string' ? photo : photo?.url;
                if (link) return gateway.sendMediaByUrl(chatId, 'image', link, extra?.caption);
                console.warn('[WhatsApp] Inline photo uploads are not supported — sending caption only.');
                return reply(extra?.caption || '🖼️ (image omitted)');
            },
            replyWithAudio: async (audio, extra = {}) => {
                const link = typeof audio === 'string' ? audio : audio?.url;
                if (link) return gateway.sendMediaByUrl(chatId, 'audio', link);
                console.warn('[WhatsApp] Inline audio uploads are not supported.');
                return undefined;
            },
            replyWithDocument: async (doc, extra = {}) => {
                const link = typeof doc === 'string' ? doc : doc?.url;
                if (link) return gateway.sendMediaByUrl(chatId, 'document', link, extra?.caption);
                return reply(extra?.caption || '📎 (document omitted)');
            },
            telegram: {
                // Deliberately no editMessageText: WhatsApp cannot edit sent
                // messages, and its absence makes ActionExecutor fall back to
                // plain replies instead of trying to patch a placeholder.
                sendMessage: (targetChatId, text, options = {}) => gateway.sendMessage(targetChatId || chatId, text, options || {}),
                deleteMessage: async () => false,
            },
        };
    }

    // =========================================================================
    //  http plumbing
    // =========================================================================

    _readRawBody(req) {
        return new Promise((resolve, reject) => {
            if (Buffer.isBuffer(req.rawBody)) return resolve(req.rawBody);
            if (typeof req.rawBody === 'string') return resolve(Buffer.from(req.rawBody, 'utf8'));

            const chunks = [];
            let total = 0;
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) return;
                settled = true;
                fn(arg);
            };

            req.on('data', (chunk) => {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > this.maxBodyBytes) {
                    const err = new Error('Webhook payload too large');
                    err.statusCode = 413;
                    settle(reject, err);
                    try { req.destroy(); } catch (_) {}
                    return;
                }
                chunks.push(buf);
            });
            req.on('end', () => settle(resolve, Buffer.concat(chunks)));
            req.on('error', (err) => settle(reject, err));
            req.on('aborted', () => settle(reject, new Error('Webhook request aborted')));
        });
    }

    _respond(res, statusCode, body = '') {
        try {
            res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(String(body));
        } catch (e) {
            console.warn(`[WhatsApp] Could not write response: ${e.message}`);
        }
    }

    _track(promise) {
        this._inflight = this._inflight.then(() => promise).catch(() => {});
        return promise;
    }
}

// -----------------------------------------------------------------------------
//  Small utilities
// -----------------------------------------------------------------------------

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

function headerValue(req, name) {
    const raw = req?.headers?.[name];
    return Array.isArray(raw) ? raw[0] : (raw || '');
}

function extensionFor(mimeType) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'video/mp4': '.mp4',
        'application/pdf': '.pdf',
    };
    return map[String(mimeType || '').split(';')[0]] || '.bin';
}

module.exports = WhatsAppGateway;
module.exports.normalizeNumber = normalizeNumber;
module.exports.parseAllowedNumbers = parseAllowedNumbers;
module.exports.splitWhatsAppMessage = splitWhatsAppMessage;
module.exports.telegramHtmlToWhatsApp = telegramHtmlToWhatsApp;
module.exports.parseBangCommand = parseBangCommand;
module.exports.resolveSlashCommand = resolveSlashCommand;
module.exports.WHATSAPP_MESSAGE_LIMIT = WHATSAPP_MESSAGE_LIMIT;
module.exports.DEFAULT_WEBHOOK_PATH = DEFAULT_WEBHOOK_PATH;
module.exports.GRAPH_API_BASE = GRAPH_API_BASE;
module.exports.DEFAULT_API_VERSION = DEFAULT_API_VERSION;
