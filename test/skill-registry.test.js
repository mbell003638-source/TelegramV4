const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const SkillRegistry = require('../core/SkillRegistry');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * A registry rooted in a throwaway temp tree — the real ./skills is never
 * touched. The base dir is deliberately NESTED a few levels below the temp
 * root so that any `../..` escape would land inside the root and therefore be
 * caught by the tree snapshot in the traversal tests. Cleanup is best-effort:
 * rmSync can throw EPERM on Windows and must never fail a test.
 */
function makeRegistry() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillreg-'));
    const baseDir = path.join(root, 'nest', 'deeper', 'app');
    fs.mkdirSync(baseDir, { recursive: true });
    const registry = new SkillRegistry({ baseDir });
    return {
        registry,
        root,
        baseDir,
        skillsDir: path.join(baseDir, 'skills'),
        draftsDir: path.join(baseDir, 'skills', 'drafts'),
        cleanup() {
            try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

/** Sorted recursive listing of a directory, for before/after comparisons. */
function tree(dir) {
    const out = [];
    const walk = (current, prefix) => {
        let entries = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (e) { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                out.push(`${rel}/`);
                walk(path.join(current, entry.name), rel);
            } else {
                out.push(rel);
            }
        }
    };
    walk(dir, '');
    return out;
}

/** Silence expected [SkillRegistry] warnings so the suite output stays readable. */
function quiet() {
    const original = console.warn;
    console.warn = () => {};
    return () => { console.warn = original; };
}

const raw = (dir, name) => fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');

// Every one of these must be refused: traversal, absolute paths, both
// separator flavours, dotfiles, and encoded variants of the same.
const HOSTILE_NAMES = [
    '../../etc/passwd',
    '../../x',
    '/etc/passwd',
    '..\\..\\x',
    '.hidden',
    'has/a/slash',
    'deploy/../../evil',
    'C:\\Windows\\System32\\evil',
    '..',
    '.',
    '%2e%2e%2fx',
    'nul',
    'con',
    'trailing\0byte',
    '',
    '   ',
];

// ===========================================================================
//  Round-trips and frontmatter
// ===========================================================================

test('use returns the skill procedure rather than executing it', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({
            name: 'deploy-vps',
            description: 'Ship the bridge',
            body: '1. run deploy.ps1\n2. check health',
            tags: ['deploy'],
        });
        const used = registry.use('deploy-vps', { args: { target: 'staging' }, chatId: 'c1', agentId: 'hermes' });
        assert.equal(used.skill, 'deploy-vps');
        assert.match(used.body, /deploy\.ps1/);
        assert.deepEqual(used.args, { target: 'staging' });
        assert.match(used.note, /procedure to follow/);
        assert.throws(() => registry.use('no-such-skill'), /Unknown skill/);
    } finally { cleanup(); }
});

test('save then get round-trips every frontmatter field', () => {
    const { registry, skillsDir, cleanup } = makeRegistry();
    try {
        const saved = registry.save({
            name: 'deploy-vps',
            description: 'Deploy the bot to the production VPS',
            tags: ['deploy', 'ops'],
            agents: ['claude', 'codex'],
            source: 'learned',
            version: 2,
            body: '1. ssh in\n2. git pull\n3. pm2 restart',
        });
        assert.equal(saved.name, 'deploy-vps');
        assert.equal(saved.version, 2);

        const got = registry.get('deploy-vps');
        assert.ok(got, 'the skill must be readable back');
        assert.equal(got.name, 'deploy-vps');
        assert.equal(got.description, 'Deploy the bot to the production VPS');
        assert.deepEqual(got.tags, ['deploy', 'ops']);
        assert.deepEqual(got.agents, ['claude', 'codex']);
        assert.equal(got.version, 2);
        assert.equal(got.source, 'learned');
        assert.equal(got.body, '1. ssh in\n2. git pull\n3. pm2 restart');
        assert.equal(got.malformed, false);
        assert.ok(got.updated > 0, 'a save stamps an updated time');

        // The on-disk form is the documented contract other machines parse.
        const text = raw(skillsDir, 'deploy-vps');
        assert.ok(text.startsWith('---\n'), 'file must open with a frontmatter fence');
        assert.match(text, /^name: deploy-vps$/m);
        assert.match(text, /^description: Deploy the bot to the production VPS$/m);
        assert.match(text, /^tags: \[deploy, ops\]$/m);
        assert.match(text, /^agents: \[claude, codex\]$/m);
        assert.match(text, /^version: 2$/m);
        assert.match(text, /^source: learned$/m);
        assert.ok(text.includes('\n---\n1. ssh in'), 'body follows the closing fence');
    } finally { cleanup(); }
});

