const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const InstanceSync = require('../core/InstanceSync');
const { AssistantDatabase } = require('../core/Database');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Fresh sqlite-backed InstanceSync in a TEMP baseDir (never the real store/).
 * SQLite keeps file handles open on Windows, so cleanup is best-effort — an
 * EPERM on rmSync must never fail a test.
 */
function makeInstance(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isync-'));
    const database = opts.database || new AssistantDatabase(path.join(dir, 'test.db'));
    const instance = new InstanceSync({
        database,
        baseDir: dir,
        selfId: opts.selfId || 'self',
        sharedSecret: opts.sharedSecret,
        transport: opts.transport,
        killSwitches: opts.killSwitches,
    });
    return {
        instance,
        database,
        dir,
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

// ===========================================================================
//  Security — token masking
// ===========================================================================

test('listPeers masks the token; the raw token appears nowhere in the serialised view', () => {
    const { instance, cleanup } = makeInstance();
    try {
        const rawToken = 'sekrit-token-abcdefgh12345';
        instance.addPeer({ id: 'peerA', url: 'http://peer.local:9999', token: rawToken, scopes: ['memories'] });

        const peers = instance.listPeers();
        const json = JSON.stringify(peers);

        assert.ok(!json.includes(rawToken), 'the raw token must never appear in listPeers() output');
        assert.equal(peers.length, 1);
        assert.equal(peers[0].hasToken, true);
        assert.ok(peers[0].tokenMasked.length > 0);
        assert.notEqual(peers[0].tokenMasked, rawToken);
        assert.equal(peers[0].token, undefined, 'no raw "token" field may leak onto the peer view at all');
    } finally { cleanup(); }
});

test('status() also never leaks a raw token, even with several peers', () => {
    const { instance, cleanup } = makeInstance();
    try {
        instance.addPeer({ id: 'p1', url: 'http://a.local', token: 'raw-token-one-123456', scopes: [] });
        instance.addPeer({ id: 'p2', url: 'http://b.local', token: 'raw-token-two-654321', scopes: ['config'] });

        const json = JSON.stringify(instance.status());
        assert.ok(!json.includes('raw-token-one-123456'));
        assert.ok(!json.includes('raw-token-two-654321'));
        assert.equal(instance.status().peerCount, 2);
        assert.equal(instance.status().sharingPeerCount, 1, 'only the peer with a granted scope counts as sharing');
    } finally { cleanup(); }
});

// ===========================================================================
//  Security — scope gating is the opt-in mechanism
// ===========================================================================

test('a peer granted ONLY "memories" receives no skills and no config on push', async () => {
    const { instance, database, dir, cleanup } = makeInstance();
    try {
        database.addMemory('c1', 'a memory to share', { source: 'test' });
        fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', 'note.md'), '# a skill file', 'utf8');

        instance.addPeer({ id: 'peerA', url: 'http://peer.local', token: 'tok-memories-only-1', scopes: ['memories'] });

        let captured = null;
        instance.transport = async ({ method, url, body }) => { captured = { method, url, body }; return { ok: true }; };

        const res = await instance.push('peerA');

        assert.equal(res.ok, true);
        assert.ok(captured, 'the transport must have been invoked');
        assert.deepEqual(captured.body.scopes, ['memories']);
        assert.ok(!('skills' in captured.body), 'skills must be entirely absent from a memories-only export');
        assert.ok(!('config' in captured.body), 'config must be entirely absent from a memories-only export');
        assert.equal(captured.body.memories.length, 1);
        assert.equal(captured.body.counts.memories, 1);
    } finally { cleanup(); }
});

test('a peer granted ONLY "skills" receives no memories and no config on push', async () => {
    const { instance, database, dir, cleanup } = makeInstance();
    try {
        database.addMemory('c1', 'a memory that must not leak', { source: 'test' });
        fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', 'note.md'), '# a skill file', 'utf8');

        instance.addPeer({ id: 'peerB', url: 'http://peer.local', token: 'tok-skills-only-12', scopes: ['skills'] });

        let captured = null;
        instance.transport = async ({ body }) => { captured = body; return { ok: true }; };

        await instance.push('peerB');

        assert.deepEqual(captured.scopes, ['skills']);
        assert.ok(!('memories' in captured), 'memories must be entirely absent from a skills-only export');
        assert.ok(!('config' in captured), 'config must be entirely absent from a skills-only export');
        assert.equal(captured.skills.length, 1);
        assert.equal(captured.skills[0].path, 'note.md');
    } finally { cleanup(); }
});

test('a peer granted ONLY "config" receives no memories and no skills on push', async () => {
    const { instance, database, dir, cleanup } = makeInstance();
    try {
        database.addMemory('c1', 'a memory that must not leak', { source: 'test' });
        database.setChatPreferences('global', { activeAgent: 'claude' });
        fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'skills', 'note.md'), '# a skill file', 'utf8');

        instance.addPeer({ id: 'peerC', url: 'http://peer.local', token: 'tok-config-only-12', scopes: ['config'] });

        let captured = null;
        instance.transport = async ({ body }) => { captured = body; return { ok: true }; };

        await instance.push('peerC');

        assert.deepEqual(captured.scopes, ['config']);
        assert.ok(!('memories' in captured), 'memories must be entirely absent from a config-only export');
        assert.ok(!('skills' in captured), 'skills must be entirely absent from a config-only export');
        assert.equal(captured.config.defaultAgent, 'claude');
    } finally { cleanup(); }
});

