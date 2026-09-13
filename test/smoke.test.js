const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const SessionStore = require('../core/SessionStore');
const DurableIdStore = require('../core/DurableIdStore');
const ActionExecutor = require('../core/ActionExecutor');
const Gateway = require('../core/Gateway');
const { channelEventBus } = require('../core/EventBus');
const { parseModelList } = require('../agents/OpenCodeAgent');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bridge-')); }

test('SessionStore includes grok in the default model catalog', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const models = store.getAvailableModels('grok');
    assert.ok(models.some(m => m.id === 'grok-4.6'));
    assert.equal(store.getActiveModel('grok'), 'default');
    await store.stop();
});

test('session cwd is stored and reused when the session id changes', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.setSession('codex', 'thread-a', 'chat-a', { cwd: '/tmp' });
    assert.equal(store.getSession('codex', 'chat-a'), 'thread-a');
    assert.equal(store.getWorkspaceCwd('codex', 'chat-a'), '/tmp');
    store.setSession('codex', 'thread-b', 'chat-a');
    assert.equal(store.getSession('codex', 'chat-a'), 'thread-b');
    assert.equal(store.getWorkspaceCwd('codex', 'chat-a'), '/tmp');
    await store.flush();
    await store.stop();
});

test('normalizeCwd accepts file URIs and rejects missing paths', () => {
    const { normalizeCwd, resolveUserCwd } = require('../core/sessionCatalog');
    const expectedTmp = path.resolve('/tmp');
    assert.equal(normalizeCwd('file:///tmp'), expectedTmp);
    assert.equal(normalizeCwd('/does/not/exist/anywhere'), null);
    assert.equal(resolveUserCwd('/tmp'), expectedTmp);
    assert.equal(resolveUserCwd('home', expectedTmp), expectedTmp);
    assert.equal(resolveUserCwd('nope-not-a-dir', expectedTmp), null);
});

test('chat /cwd override is used for workspace folder', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.setChatCwd('chat-a', '/tmp');
    assert.equal(store.getWorkspaceCwd('grok', 'chat-a'), '/tmp');
    store.setChatCwd('chat-a', null);
    assert.ok(store.getWorkspaceCwd('grok', 'chat-a'));
    await store.stop();
});

test('per-chat session state stays isolated and persists asynchronously', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.setActiveAgent('codex', 'chat-a');
    store.setActiveAgent('antigravity', 'chat-b');
    store.setSession('codex', 'thread-a', 'chat-a');
    await store.flush();
    assert.equal(store.getActiveAgent('chat-a'), 'codex');
    assert.equal(store.getActiveAgent('chat-b'), 'antigravity');
    assert.equal(store.getSession('codex', 'chat-a'), 'thread-a');
    assert.equal(store.getSession('codex', 'chat-b'), null);
    assert.ok(fs.existsSync(path.join(dir, 'sessions', 'schema.json')));
    await store.stop();
});

test('processed message IDs are deduplicated with atomic durable writes', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ids.json');
    const ids = new DurableIdStore(file);
    ids.add('message-1');
    ids.add('message-1');
    await ids.flush();
    assert.equal(ids.has('message-1'), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['message-1']);
});

test('Telegram message IDs are deduplicated per chat and persisted', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const executor = new ActionExecutor(store, {});
    let calls = 0;
    executor._handleAction = async () => { calls++; };
    const handle = executor.getMessageHandler();
    const message = (chatId) => ({
        id: '42', platform: 'telegram', chatId,
        action: { type: 'system', name: 'test' },
    });

    await handle(message('chat-a'));
    await handle(message('chat-b'));
    await handle(message('chat-a'));

    assert.equal(calls, 2);
    await executor.stop();
    await store.stop();
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'processed_mids.json'), 'utf8'));
    assert.deepEqual(persisted.sort(), ['telegram:chat-a:42', 'telegram:chat-b:42']);
});

