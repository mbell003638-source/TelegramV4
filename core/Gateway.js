// =============================================================================
//  core/Gateway.js — Telegram Gateway Plugin
//
//  Handles Telegram bot communication, commands, text messages,
//  media attachments, and callback routing.
// =============================================================================
const { Telegraf, Markup } = require('telegraf');
const { toUnifiedIncomingMessage, parseSlashArgs } = require('./types');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

function parseBangCommand(text) {
    if (typeof text !== 'string' || !text.startsWith('!')) return null;
    return text.slice(1).replace(/^\s+/, '');
}

class Gateway {
    constructor(token, messageHandler, allowedUserId, uploadsDir) {
        const https = require('https');
        this.telegramAgent = new https.Agent({
            family: config.telegramIpFamily || 4,
            keepAlive: true,
            keepAliveMsecs: config.telegramKeepAliveMs || 10000
        });
        this.bot = new Telegraf(token);
        this.messageHandler = messageHandler;
        this.allowedUserId = allowedUserId;
        this.uploadsDir = uploadsDir || path.join(__dirname, '..', 'uploads');
        this.activeUsers = new Set();

        if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });

        this._setupAuth();
        this._setupCommands();
        this._setupHandlers();
        this._setupCallbackQueries();
        this._setupMediaHandlers();
    }

    // --- Authorization Middleware (single-user, like v3) ---
    _setupAuth() {
        if (this.allowedUserId) {
            this.bot.use((ctx, next) => {
                if (ctx.from && ctx.from.id !== this.allowedUserId) {
                    return ctx.reply('⛔ Unauthorized.');
                }
                return next();
            });
        }
    }

    // --- Commands ---
    _setupCommands() {
        // /start command
        this.bot.command('start', async (ctx) => {
            this.activeUsers.add(ctx.from?.id?.toString());
            const msg = toUnifiedIncomingMessage(ctx);
            if (msg) {
                msg.content.type = 'command';
                msg.content.text = '/start';
                // Show welcome message without keyboard
                await ctx.reply('👋 Welcome! Type /help to see available commands or type a message to start.', {
                    reply_markup: {
                        remove_keyboard: true
                    },
                });
            }
        });

        // Slash commands that map to actions
        this.bot.command('agent', (ctx) => this._dispatchAction(ctx, 'system', 'agent.show'));
        this.bot.command('new', (ctx) => this._dispatchAction(ctx, 'system', 'session.new'));
        this.bot.command('status', (ctx) => this._dispatchAction(ctx, 'system', 'session.status'));
        this.bot.command('help', (ctx) => this._dispatchAction(ctx, 'system', 'help.show'));

        // System commands (kept from v3)
        this.bot.command('voice', (ctx) => this._dispatchAction(ctx, 'system', 'voice.toggle'));
        this.bot.command('model', (ctx) => {
            const originalText = ctx.message?.text || '';
            const args = parseSlashArgs(originalText, 'model');
            if (args) {
                this._dispatchAction(ctx, 'system', 'model.set', { modelName: args });
            } else {
                this._dispatchAction(ctx, 'system', 'model.show');
            }
        });
        this.bot.command('effort', (ctx) => {
            const effort = parseSlashArgs(ctx.message?.text || '', 'effort');
            this._dispatchAction(ctx, 'system', effort ? 'effort.set' : 'effort.show', { effort });
        });
        this.bot.command('cost', (ctx) => this._dispatchAction(ctx, 'system', 'cost.show'));
        this.bot.command('costreset', (ctx) => this._dispatchAction(ctx, 'system', 'cost.reset'));
        this.bot.command('memory', (ctx) => this._dispatchAction(ctx, 'system', 'memory.show'));
        this.bot.command('remember', (ctx) => {
            const originalText = ctx.message?.text || '';
            const text = parseSlashArgs(originalText, 'remember');
            this._dispatchAction(ctx, 'system', 'memory.add', { text });
        });
        this.bot.command('forget', (ctx) => this._dispatchAction(ctx, 'system', 'memory.clear'));
        this.bot.command('handoff', (ctx) => this._dispatchAction(ctx, 'system', 'handoff.show'));
        this.bot.command('resume', (ctx) => {
            const args = parseSlashArgs(ctx.message?.text || '', 'resume').toLowerCase();
            if (args === 'last' || args === 'continue') {
                this._dispatchAction(ctx, 'system', 'session.resume.last');
                return;
            }
            this._dispatchAction(ctx, 'system', 'session.resume.show', { filter: args || undefined });
        });
        this.bot.command('resume_last', (ctx) => this._dispatchAction(ctx, 'system', 'session.resume.last'));
        this.bot.command('cwd', (ctx) => {
            const args = parseSlashArgs(ctx.message?.text || '', 'cwd');
            if (args) this._dispatchAction(ctx, 'system', 'cwd.set', { path: args });
            else this._dispatchAction(ctx, 'system', 'cwd.show');
        });
        this.bot.command('screen', (ctx) => this._dispatchAction(ctx, 'system', 'screen.capture'));
        this.bot.command('lock', (ctx) => this._dispatchAction(ctx, 'system', 'pc.lock'));
        this.bot.command('kanban', (ctx) => this._dispatchAction(ctx, 'system', 'mission.tasks.show'));
        this.bot.command('tasks', (ctx) => this._dispatchAction(ctx, 'system', 'mission.tasks.show'));
        this.bot.command('task', (ctx) => {
            const originalText = ctx.message?.text || '';
            const text = parseSlashArgs(originalText, 'task');
            this._dispatchAction(ctx, 'system', 'mission.task.create', { text });
        });
        this.bot.command('hive', (ctx) => this._dispatchAction(ctx, 'system', 'hive.show'));
        this.bot.command('learn', (ctx) => this._dispatchAction(ctx, 'system', 'learn.run'));
        this.bot.command('concurrency', (ctx) => {
            const originalText = ctx.message?.text || '';
            const limit = parseSlashArgs(originalText, 'concurrency');
            this._dispatchAction(ctx, 'system', limit ? 'concurrency.set' : 'concurrency.show', { limit });
        });
        this.bot.command('pool', (ctx) => {
            const originalText = ctx.message?.text || '';
            const limit = parseSlashArgs(originalText, 'pool');
            this._dispatchAction(ctx, 'system', limit ? 'concurrency.set' : 'concurrency.show', { limit });
        });
        this.bot.command('win', (ctx) => {
            const originalText = ctx.message?.text || '';
            const command = parseSlashArgs(originalText, 'win');
            this._dispatchAction(ctx, 'system', 'satellite.exec', { command });
        });
        this.bot.command('satellite', (ctx) => this._dispatchAction(ctx, 'system', 'satellite.status'));
        this.bot.command('workers', (ctx) => this._dispatchAction(ctx, 'system', 'satellite.status'));
        this.bot.command('restart', (ctx) => this._dispatchAction(ctx, 'system', 'bridge.restart'));
    }

    _dispatchAction(ctx, category, actionName, params) {
        const msg = toUnifiedIncomingMessage(ctx);
        if (msg && this.messageHandler) {
            msg.content.type = 'action';
            msg.content.text = actionName;
            msg.action = { type: category, name: actionName, params };
            this.messageHandler(msg).catch(e => console.error(`[Gateway] Action error: ${e.message}`));
        }
    }

    // --- Text Message Handler ---
    _setupHandlers() {
        this.bot.on('text', (ctx) => {
            if (ctx.message.text.startsWith('/')) return; // Already handled by commands

            this.activeUsers.add(ctx.from?.id?.toString());

            // Direct shell escape, matching Claude Code/Hermes-style !command.
            // Refuse to expose a remote shell unless this bot is locked to one user.
            const shellCommand = parseBangCommand(ctx.message.text);
            if (shellCommand !== null) {
                if (!this.allowedUserId) {
                    return ctx.reply('⛔ Direct shell is disabled until ALLOWED_USER_ID is configured.');
                }
                return this._dispatchAction(ctx, 'system', 'shell.execute', { command: shellCommand });
            }

            // Check for Reply Keyboard button presses
            const buttonActions = {
                '🆕 New Chat': { type: 'system', action: 'session.new' },
                '📊 Status': { type: 'system', action: 'session.status' },
                '❓ Help': { type: 'system', action: 'help.show' },
                '🔄 Agent': { type: 'system', action: 'agent.show' },
                '🧠 Model': { type: 'system', action: 'model.show' },
            };

            const btnAction = buttonActions[ctx.message.text];
            if (btnAction) {
                return this._dispatchAction(ctx, btnAction.type, btnAction.action);
            }

            // Regular text → forward to ActionExecutor via messageHandler
            const msg = toUnifiedIncomingMessage(ctx);
            if (msg && this.messageHandler) {
                // Non-blocking dispatch
                this.messageHandler(msg).catch(e =>
                    console.error(`[Gateway] Message handler failed: ${e.message}`)
                );
            }
        });
    }

    // --- Callback Query Handler ---
    _setupCallbackQueries() {
        this.bot.on('callback_query', async (ctx) => {
            const data = ctx.callbackQuery?.data;
            if (!data) return;

            this.activeUsers.add(ctx.from?.id?.toString());

            // Answer callback to remove loading spinner
            ctx.answerCbQuery().catch(() => {});

            // Parse callback data: "category:action"
            const parts = data.split(':');
            const category = parts[0]; // 'agent', 'model', 'tool_auth', 'action', 'session', etc.
            const action = parts.slice(1).join(':');

            // Agent selection
            if (category === 'agent') {
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.content.text = 'agent.select';
                    msg.action = { type: 'system', name: 'agent.select', params: { agentType: action } };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Agent select error: ${e.message}`)
                    );
                    // Remove inline keyboard after selection
                    ctx.editMessageReplyMarkup(undefined).catch(() => {});
                }
                return;
            }

            // Model selection (category === 'model')
            if (category === 'model') {
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.content.text = 'model.select';
                    msg.action = { type: 'system', name: 'model.select', params: { modelId: action } };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Model select error: ${e.message}`)
                    );
                    const keepKeyboard = action === 'refresh' || action.startsWith('p:');
                    if (!keepKeyboard) ctx.editMessageReplyMarkup(undefined).catch(() => {});
                }
                return;
            }

            if (category === 'effort') {
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.content.text = 'effort.set';
                    msg.action = { type: 'system', name: 'effort.set', params: { effort: action } };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Effort select error: ${e.message}`)
                    );
                    ctx.editMessageReplyMarkup(undefined).catch(() => {});
                }
                return;
            }

            if (category === 'resume') {
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.content.text = 'session.resume.select';
                    msg.action = { type: 'system', name: 'session.resume.select', params: { token: action } };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Resume select error: ${e.message}`)
                    );
                    const keepKeyboard = action === 'last' || action.startsWith('p:') || action.startsWith('a:');
                    if (!keepKeyboard) ctx.editMessageReplyMarkup(undefined).catch(() => {});
                }
                return;
            }

            // Tool authorization (category === 'tool_auth')
            if (category === 'tool_auth') {
                const [decision, reqId] = action.split(':');
                const actionName = decision === 'approve' ? 'tool.approve' : 'tool.deny';
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.content.text = actionName;
                    msg.action = { type: 'system', name: actionName, params: { requestId: reqId } };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Tool auth error: ${e.message}`)
                    );
                    ctx.editMessageReplyMarkup(undefined).catch(() => {});
                }
                return;
            }

            // Action buttons (stop, regenerate, continue, copy)
            if (category === 'action') {
                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.type = 'action';
                    msg.action = { type: 'chat', name: `action.${action}` };
                    this.messageHandler(msg).catch(e =>
                        console.error(`[Gateway] Action callback error: ${e.message}`)
                    );
                }
                return;
            }

            // Session actions
            if (category === 'session') {
                this._dispatchAction(ctx, 'system', `session.${action}`);
                return;
            }
        });
    }

    async _downloadTelegramFile(url, destPath) {
        const response = await axios({
            url,
            responseType: 'stream',
            timeout: config.mediaTimeoutMs,
            maxContentLength: config.mediaMaxBytes,
            httpsAgent: this.telegramAgent,
        });
        const stream = fs.createWriteStream(destPath);
        response.data.pipe(stream);
        await new Promise((res, rej) => {
            stream.on('finish', res);
            stream.on('error', rej);
            response.data.on('error', rej);
        });
        return destPath;
    }

    // --- Media Handlers (photos, documents, voice) ---
    _setupMediaHandlers() {
        this.bot.on('photo', async (ctx) => {
            try {
                const photo = ctx.message.photo.pop();
                const link = await ctx.telegram.getFileLink(photo.file_id);
                const filePath = path.join(this.uploadsDir, `${photo.file_id}.jpg`);
                await this._downloadTelegramFile(link.href, filePath);

                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.text = `${ctx.message.caption || 'Analyze this image.'} @${filePath}`;
                    this.messageHandler(msg).catch(() => {});
                }
            } catch (e) {
                ctx.reply('❌ Photo processing failed.');
            }
        });

        this.bot.on('document', async (ctx) => {
            try {
                const doc = ctx.message.document;
                const link = await ctx.telegram.getFileLink(doc.file_id);
                const safeName = path.basename(doc.file_name || `file_${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
                const filePath = path.join(this.uploadsDir, `${doc.file_id}_${safeName}`);
                await this._downloadTelegramFile(link.href, filePath);

                await ctx.reply(`✅ File saved: \`${doc.file_name}\``, { parse_mode: 'Markdown' });

                if (ctx.message.caption) {
                    const msg = toUnifiedIncomingMessage(ctx);
                    if (msg && this.messageHandler) {
                        msg.content.text = `File uploaded to: ${filePath}\n\nInstruction: "${ctx.message.caption}"`;
                        this.messageHandler(msg).catch(() => {});
                    }
                }
            } catch (e) {
                ctx.reply('❌ File download failed.');
            }
        });

        this.bot.on('voice', async (ctx) => {
            try {
                const voice = ctx.message.voice;
                const link = await ctx.telegram.getFileLink(voice.file_id);
                const filePath = path.join(this.uploadsDir, `${voice.file_id}.ogg`);
                await this._downloadTelegramFile(link.href, filePath);

                const msg = toUnifiedIncomingMessage(ctx);
                if (msg && this.messageHandler) {
                    msg.content.text = `${ctx.message.caption || 'Transcribe this voice message and respond to it.'} @${filePath}`;
                    this.messageHandler(msg).catch(() => {});
                }
            } catch (e) {
                ctx.reply('❌ Voice processing failed.');
            }
        });
    }

    // --- Start the bot with exponential backoff ---
    async start() {
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = Infinity;
        this.baseReconnectDelay = config.reconnectBaseDelayMs;

        console.log('🚀 [Gateway] Starting Telegram bot...');
        
        // Register commands with Telegram so they appear in the / menu
        try {
            await this.bot.telegram.setMyCommands([
                { command: 'start', description: 'Start the bot' },
                { command: 'new', description: 'Start a new chat session' },
                { command: 'agent', description: 'Switch the active AI agent' },
                { command: 'status', description: 'View current session and usage status' },
                { command: 'model', description: 'Set the model for the active agent' },
                { command: 'voice', description: 'Toggle voice response mode' },
                { command: 'cost', description: 'Show token usage and cost' },
                { command: 'costreset', description: 'Reset token usage statistics' },
                { command: 'handoff', description: 'Show shared memory and switch agent' },
                { command: 'resume', description: 'Attach a CLI session and continue it here' },
                { command: 'resume_last', description: 'Attach the latest CLI session for this agent' },
                { command: 'cwd', description: 'Show or set the working folder' },
                { command: 'kanban', description: 'View Mission Control Kanban tasks' },
                { command: 'task', description: 'Create a new task on the Kanban board' },
                { command: 'hive', description: 'View recent Hive Mind agent delegations' },
                { command: 'learn', description: 'Analyze discipline and run self-improvement' },
                { command: 'concurrency', description: 'View or set max concurrent agent pool' },
                { command: 'screen', description: 'Capture a screenshot of the PC' },
                { command: 'lock', description: 'Lock the PC workstation' },
                { command: 'win', description: 'Run command on Windows PC (Satellite)' },
                { command: 'satellite', description: 'Show connected satellite workers' },
                { command: 'restart', description: 'Restart the Telegram bridge' },
                { command: 'help', description: 'Show available commands' }
            ]);
        } catch (e) {
            console.error('[Gateway] Failed to set commands:', e.message);
        }

        await this._launchWithRetry();

        // Graceful shutdown
        process.once('SIGINT', () => this.bot.stop('SIGINT'));
        process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
    }

    /**
     * Exponential backoff reconnection with jitter.
     * Retry indefinitely with capped exponential backoff.
     */
    async _launchWithRetry() {
        while (this.reconnectAttempts <= this.maxReconnectAttempts) {
            try {
                await this.bot.launch({ dropPendingUpdates: config.dropPendingUpdates });
                this.reconnectAttempts = 0;
                console.log('✅ [Gateway] Bot is running.');
                return;
            } catch (err) {
                this.reconnectAttempts++;
                // Exponential backoff with jitter
                const delay = Math.min(
                    this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
                    config.reconnectMaxDelayMs
                );
                console.warn(`⚠️ [Gateway] Connection failed: ${err.message}. Retrying in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    stop(reason = 'shutdown') {
        try {
            if (this.bot) this.bot.stop(reason);
        } catch (e) {}
    }
}

module.exports = Gateway;
module.exports.parseBangCommand = parseBangCommand;