test('defaults fill in when only a name and body are supplied', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'bare', body: 'do the thing' });
        const got = registry.get('bare');
        assert.equal(got.description, '');
        assert.deepEqual(got.tags, []);
        assert.deepEqual(got.agents, [], 'no agent list means available to all');
        assert.equal(got.version, 1);
        assert.equal(got.source, 'manual');
        assert.equal(registry.get('does-not-exist'), null);
    } finally { cleanup(); }
});

test('mixed-case names and messy tag input normalise instead of failing', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        const saved = registry.save({
            name: '  Deploy-VPS  ',
            tags: 'Ops, Deploy , ops',
            agents: '[Claude]',
            source: 'nonsense-source',
            body: 'x',
        });
        assert.equal(saved.name, 'deploy-vps');
        assert.deepEqual(saved.tags, ['ops', 'deploy'], 'lowercased and de-duplicated');
        assert.deepEqual(saved.agents, ['claude']);
        assert.equal(saved.source, 'manual', 'an unknown source falls back rather than being stored');
    } finally { cleanup(); }
});

test('malformed frontmatter degrades to body-only instead of throwing', () => {
    const { registry, skillsDir, cleanup } = makeRegistry();
    const restore = quiet();
    try {
        // (a) A fence that is opened and never closed.
        fs.writeFileSync(
            path.join(skillsDir, 'unclosed.md'),
            '---\nname: something-else\ndescription: never closed\nRun step one.\n',
            'utf8'
        );
        // (b) A closed fence full of junk that is not key: value at all.
        fs.writeFileSync(
            path.join(skillsDir, 'garbage.md'),
            '---\n!!! this is not yaml !!!\n[[[\n---\nThe actual procedure.\n',
            'utf8'
        );
        // (c) No frontmatter whatsoever — a plain markdown procedure.
        fs.writeFileSync(path.join(skillsDir, 'plain.md'), 'Just a procedure.\n', 'utf8');

        const unclosed = registry.get('unclosed');
        assert.ok(unclosed, 'a broken file must still be readable');
        assert.equal(unclosed.name, 'unclosed', 'name falls back to the filename');
        assert.equal(unclosed.malformed, true);
        assert.ok(unclosed.body.includes('Run step one.'), 'the whole file becomes the body');
        assert.ok(unclosed.body.includes('name: something-else'), 'an unclosed fence is not trusted as metadata');
        assert.equal(unclosed.description, '');

        const garbage = registry.get('garbage');
        assert.equal(garbage.name, 'garbage');
        assert.equal(garbage.malformed, true);
        assert.equal(garbage.body, 'The actual procedure.');
        assert.deepEqual(garbage.tags, []);

        const plain = registry.get('plain');
        assert.equal(plain.name, 'plain');
        assert.equal(plain.body, 'Just a procedure.');

        // Nothing above may poison list(), search() or stats().
        assert.equal(registry.list().length, 3);
        assert.doesNotThrow(() => registry.search('procedure'));
        assert.equal(registry.stats().count, 3);
    } finally { restore(); cleanup(); }
});

test('block-list frontmatter and comments are tolerated', () => {
    const { registry, skillsDir, cleanup } = makeRegistry();
    try {
        fs.writeFileSync(
            path.join(skillsDir, 'blocky.md'),
            '---\n# a comment line\nname: blocky\ntags:\n  - alpha\n  - beta\nagents:\n  - claude\nversion: 3\n---\nBody here.\n',
            'utf8'
        );
        const got = registry.get('blocky');
        assert.deepEqual(got.tags, ['alpha', 'beta']);
        assert.deepEqual(got.agents, ['claude']);
        assert.equal(got.version, 3);
        assert.equal(got.body, 'Body here.');
        assert.equal(got.malformed, false);
    } finally { cleanup(); }
});

// ===========================================================================
//  Filtering
// ===========================================================================

