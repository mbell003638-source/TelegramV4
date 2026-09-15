// =============================================================================
//  test/mission_control.test.js — Mission Control, Database & Self-Improvement
// =============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AssistantDatabase } = require('../core/Database');
const MissionControlServer = require('../core/MissionControl');
const SelfImprovementEngine = require('../core/SelfImprovement');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-assistant-'));
    return new AssistantDatabase(path.join(dir, 'test.db'));
}

test('Database manages mission tasks and status transitions', () => {
    const db = tempDb();
    const task = db.createMissionTask({
        title: 'Test Codebase Refactor',
        prompt: 'Clean up dead code in modules',
        assignedAgent: 'codex',
        priority: 1,
    });
    assert.equal(task.title, 'Test Codebase Refactor');
    assert.equal(task.assigned_agent, 'codex');
    assert.equal(task.status, 'queued');

    const inProg = db.updateMissionTaskStatus(task.id, 'in_progress');
    assert.equal(inProg.status, 'in_progress');
    assert.ok(inProg.started_at > 0);

    const completed = db.updateMissionTaskStatus(task.id, 'completed', { result: 'All dead code removed' });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result, 'All dead code removed');

    const all = db.getMissionTasks();
    assert.equal(all.length, 1);
});

test('Database records Hive Mind delegation and outputs', () => {
    const db = tempDb();
    db.recordHiveMind('research', 'chat-100', 'competitor_scan', 'Analyzed 3 competitors', ['comp.csv']);
    const entries = db.getHiveMindEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agent_id, 'research');
    assert.equal(entries[0].action, 'competitor_scan');
    assert.equal(entries[0].summary, 'Analyzed 3 competitors');
    assert.equal(entries[0].artifacts, '["comp.csv"]');
});

test('Database tracks salient memories and decay', () => {
    const db = tempDb();
    db.addMemory('chat-100', 'User prefers TypeScript over JavaScript', { importance: 0.8, salience: 1.0 });
    const mems = db.getMemories('chat-100');
    assert.equal(mems.length, 1);
    assert.equal(mems[0].salience, 1.0);

    db.decayMemories('chat-100', 0.9);
    const decayed = db.getMemories('chat-100');
    assert.ok(decayed[0].salience < 1.0);
    assert.ok(decayed[0].salience >= 0.89);
});

test('MissionControl web server answers API endpoints and accepts tasks', async () => {
    const db = tempDb();
    let currentActiveAgent = 'antigravity';
    const server = new MissionControlServer({
        database: db,
        sessionStore: {
            getActiveAgent: () => currentActiveAgent,
            setActiveAgent: (ag) => { currentActiveAgent = ag; },
            getRecentTurns: () => [
                { agent: 'codex', userText: 'turn 1 user', assistantText: 'turn 1 codex', at: 100 },
                { agent: 'pi', userText: 'turn 2 user', assistantText: 'turn 2 pi', at: 200 },
            ],
        },
        agents: {
            antigravity: { name: 'Antigravity', emoji: '🤖' },
            codex: { name: 'Codex', emoji: '💻' },
            pi: { name: 'Pi', emoji: '🥧' },
        },
        port: 3159,
        token: 'unit_test_token',
    });

    const started = await server.start();
    assert.equal(started, true);

    // 1. GET /api/info
    const infoRes = await fetch('http://localhost:3159/api/info?token=unit_test_token');
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.status, 'online');
    assert.equal(info.activeAgent, 'antigravity');

    // 2. POST /api/mission/tasks
    const postRes = await fetch('http://localhost:3159/api/mission/tasks?token=unit_test_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Automated Test Task',
            prompt: 'Verify system integrity',
            assignedAgent: 'antigravity',
        }),
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.task.title, 'Automated Test Task');

    // 3. GET /api/mission/tasks
    const listRes = await fetch('http://localhost:3159/api/mission/tasks?token=unit_test_token');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.tasks.length, 1);

    // 4. GET /api/agents/pi/conversation preserves cross-agent shared turns
    const convRes = await fetch('http://localhost:3159/api/agents/pi/conversation?token=unit_test_token');
    assert.equal(convRes.status, 200);
    const convData = await convRes.json();
    assert.equal(convData.turns.length, 4);
    assert.equal(convData.turns[0].content, 'turn 1 user');
    assert.equal(convData.turns[1].source, 'codex');
    assert.equal(convData.turns[2].content, 'turn 2 user');
    assert.equal(convData.turns[3].source, 'pi');
    assert.equal(convData.activeAgent, 'pi');

    // 5. GET /api/chat/history returns the identical complete shared history
    const histRes = await fetch('http://localhost:3159/api/chat/history?token=unit_test_token');
    assert.equal(histRes.status, 200);
    const histData = await histRes.json();
    assert.equal(histData.turns.length, 4);
    assert.equal(histData.turns[1].source, 'codex');
    assert.equal(histData.turns[3].source, 'pi');

    await server.stop();
});

