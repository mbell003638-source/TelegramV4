const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const MemorySearch = require('../core/MemorySearch');
const { AssistantDatabase } = require('../core/Database');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Fresh sqlite-backed memory index in a temp dir. SQLite keeps file handles
 * open on Windows, so cleanup is best-effort — an EPERM on rmSync must never
 * fail a test.
 */
function makeMemorySearch(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-'));
    const database = new AssistantDatabase(path.join(dir, 'test.db'));
    const memorySearch = new MemorySearch({ database, ...opts });
    return {
        memorySearch,
        database,
        dir,
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

// ===========================================================================
//  Indexing & search
// ===========================================================================

test('index() then search() returns the seeded memory', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        const id = memorySearch.index({
            chatId: 'chat1', text: 'The quick brown fox jumps over the lazy dog', source: 'unit-test',
        });
        assert.ok(Number.isInteger(id));

        const results = memorySearch.search('fox');
        assert.ok(Array.isArray(results));
        assert.equal(results.length, 1);
        assert.equal(results[0].text, 'The quick brown fox jumps over the lazy dog');
        assert.equal(results[0].chatId, 'chat1');
        assert.equal(results[0].source, 'unit-test');
    } finally { cleanup(); }
});

test('a better-matching row ranks first', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        memorySearch.index({
            chatId: 'rank', source: 'low',
            text: 'zephyrite is mentioned once in an otherwise unrelated long passage about '
                + 'gardening, weather, and the daily commute that keeps going for quite a while',
            summary: 'gardening and commute notes',
        });
        memorySearch.index({
            chatId: 'rank', source: 'high',
            text: 'zephyrite zephyrite zephyrite core alloy specification',
            summary: 'zephyrite alloy briefing',
        });

        const results = memorySearch.search('zephyrite', { chatId: 'rank' });
        assert.equal(results.length, 2);
        assert.equal(results[0].source, 'high', 'the denser, summary-matching row must rank first');
        assert.equal(results[1].source, 'low');
        assert.ok(results[0].score > results[1].score);
    } finally { cleanup(); }
});

// ===========================================================================
//  Filtering
// ===========================================================================

test('search filters by chatId and by agentId', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        memorySearch.index({ chatId: 'chatA', agentId: 'agentX', text: 'octopus research notes alpha' });
        memorySearch.index({ chatId: 'chatB', agentId: 'agentY', text: 'octopus research notes beta' });

        const byChat = memorySearch.search('octopus', { chatId: 'chatA' });
        assert.equal(byChat.length, 1);
        assert.equal(byChat[0].chatId, 'chatA');
        assert.ok(!byChat.some((r) => r.text.includes('beta')), 'chatB row must be excluded');

        const byAgent = memorySearch.search('octopus', { agentId: 'agentY' });
        assert.equal(byAgent.length, 1);
        assert.equal(byAgent[0].agentId, 'agentY');
        assert.ok(!byAgent.some((r) => r.text.includes('alpha')), 'agentX row must be excluded');
    } finally { cleanup(); }
});

// ===========================================================================
//  Query sanitizing — must never throw on FTS5 operator characters
// ===========================================================================

test('search() never throws on FTS5 operator characters and always returns an array', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        memorySearch.index({ chatId: 'sanitize', text: 'a normal seeded row about AND OR NOT tokens' });

        const nasty = [
            `it's a "test"`,
            'foo* OR -bar (baz)',
            'NEAR',
            '"unbalanced',
            'AND OR NOT',
            '***',
            'a AND',
        ];
        for (const query of nasty) {
            let results;
            assert.doesNotThrow(() => { results = memorySearch.search(query); }, `search() must not throw on: ${query}`);
            assert.ok(Array.isArray(results), `search() must return an array for: ${query}`);
        }
    } finally { cleanup(); }
});

test('an empty or whitespace-only query returns [] without dumping the table', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        memorySearch.index({ chatId: 'c', text: 'row one is here' });
        memorySearch.index({ chatId: 'c', text: 'row two is here' });
        memorySearch.index({ chatId: 'c', text: 'row three is here' });
        assert.equal(memorySearch.stats().indexed, 3, 'sanity: the table is non-empty');

        assert.deepEqual(memorySearch.search(''), []);
        assert.deepEqual(memorySearch.search('   '), []);
    } finally { cleanup(); }
});

// ===========================================================================
//  Reindexing
// ===========================================================================

test('reindexAll() picks up rows written to memories before the instance existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-'));
    try {
        const database = new AssistantDatabase(path.join(dir, 'test.db'));
        database.addMemory('preexist', 'a memory about narwhal migration patterns',
            { importance: 0.6, salience: 0.7, source: 'pretest' });
        database.addMemory('preexist', 'a memory about tundra logistics planning',
            { importance: 0.6, salience: 0.7, source: 'pretest' });

        // autoIndex:false so construction itself does not silently backfill —
        // this isolates reindexAll() itself as the thing under test.
        const memorySearch = new MemorySearch({ database, autoIndex: false });
        assert.equal(memorySearch.stats().indexed, 0, 'nothing indexed yet with autoIndex disabled');
        assert.deepEqual(memorySearch.search('narwhal', { chatId: 'preexist' }), []);

        const result = memorySearch.reindexAll();
        assert.equal(result.memories, 2);

        const found = memorySearch.search('narwhal', { chatId: 'preexist' });
        assert.equal(found.length, 1);
        assert.match(found[0].text, /narwhal/);
        assert.equal(memorySearch.stats().indexed, 2);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
    }
});