test('BaseAgent.ensureRunning does not re-initialize a ready agent', async () => {
    const BaseAgent = require('../core/BaseAgent');
    let inits = 0;
    let starts = 0;
    class FakeAgent extends BaseAgent {
        constructor() { super('fake', 'Fake', '🧪'); }
        async onInitialize() { inits++; }
        async onStart() { starts++; }
        async onStop() {}
        async sendMessage() {}
    }
    const agent = new FakeAgent();
    await agent.initialize();
    await agent.ensureRunning();
    await agent.ensureRunning();
    assert.equal(inits, 1);
    assert.equal(starts, 1);
    assert.equal(agent.isWarm, true);
});

test('shared agent instances serialize requests across chats', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.setActiveAgent('fake');
    const pending = [];
    const starts = [];
    const agent = {
        key: 'fake', name: 'Fake', emoji: '🧪', isWarm: true,
        setRequestContext(requestId) { this.requestId = requestId; },
        sendMessage(msg) {
            starts.push(msg.chatId);
            const requestId = this.requestId;
            return new Promise(resolve => pending.push(() => {
                channelEventBus.emitFinished('fake', `done-${msg.chatId}`, requestId);
                resolve();
            }));
        },
        async stop() {},
    };
    const executor = new ActionExecutor(store, { fake: agent });
    const handle = executor.getMessageHandler();
    const context = (chatId) => ({
        chat: { id: chatId },
        sendChatAction: async () => {},
        reply: async () => ({ message_id: Math.floor(Math.random() * 100000) }),
        telegram: {
            deleteMessage: async () => {},
            editMessageText: async () => {},
        },
    });
    const message = (chatId, id) => ({
        id, platform: 'telegram', chatId,
        content: { type: 'text', text: `hello-${chatId}` },
        raw: context(chatId),
    });

    await handle(message('chat-a', '1'));
    await handle(message('chat-b', '1'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(starts, ['chat-a']);

    pending.shift()();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(starts, ['chat-a', 'chat-b']);

    pending.shift()();
    await new Promise(resolve => setTimeout(resolve, 20));
    await executor.stop();
    await store.stop();
});

test('Telegram gateway defaults to IPv4 keep-alive on this deployment', () => {
    const dir = tempDir();
    const gateway = new Gateway('test-token', async () => {}, null, dir);
    assert.equal(gateway.telegramAgent.options.family, 4);
    assert.equal(gateway.telegramAgent.options.keepAlive, true);
    assert.equal(typeof gateway._downloadTelegramFile, 'function');
    gateway.stop('test');
});

test('bang commands are recognized without treating ordinary chat as shell', () => {
    const { parseBangCommand } = require('../core/Gateway');
    assert.equal(parseBangCommand('!pwd'), 'pwd');
    assert.equal(parseBangCommand('!  uname -a'), 'uname -a');
    assert.equal(parseBangCommand('hello'), null);
});

test('shell job management commands are parsed separately', () => {
    const { parseShellControl } = require('../core/ActionExecutor');
    assert.deepEqual(parseShellControl('status'), { name: 'status', jobId: null });
    assert.deepEqual(parseShellControl('tail abc-123'), { name: 'tail', jobId: 'abc-123' });
    assert.deepEqual(parseShellControl('stop abc-123'), { name: 'stop', jobId: 'abc-123' });
    assert.deepEqual(parseShellControl('jobs'), { name: 'jobs', jobId: null });
    assert.equal(parseShellControl('systemctl status telegram-bridge'), null);
});

test('systemd shell job properties are parsed', () => {
    const { parseSystemdProperties } = require('../core/ShellJobManager');
    assert.deepEqual(parseSystemdProperties('ActiveState=inactive\nResult=success\nExecMainStatus=0\n'), {
        ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0',
    });
});

test('OpenCode model output is converted to provider/model selector entries', () => {
    assert.deepEqual(parseModelList('opencode/big-pickle\nnvidia/foo\n\nnot-a-model\n'), [
        { id: 'default', name: 'Default Model' },
        { id: 'opencode/big-pickle', name: 'opencode/big-pickle' },
        { id: 'nvidia/foo', name: 'nvidia/foo' },
    ]);
});

test('Codex model discovery includes visible Astra and excludes hidden models', () => {
    const { normalizeCodexModels } = require('../agents/CodexAgent');
    const models = normalizeCodexModels([
        { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false },
        { id: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true },
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false },
    ]);
    assert.equal(models[1].id, 'gpt-6-astra');
    assert.ok(models.some(model => model.id === 'gpt-5.6-sol'));
    assert.equal(models.some(model => model.id === 'gpt-reserve'), false);
});

