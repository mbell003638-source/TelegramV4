const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const Scheduler = require('../core/Scheduler');
const { AssistantDatabase } = require('../core/Database');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Fresh sqlite-backed scheduler in a temp dir. SQLite keeps file handles open
 * on Windows, so cleanup is best-effort — an EPERM on rmSync must never fail
 * a test.
 */
function makeScheduler(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const database = new AssistantDatabase(path.join(dir, 'test.db'));
    const scheduler = new Scheduler({ database, intervalMs: 60000, ...opts });
    return {
        scheduler,
        database,
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

/** Local-time epoch ms, so expectations match cron's local-time semantics. */
function at(y, mo, d, h, mi) {
    return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

const fmt = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ===========================================================================
//  Cron parsing
// ===========================================================================

test('parseCron accepts wildcards, values, lists, ranges and steps', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        assert.ok(scheduler.parseCron('* * * * *'));
        assert.ok(scheduler.parseCron('*/5 * * * *'));
        assert.ok(scheduler.parseCron('0 9 * * 1-5'));
        assert.ok(scheduler.parseCron('30 2 1 * *'));
        assert.ok(scheduler.parseCron('0 0,12 * * *'));
        assert.ok(scheduler.parseCron('0 0 1 1,6,12 *'));
        // Extra internal whitespace is normalised, not rejected.
        assert.ok(scheduler.parseCron('  0   9  *  *  1-5 '));
    } finally { cleanup(); }
});

test('parseCron rejects malformed expressions with a clear message', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        for (const bad of ['', '   ', 'not a cron', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '* * * * 8', 'a * * * *', '*/0 * * * *']) {
            assert.throws(
                () => scheduler.parseCron(bad),
                /Invalid cron expression/,
                `expected "${bad}" to be rejected`
            );
        }
    } finally { cleanup(); }
});

// ===========================================================================
//  nextRun
// ===========================================================================

test('nextRun is always strictly after the given time and lands on a match', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        const from = at(2026, 3, 10, 12, 30);
        for (const expr of ['* * * * *', '*/5 * * * *', '0 9 * * 1-5', '30 2 1 * *', '0 0,12 * * *']) {
            const next = scheduler.nextRun(expr, from);
            assert.ok(next > from, `${expr}: ${fmt(next)} must be after ${fmt(from)}`);
            assert.ok(scheduler.matches(expr, next), `${expr}: ${fmt(next)} should match`);
        }
    } finally { cleanup(); }
});

test('nextRun computes the expected concrete minute', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        // 12:30 -> next 5-minute boundary is 12:35
        assert.equal(scheduler.nextRun('*/5 * * * *', at(2026, 3, 10, 12, 30)), at(2026, 3, 10, 12, 35));
        // Exactly on a boundary still moves forward (strictly after).
        assert.equal(scheduler.nextRun('*/5 * * * *', at(2026, 3, 10, 12, 35)), at(2026, 3, 10, 12, 40));
        // Tuesday 12:30 -> weekday 09:00 is Wednesday
        assert.equal(scheduler.nextRun('0 9 * * 1-5', at(2026, 3, 10, 12, 30)), at(2026, 3, 11, 9, 0));
        // Monthly on the 1st at 02:30
        assert.equal(scheduler.nextRun('30 2 1 * *', at(2026, 3, 10, 12, 30)), at(2026, 4, 1, 2, 30));
    } finally { cleanup(); }
});

test('nextRun skips a Saturday for a weekday-only schedule', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        // 2026-03-14 is a Saturday; the next weekday 09:00 is Monday the 16th.
        const sat = at(2026, 3, 14, 10, 0);
        assert.equal(new Date(sat).getDay(), 6, 'fixture must be a Saturday');
        const next = scheduler.nextRun('0 9 * * 1-5', sat);
        assert.equal(next, at(2026, 3, 16, 9, 0));
        assert.equal(new Date(next).getDay(), 1);
    } finally { cleanup(); }
});