test('a peer with no scopes at all shares nothing: pull/push are skipped, not partially applied', async () => {
    const { instance, cleanup } = makeInstance();
    try {
        instance.addPeer({ id: 'silent', url: 'http://peer.local', token: 'tok-no-scopes-1234' });
        let called = false;
        instance.transport = async () => { called = true; return {}; };

        const pushRes = await instance.push('silent');
        const pullRes = await instance.pull('silent');

        assert.equal(pushRes.skipped, true);
        assert.equal(pullRes.skipped, true);
        assert.equal(called, false, 'the transport must never be invoked when nothing is shared');
    } finally { cleanup(); }
});

// ===========================================================================
//  Security — config export is allow-listed, and secret-shaped keys are scrubbed
// ===========================================================================

test('a config-ish key that looks like a secret is never exported, even under the config scope', () => {
    const { instance, cleanup } = makeInstance({
        killSwitches: { getAll: () => ({ FOO_API_KEY: 'sk-should-never-leave-1234', BAR_ENABLED: true }) },
    });
    try {
        const payload = instance.export({ scopes: ['config'] });
        const json = JSON.stringify(payload);

        assert.ok(!json.includes('sk-should-never-leave-1234'), 'a secret-shaped value must never appear in the export');
        assert.ok(!/FOO_API_KEY/i.test(json), 'a key containing API_KEY must be scrubbed even nested inside an allow-listed section');
        assert.ok(payload.config.killSwitches, 'the allow-listed killSwitches section itself must still be present');
        assert.equal(payload.config.killSwitches.BAR_ENABLED, true, 'a benign sibling key must survive the scrub');
        assert.equal(payload.config.killSwitches.FOO_API_KEY, undefined);
    } finally { cleanup(); }
});

test('export({configKeys}) can only NARROW the allow-list, never add a key to it', () => {
    const { instance, database, cleanup } = makeInstance();
    try {
        database.setChatPreferences('global', { activeAgent: 'claude' });

        const payload = instance.export({
            scopes: ['config'],
            configKeys: ['defaultAgent', 'NOT_A_REAL_KEY', 'INSTANCE_SYNC_SECRET', 'sharedSecret'],
        });

        assert.deepEqual(Object.keys(payload.config), ['defaultAgent']);
        assert.equal(payload.config.defaultAgent, 'claude');
    } finally { cleanup(); }
});

test('the config allow-list itself contains no key that looks like a credential', () => {
    for (const { key } of InstanceSync.configAllowList()) {
        assert.ok(!/secret|token|password|apikey|api_key/i.test(key), `allow-listed key "${key}" looks like a credential`);
    }
});

// ===========================================================================
//  Security — constant-time shared-secret verification
// ===========================================================================

test('verifySharedSecret accepts the right secret and rejects a wrong one AND a wrong-length one, without throwing', () => {
    const { instance, cleanup } = makeInstance({ sharedSecret: 'correct-secret-value' });
    try {
        assert.equal(instance.verifySharedSecret('correct-secret-value'), true);

        // Same length, wrong content.
        assert.doesNotThrow(() => instance.verifySharedSecret('wrong-secret-value!!'));
        assert.equal(instance.verifySharedSecret('wrong-secret-value!!'), false);

        // Different length — this is exactly what makes crypto.timingSafeEqual
        // throw if called directly; verifySharedSecret must guard it.
        assert.doesNotThrow(() => instance.verifySharedSecret('short'));
        assert.equal(instance.verifySharedSecret('short'), false);
        assert.doesNotThrow(() => instance.verifySharedSecret('a-much-much-much-longer-secret-than-expected'));
        assert.equal(instance.verifySharedSecret('a-much-much-much-longer-secret-than-expected'), false);

        assert.equal(instance.verifySharedSecret(''), false);
        assert.equal(instance.verifySharedSecret(null), false);
        assert.equal(instance.verifySharedSecret(undefined), false);
    } finally { cleanup(); }
});