test('Codex model discovery preserves per-model reasoning levels', () => {
    const { normalizeCodexModels } = require('../agents/CodexAgent');
    const models = normalizeCodexModels([{
        id: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'ultra' },
        ],
    }], 'app-server', '/does/not/exist');
    assert.deepEqual(models[1].reasoningEfforts, ['low', 'high', 'ultra']);
    assert.equal(models[1].defaultReasoningEffort, 'low');
    assert.equal(models[1].autoReasoningEffort, 'low');
});

test('reasoning effort is remembered per chat and per model', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.setReasoningEffort('codex', 'gpt-6-astra', 'ultra', 'chat-a');
    store.setReasoningEffort('codex', 'gpt-5.5', 'high', 'chat-a');
    assert.equal(store.getReasoningEffort('codex', 'gpt-6-astra', 'chat-a'), 'ultra');
    assert.equal(store.getReasoningEffort('codex', 'gpt-5.5', 'chat-a'), 'high');
    assert.equal(store.getReasoningEffort('codex', 'gpt-6-astra', 'chat-b'), null);
    store.setReasoningEffort('codex', 'gpt-6-astra', null, 'chat-a');
    assert.equal(store.getReasoningEffort('codex', 'gpt-6-astra', 'chat-a'), null);
    await store.stop();
});

