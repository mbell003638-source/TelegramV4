// =============================================================================
//  core/types.js — Unified Message Protocol
//
//  Platform-agnostic message protocol for chat interfaces.
// =============================================================================

/**
 * Content types for unified messages
 * @typedef {'text'|'photo'|'document'|'voice'|'action'|'command'} MessageContentType
 */

/**
 * Action categories
 * @typedef {'platform'|'system'|'chat'} ActionCategory
 */

/**
 * Agent types we support
 * @typedef {'antigravity'|'codex'|'claude'|'opencode'|'openclaw'|'hermes'|'pi'|'grok'|'desktop'} AgentType
 */

/**
 * Plugin lifecycle states
 * created → initializing → ready → starting → running → stopping → stopped
 *               ↓                    ↓           ↓
 *             error ←←←←←←←←←←←←←←←←←←←←←←←←←←←
 * @typedef {'created'|'initializing'|'ready'|'starting'|'running'|'stopping'|'stopped'|'error'} PluginStatus
 */

/**
 * Build a UnifiedIncomingMessage from a Telegraf context.
 */
function toUnifiedIncomingMessage(ctx) {
    const msg = ctx.message || ctx.callbackQuery?.message;
    if (!msg) return null;

    const user = ctx.from;
    const chatId = msg.chat?.id?.toString();

    const unified = {
        id: ctx.callbackQuery ? ctx.callbackQuery.id : (msg.message_id?.toString() || Date.now().toString()),
        platform: 'telegram',
        chatId: chatId,
        user: {
            id: user?.id?.toString(),
            username: user?.username,
            displayName: [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'Unknown',
        },
        content: {
            type: 'text',
            text: msg.text || msg.caption || '',
            attachments: [],
        },
        timestamp: msg.date ? msg.date * 1000 : Date.now(),
        action: null,
        raw: ctx, // Keep original context for sending replies
    };

    // Handle photos
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        unified.content.type = 'photo';
        unified.content.attachments.push({
            type: 'photo',
            fileId: largest.file_id,
            size: largest.file_size,
        });
    }

    // Handle documents
    if (msg.document) {
        unified.content.type = 'document';
        unified.content.attachments.push({
            type: 'document',
            fileId: msg.document.file_id,
            fileName: msg.document.file_name,
            mimeType: msg.document.mime_type,
            size: msg.document.file_size,
        });
    }

    // Handle voice
    if (msg.voice) {
        unified.content.type = 'voice';
        unified.content.attachments.push({
            type: 'voice',
            fileId: msg.voice.file_id,
            duration: msg.voice.duration,
        });
    }

    return unified;
}

/**
 * Build Telegram send options from a UnifiedOutgoingMessage.
 */
function toTelegramSendParams(outgoingMessage) {
    const options = {};

    if (outgoingMessage.parseMode) {
        options.parse_mode = outgoingMessage.parseMode;
    }

    if (outgoingMessage.replyMarkup) {
        options.reply_markup = outgoingMessage.replyMarkup;
    }

    return {
        text: outgoingMessage.text || '',
        options,
    };
}

/**
 * Smart message splitting at natural break points (newlines, spaces).
 */
const TELEGRAM_MESSAGE_LIMIT = 4096;
function splitMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        // Find the last natural break point before the limit
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt === -1 || splitAt < limit * 0.5) {
            // No newline found in reasonable range, try space
            splitAt = remaining.lastIndexOf(' ', limit);
        }
        if (splitAt === -1 || splitAt < limit * 0.3) {
            // No natural break found, hard cut
            splitAt = limit;
        }
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
}

/**
 * Strip `/command` or `/command@BotName` from a Telegram message, leaving args.
 */
function parseSlashArgs(text, command) {
    if (!text || !command) return '';
    const re = new RegExp(`^/${command}(?:@\\S+)?\\s*`, 'i');
    return String(text).replace(re, '').trim();
}

module.exports = {
    toUnifiedIncomingMessage,
    toTelegramSendParams,
    splitMessage,
    parseSlashArgs,
    TELEGRAM_MESSAGE_LIMIT,
};