// ===========================================================================
//  Pruning & clearing
// ===========================================================================

test('prune() removes what it should and keeps the rest', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        const now = Date.now();
        memorySearch.index({ chatId: 'age', text: 'stale entry from long ago', createdAt: now - 1000000 });
        memorySearch.index({ chatId: 'age', text: 'fresh entry from just now', createdAt: now });
        memorySearch.index({ chatId: 'sal', text: 'low salience entry', salience: 0.05 });
        memorySearch.index({ chatId: 'sal', text: 'high salience entry', salience: 0.9 });
        assert.equal(memorySearch.stats().indexed, 4);

        const removedByAge = memorySearch.prune({ olderThanMs: 500000 });
        assert.equal(removedByAge, 1);
        const remainingAge = memorySearch.search('entry', { chatId: 'age' });
        assert.equal(remainingAge.length, 1);
        assert.match(remainingAge[0].text, /fresh/);

        const removedBySalience = memorySearch.prune({ minSalience: 0.5 });
        assert.equal(removedBySalience, 1);
        const remainingSal = memorySearch.search('entry', { chatId: 'sal' });
        assert.equal(remainingSal.length, 1);
        assert.match(remainingSal[0].text, /high/);

        assert.equal(memorySearch.stats().indexed, 2);
    } finally { cleanup(); }
});

test('clear() drops all indexed rows without touching the source tables', () => {
    const { memorySearch, database, cleanup } = makeMemorySearch();
    try {
        memorySearch.index({ chatId: 'wipe', text: 'entry that will be cleared' });
        database.addMemory('wipe', 'a source memory row that should survive clear()', { source: 'clear-test' });
        memorySearch.reindexAll();
        assert.equal(memorySearch.stats().indexed, 2);

        const ok = memorySearch.clear();
        assert.equal(ok, true);
        assert.equal(memorySearch.stats().indexed, 0);
        assert.deepEqual(memorySearch.search('entry', { chatId: 'wipe' }), []);

        // clear() only empties the memory_index / FTS shadow — the underlying
        // `memories` table it was built from is untouched.
        const sourceRows = database.getMemories('wipe', { minSalience: 0 });
        assert.equal(sourceRows.length, 1);
    } finally { cleanup(); }
});

// ===========================================================================
//  Persistence
// ===========================================================================

test('a second AssistantDatabase + MemorySearch over the same file can still search indexed rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memsearch-'));
    const dbPath = path.join(dir, 'test.db');
    try {
        const database1 = new AssistantDatabase(dbPath);
        const memorySearch1 = new MemorySearch({ database: database1 });
        memorySearch1.index({ chatId: 'persist', text: 'persistent knowledge about narwhal migration corridors' });

        const database2 = new AssistantDatabase(dbPath);
        const memorySearch2 = new MemorySearch({ database: database2 });
        const results = memorySearch2.search('narwhal', { chatId: 'persist' });

        assert.equal(results.length, 1);
        assert.match(results[0].text, /narwhal/);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
    }
});

// ===========================================================================
//  FTS5 vs LIKE-fallback mode
// ===========================================================================

test('defaults to fts5 mode when FTS5 is available (confirmed on this SQLite build)', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        assert.equal(memorySearch.ftsAvailable, true);
        assert.equal(memorySearch.stats().mode, 'fts5');
        assert.equal(memorySearch.ftsError, null);
    } finally { cleanup(); }
});

test('forceFallback:true disables FTS5 but search still works via the LIKE ranker', () => {
    const { memorySearch, cleanup } = makeMemorySearch({ forceFallback: true });
    try {
        assert.equal(memorySearch.ftsAvailable, false);
        assert.equal(memorySearch.stats().mode, 'fallback');

        memorySearch.index({ chatId: 'fb', text: 'fallback mode search over pangolin habitats' });
        const results = memorySearch.search('pangolin', { chatId: 'fb' });
        assert.equal(results.length, 1);
        assert.match(results[0].text, /pangolin/);
    } finally { cleanup(); }
});

// ===========================================================================
//  Stats & recent context
// ===========================================================================

test('stats().indexed is sane and grows as rows are indexed', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        const s0 = memorySearch.stats();
        assert.equal(s0.indexed, 0);
        assert.equal(s0.chats, 0);

        memorySearch.index({ chatId: 'growth', text: 'first tracked memory entry' });
        const s1 = memorySearch.stats();
        assert.equal(s1.indexed, 1);

        memorySearch.index({ chatId: 'growth', text: 'second tracked memory entry' });
        const s2 = memorySearch.stats();
        assert.equal(s2.indexed, 2);
        assert.ok(s2.indexed > s1.indexed);
        assert.ok(s2.chats >= 1);
        assert.ok(s2.newestAt >= s2.oldestAt);
    } finally { cleanup(); }
});

test('recentContext() respects the limit and returns the most recent entries first', () => {
    const { memorySearch, cleanup } = makeMemorySearch();
    try {
        const base = Date.now() - 100000;
        for (let i = 0; i < 5; i++) {
            memorySearch.index({ chatId: 'ctx', text: `context entry number ${i}`, createdAt: base + i * 1000 });
        }

        const recent = memorySearch.recentContext('ctx', 2);
        assert.equal(recent.length, 2);
        assert.equal(recent[0].text, 'context entry number 4');
        assert.equal(recent[1].text, 'context entry number 3');
    } finally { cleanup(); }
});