test('shared capability catalog exposes only adapter-supported effort levels', () => {
    const { EFFORT_LEVELS, withEffortCapabilities, activeEffort } = require('../core/ModelCapabilities');
    assert.deepEqual(EFFORT_LEVELS.antigravity, ['low', 'medium', 'high']);
    assert.deepEqual(EFFORT_LEVELS.claude, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(EFFORT_LEVELS.hermes.includes('ultra'));
    assert.ok(EFFORT_LEVELS.openclaw.includes('adaptive'));
    assert.deepEqual(withEffortCapabilities({ id: 'plain' }, []).reasoningEfforts, undefined);
    const fakeStore = { getReasoningEffort: () => 'ultra' };
    assert.equal(activeEffort(fakeStore, 'codex', 'astra', [{ id: 'astra', reasoningEfforts: ['high', 'ultra'] }], 'chat'), 'ultra');
    assert.equal(activeEffort(fakeStore, 'codex', 'old', [{ id: 'old' }], 'chat'), null);
});

test('Hermes configured model discovery includes primary and fallbacks', () => {
    const { parseHermesConfiguredModels } = require('../agents/HermesAgent');
    const models = parseHermesConfiguredModels(
        'model:\n  default: claude-opus-5\n  provider: anthropic\n' +
        'fallback_providers:\n  - provider: nvidia\n    model: z-ai/glm-5.2\n'
    );
    assert.deepEqual(models.map(model => model.id), [
        'default', 'anthropic/claude-opus-5', 'nvidia/z-ai/glm-5.2',
    ]);
    assert.ok(models[1].reasoningEfforts.includes('ultra'));
});

test('PiAgent model output is converted to provider/model selector entries', () => {
    const { parsePiModels } = require('../agents/PiAgent');
    const basic = parsePiModels('provider  model  context\nnvidia  google/gemma-3-12b-it  131k\n');
    assert.deepEqual(basic.map(({ id, name }) => ({ id, name })), [
        { id: 'default', name: 'Default Model' },
        { id: 'nvidia/google/gemma-3-12b-it', name: 'google/gemma-3-12b-it (nvidia)' },
    ]);
    const real = parsePiModels('provider  model                                          context  max-out  thinking  images\nnvidia    nvidia/nemotron-3-nano-omni-30b-a3b-reasoning  256K     65.5K    yes       yes   \n');
    assert.deepEqual({ id: real[1].id, name: real[1].name }, {
        id: 'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        name: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning (nvidia)',
    });
    assert.deepEqual(real[1].reasoningEfforts, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('model selector paginates and keeps Telegram callback_data under 64 bytes', () => {
    const { buildModelSelectorView } = require('../core/ActionExecutor');
    const { parseSlashArgs } = require('../core/types');
    const models = Array.from({ length: 22 }, (_, i) => ({
        id: `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning-${i}`,
        name: `Nemotron Omni ${i}`,
    }));
    const view = buildModelSelectorView(models, models[0].id, 0, 6);
    assert.equal(view.totalPages, 4);
    assert.equal(view.buttons[0][0].callback_data, 'model:i:0');
    for (const btn of view.buttons.flat()) {
        assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, btn.callback_data);
    }
    const page2 = buildModelSelectorView(models, models[0].id, 1, 6);
    assert.equal(page2.buttons[0][0].callback_data, 'model:i:6');
    assert.equal(parseSlashArgs('/model', 'model'), '');
    assert.equal(parseSlashArgs('/model@GenieBot', 'model'), '');
    assert.equal(parseSlashArgs('/model@GenieBot nvidia/foo', 'model'), 'nvidia/foo');
    assert.equal(parseSlashArgs('/resume_last', 'resume_last'), '');
});

test('GrokAgent model output is converted to model selector entries', () => {
    const { parseGrokModels, parseGrokModelsCache, mergeGrokModels, extractGrokToolName } = require('../agents/GrokAgent');
    assert.deepEqual(parseGrokModels('Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n').map(({ id, name }) => ({ id, name })), [
        { id: 'default', name: 'Default (grok-4.6)' },
        { id: 'grok-4.6', name: 'grok-4.6' },
        { id: 'grok-4.5', name: 'grok-4.5' },
    ]);
    assert.deepEqual(parseGrokModels('Default model: grok-4.5\nAvailable models:\n  - grok-4.5\n').map(({ id, name }) => ({ id, name })), [
        { id: 'default', name: 'Default (grok-4.5)' },
        { id: 'grok-4.5', name: 'grok-4.5' },
    ]);
    assert.deepEqual(parseGrokModelsCache({
        models: {
            'grok-4.6': { info: { name: 'Grok 4.6' } },
            'grok-4.5': { info: { name: 'Grok 4.5', hidden: false } },
            'hidden-model': { info: { name: 'Hidden', hidden: true } },
        }
    }), [
        { id: 'default', name: 'Default (grok-4.6)' },
        { id: 'grok-4.6', name: 'Grok 4.6' },
        { id: 'grok-4.5', name: 'Grok 4.5' },
    ]);
    assert.deepEqual(
        mergeGrokModels(
            [{ id: 'default', name: 'Default (grok-4.6)' }, { id: 'grok-4.6', name: 'grok-4.6' }],
            [{ id: 'default', name: 'Default (grok-4.6)' }, { id: 'grok-4.6', name: 'Grok 4.6' }, { id: 'grok-4.5', name: 'Grok 4.5' }]
        ),
        [
            { id: 'default', name: 'Default (grok-4.6)' },
            { id: 'grok-4.6', name: 'Grok 4.6' },
            { id: 'grok-4.5', name: 'Grok 4.5' },
        ]
    );
    assert.equal(extractGrokToolName({ type: 'tool_call', toolName: 'read_file', title: 'Read' }), 'read_file');
    assert.equal(extractGrokToolName({ type: 'tool_call', title: 'Read' }), 'Read');
    assert.equal(extractGrokToolName({ type: 'tool_call' }), 'tool');
});

test('Grok sessions on disk are listed even when CLI list is cwd-filtered', () => {
    const { listGrokSessionsFromDisk } = require('../core/sessionCatalog');
    const dir = tempDir();
    const sessionDir = path.join(dir, '.grok', 'sessions', encodeURIComponent('/home/open'), '01a05e2a-e585-7553-b841-6193ba7cd91c');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({
        info: { id: '01a05e2a-e585-7553-b841-6193ba7cd91c', cwd: '/tmp' },
        session_summary: 'Add warm Grok ACP',
        updated_at: '2026-09-01T19:00:00Z',
    }));
    const rows = listGrokSessionsFromDisk(dir, 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, '01a05e2a-e585-7553-b841-6193ba7cd91c');
    assert.match(rows[0].title, /Add warm Grok ACP/);
    assert.equal(rows[0].cwd, path.resolve('/tmp'));
});

test('CLI session lists parse grok session table rows', () => {
    const { parseGrokSessionList } = require('../core/sessionCatalog');
    const rows = parseGrokSessionList(
        'SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY\n' +
        '01a05e2a-e585-7553-b841-6193ba7cd91c  2026-09-01  2026-09-01  local  Add warm Grok ACP\n'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent, 'grok');
    assert.equal(rows[0].id, '01a05e2a-e585-7553-b841-6193ba7cd91c');
    assert.match(rows[0].title, /Add warm Grok ACP/);
});

test('Codex resume titles skip session_meta and injected prefixes', () => {
    const { listCodexSessions, peelSharedPrompt, usableUserTitle } = require('../core/sessionCatalog');
    assert.equal(
        peelSharedPrompt('Persistent shared memories (follow these; they apply for every agent):\n# PROFILE\n\n---\n\nwhat do you know about telegram v4'),
        'what do you know about telegram v4'
    );
    assert.equal(usableUserTitle('<recommended_plugins>\nignore'), '');
    const dir = tempDir();
    const sessionDir = path.join(dir, '.codex', 'sessions', '2026', '09', '13');
    fs.mkdirSync(sessionDir, { recursive: true });
    const id = '01a09bbe-f563-71d1-8a3c-956b166bb349';
    const lines = [
        JSON.stringify({
            type: 'session_meta',
            payload: {
                session_id: id,
                cwd: '/tmp',
                base_instructions: { text: 'x'.repeat(20000) },
            },
        }),
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: '<skills_instructions>\nignore me' }],
            },
        }),
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '<recommended_plugins>\nignore me too' }],
            },
        }),
        JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: 'Persistent shared memories (follow these; they apply for every agent):\n# USER PROFILE\n\n---\n\nwhat do you know about telegram v4',
                }],
            },
        }),
    ];
    fs.writeFileSync(path.join(sessionDir, `rollout-2026-09-13T22-39-38-${id}.jsonl`), `${lines.join('\n')}\n`);
    const rows = listCodexSessions(dir, 5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].cwd, path.resolve('/tmp'));
    assert.match(rows[0].title, /what do you know about telegram v4/);
    assert.doesNotMatch(rows[0].title, /Codex session|Persistent shared|recommended_plugins/);
});