test('list filters by agent and by tag', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'shared-one', tags: ['ops'], agents: [], body: 'a' });
        registry.save({ name: 'claude-only', tags: ['ops', 'writing'], agents: ['claude'], body: 'b' });
        registry.save({ name: 'codex-only', tags: ['code'], agents: ['codex'], body: 'c' });

        assert.deepEqual(registry.list().map((s) => s.name), ['claude-only', 'codex-only', 'shared-one']);

        // An empty agents list means "available to all", so it shows up for both.
        assert.deepEqual(
            registry.list({ agentKey: 'claude' }).map((s) => s.name),
            ['claude-only', 'shared-one']
        );
        assert.deepEqual(
            registry.list({ agentKey: 'codex' }).map((s) => s.name),
            ['codex-only', 'shared-one']
        );
        assert.deepEqual(registry.list({ agentKey: 'grok' }).map((s) => s.name), ['shared-one']);
        assert.deepEqual(registry.list({ agentKey: 'CLAUDE' }).map((s) => s.name), ['claude-only', 'shared-one']);

        assert.deepEqual(registry.list({ tag: 'ops' }).map((s) => s.name), ['claude-only', 'shared-one']);
        assert.deepEqual(registry.list({ tag: 'code' }).map((s) => s.name), ['codex-only']);
        assert.deepEqual(registry.list({ tag: 'nothing' }).map((s) => s.name), []);

        // Combined.
        assert.deepEqual(registry.list({ agentKey: 'claude', tag: 'ops' }).map((s) => s.name), ['claude-only', 'shared-one']);
        assert.deepEqual(registry.list({ agentKey: 'codex', tag: 'ops' }).map((s) => s.name), ['shared-one']);
    } finally { cleanup(); }
});

test('list returns registry skills only, never drafts', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'graduated', body: 'x' });
        registry.saveDraft({ name: 'candidate', body: 'y' });
        assert.deepEqual(registry.list().map((s) => s.name), ['graduated']);
        assert.deepEqual(registry.listDrafts().map((s) => s.name), ['candidate']);
        assert.equal(registry.get('candidate'), null, 'a draft is not in the registry yet');
    } finally { cleanup(); }
});

// ===========================================================================
//  Search
// ===========================================================================

test('search ranks a name/tag match above an incidental body mention', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({
            name: 'deploy-vps',
            description: 'Deploy the bot to the production VPS',
            tags: ['deploy', 'ops'],
            body: 'Run the deploy script.',
        });
        registry.save({
            name: 'write-tests',
            description: 'Add node:test coverage',
            tags: ['testing'],
            body: 'Before you deploy, write tests. deploy deploy deploy.',
        });

        const hits = registry.search('deploy');
        assert.equal(hits.length, 2, 'both mention deploy');
        assert.equal(hits[0].name, 'deploy-vps', 'the skill named deploy must rank first');
        assert.ok(hits[0].score > hits[1].score, 'ranking must be strict, not a tie');

        // Case-insensitive, and multi-term queries favour the better coverage.
        assert.equal(registry.search('DEPLOY VPS')[0].name, 'deploy-vps');
        assert.equal(registry.search('write tests')[0].name, 'write-tests');

        // Body-only matches still surface.
        assert.deepEqual(registry.search('coverage').map((s) => s.name), ['write-tests']);
        assert.deepEqual(registry.search('nothing-matches-this'), []);
        assert.deepEqual(registry.search(''), []);
        assert.deepEqual(registry.search(null), []);

        // Filters compose with search.
        registry.save({ name: 'codex-deploy', agents: ['codex'], body: 'deploy' });
        assert.ok(!registry.search('deploy', { agentKey: 'claude' }).some((s) => s.name === 'codex-deploy'));
    } finally { cleanup(); }
});

// ===========================================================================
//  Path traversal — the load-bearing safety property
// ===========================================================================

