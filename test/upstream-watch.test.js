const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const UpstreamWatch = require('../core/UpstreamWatch');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

// The local-clone path is exercised against a REAL git repo so behaviour
// matches production exactly. If `git` is not on PATH in this environment,
// those tests skip rather than fail.
let gitAvailable = true;
try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
    gitAvailable = false;
}

/**
 * Fresh UpstreamWatch over a temp baseDir/clonesDir so the real store/ is
 * never touched. `sources` is required (even a placeholder) so a test never
 * accidentally falls back to the real 7-project DEFAULT_SOURCES list, which
 * the constructor does whenever `sources` is missing or empty.
 * Cleanup is best-effort: Windows can hold file handles open (e.g. git's
 * index lock), so every caller wraps rmSync in try/catch.
 */
function makeWatch(sources, opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-watch-'));
    const baseDir = path.join(root, 'base');
    const clonesDir = path.join(root, 'clones');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(clonesDir, { recursive: true });
    const watch = new UpstreamWatch({ baseDir, clonesDir, sources, ...opts });
    return {
        watch, baseDir, clonesDir, root,
        cleanup() {
            try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

function git(dir, args) {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A tiny real git repo at <clonesDir>/<id>, with one commit per subject (oldest first). */
function makeLocalClone(clonesDir, id, subjects) {
    const dir = path.join(clonesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '--quiet']);
    for (const subject of subjects) {
        fs.appendFileSync(path.join(dir, 'file.txt'), subject + '\n');
        git(dir, ['add', '.']);
        git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '--quiet', '-m', subject]);
    }
    return dir;
}

/** A path that looks like a clone (has .git) but is not a usable repo — triggers the error path with no network. */
function makeBrokenClone(clonesDir, id) {
    const dir = path.join(clonesDir, id);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
}

const SRC = (id) => ({ id, repo: `test-org/${id}`, note: `note for ${id}` });

// ===========================================================================
//  localClonePath
// ===========================================================================

test('localClonePath returns the clone dir when .git exists, null otherwise', () => {
    const { watch, clonesDir, cleanup } = makeWatch([SRC('placeholder')]);
    try {
        fs.mkdirSync(path.join(clonesDir, 'has-clone', '.git'), { recursive: true });

        assert.equal(watch.localClonePath(SRC('has-clone')), path.join(clonesDir, 'has-clone'));
        assert.equal(watch.localClonePath(SRC('no-clone')), null);
    } finally { cleanup(); }
});

// ===========================================================================
//  Local mode
// ===========================================================================

test('checkSource in local mode reports mode=local, a headSha, and shaped newCommits', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const source = SRC('proj-a');
    const { watch, clonesDir, cleanup } = makeWatch([source]);
    try {
        makeLocalClone(clonesDir, source.id, ['first', 'second', 'third']);

        const report = await watch.checkSource(source);

        assert.equal(report.error, null);
        assert.equal(report.mode, 'local');
        assert.match(report.headSha, /^[0-9a-f]{40}$/);
        assert.equal(report.newCommits.length, 3);

        // git log lists newest first.
        assert.equal(report.newCommits[0].subject, 'third');
        assert.equal(report.newCommits[1].subject, 'second');
        assert.equal(report.newCommits[2].subject, 'first');

        for (const c of report.newCommits) {
            assert.match(c.sha, /^[0-9a-f]{40}$/);
            assert.equal(c.shortSha, c.sha.slice(0, 8));
            assert.equal(c.author, 'Test');
            assert.ok(c.date, 'date must be present');
            assert.ok(c.subject, 'subject must be present');
        }
    } finally { cleanup(); }
});

// ===========================================================================
//  First look vs up to date vs a new commit landing later
// ===========================================================================

test('first look reports upToDate=false with the latest window; acknowledge then re-check reports upToDate=true', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const source = SRC('proj-b');
    const { watch, clonesDir, cleanup } = makeWatch([source]);
    try {
        makeLocalClone(clonesDir, source.id, ['a', 'b']);

        const first = await watch.checkSource(source);
        assert.equal(first.lastSeenSha, null, 'no baseline has been acknowledged yet');
        assert.equal(first.upToDate, false, 'with no baseline this must not claim to be up to date');
        assert.equal(first.newCount, 2);
        assert.equal(first.newCommits.length, 2);

        const acked = watch.acknowledge([first]);
        assert.deepEqual(acked, [source.id]);

        const second = await watch.checkSource(source);
        assert.equal(second.lastSeenSha, first.headSha);
        assert.equal(second.upToDate, true);
        assert.equal(second.newCount, 0);
        assert.deepEqual(second.newCommits, []);
    } finally { cleanup(); }
});

