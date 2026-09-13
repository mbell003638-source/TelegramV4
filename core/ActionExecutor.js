// =============================================================================
//  core/ActionExecutor.js — Action Router & Stream Orchestrator
//
//  Handles:
//    1. Receives UnifiedIncomingMessages from Gateway
//    2. Checks authorization
//    3. Routes to the correct Action handler based on action.type
//    4. For chat messages: sends to the Agent, manages stream throttling
//    5. Emits "⏳ Thinking..." placeholder, then edits it with streamed text
// =============================================================================
const { channelEventBus } = require('./EventBus');
const { Markup } = require('telegraf');
const { markdownToTelegramHtml } = require('./formatters');
const { splitMessage, parseSlashArgs } = require('./types');

const UPDATE_THROTTLE_MS = 1000;
const MODEL_PAGE_SIZE = 6;
const MODEL_DISCOVERY_WAIT_MS = 2500;
const RESUME_PAGE_SIZE = 6;
const path = require('path');
const DurableIdStore = require('./DurableIdStore');
const ShellJobManager = require('./ShellJobManager');
const { globalAgentPool } = require('./AgentPool');
const { globalSatelliteHub } = require('./SatelliteHub');
const { globalLoopGuard } = require('./LoopGuard');
const { globalTruncator } = require('./TruncationEngine');
const { globalApprovalGate } = require('./SecurityApprovalGate');
const config = require('./config');

function stripAnsi(value) {
    return String(value || '').replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function parseShellControl(command) {
    const match = String(command || '').trim().match(/^(jobs|status|tail|stop)(?:\s+([^\s]+))?\s*$/i);
    return match ? { name: match[1].toLowerCase(), jobId: match[2] || null } : null;
}

function formatElapsed(startedAt, finishedAt = Date.now()) {
    const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours ? `${hours}h ${minutes}m` : (minutes ? `${minutes}m ${remainder}s` : `${remainder}s`);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isEmptyMemories(memories) {
    const trimmed = String(memories || '').trim();
    return !trimmed || trimmed === '# USER PROFILE & PREFERENCES';
}

function clipText(value, max) {
    const text = String(value || '').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function buildSharedPrompt(text, options = {}) {
    if (!text) return text;
    const {
        memories = '',
        recentTurns = [],
        pendingNotes = [],
        hasExistingSession = false,
        maxTurns = 2,
    } = options;
    const parts = [];

    if (!hasExistingSession && !isEmptyMemories(memories)) {
        parts.push(`Persistent shared memories (follow these; they apply for every agent):\n${String(memories).trim()}`);
    }

    const turns = Array.isArray(recentTurns) ? recentTurns.slice(-Math.max(1, maxTurns)) : [];
    if (turns.length > 0) {
        const transcript = turns.map((turn) => {
            const name = turn.agentName || turn.agent || 'agent';
            const user = clipText(turn.userText, 500);
            const assistant = clipText(turn.assistantText, 700);
            return `[${name}]\nUser: ${user}\nAssistant: ${assistant}`;
        }).join('\n\n');
        parts.push(`Shared recent conversation across agents. Continue this work; do not restart from scratch.\n${transcript}`);
    }

    const pending = (pendingNotes || []).map(n => String(n || '').trim()).filter(Boolean);
    if (pending.length) {
        parts.push(`New shared memories to retain from now on (all agents):\n${pending.map(n => `- ${n}`).join('\n')}`);
    }

    if (!parts.length) return text;
    return `${parts.join('\n\n---\n\n')}\n\n---\n\n${text}`;
}

function applyPersistentMemories(text, memories, hasExistingSession) {
    return buildSharedPrompt(text, { memories, hasExistingSession });
}

function buildModelSelectorView(models, currentModel, page = 0, pageSize = MODEL_PAGE_SIZE, discovery = 'live') {
    const list = Array.isArray(models) ? models : [];
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize) || 1);
    const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
    const start = safePage * pageSize;
    const slice = list.slice(start, start + pageSize);
    const buttons = [];
    let row = [];
    slice.forEach((model, offset) => {
        const index = start + offset;
        const prefix = model.id === currentModel ? '✓ ' : '';
        let label = `${prefix}${model.name || model.id}`;
        if (label.length > 28) label = `${label.slice(0, 26)}…`;
        row.push({ text: label, callback_data: `model:i:${index}` });
        if (row.length === 2) {
            buttons.push(row);
            row = [];
        }
    });
    if (row.length) buttons.push(row);

    const nav = [];
    if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `model:p:${safePage - 1}` });
    nav.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: `model:p:${safePage}` });
    if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `model:p:${safePage + 1}` });
    if (nav.length) buttons.push(nav);
    const refreshLabel = discovery === 'live'
        ? '🔄 Scan Latest Models'
        : (discovery === 'configured' ? '↻ Reload Configured Models' : '↻ Reload Model List');
    buttons.push([{ text: refreshLabel, callback_data: 'model:refresh' }]);

    return { buttons, page: safePage, totalPages, start };
}

class ActionExecutor {
    constructor(sessionStore, agents) {
        this.sessionStore = sessionStore;
        this.agents = agents;
        this.queues = new Map();
        this.active = new Map();

        // Streaming state
        this.pendingToolApprovals = new Map(); // reqId -> { resolve, timeout }
        this.lastMessages = new Map(); // chatId -> last user message, for replay actions
        this.lastResponses = new Map(); // chatId -> last completed response
        const processedFile = path.join(this.sessionStore.dir, 'processed_mids.json');
        this.processedIdStore = new DurableIdStore(processedFile, 500);
        this.shellJobs = new ShellJobManager(this.sessionStore.dir);
        this.agentInstances = new Map();
        this.resumeLists = new Map();

        // Wire up EventBus listeners
        channelEventBus.onAgentMessage((event) => this._onStreamChunk(event));
        channelEventBus.onToolCall((event) => this._onToolCall(event));
        channelEventBus.onStatus((event) => this._onStatusChange(event));
        channelEventBus.onFinished((event) => this._onFinished(event));
        channelEventBus.onError((event) => this._onError(event));

        // When a concurrency pool slot opens, wake waiting queues
        globalAgentPool.on('pool.slot_released', () => {
            for (const waitingChatId of this.queues.keys()) {
                this._processChat(waitingChatId);
            }
        });
    }

    /**
     * Get the message handler function.
     * This is what the Gateway calls when a message arrives.
     */
    getMessageHandler() {
        return async (unifiedMessage) => {
            // Check for duplicate message ID (per-chat key)
            const idKey = unifiedMessage.platform ? `${unifiedMessage.platform}:${unifiedMessage.chatId || ''}:${unifiedMessage.id}` : unifiedMessage.id;
            if (idKey) {
                if (this.processedIdStore.has(idKey)) {
                    console.log(`[ActionExecutor] Duplicate message detected (ID: ${unifiedMessage.id}). Ignoring.`);
                    return;
                }
                this.processedIdStore.add(idKey);
            }

            // Check if it's an action (button press, command)
            if (unifiedMessage.action) {
                await this._handleAction(unifiedMessage);
                return;
            }

            // Regular chat message — queue it
            this._enqueue(unifiedMessage);
        };
    }