test('path traversal is blocked for every write path and nothing lands outside skills/', () => {
    const { registry, root, skillsDir, cleanup } = makeRegistry();
    const restore = quiet();
    try {
        registry.save({ name: 'legit', body: 'untouched' });
        const before = tree(root);
        assert.ok(before.includes('nest/deeper/app/skills/legit.md'), 'fixture sanity');

        for (const name of HOSTILE_NAMES) {
            const label = JSON.stringify(name);

            // Gate 1: the name never sanitises.
            assert.equal(registry.sanitizeName(name), null, `sanitizeName must reject ${label}`);
            assert.equal(registry.isValidName(name), false, `isValidName must reject ${label}`);

            // Gate 2: the resolved path never passes containment, in either dir.
            assert.equal(registry._safePath(skillsDir, name), null, `_safePath must reject ${label}`);
            assert.equal(registry._safePath(registry.draftsDir, name), null, `_safePath (drafts) must reject ${label}`);

            // Writes are loud failures, not silent no-ops.
            assert.throws(
                () => registry.save({ name, body: 'PWNED' }),
                /Invalid skill name/,
                `save must refuse ${label}`
            );
            assert.throws(
                () => registry.saveDraft({ name, body: 'PWNED' }),
                /Invalid skill name/,
                `saveDraft must refuse ${label}`
            );

            // Reads and deletes fail closed.
            assert.equal(registry.get(name), null, `get must refuse ${label}`);
            assert.equal(registry.getDraft(name), null, `getDraft must refuse ${label}`);
            assert.equal(registry.remove(name), false, `remove must refuse ${label}`);
            assert.equal(registry.removeDraft(name), false, `removeDraft must refuse ${label}`);

            // Promotion and import take names from remote machines — same gate.
            const promoted = registry.promote(name);
            assert.equal(promoted.promoted, false, `promote must refuse ${label}`);
            assert.equal(promoted.reason, 'invalid-name');

            const imported = registry.import([{ name, body: 'PWNED', version: 99 }]);
            assert.deepEqual(imported.imported, [], `import must not write ${label}`);
            assert.deepEqual(imported.updated, []);
            assert.equal(imported.skipped.length, 1);
            assert.equal(imported.skipped[0].reason, 'invalid-name');

            // Prompt rendering must not read through a hostile name either.
            assert.equal(registry.renderForPrompt([name]), '');
        }

        // The decisive assertion: the temp tree is byte-for-byte unchanged, so
        // no file was created, moved or deleted anywhere — inside skills/ or out.
        assert.deepEqual(tree(root), before, 'no file may appear or vanish anywhere under the temp root');
        assert.deepEqual(registry.list().map((s) => s.name), ['legit']);
        assert.equal(registry.get('legit').body, 'untouched');

        // And no stray file with a traversal-ish name inside skills/ either.
        for (const entry of fs.readdirSync(skillsDir)) {
            assert.ok(
                entry === 'drafts' || /^[a-z0-9][a-z0-9-]*\.md$/.test(entry),
                `unexpected entry in skills/: ${entry}`
            );
        }
    } finally { restore(); cleanup(); }
});

test('a valid name always resolves to a direct child of the skills dir', () => {
    const { registry, skillsDir, cleanup } = makeRegistry();
    try {
        for (const name of ['a', 'deploy-vps', 'x1-2-3', '0start']) {
            const resolved = registry._safePath(skillsDir, name);
            assert.equal(resolved, path.join(path.resolve(skillsDir), `${name}.md`));
            assert.equal(path.dirname(resolved), path.resolve(skillsDir));
        }
        // Over-long names are refused rather than truncated into a collision.
        assert.equal(registry.sanitizeName('a'.repeat(65)), null);
        assert.equal(registry.sanitizeName('a'.repeat(64)), 'a'.repeat(64));
    } finally { cleanup(); }
});

// ===========================================================================
//  Promotion
// ===========================================================================

test('promote moves a draft into the registry and removes it from drafts', () => {
    const { registry, draftsDir, cleanup } = makeRegistry();
    try {
        registry.saveDraft({
            name: 'rotate-keys',
            description: 'Rotate the API keys',
            tags: ['ops'],
            agents: ['claude'],
            body: 'Step one. Step two.',
        });
        assert.ok(fs.existsSync(path.join(draftsDir, 'rotate-keys.md')));

        const result = registry.promote('rotate-keys');
        assert.equal(result.promoted, true);
        assert.equal(result.name, 'rotate-keys');
        assert.equal(result.previousVersion, 0);
        assert.equal(result.version, 1);

        const got = registry.get('rotate-keys');
        assert.ok(got, 'the skill is now in the registry');
        assert.equal(got.description, 'Rotate the API keys');
        assert.deepEqual(got.tags, ['ops']);
        assert.equal(got.body, 'Step one. Step two.');
        assert.equal(got.source, 'learned', 'a promoted draft is a learned skill');

        assert.equal(fs.existsSync(path.join(draftsDir, 'rotate-keys.md')), false, 'the draft is moved, not copied');
        assert.deepEqual(registry.listDrafts(), []);
    } finally { cleanup(); }
});

