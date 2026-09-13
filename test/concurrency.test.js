// =============================================================================
//  test/concurrency.test.js — Agent Concurrency Pool & Workspace Isolation Tests
// =============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AgentPool } = require('../core/AgentPool');
const { WorkspaceManager } = require('../core/WorkspaceManager');

test('AgentPool acquires and releases slots up to maxConcurrent', async () => {
    const pool = new AgentPool(2); // Max 2 concurrent
    assert.equal(pool.maxConcurrent, 2);

    // Acquire slot 1
    const s1 = await pool.acquire('task_1', { agentKey: 'claude' });
    assert.equal(s1, true);
    assert.equal(pool.running.size, 1);

    // Acquire slot 2
    const s2 = await pool.acquire('task_2', { agentKey: 'codex' });
    assert.equal(s2, true);
    assert.equal(pool.running.size, 2);

    // Slot 3 must queue
    let task3Acquired = false;
    pool.acquire('task_3', { agentKey: 'grok' }).then(() => {
        task3Acquired = true;
    });

    assert.equal(task3Acquired, false);
    assert.equal(pool.queue.length, 1);

    // Release slot 1 -> slot 3 should be granted immediately
    pool.release('task_1');
    await new Promise(r => setImmediate(r));

    assert.equal(task3Acquired, true);
    assert.equal(pool.running.size, 2);
    assert.equal(pool.queue.length, 0);

    pool.release('task_2');
    pool.release('task_3');
    assert.equal(pool.running.size, 0);
});

test('AgentPool respects priority ordering when draining queue', async () => {
    const pool = new AgentPool(1);
    await pool.acquire('active_task');

    const executionOrder = [];
    pool.acquire('normal_task', { priority: 0 }).then(() => executionOrder.push('normal'));
    pool.acquire('urgent_task', { priority: 2 }).then(() => executionOrder.push('urgent'));
    pool.acquire('high_task', { priority: 1 }).then(() => executionOrder.push('high'));

    // Release active task
    pool.release('active_task');
    await new Promise(r => setImmediate(r));

    // Urgent should be first!
    assert.equal(executionOrder[0], 'urgent');

    pool.release('urgent_task');
    await new Promise(r => setImmediate(r));
    assert.equal(executionOrder[1], 'high');

    pool.release('high_task');
    await new Promise(r => setImmediate(r));
    assert.equal(executionOrder[2], 'normal');
});

test('AgentPool dynamically updates limit at runtime', async () => {
    const pool = new AgentPool(2);
    await pool.acquire('t1');
    await pool.acquire('t2');

    let t3Granted = false;
    pool.acquire('t3').then(() => { t3Granted = true; });
    assert.equal(t3Granted, false);

    // Expand limit to 4
    pool.setMaxConcurrent(4);
    await new Promise(r => setImmediate(r));

    assert.equal(pool.maxConcurrent, 4);
    assert.equal(t3Granted, true);
    assert.equal(pool.running.size, 3);
});

test('WorkspaceManager acquires and cleans isolated directories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const mgr = new WorkspaceManager(tmp);

    const ws = mgr.acquireWorkspace('1234');
    assert.ok(fs.existsSync(ws));
    assert.match(ws, /task_1234/);

    mgr.releaseWorkspace('1234');
    assert.equal(fs.existsSync(ws), false);
});