test('a commit landing after acknowledge is the only one reported next time', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const source = SRC('proj-c');
    const { watch, clonesDir, cleanup } = makeWatch([source]);
    try {
        const dir = makeLocalClone(clonesDir, source.id, ['a', 'b']);
        const first = await watch.checkSource(source);
        watch.acknowledge([first]);

        // One more commit lands upstream after the acknowledge.
        fs.appendFileSync(path.join(dir, 'file.txt'), 'c\n');
        git(dir, ['add', '.']);
        git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'c']);

        const after = await watch.checkSource(source);
        assert.equal(after.upToDate, false);
        assert.equal(after.newCount, 1);
        assert.equal(after.newCommits.length, 1);
        assert.equal(after.newCommits[0].subject, 'c');
        assert.notEqual(after.headSha, first.headSha);
        assert.equal(after.lastSeenSha, first.headSha);
    } finally { cleanup(); }
});

// ===========================================================================
//  Persistence
// ===========================================================================

test('acknowledge persists to disk: a new UpstreamWatch over the same baseDir remembers the seen sha', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const source = SRC('proj-d');
    const { watch, baseDir, clonesDir, cleanup } = makeWatch([source]);
    try {
        makeLocalClone(clonesDir, source.id, ['a']);
        const first = await watch.checkSource(source);
        watch.acknowledge([first]);

        const statePath = path.join(baseDir, 'store', 'upstream-watch.json');
        assert.ok(fs.existsSync(statePath), 'acknowledge must persist state to <baseDir>/store/upstream-watch.json');
        const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.equal(onDisk.seen[source.id].sha, first.headSha);

        // A brand new instance, same baseDir/clonesDir, no shared in-memory state.
        const watch2 = new UpstreamWatch({ baseDir, clonesDir, sources: [source] });
        const second = await watch2.checkSource(source);
        assert.equal(second.lastSeenSha, first.headSha);
        assert.equal(second.upToDate, true);
        assert.equal(second.newCount, 0);
    } finally { cleanup(); }
});

// ===========================================================================
//  acknowledge edge cases
// ===========================================================================

test('acknowledge skips errored or headSha-less entries and returns only the ids it acked', () => {
    const { watch, cleanup } = makeWatch([SRC('placeholder')]);
    try {
        const reports = [
            { id: 'ok1', headSha: 'sha1', error: null },
            { id: 'errored', headSha: 'sha2', error: 'boom' },
            { id: 'nohead', headSha: null, error: null },
            null,
            { id: 'ok2', headSha: 'sha3', error: null },
        ];

        const acked = watch.acknowledge(reports);

        assert.deepEqual(acked, ['ok1', 'ok2']);
        assert.equal(watch.state.seen.ok1.sha, 'sha1');
        assert.equal(watch.state.seen.ok2.sha, 'sha3');
        assert.ok(!watch.state.seen.errored, 'an errored entry must not be recorded as seen');
        assert.ok(!watch.state.seen.nohead, 'a headSha-less entry must not be recorded as seen');
    } finally { cleanup(); }
});

test('acknowledge with nothing ackable does not write a state file', () => {
    const { watch, baseDir, cleanup } = makeWatch([SRC('placeholder')]);
    try {
        const acked = watch.acknowledge([
            { id: 'x', headSha: null, error: null },
            { id: 'y', headSha: 'z', error: 'nope' },
        ]);

        assert.deepEqual(acked, []);
        assert.equal(fs.existsSync(path.join(baseDir, 'store', 'upstream-watch.json')), false);
    } finally { cleanup(); }
});

// ===========================================================================
//  Error resilience
// ===========================================================================

test('a source that cannot be checked sets error and does not throw', async () => {
    const source = SRC('broken');
    const { watch, clonesDir, cleanup } = makeWatch([source]);
    try {
        makeBrokenClone(clonesDir, source.id); // has .git, so local mode is chosen, but it is not a usable repo

        const report = await watch.checkSource(source);

        assert.equal(report.mode, 'local', 'mode is chosen from localClonePath before the failure occurs');
        assert.ok(report.error, 'an unusable clone must surface as report.error, not a throw');
        assert.equal(report.headSha, null);
        assert.equal(report.newCommits.length, 0);
    } finally { cleanup(); }
});

test('checkAll keeps sweeping the rest of the sources after one errors', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const good = SRC('good-1');
    const bad = SRC('bad-1');
    const { watch, clonesDir, cleanup } = makeWatch([good, bad]);
    try {
        makeLocalClone(clonesDir, good.id, ['x']);
        makeBrokenClone(clonesDir, bad.id);

        const result = await watch.checkAll();

        assert.equal(result.total, 2, 'one failure must not abort the sweep');
        const goodReport = result.reports.find((r) => r.id === good.id);
        const badReport = result.reports.find((r) => r.id === bad.id);
        assert.ok(goodReport && !goodReport.error);
        assert.ok(badReport && badReport.error);
    } finally { cleanup(); }
});