test('promote bumps the version past an existing skill of the same name', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'deploy-vps', version: 3, body: 'old procedure' });
        registry.saveDraft({ name: 'deploy-vps', body: 'new improved procedure' });

        const result = registry.promote('deploy-vps');
        assert.equal(result.promoted, true);
        assert.equal(result.previousVersion, 3);
        assert.equal(result.version, 4, 'the promotion must read as newer everywhere else');

        const got = registry.get('deploy-vps');
        assert.equal(got.version, 4);
        assert.equal(got.body, 'new improved procedure');
    } finally { cleanup(); }
});

test('promote reads a hand-written draft file and reports a missing draft', () => {
    const { registry, draftsDir, cleanup } = makeRegistry();
    try {
        // Exactly what core/SelfImprovement.js would drop into skills/drafts.
        fs.writeFileSync(
            path.join(draftsDir, 'handwritten.md'),
            '---\nname: handwritten\ndescription: Written by hand\ntags: [manualwork]\n---\nThe body.\n',
            'utf8'
        );
        const ok = registry.promote('handwritten');
        assert.equal(ok.promoted, true);
        assert.equal(registry.get('handwritten').description, 'Written by hand');

        const missing = registry.promote('never-existed');
        assert.equal(missing.promoted, false);
        assert.equal(missing.reason, 'draft-not-found');
    } finally { cleanup(); }
});

// ===========================================================================
//  Export / import
// ===========================================================================

test('export/import round-trips between two registries', () => {
    const a = makeRegistry();
    const b = makeRegistry();
    try {
        a.registry.save({
            name: 'deploy-vps', description: 'Deploy it', tags: ['ops', 'deploy'],
            agents: ['claude'], source: 'learned', version: 2, body: 'ssh; pull; restart',
        });
        a.registry.save({ name: 'take-notes', tags: ['writing'], body: 'Write it down.' });

        const payload = a.registry.export();
        assert.equal(payload.length, 2);
        assert.deepEqual(Object.keys(payload[0]).sort(),
            ['agents', 'body', 'description', 'name', 'source', 'tags', 'updated', 'version']);
        assert.equal(JSON.parse(JSON.stringify(payload)).length, 2, 'payload must be plain JSON');

        const result = b.registry.import(payload);
        assert.deepEqual(result.imported.sort(), ['deploy-vps', 'take-notes']);
        assert.deepEqual(result.skipped, []);
        assert.deepEqual(result.errors, []);

        // The far end is identical, field for field.
        assert.deepEqual(b.registry.export(), payload);
        const there = b.registry.get('deploy-vps');
        assert.equal(there.version, 2);
        assert.equal(there.body, 'ssh; pull; restart');
        assert.deepEqual(there.agents, ['claude']);

        // export() honours the same filters as list().
        assert.deepEqual(a.registry.export({ tags: 'writing' }).map((s) => s.name), ['take-notes']);
        assert.deepEqual(a.registry.export({ agentKey: 'codex' }).map((s) => s.name), ['take-notes']);
        assert.deepEqual(a.registry.export({ names: ['deploy-vps'] }).map((s) => s.name), ['deploy-vps']);
    } finally { a.cleanup(); b.cleanup(); }
});

test('import is idempotent — re-importing the same payload writes nothing', () => {
    const a = makeRegistry();
    const b = makeRegistry();
    try {
        a.registry.save({ name: 'deploy-vps', description: 'Deploy it', tags: ['ops'], version: 2, body: 'x' });
        const payload = a.registry.export();

        const first = b.registry.import(payload);
        assert.deepEqual(first.imported, ['deploy-vps']);
        const bytes = raw(b.skillsDir, 'deploy-vps');

        const second = b.registry.import(payload);
        assert.deepEqual(second.imported, [], 'nothing new on a repeat import');
        assert.deepEqual(second.updated, []);
        assert.equal(second.skipped.length, 1);
        assert.equal(second.skipped[0].name, 'deploy-vps');
        assert.equal(second.skipped[0].reason, 'identical');
        assert.match(second.skipped[0].detail, /already matches/);
        assert.equal(raw(b.skillsDir, 'deploy-vps'), bytes, 'the file on disk must be untouched');

        const third = b.registry.import(payload);
        assert.equal(third.skipped[0].reason, 'identical');
        assert.equal(b.registry.list().length, 1, 'no duplicates accumulate');
    } finally { a.cleanup(); b.cleanup(); }
});