test('day-of-month and day-of-week both restricted means OR, per standard cron', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        // "0 0 13 * 5" = midnight on the 13th OR on any Friday.
        const expr = '0 0 13 * 5';
        // 2026-03-13 is a Friday, so it satisfies both halves.
        assert.ok(scheduler.matches(expr, at(2026, 3, 13, 0, 0)));
        // 2026-04-13 is a Monday — matches on day-of-month alone.
        assert.equal(new Date(at(2026, 4, 13, 0, 0)).getDay(), 1);
        assert.ok(scheduler.matches(expr, at(2026, 4, 13, 0, 0)));
        // 2026-04-17 is a Friday — matches on day-of-week alone.
        assert.equal(new Date(at(2026, 4, 17, 0, 0)).getDay(), 5);
        assert.ok(scheduler.matches(expr, at(2026, 4, 17, 0, 0)));
        // 2026-04-14 is a Tuesday and not the 13th — matches neither.
        assert.ok(!scheduler.matches(expr, at(2026, 4, 14, 0, 0)));

        // With only day-of-week restricted it is a plain AND with month/time.
        assert.ok(scheduler.matches('0 0 * * 5', at(2026, 4, 17, 0, 0)));
        assert.ok(!scheduler.matches('0 0 * * 5', at(2026, 4, 14, 0, 0)));
    } finally { cleanup(); }
});

test('an impossible expression terminates instead of hanging', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        // February 30th never occurs; must return null, not spin forever.
        const started = Date.now();
        assert.equal(scheduler.nextRun('0 0 30 2 *', at(2026, 1, 1, 0, 0)), null);
        assert.ok(Date.now() - started < 10000, 'search must be bounded');
    } finally { cleanup(); }
});

// ===========================================================================
//  Persistence
// ===========================================================================

test('scheduleTask persists and round-trips through the database', () => {
    const { scheduler, database, cleanup } = makeScheduler();
    try {
        const task = scheduler.scheduleTask({
            chatId: 'c1', agentId: 'claude', prompt: 'nightly backup',
            schedule: '0 3 * * *', from: at(2026, 3, 10, 12, 0),
        });
        assert.ok(task.id);
        assert.equal(task.next_run, at(2026, 3, 11, 3, 0));

        const listed = database.getScheduledTasks('c1');
        assert.equal(listed.length, 1);
        assert.equal(listed[0].prompt, 'nightly backup');
        assert.equal(listed[0].schedule, '0 3 * * *');
        assert.equal(listed[0].status, 'active');

        // Pause / resume / delete
        database.setScheduledTaskStatus(task.id, 'paused');
        assert.equal(database.getScheduledTasks('c1')[0].status, 'paused');
        database.setScheduledTaskStatus(task.id, 'active');
        assert.equal(database.getScheduledTasks('c1')[0].status, 'active');
        database.deleteScheduledTask(task.id);
        assert.equal(database.getScheduledTasks('c1').length, 0);
    } finally { cleanup(); }
});

test('listTasks and cancelTask are the scheduler surface the Hermes cron tool calls', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        const task = scheduler.scheduleTask({
            chatId: 'c1', prompt: 'ping', schedule: '0 4 * * *', from: at(2026, 3, 10, 12, 0),
        });
        const listed = scheduler.listTasks('c1');
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, task.id);

        const miss = scheduler.cancelTask('no-such-task');
        assert.equal(miss.cancelled, false);
        const hit = scheduler.cancelTask(task.id);
        assert.equal(hit.cancelled, true);
        assert.equal(scheduler.listTasks('c1').length, 0);
    } finally { cleanup(); }
});

test('scheduleTask refuses a malformed cron instead of storing a task that never fires', () => {
    const { scheduler, database, cleanup } = makeScheduler();
    try {
        assert.throws(() => scheduler.scheduleTask({ prompt: 'x', schedule: 'nope' }), /Invalid cron/);
        assert.equal(database.getScheduledTasks('').length, 0);
    } finally { cleanup(); }
});

test('getDueScheduledTasks returns only active tasks that are actually due', () => {
    const { scheduler, database, cleanup } = makeScheduler();
    try {
        const base = at(2026, 3, 10, 12, 0);
        const due = scheduler.scheduleTask({ chatId: 'c', prompt: 'due', schedule: '* * * * *', from: base - 120000 });
        const later = scheduler.scheduleTask({ chatId: 'c', prompt: 'later', schedule: '0 3 1 1 *', from: base });
        const paused = scheduler.scheduleTask({ chatId: 'c', prompt: 'paused', schedule: '* * * * *', from: base - 120000 });
        database.setScheduledTaskStatus(paused.id, 'paused');

        const ids = database.getDueScheduledTasks(base).map((t) => t.id);
        assert.ok(ids.includes(due.id), 'a due task must be returned');
        assert.ok(!ids.includes(later.id), 'a future task must not be returned');
        assert.ok(!ids.includes(paused.id), 'a paused task must not be returned');
    } finally { cleanup(); }
});