test('verifySharedSecret always returns false when no secret is configured', () => {
    const { instance, cleanup } = makeInstance({ sharedSecret: null });
    try {
        assert.equal(instance.verifySharedSecret('anything'), false);
        assert.equal(instance.verifySharedSecret(''), false);
    } finally { cleanup(); }
});

// ===========================================================================
//  peerForToken
// ===========================================================================

test('peerForToken resolves a known token and returns a falsy value for an unknown one', () => {
    const { instance, cleanup } = makeInstance();
    try {
        instance.addPeer({ id: 'peerA', url: 'http://peer.local', token: 'tok-A-123456789', scopes: ['memories', 'skills'] });
        instance.addPeer({ id: 'peerB', url: 'http://other.local', token: 'tok-B-987654321', scopes: [] });

        const found = instance.peerForToken('tok-A-123456789');
        assert.ok(found);
        assert.equal(found.id, 'peerA');
        assert.deepEqual(found.scopes.sort(), ['memories', 'skills'].sort());
        assert.equal(found.token, undefined, 'the resolved descriptor must not carry the raw token either');

        assert.ok(!instance.peerForToken('not-a-real-token-at-all'));
        assert.ok(!instance.peerForToken(''));
        assert.ok(!instance.peerForToken(null));
    } finally { cleanup(); }
});

// ===========================================================================
//  export({since}) cursor
// ===========================================================================