test('import never clobbers a newer local version unless overwrite is set', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'deploy-vps', version: 5, body: 'LOCAL v5', tags: ['ops'] });

        // (a) Older incoming -> refused, with the reason and both versions.
        const older = registry.import([{ name: 'deploy-vps', version: 2, body: 'REMOTE v2' }]);
        assert.deepEqual(older.imported, []);
        assert.deepEqual(older.updated, []);
        assert.equal(older.skipped[0].reason, 'local-newer');
        assert.equal(older.skipped[0].localVersion, 5);
        assert.equal(older.skipped[0].incomingVersion, 2);
        assert.match(older.skipped[0].detail, /overwrite/);
        assert.equal(registry.get('deploy-vps').body, 'LOCAL v5', 'local content survives');
        assert.equal(registry.get('deploy-vps').version, 5);

        // (b) Same version but different content -> also refused, different reason.
        const sideways = registry.import([{ name: 'deploy-vps', version: 5, body: 'REMOTE v5 different' }]);
        assert.equal(sideways.skipped[0].reason, 'same-version-differs');
        assert.equal(registry.get('deploy-vps').body, 'LOCAL v5');

        // (c) Newer incoming wins without any flag.
        const newer = registry.import([{ name: 'deploy-vps', version: 6, body: 'REMOTE v6' }]);
        assert.deepEqual(newer.updated, ['deploy-vps']);
        assert.deepEqual(newer.imported, []);
        assert.equal(registry.get('deploy-vps').body, 'REMOTE v6');
        assert.equal(registry.get('deploy-vps').version, 6);

        // (d) overwrite:true forces an older copy through, deliberately.
        const forced = registry.import([{ name: 'deploy-vps', version: 1, body: 'FORCED v1' }], { overwrite: true });
        assert.deepEqual(forced.updated, ['deploy-vps']);
        assert.deepEqual(forced.skipped, []);
        assert.equal(registry.get('deploy-vps').body, 'FORCED v1');
        assert.equal(registry.get('deploy-vps').version, 1);
    } finally { cleanup(); }
});

test('import tolerates junk entries without losing the good ones', () => {
    const { registry, cleanup } = makeRegistry();
    const restore = quiet();
    try {
        const result = registry.import([
            { name: 'good-one', body: 'fine' },
            { name: '../../evil', body: 'nope' },
            { body: 'no name at all' },
            null,
            { name: 'good-two', body: 'also fine' },
        ]);
        assert.deepEqual(result.imported.sort(), ['good-one', 'good-two']);
        assert.equal(result.skipped.filter((s) => s.reason === 'invalid-name').length, 3);
        assert.equal(result.total, 5);
        assert.deepEqual(registry.list().map((s) => s.name), ['good-one', 'good-two']);

        // A single object is accepted as well as an array.
        assert.deepEqual(registry.import({ name: 'solo', body: 'x' }).imported, ['solo']);
        assert.equal(registry.import([]).total, 0);
        assert.equal(registry.import(null).total, 0);
    } finally { restore(); cleanup(); }
});

// ===========================================================================
//  Prompt rendering
// ===========================================================================

test('renderForPrompt concatenates the selected skills', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'alpha', description: 'First skill', tags: ['ops'], agents: ['claude'], body: 'Do A.' });
        registry.save({ name: 'beta', description: 'Second skill', tags: ['ops'], agents: ['codex'], body: 'Do B.' });

        const both = registry.renderForPrompt(['alpha', 'beta']);
        assert.match(both, /^# Available Skills/);
        assert.ok(both.includes('## alpha') && both.includes('## beta'));
        assert.ok(both.includes('First skill') && both.includes('Do A.'));
        assert.ok(both.includes('tags: ops'));
        assert.ok(!both.includes('truncated'), 'a short registry is never marked truncated');

        // Selector forms.
        const forClaude = registry.renderForPrompt({ agentKey: 'claude' });
        assert.ok(forClaude.includes('## alpha'));
        assert.ok(!forClaude.includes('## beta'), 'agent scoping applies to prompt injection too');
        assert.ok(registry.renderForPrompt('alpha').includes('Do A.'));
        assert.ok(registry.renderForPrompt({ tag: 'ops' }).includes('## beta'));

        // Nothing selected is an empty string, not a stray header.
        assert.equal(registry.renderForPrompt([]), '');
        assert.equal(registry.renderForPrompt({ agentKey: 'nobody' }), '');
        assert.equal(registry.renderForPrompt(['no-such-skill']), '');
    } finally { cleanup(); }
});