test('SelfImprovement engine evaluates turns and scores discipline', async () => {
    const db = tempDb();
    const mockStore = {
        getChatPreferences: () => ({
            recentTurns: [
                { agent: 'codex', userText: 'Run deployment', assistantText: '⚠️ Error: command failed' },
                { agent: 'claude', userText: 'Fix bug', assistantText: 'Bug fixed successfully' },
            ],
        }),
    };
    const engine = new SelfImprovementEngine({ database: db, sessionStore: mockStore });
    const report = await engine.evaluateAndLearn('chat-100');
    assert.equal(report.analyzedTurns, 2);
    assert.ok(report.disciplineScore < 100);
    assert.ok(report.insights.length > 0);

    const mems = db.getMemories('chat-100');
    assert.ok(mems.length > 0);
});

test('MissionControl mounts delegation and peer-auth instance sync at boot', async () => {
    const db = tempDb();
    const PEER_TOKEN = 'peer-tok-boot-wiring-1';
    const SHARED = 'shared-secret-boot-wiring';
    const DASH = 'dash-token-boot-wiring';

    const delegation = {
        getTasks: () => [{ id: 't1', status: 'pending' }],
        agentKeys: () => ['claude', 'codex'],
    };
    const instanceSync = {
        peerForToken: (presented) => (presented === PEER_TOKEN
            ? { id: 'laptop', scopes: ['memories'] }
            : null),
        peerForId: (id) => (id === 'laptop' ? { id: 'laptop', scopes: ['memories'] } : null),
        verifySharedSecret: (presented) => presented === SHARED,
        export: ({ scopes }) => ({ instanceId: 'self', scopes, counts: { memories: 0, skills: 0, config: 0 } }),
        import: () => ({ ok: true }),
    };

    const server = new MissionControlServer({
        database: db,
        sessionStore: { getActiveAgent: () => 'antigravity', getRecentTurns: () => [] },
        agents: { antigravity: { name: 'Antigravity', emoji: '🤖' } },
        port: 3163,
        token: DASH,
        delegation,
        instanceSync,
    });

    try {
        const started = await server.start();
        assert.equal(started, true);
        const base = 'http://127.0.0.1:3163';

        // Delegation is a dashboard-token route: constructed AND mounted.
        const listed = await fetch(`${base}/api/delegation/tasks?token=${DASH}`);
        assert.equal(listed.status, 200);
        const listedBody = await listed.json();
        assert.deepEqual(listedBody.tasks, [{ id: 't1', status: 'pending' }]);

        const unauthDeleg = await fetch(`${base}/api/delegation/tasks`);
        assert.equal(unauthDeleg.status, 401);

        // Peer export is reachable WITHOUT the dashboard token.
        const peerOk = await fetch(`${base}/api/instance/export?scopes=memories`, {
            headers: { 'X-Instance-Token': PEER_TOKEN },
        });
        assert.equal(peerOk.status, 200);
        const peerBody = await peerOk.json();
        assert.deepEqual(peerBody.scopes, ['memories']);

        // A leaked dashboard token is not a vault key.
        const dashAsPeer = await fetch(`${base}/api/instance/export?token=${DASH}`);
        assert.equal(dashAsPeer.status, 401);

        // Shared secret of an unknown device id is refused (not auto-accepted).
        const unknown = await fetch(`${base}/api/instance/export`, {
            headers: { 'X-Instance-Secret': SHARED, 'X-Instance-Id': 'stranger' },
        });
        assert.equal(unknown.status, 401);

        // Shared secret of a registered peer is the bootstrap path, still opt-in.
        const bootstrap = await fetch(`${base}/api/instance/export?scopes=memories,config`, {
            headers: { 'X-Instance-Secret': SHARED, 'X-Instance-Id': 'laptop' },
        });
        assert.equal(bootstrap.status, 200);
        const bootstrapBody = await bootstrap.json();
        assert.deepEqual(bootstrapBody.scopes, ['memories']);
    } finally {
        await server.stop();
    }
});