test('GrokAgent is wired for warm ACP stdio with headless fallback args', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const GrokAgent = require('../agents/GrokAgent');
    const agent = new GrokAgent(store);
    assert.deepEqual(agent.cliArgs, ['agent', '--always-approve', '--no-leader', 'stdio']);
    assert.equal(typeof agent.connectAcp, 'function');
    assert.equal(typeof agent.cancelTurn, 'function');
    assert.equal(typeof agent.ensureSession, 'function');
    await store.stop();
});

test('GrokAgent builds headless CLI args with prompt-file, model, and resume', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const GrokAgent = require('../agents/GrokAgent');
    const agent = new GrokAgent(store);
    assert.deepEqual(agent._buildArgs({ promptFile: '/tmp/p.txt', model: 'grok-4.6', sessionId: 'abc' }), [
        '--prompt-file', '/tmp/p.txt',
        '--output-format', 'streaming-json',
        '--permission-mode', 'bypassPermissions',
        '--always-approve',
        '--no-auto-update',
        '-m', 'grok-4.6',
        '-r', 'abc',
    ]);
    const fresh = agent._buildArgs({ promptFile: '/tmp/p.txt', model: 'default', sessionId: null });
    assert.equal(fresh.includes('-m'), false);
    assert.equal(fresh.includes('-r'), false);
    await store.stop();
});