test('export({since}) excludes memories older than the cursor', () => {
    const { instance, database, cleanup } = makeInstance();
    try {
        const raw = database.db;
        const insert = raw.prepare(`
            INSERT INTO memories (chat_id, source, raw_text, summary, importance, salience, created_at, accessed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insert.run('c1', 'test', 'old memory before the cursor', 'old memory before the cursor', 0.5, 1.0, 1000, 1000);
        insert.run('c1', 'test', 'new memory after the cursor', 'new memory after the cursor', 0.5, 1.0, 5000, 5000);

        const payload = instance.export({ scopes: ['memories'], since: 4000 });

        assert.equal(payload.memories.length, 1);
        assert.equal(payload.memories[0].text, 'new memory after the cursor');
    } finally { cleanup(); }
});

// ===========================================================================
//  Import idempotency
// ===========================================================================

test('import is idempotent: importing the same payload twice does not duplicate rows', () => {
    const { instance, database, cleanup } = makeInstance();
    try {
        const payload = {
            instanceId: 'peerX',
            exportedAt: 10000,
            scopes: ['memories'],
            memories: [{
                chatId: 'c1', source: 'peerX', text: 'idempotent sentinel memory',
                summary: 'idempotent sentinel memory', importance: 0.5, salience: 1, createdAt: 9000,
            }],
        };

        const r1 = instance.import(payload, { scopes: ['memories'], peerId: 'peerX' });
        assert.equal(r1.memories.imported, 1);
        const countAfterFirst = database.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;

        const r2 = instance.import(payload, { scopes: ['memories'], peerId: 'peerX' });
        assert.equal(r2.memories.imported, 0);
        assert.equal(r2.memories.skipped, 1);
        const countAfterSecond = database.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;

        assert.equal(countAfterSecond, countAfterFirst, 'replaying the same payload must never duplicate rows');
        assert.equal(countAfterFirst, 1);
    } finally { cleanup(); }
});

// ===========================================================================
//  Full A -> B round trip
// ===========================================================================

test('a full A -> B round trip replicates A\'s memories into B', () => {
    const a = makeInstance({ selfId: 'A' });
    const b = makeInstance({ selfId: 'B' });
    try {
        a.database.addMemory('shared-chat', 'A said the sky is blue today', { source: 'A', importance: 0.6 });
        a.database.addMemory('shared-chat', 'A also noted rain is expected', { source: 'A', importance: 0.4 });

        const payload = a.instance.export({ scopes: ['memories'] });
        assert.equal(payload.memories.length, 2);

        const report = b.instance.import(payload, { scopes: ['memories'], peerId: 'A' });

        assert.equal(report.memories.imported, 2);
        const rows = b.database.db.prepare('SELECT * FROM memories WHERE chat_id = ?').all('shared-chat');
        assert.equal(rows.length, 2);
        assert.ok(rows.some(r => r.raw_text === 'A said the sky is blue today'));
        assert.ok(rows.some(r => r.raw_text === 'A also noted rain is expected'));
    } finally { a.cleanup(); b.cleanup(); }
});

// ===========================================================================
//  Garbage input handling
// ===========================================================================

test('import of a garbage or partial payload never throws and never corrupts local state', () => {
    const { instance, database, cleanup } = makeInstance();
    try {
        database.addMemory('c1', 'pre-existing local memory', {});
        const before = database.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;

        const garbageInputs = [
            null, undefined, 'a plain string', 42, [], true,
            { memories: 'not-an-array' },
            { memories: [null, 42, 'oops', { text: '' }, { text: '   ' }] },
            { skills: [{ path: '../../etc/passwd', content: 'evil' }, { path: 'C:\\Windows\\bad.md', content: 'evil' }] },
            { config: { NOT_ALLOWLISTED_KEY: 'value', __proto__: 'oops' } },
        ];

        for (const garbage of garbageInputs) {
            assert.doesNotThrow(() => instance.import(garbage, { scopes: ['memories', 'skills', 'config'] }));
        }

        const after = database.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        assert.equal(after, before, 'garbage payloads must never add rows');
    } finally { cleanup(); }
});

test('import rejects a skill path that tries to escape the skills directory', () => {
    const { instance, dir, cleanup } = makeInstance();
    try {
        const payload = {
            instanceId: 'attacker',
            exportedAt: Date.now(),
            skills: [
                { path: '../../outside.md', content: 'malicious', modifiedAt: Date.now() },
                { path: 'ok/inside.md', content: 'fine', modifiedAt: Date.now() },
            ],
        };
        const report = instance.import(payload, { scopes: ['skills'], peerId: 'attacker' });

        assert.equal(report.skills.written, 1);
        assert.equal(report.skills.rejected, 1);
        assert.ok(!fs.existsSync(path.join(dir, 'outside.md')));
        assert.ok(fs.existsSync(path.join(dir, 'skills', 'ok', 'inside.md')));
    } finally { cleanup(); }
});

// ===========================================================================
//  syncAll isolates a failing peer
// ===========================================================================

test('syncAll/pull isolates a failing peer: it is reported as failed and the others still sync', async () => {
    const { instance, cleanup } = makeInstance();
    try {
        instance.addPeer({ id: 'good', url: 'http://good.local', token: 'tok-good-1234567', scopes: ['memories'] });
        instance.addPeer({ id: 'bad', url: 'http://bad.local', token: 'tok-bad-12345678', scopes: ['memories'] });

        instance.transport = async ({ url }) => {
            if (url.includes('bad.local')) throw new Error('connection refused');
            return {
                instanceId: 'good', exportedAt: Date.now(), scopes: ['memories'],
                memories: [], counts: { memories: 0, skills: 0, config: 0 },
            };
        };

        const res = await instance.syncAll({ direction: 'pull' });

        assert.equal(res.total, 2);
        assert.equal(res.succeeded, 1);
        assert.equal(res.failed, 1);
        assert.equal(res.ok, false);

        const badResult = res.results.find(r => r.peerId === 'bad');
        const goodResult = res.results.find(r => r.peerId === 'good');
        assert.equal(badResult.ok, false);
        assert.match(badResult.error, /connection refused/);
        assert.equal(goodResult.ok, true);
    } finally { cleanup(); }
});

// ===========================================================================
//  Persistence round trip
// ===========================================================================

test('peer state survives a save/load round trip: a new instance over the same baseDir sees the same peers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isync-persist-'));
    try {
        const database = new AssistantDatabase(path.join(dir, 'test.db'));
        const instance1 = new InstanceSync({ database, baseDir: dir, selfId: 'self' });
        instance1.addPeer({
            id: 'peerA', url: 'http://peer.local', token: 'tok-persisted-1234',
            scopes: ['memories', 'skills'], label: 'Laptop',
        });

        assert.ok(fs.existsSync(path.join(dir, 'store', 'instance-peers.json')));

        const instance2 = new InstanceSync({ database, baseDir: dir, selfId: 'self' });
        const peers = instance2.listPeers();

        assert.equal(peers.length, 1);
        assert.equal(peers[0].id, 'peerA');
        assert.deepEqual(peers[0].scopes.sort(), ['memories', 'skills'].sort());
        assert.equal(peers[0].label, 'Laptop');
        assert.equal(peers[0].hasToken, true);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
    }
});
