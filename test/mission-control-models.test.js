const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const MissionControlServer = require('../core/MissionControl');
const SessionStore = require('../core/SessionStore');
const { AssistantDatabase } = require('../core/Database');

test('MissionControl dynamic agent models and custom model registration', async () => {
    const tmpDir = path.join(__dirname, 'tmp_mc_models_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    const db = new AssistantDatabase(path.join(tmpDir, 'test.db'));
    const sessionStore = new SessionStore(tmpDir);

    const fakeAgents = {
        hermes: { name: 'Hermes', emoji: '🪽' },
        openclaw: { name: 'OpenClaw', emoji: '🦞' },
    };

    const server = new MissionControlServer({
        database: db,
        sessionStore,
        actionExecutor: null,
        agents: fakeAgents,
        port: 3155,
        token: 'test_token',
    });

    await server.start();

    // 1. GET /api/agents
    const agentsRes = await fetch('http://localhost:3155/api/agents?token=test_token').then(r => r.json());
    assert.equal(agentsRes.agents.length, 2);
    assert.ok(Array.isArray(agentsRes.agents[0].availableModels));

    // 2. PATCH /api/agents/hermes/model with custom model
    const patchRes = await fetch('http://localhost:3155/api/agents/hermes/model?token=test_token', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3' }),
    }).then(r => r.json());

    assert.equal(patchRes.success, true);
    assert.equal(patchRes.model, 'deepseek-ai/DeepSeek-V3');
    assert.equal(sessionStore.getActiveModel('hermes'), 'deepseek-ai/DeepSeek-V3');

    // 3. Verify it appears in dynamic models list
    const updatedAgentsRes = await fetch('http://localhost:3155/api/agents?token=test_token').then(r => r.json());
    const hermes = updatedAgentsRes.agents.find(a => a.id === 'hermes');
    assert.equal(hermes.model, 'deepseek-ai/DeepSeek-V3');
    assert.ok(hermes.availableModels.some(m => (typeof m === 'string' ? m : m.id) === 'deepseek-ai/DeepSeek-V3'));

    // 4. POST /api/agents/active
    const switchRes = await fetch('http://localhost:3155/api/agents/active?token=test_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'openclaw' }),
    }).then(r => r.json());

    assert.equal(switchRes.success, true);
    assert.equal(switchRes.activeAgent, 'openclaw');
    assert.equal(sessionStore.getActiveAgent(), 'openclaw');

    await server.stop();
    await sessionStore.flush();
    if (db.db && typeof db.db.close === 'function') db.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