test('persistent memories are injected only on the first turn of a session', () => {
    const { applyPersistentMemories, buildSharedPrompt } = require('../core/ActionExecutor');
    const memories = '# USER PROFILE & PREFERENCES\n- Name: Ahemnani';
    assert.equal(applyPersistentMemories('hello', memories, true), 'hello');
    assert.equal(applyPersistentMemories('hello', '# USER PROFILE & PREFERENCES', false), 'hello');
    assert.match(applyPersistentMemories('hello', memories, false), /Persistent shared memories[\s\S]*hello/);

    const withHandoff = buildSharedPrompt('keep going', {
        memories,
        hasExistingSession: false,
        recentTurns: [{ agentName: 'Claude Code', userText: 'fix the bot', assistantText: 'patched Gateway' }],
    });
    assert.match(withHandoff, /Claude Code/);
    assert.match(withHandoff, /fix the bot/);
    assert.match(withHandoff, /keep going/);

    const midSessionRemember = buildSharedPrompt('next task', {
        hasExistingSession: true,
        pendingNotes: ['Prefer pytest'],
    });
    assert.match(midSessionRemember, /Prefer pytest/);
    assert.match(midSessionRemember, /next task/);

    const switchHandoff = buildSharedPrompt('keep going', {
        hasExistingSession: true,
        maxTurns: 1,
        recentTurns: [{ agentName: 'Claude Code', userText: 'fix the bot', assistantText: 'patched Gateway' }],
    });
    assert.match(switchHandoff, /Claude Code/);
    assert.equal(switchHandoff.includes('Persistent shared memories'), false);
});

test('shared memories and recent turns persist across agents for a chat', async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    store.addMemory('Name is Ahemnani');
    store.addPendingMemory('chat-a', 'Prefer pytest');
    store.appendRecentTurn('chat-a', {
        agent: 'claude',
        agentName: 'Claude Code',
        userText: 'fix telegram',
        assistantText: 'done',
    });
    await store.flush();

    assert.match(store.getMemories(), /Name is Ahemnani/);
    assert.deepEqual(store.getPendingMemories('chat-a'), ['Prefer pytest']);
    assert.equal(store.getRecentTurns('chat-b').length, 0);
    assert.equal(store.getRecentTurns('chat-a')[0].agent, 'claude');

    store.clearPendingMemories('chat-a');
    store.clearRecentTurns('chat-a');
    store.clearMemories();
    await store.flush();
    assert.deepEqual(store.getPendingMemories('chat-a'), []);
    assert.deepEqual(store.getRecentTurns('chat-a'), []);
    assert.equal(store.getMemories().trim(), '# USER PROFILE & PREFERENCES');
    await store.stop();
});

test('Hermes scratchpad thought and tool_call tags are rendered into Telegram HTML', () => {
    const { markdownToTelegramHtml } = require('../core/formatters');
    const input = 'Hello\n<thought>\nNeed to run ls -la\n</thought>\n<tool_call>{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>\nHere is the result: `done`';
    const output = markdownToTelegramHtml(input);
    assert.match(output, /<blockquote expandable><b>💭 Hermes Thinking:<\/b>/);
    assert.match(output, /Need to run ls -la/);
    assert.match(output, /🔧 <code>bash\({"command":"ls"}\)<\/code>/);
    assert.match(output, /<code>done<\/code>/);
});