    // --- Action Handling ---
    async _handleAction(msg) {
        const ctx = msg.raw;
        const actionName = msg.action?.name;

        // OpenClaw Security Approval Gate Callbacks (approve:id or deny:id)
        if (actionName && (actionName.startsWith('approve:') || actionName.startsWith('deny:'))) {
            const parts = actionName.split(':');
            const isApproved = parts[0] === 'approve';
            const approvalId = parts[1];
            const result = globalApprovalGate.handleCallback(approvalId, isApproved);
            if (result.handled) {
                await ctx.reply(isApproved ? `✅ Command authorized: <code>${escapeHtml(result.command)}</code>` : `🛑 Command aborted by user.`, { parse_mode: 'HTML' });
            } else {
                await ctx.reply('ℹ️ This authorization request has expired or already been handled.');
            }
            return;
        }

        switch (actionName) {
            case 'bridge.restart': {
                await ctx.reply('🔄 Restarting bridge...');
                setTimeout(() => process.exit(0), 2500);
                break;
            }
            case 'shell.execute': {
                const command = String(msg.action?.params?.command || '');
                if (!command.trim()) {
                    await ctx.reply(
                        'Usage: <code>!command</code>\nExample: <code>!uname -a</code>\n\n' +
                        'Jobs: <code>!jobs</code>, <code>!status [id]</code>, <code>!tail [id]</code>, <code>!stop [id]</code>',
                        { parse_mode: 'HTML' }
                    );
                    break;
                }

                // Check destructive command protection (OpenClaw Security Gate)
                const dangerCheck = globalApprovalGate.isDangerous(command);
                if (dangerCheck.dangerous) {
                    const approval = await globalApprovalGate.requestApproval(command, {
                        chatId: msg.chatId,
                        agentName: 'Shell',
                        telegram: ctx.telegram,
                    });
                    if (!approval.approved) {
                        await ctx.reply(`🛑 Command blocked: ${approval.reason || 'User denied permission'}`);
                        break;
                    }
                }

                const control = parseShellControl(command);
                if (control) {
                    await this._handleShellControl(ctx, msg.chatId, control);
                    break;
                }
                const activeKey = this.sessionStore.getActiveAgent(msg.chatId);
                const cwd = this.sessionStore.getWorkspaceCwd(activeKey, msg.chatId);
                let job;
                let pending;
                try {
                    job = await this.shellJobs.start(command, {
                        chatId: msg.chatId, cwd, attachedForMs: config.shellCommandTimeoutMs,
                    });
                    pending = await ctx.reply(
                        `⚙️ Job <code>${job.id}</code> running in <code>${escapeHtml(cwd)}</code>…\n` +
                        `It will move to background tracking after ${Math.round(config.shellCommandTimeoutMs / 60000)} minutes.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (error) {
                    await ctx.reply(`❌ Failed to start systemd job: <code>${escapeHtml(error.stderr || error.message)}</code>`, { parse_mode: 'HTML' });
                    break;
                }

                const result = await this.shellJobs.wait(job.id, config.shellCommandTimeoutMs);
                if (pending?.message_id && ctx.telegram?.deleteMessage) {
                    await ctx.telegram.deleteMessage(ctx.chat.id, pending.message_id).catch(() => {});
                }

                if (result && ['running', 'starting'].includes(result.state)) {
                    await ctx.reply(
                        `⏳ Job <code>${result.id}</code> is still running after ${Math.round(config.shellCommandTimeoutMs / 60000)} minutes. It was <b>not stopped</b>.\n\n` +
                        `Check: <code>!status ${result.id}</code>\nOutput: <code>!tail ${result.id}</code>\nStop: <code>!stop ${result.id}</code>`,
                        { parse_mode: 'HTML' }
                    );
                } else if (result) {
                    await this._sendShellJobResult(result, (text, options) => ctx.reply(text, options));
                    await this.shellJobs.markNotified(result);
                }
                break;
            }
            case 'cwd.show': {
                const chatId = msg.chatId;
                const activeKey = this.sessionStore.getActiveAgent(chatId);
                const cwd = this.sessionStore.getWorkspaceCwd(activeKey, chatId);
                const override = this.sessionStore.getChatCwd(chatId);
                await ctx.reply(
                    `📂 Working folder:\n<code>${escapeHtml(cwd)}</code>\n\n` +
                    (override ? 'Set with /cwd for this chat.\n' : 'Default (WORKSPACE_ROOT / resumed session).\n') +
                    `Change: <code>/cwd /home/open/project</code>\n` +
                    `Reset: <code>/cwd home</code>\n\n` +
                    `This is the start folder. Agents still run as user <code>open</code> and can read/write anywhere that user can (YOLO). They are not jailed to this folder.`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'cwd.set': {
                const chatId = msg.chatId;
                const requested = (msg.action?.params?.path || '').trim();
                const activeKey = this.sessionStore.getActiveAgent(chatId);
                const agent = this.agents[activeKey];
                if (['reset', 'clear'].includes(requested.toLowerCase())) {
                    this.sessionStore.setChatCwd(chatId, null);
                    this.sessionStore.clearSession(activeKey, chatId);
                    if (agent && typeof agent.clearSession === 'function') agent.clearSession(chatId);
                    const cwd = this.sessionStore.getWorkspaceCwd(activeKey, chatId);
                    await ctx.reply(`📂 Working folder reset to\n<code>${escapeHtml(cwd)}</code>`, { parse_mode: 'HTML' });
                    break;
                }
                const { resolveUserCwd } = require('./sessionCatalog');
                const resolved = resolveUserCwd(requested, require('os').homedir());
                if (!resolved) {
                    await ctx.reply(`❌ Folder not found: <code>${escapeHtml(requested)}</code>\nExample: <code>/cwd /home/open</code> or <code>/cwd ~/Documents</code>`, { parse_mode: 'HTML' });
                    break;
                }
                this.sessionStore.setChatCwd(chatId, resolved);
                this.sessionStore.clearSession(activeKey, chatId);
                if (agent && typeof agent.clearSession === 'function') agent.clearSession(chatId);
                await ctx.reply(
                    `📂 Working folder set to\n<code>${escapeHtml(resolved)}</code>\n\n` +
                    `Next message starts a fresh ${agent?.emoji || ''} thread in that folder. Tools can still access the rest of the Pi as user <code>open</code>.`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'session.new': {
                const chatId = msg.chatId;
                const activeAgent = this.sessionStore.getActiveAgent(chatId);
                const agent = this.agents[activeAgent];
                this.sessionStore.clearSession(activeAgent, chatId);
                this.sessionStore.clearRecentTurns(chatId);
                this.sessionStore.clearPendingMemories(chatId);
                if (agent && typeof agent.clearSession === 'function') {
                    agent.clearSession(chatId);
                }
                await ctx.reply('🆕 Started a fresh session. Shared memories are kept; recent chat context was cleared.');
                break;
            }
            case 'action.stop': {
                const state = this.active.get(msg.chatId);
                if (state) {
                    const agent = this._getAgent(state.agentKey, msg.chatId);
                    if (agent && typeof agent.cancelTurn === 'function') {
                        await agent.cancelTurn().catch(() => {});
                    } else if (agent) {
                        await agent.stop().catch(() => {});
                    }
                    await ctx.reply('🛑 Stopped.').catch(() => {});
                    this._cleanup(state);
                } else {
                    await ctx.reply('ℹ️ Nothing is currently running.').catch(() => {});
                }
                break;
            }
            case 'action.copy': {
                const response = this.lastResponses.get(msg.chatId);
                await ctx.reply(response ? response.substring(0, 4096) : 'ℹ️ No completed response to copy.').catch(() => {});
                break;
            }
            case 'action.retry':
            case 'action.regenerate':
            case 'action.continue': {
                const previous = this.lastMessages.get(msg.chatId);
                if (!previous) {
                    await ctx.reply('ℹ️ There is no previous message to retry.').catch(() => {});
                    break;
                }
                const replay = { ...previous, id: `replay:${Date.now()}`, raw: ctx };
                if (actionName === 'action.regenerate') {
                    const agentKey = this.sessionStore.getActiveAgent(msg.chatId);
                    this.sessionStore.clearSession(agentKey, msg.chatId);
                }
                if (actionName === 'action.continue') {
                    replay.content = { ...replay.content, text: 'Continue from your last response. Do not repeat it; continue where you left off.' };
                }
                this._enqueue(replay);
                break;
            }
            case 'session.status': {
                await this._sendStatus(ctx, msg.chatId);
                break;
            }
            case 'help.show': {
                await this._sendHelp(ctx);
                break;
            }
            case 'agent.show': {
                await this._sendAgentSelector(ctx, msg.chatId);
                break;
            }
            case 'agent.select': {
                const agentType = msg.action?.params?.agentType;
                const chatId = msg.chatId;
                if (agentType && this.agents[agentType]) {
                    this.sessionStore.setActiveAgent(agentType, chatId);
                    const agent = this.agents[agentType];
                    const resumed = Boolean(this.sessionStore.getSession(agentType, chatId));
                    this._warmAgent(agent);
                    await ctx.reply(
                        `✅ Switched to ${agent.emoji} <b>${escapeHtml(agent.name)}</b>\n` +
                        (resumed
                            ? 'Resuming this agent\'s previous thread (faster). Shared memory still applies.'
                            : 'New thread. Shared memories and recent chat will be passed on the next message.'),
                        { parse_mode: 'HTML' }
                    );
                }
                break;
            }
            // Model selector and configuration
            case 'model.show': {
                try {
                    await this._sendModelSelector(ctx, msg.chatId, 0);
                } catch (e) {
                    console.error(`[ActionExecutor] model.show failed: ${e.message}`);
                    await ctx.reply('ℹ️ Could not render the model list. Type /model <id> to set one.').catch(() => {});
                }
                break;
            }
            case 'model.select': {
                let modelId = msg.action?.params?.modelId;
                const chatId = msg.chatId;
                const activeKey = this.sessionStore.getActiveAgent(chatId);
                if (modelId === 'refresh') {
                    const agent = this.agents[activeKey];
                    let discovered = null;
                    if (agent && agent.discoverModels) {
                        try { discovered = await agent.discoverModels({ force: true }); } catch(e) {}
                    }
                    const discovery = agent?.modelControl?.discovery || 'static';
                    const notice = Array.isArray(discovered) && discovered.length
                        ? `🔄 Loaded ${Math.max(0, discovered.length - 1)} ${discovery} models`
                        : `ℹ️ ${agent?.name || activeKey} uses its configured model list`;
                    try { if (ctx.answerCbQuery) await ctx.answerCbQuery(notice); } catch(e) {}
                    await this._sendModelSelector(ctx, chatId, 0, { discover: false });
                    break;
                }
                if (typeof modelId === 'string' && modelId.startsWith('p:')) {
                    const page = Number(modelId.slice(2));
                    await this._sendModelSelector(ctx, chatId, Number.isFinite(page) ? page : 0);
                    break;
                }
                if (typeof modelId === 'string' && modelId.startsWith('i:')) {
                    const idx = Number(modelId.slice(2));
                    const models = this.sessionStore.getAvailableModels(activeKey);
                    const picked = Number.isFinite(idx) ? models[idx] : null;
                    if (!picked) {
                        await ctx.reply('ℹ️ That model list expired. Send /model again.');
                        break;
                    }
                    modelId = picked.id;
                }
                if (modelId) {
                    this.sessionStore.setActiveModel(activeKey, modelId, chatId);
                    this.sessionStore.clearSession(activeKey, chatId);
                    const agent = this.agents[activeKey];
                    if (agent && typeof agent.applyModel === 'function') {
                        try { await agent.applyModel(modelId, chatId); } catch(e) {}
                    }
                    try { if (ctx.answerCbQuery) await ctx.answerCbQuery(); } catch(e) {}
                    const selected = this.sessionStore.getAvailableModels(activeKey).find(model => model.id === modelId);
                    if (selected?.reasoningEfforts?.length) {
                        await this._sendReasoningSelector(ctx, chatId, { model: selected, modelChanged: true });
                    } else {
                        await ctx.reply(`✅ Model set to <code>${escapeHtml(modelId)}</code> for ${agent?.emoji || '🤖'} <b>${escapeHtml(agent?.name || activeKey)}</b>.\nFresh session started.`, { parse_mode: 'HTML' });
                    }
                }
                break;
            }
            case 'model.set': {
                const modelName = (msg.action?.params?.modelName || parseSlashArgs(msg.action?.params?.originalText || '', 'model')).trim();
                if (modelName) {
                    const chatId = msg.chatId;
                    const activeKey = this.sessionStore.getActiveAgent(chatId);
                    this.sessionStore.setActiveModel(activeKey, modelName, chatId);
                    this.sessionStore.clearSession(activeKey, chatId);
                    const agent = this.agents[activeKey];
                    if (agent && typeof agent.applyModel === 'function') {
                        try { await agent.applyModel(modelName, chatId); } catch(e) {}
                    }
                    const selected = this.sessionStore.getAvailableModels(activeKey).find(model => model.id === modelName);
                    if (selected?.reasoningEfforts?.length) {
                        await this._sendReasoningSelector(ctx, chatId, { model: selected, modelChanged: true });
                    } else {
                        await ctx.reply(`✅ Model set to <code>${escapeHtml(modelName)}</code> for ${agent?.emoji || '🤖'} <b>${escapeHtml(agent?.name || activeKey)}</b>.\nFresh session started.`, { parse_mode: 'HTML' });
                    }
                } else {
                    await this._sendModelSelector(ctx, msg.chatId);
                }
                break;
            }
            case 'effort.show': {
                await this._sendReasoningSelector(ctx, msg.chatId);
                break;
            }
            case 'effort.set': {
                const chatId = msg.chatId;
                const activeKey = this.sessionStore.getActiveAgent(chatId);
                const modelId = this.sessionStore.getActiveModel(activeKey, chatId) || 'default';
                const model = this.sessionStore.getAvailableModels(activeKey).find(item => item.id === modelId);
                const requested = String(msg.action?.params?.effort || '').toLowerCase();
                if (!model?.reasoningEfforts?.length) {
                    await ctx.reply(`ℹ️ No reasoning-effort metadata is available for <code>${escapeHtml(modelId)}</code>. For Codex, tap Scan Latest Models first.`, { parse_mode: 'HTML' });
                    break;
                }
                if (requested !== 'auto' && !model.reasoningEfforts.includes(requested)) {
                    await ctx.reply(`❌ <code>${escapeHtml(requested)}</code> is not supported by <code>${escapeHtml(modelId)}</code>.\nSupported: <code>${escapeHtml(model.reasoningEfforts.join(', '))}</code>`, { parse_mode: 'HTML' });
                    break;
                }
                this.sessionStore.setReasoningEffort(activeKey, modelId, requested === 'auto' ? null : requested, chatId);
                await ctx.reply(
                    `✅ Reasoning effort: <code>${requested === 'auto' ? `auto (${model.autoReasoningEffort || model.defaultReasoningEffort || 'CLI default'})` : requested}</code>\n` +
                    `Model: <code>${escapeHtml(modelId)}</code>\nCurrent session is preserved.`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'tool.approve': {
                const reqId = msg.action?.params?.requestId;
                if (reqId && this.pendingToolApprovals.has(reqId)) {
                    const entry = this.pendingToolApprovals.get(reqId);
                    clearTimeout(entry.timeout);
                    this.pendingToolApprovals.delete(reqId);
                    entry.resolve(true);
                    await ctx.reply('✅ Tool execution approved.');
                }
                break;
            }
            case 'tool.deny': {
                const reqId = msg.action?.params?.requestId;
                if (reqId && this.pendingToolApprovals.has(reqId)) {
                    const entry = this.pendingToolApprovals.get(reqId);
                    clearTimeout(entry.timeout);
                    this.pendingToolApprovals.delete(reqId);
                    entry.resolve(false);
                    await ctx.reply('❌ Tool execution denied.');
                }
                break;
            }
            case 'voice.toggle': {
                const current = this.sessionStore.getVoiceMode();
                this.sessionStore.setVoiceMode(!current);
                await ctx.reply(`🗣️ Voice mode: ${!current ? 'ON' : 'OFF'}`);
                break;
            }
            case 'cost.show': {
                const activeKey = this.sessionStore.getActiveAgent(msg.chatId);
                const usage = this.sessionStore.getUsage(activeKey);
                await ctx.reply(
                    `📊 <b>Usage (${this.agents[activeKey]?.name})</b>\n\n` +
                    `Requests: ${usage.totalRequests}\n` +
                    `Input tokens: ${usage.totalInputTokens.toLocaleString()}\n` +
                    `Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'cost.reset': {
                this.sessionStore.resetUsage();
                await ctx.reply('✅ Usage stats reset.');
                break;
            }
            case 'memory.show': {
                const content = this.sessionStore.getMemories().trim();
                if (content && content !== '# USER PROFILE & PREFERENCES') {
                    const display = content.length > 3500 ? content.slice(0, 3500) + '...' : content;
                    await ctx.reply(`🧠 <b>Shared memories (all agents):</b>\n\n<pre>${escapeHtml(display)}</pre>`, { parse_mode: 'HTML' });
                    break;
                }
                await ctx.reply('🧠 No persistent memories stored yet.\n\nUse <code>/remember &lt;note&gt;</code> to save facts or preferences across all AI agents.', { parse_mode: 'HTML' });
                break;
            }
            case 'memory.add': {
                const note = msg.action?.params?.text;
                if (!note) {
                    await ctx.reply('ℹ️ Usage: <code>/remember &lt;fact or preference&gt;</code>\n\nExample: <code>/remember Always output concise Python code</code>', { parse_mode: 'HTML' });
                    break;
                }
                if (!this.sessionStore.addMemory(note)) {
                    await ctx.reply('❌ Failed to save memory.');
                    break;
                }
                this.sessionStore.addPendingMemory(msg.chatId, note);
                await ctx.reply(`✅ Added to shared memory:\n<i>"${escapeHtml(note)}"</i>\n\nEvery agent will get this. The current session will pick it up on the next message.`, { parse_mode: 'HTML' });
                break;
            }
            case 'memory.clear': {
                try {
                    this.sessionStore.clearMemories();
                    this.sessionStore.clearPendingMemories(msg.chatId);
                    await ctx.reply('🧹 Shared memories cleared for all agents. Recent chat turns are unchanged; use /new to clear those too.');
                } catch (e) {
                    await ctx.reply(`❌ Failed to clear memory: ${e.message}`);
                }
                break;
            }
            case 'handoff.show': {
                await this._sendHandoff(ctx, msg.chatId);
                break;
            }
            case 'mission.tasks.show': {
                const db = require('./Database').getDatabase();
                const tasks = db.getMissionTasks({ limit: 8 });
                if (!tasks.length) {
                    await ctx.reply('📋 <b>Mission Control Kanban:</b>\n\nNo active tasks in database.\n\nUse <code>/task &lt;description&gt;</code> to create a task, or open Mission Control at:\n<code>http://localhost:3141/?token=admin</code>', { parse_mode: 'HTML' });
                    break;
                }
                const lines = ['📋 <b>Mission Control Kanban (Recent Tasks):</b>\n'];
                for (const t of tasks) {
                    const statusEmoji = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '⏳' : t.status === 'failed' ? '❌' : '📥';
                    lines.push(`${statusEmoji} <b>[${t.assigned_agent}]</b> ${escapeHtml(t.title)} (<i>${t.status}</i>)`);
                }
                lines.push('\n🌐 Dashboard: <code>http://localhost:3141/?token=admin</code>');
                await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
                break;
            }
            case 'mission.task.create': {
                const text = msg.action?.params?.text;
                if (!text) {
                    await ctx.reply('ℹ️ Usage: <code>/task &lt;title or instruction&gt;</code>\n\nExample: <code>/task Refactor database queries and run tests</code>', { parse_mode: 'HTML' });
                    break;
                }
                const db = require('./Database').getDatabase();
                const activeAgent = this.sessionStore.getActiveAgent(msg.chatId) || 'antigravity';
                const task = db.createMissionTask({
                    title: text.length > 60 ? text.slice(0, 57) + '...' : text,
                    prompt: text,
                    assignedAgent: activeAgent,
                    createdBy: 'telegram',
                });
                await ctx.reply(`📋 <b>Task Created:</b> <code>${task.id}</code>\nAssigned to: <b>${activeAgent}</b>\nStatus: <i>queued</i>\n\nView in Mission Control:\n<code>http://localhost:3141/?token=admin</code>`, { parse_mode: 'HTML' });
                break;
            }
            case 'hive.show': {
                const db = require('./Database').getDatabase();
                const entries = db.getHiveMindEntries({ limit: 6 });
                if (!entries.length) {
                    await ctx.reply('🐝 <b>Hive Mind Blackboard:</b>\n\nNo delegation actions recorded yet.', { parse_mode: 'HTML' });
                    break;
                }
                const lines = ['🐝 <b>Recent Hive Mind Delegations:</b>\n'];
                for (const e of entries) {
                    const time = new Date(e.created_at).toLocaleTimeString();
                    lines.push(`• <b>[${e.agent_id}]</b> <i>${escapeHtml(e.action)}</i> (${time})\n  ${escapeHtml(e.summary)}`);
                }
                await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
                break;
            }
            case 'learn.run': {
                await ctx.reply('🧠 <b>Self-Improvement Review:</b>\nAnalyzing recent execution logs and discipline metrics...', { parse_mode: 'HTML' });
                const SelfImprovementEngine = require('./SelfImprovement');
                const db = require('./Database').getDatabase();
                const engine = new SelfImprovementEngine({ database: db, sessionStore: this.sessionStore, baseDir: config.baseDir });
                const report = await engine.evaluateAndLearn(msg.chatId);
                const testStatus = report.testsPassed ? '✅ All tests passed' : '⚠️ Test verification failed';
                await ctx.reply(
                    `🎓 <b>Self-Improvement Report:</b>\n\n` +
                    `• Analyzed turns: <b>${report.analyzedTurns}</b>\n` +
                    `• Discipline Score: <b>${report.disciplineScore}/100</b>\n` +
                    `• Regression Gate: <b>${testStatus}</b>\n\n` +
                    `<b>Learned Insights:</b>\n` +
                    (report.promotedRules.length ? report.promotedRules.map(r => `• <i>${escapeHtml(r)}</i>`).join('\n') : '• No new rules required.') +
                    `\n\n<i>Rules promoted to persistent shared memories.</i>`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'concurrency.set':
            case 'concurrency.show': {
                const limitArg = msg.action?.params?.limit;
                if (limitArg) {
                    const parsed = parseInt(limitArg, 10);
                    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 16) {
                        globalAgentPool.setMaxConcurrent(parsed);
                        await ctx.reply(
                            `⚡ <b>Agent Concurrency Pool Updated:</b>\n\n` +
                            `Max simultaneous agents set to: <b>${parsed}</b>\n` +
                            `Tasks exceeding this limit will queue automatically by priority.`,
                            { parse_mode: 'HTML' }
                        );
                        break;
                    }
                    await ctx.reply('⚠️ Please provide a valid number between 1 and 16. Example: <code>/concurrency 4</code>', { parse_mode: 'HTML' });
                    break;
                }
                const st = globalAgentPool.getStatus();
                const runningDetails = st.activeTasks.length
                    ? st.activeTasks.map(t => `  • <b>[${t.agentKey}]</b> ${escapeHtml(t.description)} (${Math.round(t.elapsedMs / 1000)}s)`).join('\n')
                    : '  <i>No agents currently running</i>';

                await ctx.reply(
                    `⚡ <b>Agent Concurrency & Resource Pool:</b>\n\n` +
                    `• Max Concurrent Agents: <b>${st.maxConcurrent}</b>\n` +
                    `• Active Running: <b>${st.runningCount}</b> / ${st.maxConcurrent}\n` +
                    `• Queued Waiting: <b>${st.queuedCount}</b>\n` +
                    `• Memory: <b>${st.memory.freeGB} GB free</b> of ${st.memory.totalGB} GB (${st.memory.usedPercent}% used)\n\n` +
                    `<b>Active Agents:</b>\n${runningDetails}\n\n` +
                    `<i>Change pool limit anytime with:</i> <code>/concurrency &lt;number&gt;</code>`,
                    { parse_mode: 'HTML' }
                );
                break;
            }
            case 'session.resume.show': {
                const filter = msg.action?.params?.filter || this.sessionStore.getActiveAgent(msg.chatId) || 'all';
                await this._sendResumeSelector(ctx, msg.chatId, { filter, page: 0 });
                break;
            }
            case 'session.resume.last': {
                await this._resumeLastSession(ctx, msg.chatId);
                break;
            }
            case 'session.resume.select': {
                const token = msg.action?.params?.token;
                const chatId = msg.chatId;
                if (token === 'last') {
                    await this._resumeLastSession(ctx, chatId);
                    break;
                }
                if (typeof token === 'string' && token.startsWith('p:')) {
                    const page = Number(token.slice(2));
                    const state = this.resumeLists.get(chatId) || {};
                    await this._sendResumeSelector(ctx, chatId, { filter: state.filter || 'all', page: Number.isFinite(page) ? page : 0 });
                    break;
                }
                if (typeof token === 'string' && token.startsWith('a:')) {
                    await this._sendResumeSelector(ctx, chatId, { filter: token.slice(2) || 'all', page: 0 });
                    break;
                }
                if (typeof token === 'string' && token.startsWith('i:')) {
                    const idx = Number(token.slice(2));
                    const state = this.resumeLists.get(chatId);
                    const record = state?.items?.[idx];
                    if (!record) {
                        await ctx.reply('ℹ️ That session list expired. Send /resume again.');
                        break;
                    }
                    await this._attachCliSession(ctx, chatId, record);
                    break;
                }
                break;
            }
            case 'screen.capture': {
                try {
                    // 1. If a remote Windows satellite is online, delegate to it
                    if (globalSatelliteHub.hasOnlineSatellite()) {
                        await ctx.reply('📡 Requesting screenshot from Windows satellite worker...');
                        const res = await globalSatelliteHub.dispatch('screen.capture', { format: 'png' }, { timeoutMs: 15000 });
                        if (res && res.base64) {
                            const img = Buffer.from(res.base64, 'base64');
                            await ctx.replyWithPhoto({ source: img }, { caption: `🖥️ Windows Desktop (${res.hostname || 'Satellite'})` });
                            break;
                        }
                    }

                    // 2. Standalone local fallback (e.g. bot running directly on Windows)
                    if (process.platform === 'win32') {
                        const screenshot = require('screenshot-desktop');
                        const img = await screenshot({ format: 'png' });
                        await ctx.replyWithPhoto({ source: img }, { caption: '🖥️ Local Screenshot' });
                    } else {
                        await ctx.reply('⚠️ Headless VPS: No local desktop display session.\nWindows satellite worker is currently offline.\n\nTo capture your Windows screen, start the satellite on your PC:\n`node satellite/desktop-worker.js`', { parse_mode: 'Markdown' });
                    }
                } catch (e) {
                    await ctx.reply(`❌ Screenshot failed: ${e.message}`);
                }
                break;
            }
            case 'pc.lock': {
                try {
                    // 1. If a remote Windows satellite is online, delegate lock command
                    if (globalSatelliteHub.hasOnlineSatellite()) {
                        await ctx.reply('🔒 Sending lock command to Windows satellite...');
                        const res = await globalSatelliteHub.dispatch('pc.lock', {}, { timeoutMs: 10000 });
                        await ctx.reply(`🔒 Windows PC locked via satellite (${res.hostname || 'desktop'}).`);
                        break;
                    }

                    // 2. Standalone local fallback
                    const platform = require('os').platform();
                    if (platform === 'win32') {
                        const { execSync } = require('child_process');
                        try {
                            const qwinsta = execSync('qwinsta').toString();
                            const activeSessionLine = qwinsta.split('\n').find(line => 
                                line.toLowerCase().includes('active') && !line.toLowerCase().includes('services')
                            );
                            if (activeSessionLine) {
                                const match = activeSessionLine.match(/\s+(\d+)\s+/);
                                if (match && match[1]) {
                                    execSync(`tsdiscon.exe ${match[1]}`);
                                    await ctx.reply('🔒 PC locked (active session disconnected).');
                                    break;
                                }
                            }
                            execSync('tsdiscon.exe');
                            await ctx.reply('🔒 PC locked (session disconnected).');
                        } catch (err) {
                            execSync('rundll32.exe user32.dll,LockWorkStation');
                            await ctx.reply('🔒 PC locked.');
                        }
                    } else if (platform === 'darwin') {
                        require('child_process').execSync('pmset displaysleepnow');
                        await ctx.reply('🔒 Mac locked.');
                    } else {
                        try {
                            require('child_process').execSync('loginctl lock-session 2>/dev/null || xdg-screensaver lock 2>/dev/null');
                            await ctx.reply('🔒 Session locked.');
                        } catch {
                            await ctx.reply('ℹ️ Headless Linux/VPS environment — no active desktop display session to lock.\nTo lock your physical PC, start the Windows satellite worker.');
                        }
                    }
                } catch (e) {
                    await ctx.reply(`❌ Lock failed: ${e.message}`);
                }
                break;
            }
            case 'satellite.exec': {
                try {
                    const command = params.command || params.text;
                    if (!command) {
                        await ctx.reply('Usage: `/win <command>`\nExample: `/win dir C:\\`', { parse_mode: 'Markdown' });
                        break;
                    }
                    if (!globalSatelliteHub.hasOnlineSatellite()) {
                        await ctx.reply('⚠️ No Windows satellite worker connected.\nTo connect your Windows machine, run:\n`node satellite/desktop-worker.js`', { parse_mode: 'Markdown' });
                        break;
                    }
                    await ctx.reply(`⏳ Running on Windows PC: \`${command}\`...`, { parse_mode: 'Markdown' });
                    const res = await globalSatelliteHub.dispatch('cmd.exec', { command }, { timeoutMs: 30000 });
                    const output = (res.stdout || res.stderr || '(No output returned)').trim();
                    const formatted = output.length > 3500 ? output.slice(0, 3500) + '\n...[truncated]' : output;
                    await ctx.reply(`🖥️ *Windows Satellite (${res.hostname})*:\n\`\`\`\n${formatted}\n\`\`\``, { parse_mode: 'Markdown' });
                } catch (e) {
                    await ctx.reply(`❌ Remote execution failed: ${e.message}`);
                }
                break;
            }
            case 'satellite.status': {
                try {
                    const status = globalSatelliteHub.getStatus();
                    if (status.satellites.length === 0) {
                        await ctx.reply('📡 *Satellite Workers*\nNo satellites registered yet.\n\nTo connect your Windows PC, run:\n`node satellite/desktop-worker.js`', { parse_mode: 'Markdown' });
                        break;
                    }
                    let reply = `📡 *Satellite Workers (${status.onlineCount}/${status.totalRegistered} Online)*\n\n`;
                    for (const sat of status.satellites) {
                        const icon = sat.online ? '🟢' : '🔴';
                        reply += `${icon} *${sat.hostname}* (\`${sat.id}\`)\n`;
                        reply += `   Platform: ${sat.platform} | IP: \`${sat.ip}\`\n`;
                        reply += `   Status: ${sat.online ? 'Online' : `Offline (last seen ${sat.lastSeenSecondsAgo}s ago)`}\n`;
                        if (sat.systemInfo && sat.systemInfo.totalMemMb) {
                            reply += `   RAM: ${sat.systemInfo.freeMemMb}MB free / ${sat.systemInfo.totalMemMb}MB\n`;
                        }
                        reply += '\n';
                    }
                    await ctx.reply(reply, { parse_mode: 'Markdown' });
                } catch (e) {
                    await ctx.reply(`❌ Failed getting satellite status: ${e.message}`);
                }
                break;
            }
            default:
                console.warn(`[ActionExecutor] Unknown action: ${actionName}`);
        }
    }

    async _sendAgentSelector(ctx, chatId) {
        const currentAgent = this.sessionStore.getActiveAgent(chatId);
        const buttons = Object.entries(this.agents).map(([key, agent]) => {
            const active = key === currentAgent ? '✓ ' : '';
            return [Markup.button.callback(`${active}${agent.emoji} ${agent.name}`, `agent:${key}`)];
        });
        await ctx.reply('🤖 Select an agent:', Markup.inlineKeyboard(buttons));
    }

    async _sendReasoningSelector(ctx, chatId, { model = null, modelChanged = false } = {}) {
        const activeKey = this.sessionStore.getActiveAgent(chatId);
        const modelId = model?.id || this.sessionStore.getActiveModel(activeKey, chatId) || 'default';
        const selectedModel = model || this.sessionStore.getAvailableModels(activeKey).find(item => item.id === modelId);
        if (!selectedModel?.reasoningEfforts?.length) {
            await ctx.reply(`ℹ️ No reasoning-effort metadata is available for <code>${escapeHtml(modelId)}</code>. For Codex, tap Scan Latest Models first.`, { parse_mode: 'HTML' });
            return;
        }
        const current = this.sessionStore.getReasoningEffort(activeKey, modelId, chatId);
        const options = ['auto', ...selectedModel.reasoningEfforts];
        const rows = [];
        for (let i = 0; i < options.length; i += 3) {
            rows.push(options.slice(i, i + 3).map(effort => {
                const active = effort === 'auto' ? !current : current === effort;
                const label = effort === 'auto'
                    ? `Auto (${selectedModel.autoReasoningEffort || selectedModel.defaultReasoningEffort || 'CLI'})`
                    : effort.toUpperCase();
                return Markup.button.callback(`${active ? '✓ ' : ''}${label}`, `effort:${effort}`);
            }));
        }
        const intro = modelChanged ? `✅ Model set; fresh session started.\n` : '';
        await ctx.reply(
            `${intro}🧠 <b>Reasoning effort</b> for <code>${escapeHtml(modelId)}</code>\n` +
            `Current: <code>${escapeHtml(current || `auto (${selectedModel.autoReasoningEffort || selectedModel.defaultReasoningEffort || 'CLI'})`)}</code>\n\n` +
            `Choose only from the levels this model supports:`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
        );
    }

    async _collectSessions(filterAgent) {
        const keys = filterAgent && filterAgent !== 'all'
            ? [filterAgent]
            : ['grok', 'claude', 'codex', 'antigravity'];
        const lists = await Promise.all(keys.map(async (key) => {
            const agent = this.agents[key];
            if (agent && typeof agent.listSessions === 'function') {
                try { return await agent.listSessions(12); }
                catch (e) {
                    console.warn(`[ActionExecutor] listSessions ${key}: ${e.message}`);
                    return [];
                }
            }
            return [];
        }));
        return lists.flat();
    }

    async _attachCliSession(ctx, chatId, record) {
        const agent = this.agents[record.agent];
        if (!agent) {
            await ctx.reply(`❌ Agent ${record.agent} is not registered.`);
            return;
        }
        this.sessionStore.setActiveAgent(record.agent, chatId);
        this.sessionStore.setSession(record.agent, record.id, chatId, { cwd: record.cwd || null });
        if (record.cwd) this.sessionStore.setChatCwd(chatId, record.cwd);
        if (typeof agent.attachSession === 'function') {
            agent.attachSession(chatId, record.id, { cwd: record.cwd || null });
        }
        this._warmAgent(agent);
        const shortId = String(record.id).slice(0, 8);
        const cwd = this.sessionStore.getWorkspaceCwd(record.agent, chatId);
        await ctx.reply(
            `🔗 Attached ${agent.emoji} <b>${escapeHtml(agent.name)}</b> to CLI session\n` +
            `<code>${escapeHtml(record.id)}</code>\n` +
            `${escapeHtml(record.title || '')}\n` +
            `Folder: <code>${escapeHtml(cwd)}</code>\n\n` +
            `Your next message continues that thread (${shortId}…).`,
            { parse_mode: 'HTML' }
        );
    }

    async _resumeLastSession(ctx, chatId) {
        const active = this.sessionStore.getActiveAgent(chatId);
        const items = await this._collectSessions(active);
        if (!items.length) {
            await ctx.reply(`ℹ️ No saved ${active} CLI sessions found. Work in that CLI first, then /resume.`);
            return;
        }
        await this._attachCliSession(ctx, chatId, items[0]);
    }

    async _sendResumeSelector(ctx, chatId, { filter = 'all', page = 0 } = {}) {
        const items = await this._collectSessions(filter);
        this.resumeLists.set(chatId, { items, filter, page });
        if (!items.length) {
            await ctx.reply('ℹ️ No CLI sessions found for that agent. Start one in the terminal, then /resume.');
            return;
        }
        const totalPages = Math.max(1, Math.ceil(items.length / RESUME_PAGE_SIZE));
        const safePage = Math.min(Math.max(0, page), totalPages - 1);
        const start = safePage * RESUME_PAGE_SIZE;
        const slice = items.slice(start, start + RESUME_PAGE_SIZE);
        const lines = slice.map((item, offset) => {
            const agent = this.agents[item.agent] || { emoji: '🤖', name: item.agent };
            const idx = start + offset;
            const cwd = item.cwd ? `\n   <code>${escapeHtml(item.cwd)}</code>` : '';
            return `${idx + 1}. ${agent.emoji} <code>${escapeHtml(String(item.id).slice(0, 8))}</code> ${escapeHtml(item.title || '')}${cwd}`;
        });
        const rows = [];
        let row = [];
        slice.forEach((item, offset) => {
            const idx = start + offset;
            const agent = this.agents[item.agent] || { emoji: '🤖' };
            let label = `${agent.emoji} ${(item.title || item.id).slice(0, 22)}`;
            row.push(Markup.button.callback(label, `resume:i:${idx}`));
            if (row.length === 2) { rows.push(row); row = []; }
        });
        if (row.length) rows.push(row);
        const nav = [];
        if (safePage > 0) nav.push(Markup.button.callback('⬅️ Prev', `resume:p:${safePage - 1}`));
        nav.push(Markup.button.callback(`📄 ${safePage + 1}/${totalPages}`, `resume:p:${safePage}`));
        if (safePage < totalPages - 1) nav.push(Markup.button.callback('Next ➡️', `resume:p:${safePage + 1}`));
        if (nav.length) rows.push(nav);
        rows.push([
            Markup.button.callback(filter === 'all' ? '✓ All' : 'All', 'resume:a:all'),
            Markup.button.callback(filter === 'grok' ? '✓ Grok' : 'Grok', 'resume:a:grok'),
            Markup.button.callback(filter === 'claude' ? '✓ Claude' : 'Claude', 'resume:a:claude'),
        ]);
        rows.push([
            Markup.button.callback(filter === 'codex' ? '✓ Codex' : 'Codex', 'resume:a:codex'),
            Markup.button.callback(filter === 'antigravity' ? '✓ Agy' : 'Agy', 'resume:a:antigravity'),
            Markup.button.callback('⏩ Latest', 'resume:last'),
        ]);
        const html =
            `🔗 <b>Resume a CLI session</b>\n` +
            `Filter: <code>${escapeHtml(filter)}</code> · ${items.length} found\n\n` +
            `${lines.join('\n')}\n\n` +
            `Pick a session. The next Telegram message continues that CLI thread.`;
        const keyboard = Markup.inlineKeyboard(rows);
        try {
            if (ctx.callbackQuery && typeof ctx.editMessageText === 'function') {
                await ctx.editMessageText(html, { parse_mode: 'HTML', ...keyboard });
                return;
            }
            await ctx.reply(html, { parse_mode: 'HTML', ...keyboard });
        } catch (err) {
            console.warn('[ActionExecutor] Resume selector HTML failed:', err.message);
            await ctx.reply(html.replace(/<[^>]+>/g, ''), keyboard).catch(() => {});
        }
    }

    async _sendHandoff(ctx, chatId) {
        const memories = this.sessionStore.getMemories().trim();
        const turns = this.sessionStore.getRecentTurns(chatId);
        const memoryLines = isEmptyMemories(memories)
            ? 'None yet. Use /remember <fact> to save one for every agent.'
            : memories.length > 1200 ? memories.slice(0, 1200) + '...' : memories;
        const turnLines = turns.length
            ? turns.map((turn) => {
                const name = turn.agentName || turn.agent || 'agent';
                const user = String(turn.userText || '').slice(0, 180);
                const assistant = String(turn.assistantText || '').slice(0, 180);
                return `• ${name}\n  You: ${user}\n  Agent: ${assistant}`;
            }).join('\n')
            : 'No recent chat turns stored yet.';

        await ctx.reply(
            `🧠 <b>Shared context (all agents)</b>\n\n` +
            `<b>Persistent memories</b>\n<pre>${escapeHtml(memoryLines)}</pre>\n\n` +
            `<b>Recent turns</b>\n<pre>${escapeHtml(turnLines)}</pre>\n\n` +
            `Switching agents keeps this context. /new clears recent turns but keeps memories.`,
            { parse_mode: 'HTML' }
        );
        await this._sendAgentSelector(ctx, chatId);
    }

    async _discoverModelsQuick(agent, { force = false } = {}) {
        if (!agent || typeof agent.discoverModels !== 'function') return;
        let timer;
        try {
            await Promise.race([
                agent.discoverModels({ force }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('model discovery timed out')), MODEL_DISCOVERY_WAIT_MS);
                    if (timer.unref) timer.unref();
                }),
            ]);
        } catch (e) {
            console.warn(`[ActionExecutor] Model discovery failed for ${agent.key || agent.name}:`, e.message);
        } finally {
            clearTimeout(timer);
        }
    }

    async _sendModelSelector(ctx, chatId, page = 0, { discover = true } = {}) {
        const activeKey = this.sessionStore.getActiveAgent(chatId);
        const agent = this.agents[activeKey] || { name: activeKey, emoji: '🤖', key: activeKey };

        if (discover) await this._discoverModelsQuick(agent);

        const availableModels = this.sessionStore.getAvailableModels(activeKey);
        const currentModel = this.sessionStore.getActiveModel(activeKey, chatId) || 'default';

        if (!availableModels || availableModels.length === 0) {
            const msgText = `ℹ️ ${agent.emoji || '🤖'} ${agent.name || activeKey} does not have a model list yet.\nType /model <id> to set one manually.`;
            await ctx.reply(msgText).catch(e => console.error('[ActionExecutor] Empty model selector failed:', e.message));
            return;
        }

        const view = buildModelSelectorView(
            availableModels, currentModel, page, MODEL_PAGE_SIZE, agent.modelControl?.discovery || 'static'
        );
        const pageModels = availableModels.slice(view.start, view.start + MODEL_PAGE_SIZE);
        const listLines = pageModels.map((model, offset) => {
            const mark = model.id === currentModel ? '👉 ' : '• ';
            return `${mark}<code>${escapeHtml(model.id)}</code>`;
        });
        const html =
            `🧠 Models for ${agent.emoji || '🤖'} <b>${escapeHtml(agent.name || activeKey)}</b>\n` +
            `Current: <code>${escapeHtml(currentModel)}</code>\n` +
            `Page ${view.page + 1}/${view.totalPages} (${availableModels.length} models)\n\n` +
            `${listLines.join('\n')}\n\n` +
            `Tap a button or type /model &lt;id&gt;`;

        const keyboard = Markup.inlineKeyboard(
            view.buttons.map(row => row.map(btn => Markup.button.callback(btn.text, btn.callback_data)))
        );

        try {
            if (ctx.callbackQuery && typeof ctx.editMessageText === 'function') {
                await ctx.editMessageText(html, { parse_mode: 'HTML', ...keyboard });
                return;
            }
            await ctx.reply(html, { parse_mode: 'HTML', ...keyboard });
        } catch (err) {
            console.warn('[ActionExecutor] HTML model selector failed, sending plain text:', err.message);
            const plain =
                `Models for ${agent.name || activeKey}\n` +
                `Current: ${currentModel}\n` +
                `Page ${view.page + 1}/${view.totalPages}\n\n` +
                pageModels.map(model => `${model.id === currentModel ? '-> ' : '- '}${model.id}`).join('\n') +
                `\n\nType /model <id> to switch.`;
            try {
                if (ctx.callbackQuery && typeof ctx.editMessageText === 'function') {
                    await ctx.editMessageText(plain, keyboard);
                    return;
                }
                await ctx.reply(plain, keyboard);
            } catch (err2) {
                await ctx.reply(plain).catch(e => console.error('[ActionExecutor] Plain model selector failed:', e.message));
            }
        }
    }

    requestToolApproval(agentKey, toolName, toolParams, chatId, rawCtx) {
        const reqId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.pendingToolApprovals.delete(reqId);
                resolve(false); // auto-deny on 2 min timeout
            }, config.toolApprovalTimeoutMs);

