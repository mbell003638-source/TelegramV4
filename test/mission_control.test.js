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
    const server = new MissionControlServer({
        database: db,
        sessionStore: { getActiveAgent: () => 'antigravity' },
        agents: { antigravity: { name: 'Antigravity', emoji: '🤖' } },
        port: 3149,
        token: 'unit_test_token',
    });

    const started = await server.start();
    assert.equal(started, true);

    // 1. GET /api/info
    const infoRes = await fetch('http://localhost:3149/api/info?token=unit_test_token');
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.status, 'online');
    assert.equal(info.activeAgent, 'antigravity');

    // 2. POST /api/mission/tasks
    const postRes = await fetch('http://localhost:3149/api/mission/tasks?token=unit_test_token', {
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
    const listRes = await fetch('http://localhost:3149/api/mission/tasks?token=unit_test_token');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.tasks.length, 1);

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