// ===========================================================================
//  Execution
// ===========================================================================

test('tick runs due tasks, records the result, and reschedules', async () => {
    const seen = [];
    const { scheduler, database, cleanup } = makeScheduler({
        runner: async (task) => { seen.push(task.prompt); return 'ok:' + task.prompt; },
        now: () => at(2026, 3, 10, 12, 0),
    });
    try {
        const t = scheduler.scheduleTask({
            chatId: 'c', prompt: 'ping', schedule: '* * * * *', from: at(2026, 3, 10, 11, 58),
        });
        await scheduler.tick();
        await scheduler.drain();

        assert.deepEqual(seen, ['ping']);
        const row = database.getScheduledTasks('c').find((x) => x.id === t.id);
        assert.match(String(row.last_result), /ok:ping/);
        assert.ok(row.last_run > 0 || row.last_run_at > 0, 'a run timestamp must be recorded');
        assert.ok(row.next_run > at(2026, 3, 10, 12, 0), 'must be rescheduled into the future');
    } finally { cleanup(); }
});

test('SCHEDULER_ENABLED off means nothing runs', async () => {
    const seen = [];
    const { scheduler, cleanup } = makeScheduler({
        runner: async (t) => { seen.push(t.prompt); },
        killSwitches: { isEnabled: (name) => name !== 'SCHEDULER_ENABLED' },
        now: () => at(2026, 3, 10, 12, 0),
    });
    try {
        scheduler.scheduleTask({ prompt: 'blocked', schedule: '* * * * *', from: at(2026, 3, 10, 11, 58) });
        await scheduler.tick();
        await scheduler.drain();
        assert.deepEqual(seen, [], 'the kill switch must gate execution');
    } finally { cleanup(); }
});

test('a throwing task is recorded as failed and does not stop the others', async () => {
    const seen = [];
    const { scheduler, database, cleanup } = makeScheduler({
        runner: async (task) => {
            seen.push(task.prompt);
            if (task.prompt === 'boom') throw new Error('kaboom');
            return 'fine';
        },
        now: () => at(2026, 3, 10, 12, 0),
    });
    try {
        const from = at(2026, 3, 10, 11, 58);
        const bad = scheduler.scheduleTask({ chatId: 'c', prompt: 'boom', schedule: '* * * * *', from });
        scheduler.scheduleTask({ chatId: 'c', prompt: 'good-a', schedule: '* * * * *', from });
        scheduler.scheduleTask({ chatId: 'c', prompt: 'good-b', schedule: '* * * * *', from });

        await scheduler.tick();
        await scheduler.drain();

        assert.equal(seen.length, 3, 'every due task must be attempted');
        assert.ok(seen.includes('good-a') && seen.includes('good-b'));
        const row = database.getScheduledTasks('c').find((x) => x.id === bad.id);
        assert.match(String(row.last_result || row.last_error || ''), /kaboom/);
        assert.ok(row.next_run > at(2026, 3, 10, 12, 0), 'a failed task still reschedules');
    } finally { cleanup(); }
});

test('the overlap guard stops a still-running task from starting twice', async () => {
    let starts = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { scheduler, cleanup } = makeScheduler({
        runner: async () => { starts += 1; await gate; return 'done'; },
        now: () => at(2026, 3, 10, 12, 0),
    });
    try {
        scheduler.scheduleTask({ prompt: 'slow', schedule: '* * * * *', from: at(2026, 3, 10, 11, 58) });
        await scheduler.tick();          // starts the task, which blocks on `gate`
        await scheduler.tick();          // must NOT start it again
        await scheduler.tick();
        assert.equal(starts, 1, 'an in-flight task must not be restarted');
        release();
        await scheduler.drain();
    } finally { cleanup(); }
});

test('start/stop is clean and the timer never holds the process open', async () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
        scheduler.start();
        assert.ok(scheduler.timer, 'a timer should be installed');
        // An unref'd timer must not keep the event loop alive.
        assert.equal(typeof scheduler.timer.hasRef === 'function' ? scheduler.timer.hasRef() : false, false);
        await scheduler.stop();
        assert.equal(scheduler.timer, null);
        await scheduler.stop(); // idempotent
    } finally { cleanup(); }
});