            this.pendingToolApprovals.set(reqId, { resolve, timeout });

            const agent = this.agents[agentKey] || { name: agentKey, emoji: '🤖' };
            const detailsStr = typeof toolParams === 'string' ? toolParams : JSON.stringify(toolParams || {}, null, 2);
            const text = `⚠️ <b>Tool Permission Request</b>\n\n` +
                         `Agent: ${escapeHtml(agent.emoji)} <b>${escapeHtml(agent.name)}</b>\n` +
                         `Tool: <code>${escapeHtml(toolName)}</code>\n` +
                         `Details: <pre>${escapeHtml(detailsStr.slice(0, 500))}</pre>`;

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Approve', `tool_auth:approve:${reqId}`),
                    Markup.button.callback('❌ Deny', `tool_auth:deny:${reqId}`)
                ]
            ]);

            rawCtx.reply(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
        });
    }

    async _sendHelp(ctx) {
        const agentList = Object.values(this.agents)
            .map(agent => `${agent.emoji} ${agent.name}`)
            .join(', ');
        const lines = [
            '📖 *Commands*',
            '',
            `Agents: ${agentList || 'none registered'}`,
            '',
            '🤖 Agent — Switch AI agent',
            '🆕 New Chat — Clear session',
            '📊 Status — Show bot info',
            '🧠 Memory — View persistent memories',
            '❓ Help — This menu',
            '',
            '/agent — Switch agent',
            '/model \\<name\\> — Set model',
            '/effort [level|auto] — Set model reasoning depth',
            '/new — New session (clears active agent thread)',
            '/resume — Attach a CLI session (Grok/Claude/Codex/agy)',
            '/resume_last — Attach the latest CLI session for this agent',
            '/cwd — Show or set the working folder',
            '!command — Run a shell command directly (bypasses the AI)',
            '!jobs — List managed shell jobs',
            '!status [id] — Check a shell job',
            '!tail [id] — Show recent job output',
            '!stop [id] — Stop a shell job',
            '/kanban — Show Mission Control tasks',
            '/task \\<prompt\\> — Queue task in Mission Control',
            '/concurrency [N] — View or set max simultaneous agents',
            '/hive — View Hive Mind inter-agent activity',
            '/learn — Run self-improvement discipline check',
            '/memory — View shared memories (all agents)',
            '/remember \\<fact\\> — Save a fact for every agent',
            '/forget — Clear shared memories',
            '/status — Bot status',
            '/voice — Toggle TTS',
            '/cost — Token usage',
            '/screen — Screenshot',
            '/lock — Lock session',
            '/win <command> — Run command on Windows PC (via Satellite)',
            '/satellite — Status of connected satellite workers',
            '/handoff — Show shared context and switch agent',
            '/restart — Restart bridge daemon',
        ];
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    }

    setShellNotifier(sendMessage) {
        this.shellJobs.setNotifier((job) => this._sendShellJobResult(
            job,
            (text, options) => sendMessage(job.chatId, text, options),
            true
        ));
    }

    _resolveShellJob(chatId, jobId) {
        return jobId ? this.shellJobs.get(jobId, chatId) : this.shellJobs.latest(chatId);
    }

    _shellStatusLabel(job) {
        if (job.state === 'completed') return '✅ completed';
        if (job.state === 'running' || job.state === 'starting') return '⏳ running';
        if (job.state === 'stopped') return '🛑 stopped';
        return '❌ failed';
    }

    async _sendShellJobResult(job, send, automatic = false) {
        const refreshed = await this.shellJobs.refresh(job) || job;
        const status = this._shellStatusLabel(refreshed);
        const exit = refreshed.exitCode === null ? '' : ` · exit ${refreshed.exitCode}`;
        const output = stripAnsi(await this.shellJobs.tail(refreshed, config.shellCommandMaxOutputBytes)) || '(no output)';
        const chunks = splitMessage(output, 3400);
        for (let i = 0; i < chunks.length; i++) {
            const heading = i === 0
                ? `${automatic ? '🔔 ' : ''}${status}${exit} · job <code>${refreshed.id}</code>\n<code>${escapeHtml(refreshed.cwd)}</code>\n`
                : '';
            await send(`${heading}<pre>${escapeHtml(chunks[i])}</pre>`, { parse_mode: 'HTML' });
        }
    }

    async _handleShellControl(ctx, chatId, control) {
        if (control.name === 'jobs') {
            const jobs = this.shellJobs.list(chatId, 10);
            if (!jobs.length) {
                await ctx.reply('ℹ️ No managed shell jobs for this chat.');
                return;
            }
            await Promise.all(jobs.map(job => this.shellJobs.refresh(job)));
            const lines = jobs.map(job => {
                const elapsed = formatElapsed(job.startedAt, job.finishedAt || Date.now());
                return `${this._shellStatusLabel(job)} <code>${job.id}</code> · ${elapsed}\n<code>${escapeHtml(clipText(job.command, 120))}</code>`;
            });
            await ctx.reply(`💻 <b>Shell jobs</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
            return;
        }

        const job = this._resolveShellJob(chatId, control.jobId);
        if (!job) {
            await ctx.reply(control.jobId
                ? `❌ Job not found: <code>${escapeHtml(control.jobId)}</code>`
                : 'ℹ️ No managed shell jobs for this chat.', { parse_mode: 'HTML' });
            return;
        }

        if (control.name === 'stop') {
            await this.shellJobs.stopJob(job);
            await ctx.reply(`🛑 Stopped job <code>${job.id}</code>.`, { parse_mode: 'HTML' });
            return;
        }

        await this.shellJobs.refresh(job);
        if (control.name === 'tail') {
            const output = stripAnsi(await this.shellJobs.tail(job, config.shellCommandMaxOutputBytes)) || '(no output yet)';
            const chunks = splitMessage(output, 3500);
            for (let i = 0; i < chunks.length; i++) {
                const heading = i === 0 ? `📄 Job <code>${job.id}</code> · ${this._shellStatusLabel(job)}\n` : '';
                await ctx.reply(`${heading}<pre>${escapeHtml(chunks[i])}</pre>`, { parse_mode: 'HTML' });
            }
            return;
        }

        const elapsed = formatElapsed(job.startedAt, job.finishedAt || Date.now());
        const exit = job.exitCode === null ? '—' : job.exitCode;
        const tail = stripAnsi(await this.shellJobs.tail(job, 2500)) || '(no output yet)';
        await ctx.reply(
            `${this._shellStatusLabel(job)} · job <code>${job.id}</code>\n` +
            `Elapsed: <code>${elapsed}</code> · Exit: <code>${exit}</code>\n` +
            `Folder: <code>${escapeHtml(job.cwd)}</code>\n` +
            `Command: <code>${escapeHtml(clipText(job.command, 500))}</code>\n\n` +
            `<pre>${escapeHtml(tail)}</pre>`,
            { parse_mode: 'HTML' }
        );
    }

    async _sendStatus(ctx, chatId) {
        const activeKey = this.sessionStore.getActiveAgent(chatId);
        const agent = this.agents[activeKey];
        const usage = this.sessionStore.getUsage(activeKey);
        const session = this.sessionStore.getSession(activeKey, chatId);
        const model = this.sessionStore.getActiveModel(activeKey, chatId) || 'default';
        const cwd = this.sessionStore.getWorkspaceCwd(activeKey, chatId);

        const lines = [
            '🤖 *Bot Status*', '',
            `Agent: ${agent.emoji} ${agent.name}`,
            `Model: \`${model}\``,
            `Session: \`${session ? session.substring(0, 12) + '...' : 'none'}\``,
            `Folder: \`${cwd}\``,
            `Voice: ${this.sessionStore.getVoiceMode() ? 'ON 🗣️' : 'OFF 🔇'}`,
            `Processing: ${this.isProcessing ? 'Yes ⏳' : 'Idle ✅'}`,
            `Queue: ${(this.queues.get(chatId)?.length || 0)} pending in this chat`,
            '', '📊 *Usage*',
            `Requests: ${usage.totalRequests}`,
            `Tokens: ${usage.totalInputTokens.toLocaleString()} in / ${usage.totalOutputTokens.toLocaleString()} out`,
        ];
        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    }

    get isProcessing() { return this.active.size > 0; }
    get queue() { return [...this.queues.values()].flat(); }

    _getAgent(agentKey, chatId) {
        return this.agents[agentKey] || null;
    }

    // --- Per-chat queues: slow work in one chat never blocks another chat ---
    _enqueue(unifiedMessage) {
        if (unifiedMessage.chatId && unifiedMessage.content?.type !== 'action') {
            this.lastMessages.set(unifiedMessage.chatId, unifiedMessage);
        }
        const chatId = unifiedMessage.chatId || '__unknown__';
        const queue = this.queues.get(chatId) || [];
        queue.push(unifiedMessage);
        this.queues.set(chatId, queue);
        if (queue.length > config.queueNoticeThreshold) {
            unifiedMessage.raw.reply(`📥 Queued for this chat (position #${queue.length})`).catch(() => {});
        }
        this._processChat(chatId);
    }

    async _processChat(chatId) {
        if (this.active.has(chatId)) return;
        const queue = this.queues.get(chatId);
        if (!queue || queue.length === 0) return;

        const nextMsg = queue[0];
        const agentKey = this.sessionStore.getActiveAgent(nextMsg.chatId);
        if (this.runningAgents && this.runningAgents.has(agentKey)) {
            // Agent instance is busy with another chat, wait until turn finishes
            return;
        }

        // Check global pool limit
        if (globalAgentPool.running.size >= globalAgentPool.maxConcurrent) {
            return;
        }

        const msg = queue.shift();
        if (queue.length === 0) this.queues.delete(chatId);
        if (!this.runningAgents) this.runningAgents = new Set();
        this.runningAgents.add(agentKey);

        const ctx = msg.raw;
        const state = {
            chatId, ctx, msg, responseText: '', statusText: '⏳ Thinking...', thinkingMsgId: null,
            lastEdit: 0, pendingTimer: null, agentKey,
            requestId: `${chatId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        };
        this.active.set(chatId, state);
        globalAgentPool.acquire(state.requestId, { agentKey, priority: 1, description: `Chat ${chatId}` });

        const agent = this._getAgent(state.agentKey, chatId);
        if (!agent) {
            await ctx.reply('❌ No agent configured.');
            this._cleanup(state);
            return;
        }

        // Track usage
        this.sessionStore.trackRequest(state.agentKey);

        // Typing + placeholder run in parallel with the agent so Telegram RTT
        // is not on the critical path.
        if (typeof ctx?.sendChatAction === 'function') {
            ctx.sendChatAction('typing').catch(() => {});
            state.typingTimer = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), config.typingRefreshIntervalMs);
            if (state.typingTimer.unref) state.typingTimer.unref();
        }
        if (typeof ctx?.reply === 'function') {
            state.thinkingPromise = ctx.reply(
                `${agent.emoji} ${agent.name}\n\n⏳ Thinking...`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🛑 Stop', 'action:stop')]
                ])
            ).then((thinkingMsg) => {
                if (thinkingMsg) state.thinkingMsgId = thinkingMsg.message_id;
            }).catch(e => {
                console.error('[ActionExecutor] Failed to send thinking placeholder:', e.message);
            });
        }

        // Send message to agent
        try {
            if (typeof agent.ensureRunning === 'function') {
                await agent.ensureRunning();
            } else if (!agent.isWarm) {
                await agent.initialize();
                await agent.start();
            }
            if (typeof agent.setRequestContext === 'function') agent.setRequestContext(state.requestId);
            // Set 15-minute hard timeout to kill agent process if it hangs
            state.agentTimeout = setTimeout(() => {
                const childProc = agent._headlessProc || agent.child || agent.process;
                if (childProc) {
                    console.error(`[ActionExecutor] Agent process timeout (${config.agentTimeoutMs} ms) — force-killing.`);
                    try { childProc.kill('SIGKILL'); } catch (e) {}
                }
            }, config.agentTimeoutMs);

            const hasSession = Boolean(this.sessionStore.getSession(state.agentKey, chatId));
            const allTurns = this.sessionStore.getRecentTurns(chatId);
            const lastTurn = allTurns[allTurns.length - 1];
            const switched = Boolean(lastTurn && lastTurn.agent && lastTurn.agent !== state.agentKey);
            const outbound = {
                ...msg,
                content: {
                    ...msg.content,
                    text: buildSharedPrompt(msg.content?.text, {
                        memories: this.sessionStore.getMemories(),
                        recentTurns: (!hasSession || switched) ? allTurns : [],
                        pendingNotes: this.sessionStore.getPendingMemories(chatId),
                        hasExistingSession: hasSession,
                        maxTurns: hasSession ? 1 : 2,
                    }),
                },
            };
            await agent.sendMessage(outbound);
        } catch (e) {
            console.error(`[ActionExecutor] Agent error: ${e.message}`);
            // Error recovery keyboard
            await ctx.reply(`❌ Error: ${e.message}`, Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Retry', 'action:retry'),
                 Markup.button.callback('🆕 New Session', 'session:new')],
            ])).catch(() => {});
            this._cleanup(state);
        }
    }

    // --- Stream Event Handlers ---

    _findState(event) {
        if (!event) return null;
        return [...this.active.values()].find(s => 
            s.agentKey === event.agentKey && event.requestId && s.requestId === event.requestId
        ) || [...this.active.values()].find(s => s.agentKey === event.agentKey);
    }

    /**
     * Handle streaming text chunks from the agent.
     * Throttle mechanism: edits the Telegram message every 500ms max.
     */
    _onStreamChunk(event) {
        const state = this._findState(event);
        if (!state) return;

        if (event.type === 'text' && event.text) {
            if (event.text.startsWith(state.responseText)) {
                state.responseText = event.text;
            } else {
                state.responseText += event.text;
            }
            state.statusText = '';
        }

        const throttleMs = config.streamUpdateIntervalMs || UPDATE_THROTTLE_MS;
        const now = Date.now();
        const delta = state.responseText.length - (state.lastEmittedLength || 0);
        if (delta < 32 && now - state.lastEdit < throttleMs) {
            clearTimeout(state.pendingTimer);
            state.pendingTimer = setTimeout(() => this._editThinkingMessage(state), throttleMs);
            if (state.pendingTimer.unref) state.pendingTimer.unref();
            return;
        }
        if (now - state.lastEdit >= throttleMs) {
            this._editThinkingMessage(state);
        } else {
            clearTimeout(state.pendingTimer);
            const delay = throttleMs - (now - state.lastEdit);
            state.pendingTimer = setTimeout(() => this._editThinkingMessage(state), delay);
            if (state.pendingTimer.unref) state.pendingTimer.unref();
        }
    }

    _onToolCall(event) {
        const state = this._findState(event);
        if (!state) return;
        state.statusText = `🛠️ ${event.toolName}...`;
        this._editThinkingMessage(state);
    }

    _onStatusChange(event) {
        const state = this._findState(event);
        if (state) state.statusText = event.message;
    }

    async _onFinished(event) {
        const state = this._findState(event);
        if (!state) return;

        // Clear any pending throttle timer
        clearTimeout(state.pendingTimer);
        if (state.thinkingPromise) await state.thinkingPromise.catch(() => {});

        const rawText = (event.finalText || state.responseText || '⚠️ No response.').trim();
        const truncated = globalTruncator.truncate(rawText, { maxLength: 12000, label: state.agentKey });
        const finalText = truncated.text;
        this.lastResponses.set(state.chatId, finalText);
        this.sessionStore.appendRecentTurn(state.chatId, {
            agent: state.agentKey,
            agentName: this.agents[state.agentKey]?.name || state.agentKey,
            userText: state.msg?.content?.text || '',
            assistantText: finalText,
        });
        this.sessionStore.clearPendingMemories(state.chatId);

        const chunks = splitMessage(finalText, 4000);
        const actionKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📋 Copy', 'action:copy'),
             Markup.button.callback('🔄 Regenerate', 'action:regenerate'),
             Markup.button.callback('💬 Continue', 'action:continue')],
        ]);

        let reusedPlaceholder = false;
        if (state.thinkingMsgId && chunks.length === 1 && state.ctx?.telegram?.editMessageText) {
            const htmlText = markdownToTelegramHtml(chunks[0]);
            try {
                await state.ctx.telegram.editMessageText(
                    state.ctx.chat?.id,
                    state.thinkingMsgId,
                    null,
                    htmlText,
                    { parse_mode: 'HTML', ...actionKeyboard }
                );
                reusedPlaceholder = true;
            } catch {
                try {
                    await state.ctx.telegram.editMessageText(
                        state.ctx.chat?.id,
                        state.thinkingMsgId,
                        null,
                        chunks[0],
                        actionKeyboard
                    );
                    reusedPlaceholder = true;
                } catch { /* fall through to delete + reply */ }
            }
        }

        if (!reusedPlaceholder) {
            if (state.thinkingMsgId && state.ctx?.telegram?.deleteMessage) {
                await state.ctx.telegram.deleteMessage(
                    state.ctx.chat?.id, state.thinkingMsgId
                ).catch(() => {});
            }
            for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                const keyboard = isLast ? actionKeyboard : {};
                const htmlText = markdownToTelegramHtml(chunks[i]);
                if (typeof state.ctx?.reply === 'function') {
                    await state.ctx.reply(htmlText, { parse_mode: 'HTML', ...keyboard }).catch(e => {
                        state.ctx.reply(chunks[i], keyboard).catch(() => {});
                        console.error('[ActionExecutor] Final reply failed:', e.message);
                    });
                }
            }
        }

        // Voice response generation (TTS)
        const voiceMode = this.sessionStore.getVoiceMode();
        if (voiceMode && finalText) {
            try {
                const googleTTS = require('google-tts-api');
                const ttsText = finalText
                    .replace(/```[\s\S]*?```/g, ' [code block] ')
                    .replace(/`([^`]+)`/g, '$1')
                    .replace(/[*#_~]/g, '')
                    .substring(0, 2000);
                
                if (ttsText.trim()) {
                    const results = googleTTS.getAllAudioUrls(ttsText, {
                        lang: 'en', slow: false, host: 'https://translate.google.com',
                    });
                    
                    for (const result of results) {
                        await state.ctx.replyWithAudio(result.url).catch(e => 
                            console.error(`[ActionExecutor] TTS Chunk Error: ${e.message}`)
                        );
                    }
                }
            } catch (e) {
                console.error('[ActionExecutor] Voice response failed:', e.message);
            }
        }

        this._cleanup(state);
    }

    async _onError(event) {
        const state = this._findState(event);
        if (!state) return;
        clearTimeout(state.pendingTimer);
        if (state.thinkingPromise) await state.thinkingPromise.catch(() => {});

        if (state.thinkingMsgId && state.ctx?.telegram?.deleteMessage) {
            await state.ctx.telegram.deleteMessage(
                state.ctx.chat?.id, state.thinkingMsgId
            ).catch(() => {});
        }

        // Error recovery keyboard
        if (typeof state.ctx?.reply === 'function') {
            await state.ctx.reply(`❌ Error: ${event.error}`, Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Retry', 'action:retry'),
                 Markup.button.callback('🆕 New Session', 'session:new')],
            ])).catch(() => {});
        }
        this._cleanup(state);
    }

    /**
     * Edit the "Thinking" placeholder with the latest streamed content.
     */
    _warmAgent(agent) {
        if (!agent || typeof agent.ensureRunning !== 'function') return;
        agent.ensureRunning().catch(err => console.warn(`[ActionExecutor] Warm ${agent.name} failed: ${err.message}`));
    }

    async _editThinkingMessage(state) {
        if (!state.thinkingMsgId || !state.ctx) return;
        if (state.editInFlight) {
            state.editQueued = true;
            return;
        }
        state.lastEdit = Date.now();
        state.lastEmittedLength = state.responseText.length;
        state.editInFlight = true;

        const agent = this.agents[state.agentKey];
        const display = state.responseText || state.statusText || '⏳ Thinking...';

        // Truncate for Telegram's 4096 limit
        let truncated = display;
        if (truncated.length > 3900) {
            truncated = '...' + truncated.substring(truncated.length - 3900);
        }

        const text = `${agent.emoji} ${agent.name} (streaming...)\n\n${truncated}`;

        try {
            if (state.ctx?.telegram?.editMessageText) {
                await state.ctx.telegram.editMessageText(
                    state.ctx.chat?.id,
                    state.thinkingMsgId,
                    null,
                    text,
                    {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🛑 Stop', 'action:stop')]
                        ]).reply_markup,
                    }
                );
            }
        } catch (e) {
            if (!e.message?.includes('message is not modified')) {
                console.error('[ActionExecutor] Edit failed:', e.message);
            }
        } finally {
            state.editInFlight = false;
            if (state.editQueued) {
                state.editQueued = false;
                this._editThinkingMessage(state);
            }
        }
    }

    _cleanup(state) {
        clearTimeout(state?.agentTimeout);
        if (state?.typingTimer) clearInterval(state.typingTimer);
        if (state) {
            if (state.requestId) {
                globalAgentPool.release(state.requestId);
            }
            if (this.runningAgents && state.agentKey) {
                this.runningAgents.delete(state.agentKey);
            }
            this.active.delete(state.chatId);
            this._processChat(state.chatId);
            for (const waitingChatId of this.queues.keys()) {
                this._processChat(waitingChatId);
            }
        }
    }

    async stop() {
        for (const state of this.active.values()) {
            if (state.pendingTimer) clearTimeout(state.pendingTimer);
            if (state.agentTimeout) clearTimeout(state.agentTimeout);
            if (state.typingTimer) clearInterval(state.typingTimer);
        }
        this.active.clear();
        this.queues.clear();
        if (this.runningAgents) this.runningAgents.clear();
        if (this.processedIdStore) await this.processedIdStore.flush();
        if (this.shellJobs) await this.shellJobs.close();
    }
}

module.exports = ActionExecutor;
module.exports.applyPersistentMemories = applyPersistentMemories;
module.exports.buildSharedPrompt = buildSharedPrompt;
module.exports.buildModelSelectorView = buildModelSelectorView;
module.exports.parseShellControl = parseShellControl;