test('renderForPrompt respects the character budget and marks the truncation', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        for (let i = 0; i < 5; i += 1) {
            registry.save({
                name: `bulk-${i}`,
                description: `Bulk skill number ${i}`,
                tags: ['bulk'],
                body: `${'x'.repeat(2000)} END${i}`,
            });
        }

        const tight = registry.renderForPrompt({ budget: 1000 });
        assert.ok(tight.length <= 1000, `budget must be a hard ceiling, got ${tight.length}`);
        assert.match(tight, /truncated/, 'truncation must be marked in-band');
        assert.ok(tight.includes('## bulk-0'), 'the first skill still makes it in');
        assert.ok(!tight.includes('## bulk-4'), 'later skills are dropped');

        // Even an absurdly small budget holds, and still says why.
        const tiny = registry.renderForPrompt({ budget: 1 });
        assert.ok(tiny.length <= 200, `got ${tiny.length}`);
        assert.match(tiny, /truncated/);

        // The default budget is ~8000 chars, applied without being asked for.
        const dflt = registry.renderForPrompt({});
        assert.ok(dflt.length <= 8000, `default budget must apply, got ${dflt.length}`);
        assert.match(dflt, /truncated/);

        // A budget big enough for everything leaves no marker.
        const roomy = registry.renderForPrompt({ budget: 60000 });
        assert.ok(roomy.includes('END0') && roomy.includes('END4'));
        assert.ok(!roomy.includes('truncated'));
    } finally { cleanup(); }
});

// ===========================================================================
//  Stats and removal
// ===========================================================================

test('stats counts skills, tags, sources and per-agent reach', () => {
    const { registry, cleanup } = makeRegistry();
    try {
        assert.deepEqual(registry.stats().tags, {});
        assert.equal(registry.stats().count, 0);

        registry.save({ name: 'one', tags: ['ops', 'deploy'], agents: ['claude'], source: 'manual', body: 'a' });
        registry.save({ name: 'two', tags: ['ops'], agents: [], source: 'manual', body: 'bb' });
        registry.save({ name: 'three', tags: ['notes'], agents: ['claude', 'codex'], source: 'learned', body: 'ccc' });
        registry.saveDraft({ name: 'pending', body: 'd' });

        const stats = registry.stats();
        assert.equal(stats.count, 3);
        assert.equal(stats.drafts, 1);
        assert.equal(stats.shared, 1, 'only "two" is unrestricted');
        assert.equal(stats.malformed, 0);
        assert.deepEqual(stats.tags, { ops: 2, deploy: 1, notes: 1 });
        assert.deepEqual(stats.agents, { claude: 2, codex: 1 });
        assert.deepEqual(stats.sources, { manual: 2, learned: 1 });
        assert.equal(stats.bytes, 1 + 2 + 3);
        assert.equal(stats.skillsDir, registry.skillsDir);
        assert.equal(stats.draftsDir, registry.draftsDir);
    } finally { cleanup(); }
});

test('remove deletes a skill and reports whether anything was there', () => {
    const { registry, skillsDir, cleanup } = makeRegistry();
    try {
        registry.save({ name: 'temporary', body: 'x' });
        assert.equal(registry.remove('temporary'), true);
        assert.equal(registry.get('temporary'), null);
        assert.equal(fs.existsSync(path.join(skillsDir, 'temporary.md')), false);
        assert.equal(registry.remove('temporary'), false, 'removing twice is not an error');

        registry.saveDraft({ name: 'scratch', body: 'y' });
        assert.equal(registry.removeDraft('scratch'), true);
        assert.deepEqual(registry.listDrafts(), []);
    } finally { cleanup(); }
});

test('the constructor creates the skills and drafts directories it needs', () => {
    const { registry, skillsDir, draftsDir, cleanup } = makeRegistry();
    try {
        assert.ok(fs.existsSync(skillsDir), 'skills/ must exist');
        assert.ok(fs.existsSync(draftsDir), 'skills/drafts/ must exist — SelfImprovement writes there');
        assert.equal(registry.skillsDir, skillsDir);
        assert.equal(registry.draftsDir, draftsDir);
        // Re-opening an existing tree is a no-op, not a failure.
        assert.doesNotThrow(() => new SkillRegistry({ baseDir: registry.baseDir }));
    } finally { cleanup(); }
});