test('checkAll counts total, withUpdates and errored correctly', async (t) => {
    if (!gitAvailable) return t.skip('git binary not available in this environment');
    const withNew = SRC('with-new');
    const upToDateSrc = SRC('up-to-date');
    const broken = SRC('broken-2');
    const { watch, clonesDir, cleanup } = makeWatch([withNew, upToDateSrc, broken]);
    try {
        makeLocalClone(clonesDir, withNew.id, ['a']);
        makeLocalClone(clonesDir, upToDateSrc.id, ['a']);
        makeBrokenClone(clonesDir, broken.id);

        // Pre-acknowledge only the "up to date" source.
        const pre = await watch.checkSource(upToDateSrc);
        watch.acknowledge([pre]);

        const result = await watch.checkAll();

        assert.equal(result.total, 3);
        assert.equal(result.errored, 1);
        assert.equal(result.withUpdates, 1, 'only withNew has newCount > 0 and no error');
        assert.equal(typeof result.checkedAt, 'number');
        assert.equal(result.reports.length, 3);
    } finally { cleanup(); }
});

// ===========================================================================
//  formatDigest
// ===========================================================================

test('formatDigest renders an up-to-date line, a first-look listing, and an error line', () => {
    const result = {
        reports: [
            { id: 'quiet', error: null, upToDate: true, newCount: 0, lastSeenSha: 'abc', mode: 'local', newCommits: [] },
            {
                id: 'active', error: null, upToDate: false, newCount: 2, lastSeenSha: null, mode: 'local',
                newCommits: [
                    { shortSha: 'deadbeef', subject: 'add feature' },
                    { shortSha: 'cafebabe', subject: 'fix bug' },
                ],
            },
            { id: 'broken', error: 'HTTP 500', upToDate: false, newCount: 0, lastSeenSha: null, mode: null, newCommits: [] },
        ],
    };

    const digest = UpstreamWatch.formatDigest(result);

    assert.match(digest, /- quiet: up to date/);
    assert.match(digest, /- active: latest 2 commit\(s\), first look \[local\]/);
    assert.match(digest, /deadbeef {2}add feature/);
    assert.match(digest, /cafebabe {2}fix bug/);
    assert.match(digest, /- broken: could not check \(HTTP 500\)/);
});

test('formatDigest labels a subsequent-look update as "N new commit(s)" (not "first look")', () => {
    const result = {
        reports: [
            {
                id: 'proj', error: null, upToDate: false, newCount: 1, lastSeenSha: 'priorsha', mode: 'local',
                newCommits: [{ shortSha: 'abc12345', subject: 'a small fix' }],
            },
        ],
    };

    const digest = UpstreamWatch.formatDigest(result);

    assert.match(digest, /- proj: 1 new commit\(s\) \[local\]/);
    assert.doesNotMatch(digest, /first look/);
});

test('formatDigest truncates long commit lists with a "...and N more" line', () => {
    const newCommits = Array.from({ length: 7 }, (_, i) => ({ shortSha: `sha${i}`, subject: `commit ${i}` }));
    const result = { reports: [{ id: 'busy', error: null, upToDate: false, newCount: 7, lastSeenSha: 'x', mode: 'local', newCommits }] };

    const digest = UpstreamWatch.formatDigest(result);

    assert.match(digest, /- busy: 7 new commit\(s\) \[local\]/);
    const detailLines = digest.split('\n').filter((l) => l.includes('commit '));
    assert.equal(detailLines.length, 5, 'only the first 5 commits are listed');
    assert.match(digest, /\.\.\.and 2 more/);
});

test('formatDigest does not throw on null or garbage top-level input', () => {
    assert.equal(UpstreamWatch.formatDigest(null), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest(undefined), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest({}), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest([]), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest({ reports: 'nope' }), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest({ reports: 123 }), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest('just a string'), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest(42), 'No upstream report available.');
    assert.equal(UpstreamWatch.formatDigest({ reports: [] }), '');
});

// ===========================================================================
//  Remote-mode precondition (see the test report for what is intentionally
//  NOT covered here: this repo must never make a network call).
// ===========================================================================

test('a source with no local clone has no clone path, which is the sole precondition for remote mode', () => {
    const { watch, cleanup } = makeWatch([SRC('placeholder')]);
    try {
        // checkSource() would set report.mode = 'remote' and call the GitHub
        // API for exactly this condition (localClonePath returns null). That
        // call is intentionally not exercised here — see report for details.
        assert.equal(watch.localClonePath(SRC('never-cloned')), null);
    } finally { cleanup(); }
});
