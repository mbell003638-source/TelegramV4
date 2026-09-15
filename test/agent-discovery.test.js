const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const AgentDiscovery = require('../core/AgentDiscovery');
const { AGENT_CATALOGUE } = require('../core/AgentDiscovery');

// ---------------------------------------------------------------------------
//  Helpers
//
//  Every test here is hermetic: fake binaries live in a temp dir injected via
//  extraPaths / env.PATH, the platform is injected, and child_process.execFile
//  is injected as a stub. Nothing real on this machine is probed or executed
//  except our own inert fakes (and only in the tests that say so).
//  Windows keeps file handles around, so rmSync cleanup is best-effort — an
//  EPERM must never fail a test.
// ---------------------------------------------------------------------------

/** Temp sandbox with helpers to plant inert fake binaries. */
function makeSandbox(prefix = 'agentdisc-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        dir,
        /** Plant an inert file (never executed unless a test opts in). */
        plant(relativePath, contents = '') {
            const full = path.join(dir, relativePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, contents);
            return full;
        },
        subdir(name) {
            const full = path.join(dir, name);
            fs.mkdirSync(full, { recursive: true });
            return full;
        },
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
        },
    };
}

/** A tiny two-entry catalogue: one supported, one detected-but-unsupported. */
function miniCatalogue() {
    return [
        {
            id: 'foo',
            name: 'Foo CLI',
            emoji: '\u{1F535}',
            bin: 'foo',
            adapter: 'FooAgent',
            module: './agents/FooAgent',
            category: 'core',
            versionArgs: ['--version'],
            candidates: { win32: [], darwin: [], linux: [] },
        },
        {
            id: 'bar',
            name: 'Bar CLI',
            emoji: '\u{1F7E1}',
            bin: 'bar',
            adapter: null,
            module: null,
            category: 'coding',
            versionArgs: ['--version'],
            candidates: { win32: [], darwin: [], linux: [] },
        },
    ];
}

/** execFile stub: records calls, replies from a canned handler. */
function makeExecStub(handler) {
    const calls = [];
    const impl = (file, args, options, callback) => {
        calls.push({ file, args, options });
        const reply = handler ? handler(file, args) : null;
        if (reply === 'hang') return;   // never calls back — watchdog must save us
        setImmediate(() => {
            if (!reply) return callback(new Error('spawn ENOENT'), '', '');
            if (reply.error) return callback(reply.error, reply.stdout || '', reply.stderr || '');
            callback(null, reply.stdout || '', reply.stderr || '');
        });
    };
    impl.calls = calls;
    return impl;
}

/** Env with nothing but what the test injects, so no real machine leaks in. */
function isolatedEnv(extra = {}) {
    return { PATH: '', HOME: '', USERPROFILE: '', APPDATA: '', LOCALAPPDATA: '', ...extra };
}

// ===========================================================================
//  Catalogue shape
// ===========================================================================

test('catalogue covers the 8 supported adapters plus open-ended extras', () => {
    const ids = AGENT_CATALOGUE.map(e => e.id);
    for (const required of ['claude', 'codex', 'grok', 'hermes', 'opencode', 'openclaw', 'pi', 'antigravity']) {
        assert.ok(ids.includes(required), `catalogue must include ${required}`);
    }
    for (const extra of ['aider', 'goose', 'cline', 'continue', 'gemini', 'qwen', 'crush', 'amp', 'cursor-agent', 'ollama', 'llm', 'opencodex']) {
        assert.ok(ids.includes(extra), `catalogue must include ${extra}`);
    }
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique');

    for (const entry of AGENT_CATALOGUE) {
        assert.equal(typeof entry.name, 'string');
        assert.equal(typeof entry.bin, 'string');
        assert.ok(Array.isArray(entry.versionArgs));
        for (const plat of ['win32', 'darwin', 'linux']) {
            assert.ok(Array.isArray(entry.candidates[plat]), `${entry.id}.candidates.${plat}`);
        }
    }

    // The eight with adapters, and nothing else, are drivable today.
    const withAdapter = AGENT_CATALOGUE.filter(e => e.adapter).map(e => e.id).sort();
    // .sort() is lexicographic: 'openclaw' sorts before 'opencode' (l < o).
    assert.deepEqual(withAdapter, ['antigravity', 'claude', 'codex', 'grok', 'hermes', 'openclaw', 'opencode', 'pi']);
});

// ===========================================================================
//  Resolution
// ===========================================================================

test('an agent in an injected candidate path is found with the right binaryPath and source', async () => {
    const box = makeSandbox();
    try {
        const planted = box.plant('bin/foo', '#!/bin/sh\necho foo 1.2.3\n');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: 'foo 1.2.3\n' })),
        });

        const results = await discovery.scan({ withVersion: false });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true);
        assert.equal(foo.binaryPath, planted);
        assert.equal(foo.source, 'known-path');
        assert.equal(foo.supported, true);
    } finally { box.cleanup(); }
});

test('an agent on the injected PATH resolves with source "path"', async () => {
    const box = makeSandbox();
    try {
        const planted = box.plant('pathdir/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv({ PATH: path.join(box.dir, 'pathdir') }),
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true);
        assert.equal(foo.source, 'path');
        assert.equal(foo.binaryPath, planted);
    } finally { box.cleanup(); }
});

test('an absent agent reports installed:false without throwing', async () => {
    const box = makeSandbox();
    try {
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'empty')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.length, 2);
        for (const r of results) {
            assert.equal(r.installed, false);
            assert.equal(r.binaryPath, null);
            assert.equal(r.source, null);
            assert.equal(r.version, null);
            assert.equal(r.error, null, 'simply absent is not an error');
        }
    } finally { box.cleanup(); }
});

test('a scan where every probe fails still resolves without throwing', async () => {
    const box = makeSandbox();
    try {
        const exploding = () => { throw new Error('exec exploded'); };
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv({ PATH: path.join(box.dir, 'does-not-exist') }),
            extraPaths: [path.join(box.dir, 'also-missing')],
            versionTimeoutMs: 50,
            catalogue: miniCatalogue(),
            execFileImpl: exploding,
        });

        const results = await discovery.scan({ force: true });
        assert.equal(results.length, 2);
        assert.deepEqual(results.map(r => r.installed), [false, false]);
        assert.deepEqual(discovery.getInstalled(), []);
        assert.equal(discovery.summary().installed, 0);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Windows extension-variant probing (the #1 cause of missed detections)
// ===========================================================================

test('windows probing finds foo.cmd when the catalogue says "foo"', async () => {
    const box = makeSandbox();
    try {
        const planted = box.plant('npm/foo.cmd', '@echo foo 9.9.9\r\n');
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'npm')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: 'foo 9.9.9\r\n' })),
        });

        const results = await discovery.scan({ withVersion: false });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true);
        assert.equal(foo.binaryPath, planted);
        assert.ok(foo.binaryPath.endsWith('.cmd'));
    } finally { box.cleanup(); }
});

test('windows probing also finds the .exe and .ps1 variants, and the bare name', async () => {
    for (const [file, suffix] of [['bin/foo.exe', '.exe'], ['bin/foo.ps1', '.ps1'], ['bin/foo', 'foo']]) {
        const box = makeSandbox();
        try {
            const planted = box.plant(file, 'inert');
            const discovery = new AgentDiscovery({
                platform: 'win32',
                env: isolatedEnv(),
                extraPaths: [path.join(box.dir, 'bin')],
                catalogue: miniCatalogue(),
                execFileImpl: makeExecStub(() => null),
            });
            const results = await discovery.scan({ withVersion: false });
            const foo = results.find(r => r.id === 'foo');
            assert.equal(foo.installed, true, `expected to find ${file}`);
            assert.equal(foo.binaryPath, planted);
            assert.ok(foo.binaryPath.endsWith(suffix));
        } finally { box.cleanup(); }
    }
});

test('a candidate written as .cmd still resolves when only the .exe exists', async () => {
    const box = makeSandbox();
    try {
        const binDir = box.subdir('tools');
        const planted = box.plant('tools/foo.exe', 'inert');
        const catalogue = miniCatalogue();
        // Catalogue claims a .cmd shim; reality is an .exe.
        catalogue[0].candidates.win32 = [path.join(binDir, 'foo.cmd').split(path.sep).join('/')];
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv(),
            catalogue,
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').binaryPath, planted);
    } finally { box.cleanup(); }
});

test('non-windows platforms do not invent extension variants', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo.cmd', 'inert');   // a .cmd is meaningless on linux
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').installed, false);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Paths containing a space (must never become shell injection)
// ===========================================================================

test('a candidate directory containing a space resolves and version-probes safely', async () => {
    const box = makeSandbox();
    try {
        const spaced = box.subdir('Program Files Fake');
        const planted = box.plant('Program Files Fake/foo.cmd', '@echo foo 3.4.5\r\n');
        const exec = makeExecStub(() => ({ stdout: 'foo 3.4.5\r\n' }));
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv({ COMSPEC: 'cmd.exe' }),
            extraPaths: [spaced],
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.binaryPath, planted);
        assert.ok(foo.binaryPath.includes(' '), 'path under test must contain a space');
        assert.equal(foo.version, '3.4.5');

        // The spaced path must have travelled as argv data, quoted, never as a
        // shell string we concatenated ourselves.
        const call = exec.calls.find(c => /cmd\.exe$/i.test(c.file));
        assert.ok(call, 'a .cmd shim must be run through cmd.exe');
        assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
        assert.ok(call.args[3].includes(`"${planted}"`), 'binary path must be quoted');
        assert.equal(call.options.windowsHide, true);
    } finally { box.cleanup(); }
});

test('a path containing an ampersand is passed as data, not as a command separator', async () => {
    const box = makeSandbox();
    try {
        const nasty = box.subdir('a & b');
        const planted = box.plant('a & b/foo.cmd', '@echo foo 1.0.0\r\n');
        const exec = makeExecStub(() => ({ stdout: 'foo 1.0.0\r\n' }));
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv({ COMSPEC: 'cmd.exe' }),
            extraPaths: [nasty],
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const results = await discovery.scan({ force: true });
        assert.equal(results.find(r => r.id === 'foo').binaryPath, planted);
        const call = exec.calls.find(c => /cmd\.exe$/i.test(c.file));
        assert.ok(call.args[3].startsWith(`""${planted}"`), 'outer-quoted so & cannot separate commands');
        assert.ok(Array.isArray(call.args), 'argv array — never a concatenated command line');
    } finally { box.cleanup(); }
});

test('a real .cmd shim in a spaced directory reports its version end to end', async (t) => {
    if (process.platform !== 'win32') return t.skip('windows-only: executes a real .cmd fake');
    const box = makeSandbox();
    try {
        const spaced = box.subdir('Spaced Dir');
        box.plant('Spaced Dir/foo.cmd', '@echo off\r\necho foo version 7.8.9\r\n');
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv({ COMSPEC: process.env.COMSPEC || 'cmd.exe' }),
            extraPaths: [spaced],
            catalogue: miniCatalogue(),
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true);
        assert.equal(foo.version, '7.8.9');
        assert.equal(foo.error, null);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Version detection: bounded, never throws, never stalls
// ===========================================================================

test('a failing version probe yields version:null with a reason and never throws', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ error: Object.assign(new Error('Command failed: exit 1'), { code: 1 }) })),
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true, 'a failed version probe must not un-install the agent');
        assert.equal(foo.version, null);
        assert.match(foo.error, /version probe failed/);
    } finally { box.cleanup(); }
});

test('a hanging CLI is bounded by the watchdog: version:null, reason recorded, scan completes', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            versionTimeoutMs: 60,
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => 'hang'),   // callback never fires
        });

        const started = Date.now();
        const results = await discovery.scan({ force: true });
        assert.ok(Date.now() - started < 5000, 'scan must not stall on a hanging CLI');
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.installed, true);
        assert.equal(foo.version, null);
        assert.match(foo.error, /timed out/);
    } finally { box.cleanup(); }
});

test('a banner-only CLI that prints no version yields version:null with a reason', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: '   \n \n' })),
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.version, null);
        assert.match(foo.error, /no recognizable version/);
    } finally { box.cleanup(); }
});

test('a version printed on stderr is still captured', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: '', stderr: 'foo/2.11.0-beta.3\n' })),
        });

        const results = await discovery.scan({ force: true });
        assert.equal(results.find(r => r.id === 'foo').version, '2.11.0-beta.3');
    } finally { box.cleanup(); }
});

test('withVersion:false executes nothing at all', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const exec = makeExecStub(() => ({ stdout: 'foo 1.0.0' }));
        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').installed, true);
        assert.equal(results.find(r => r.id === 'foo').version, null);
        assert.equal(exec.calls.length, 0, 'the fast path must spawn zero child processes');
    } finally { box.cleanup(); }
});

test('the npm prefix is resolved once per instance, not once per agent', async () => {
    const box = makeSandbox();
    try {
        const prefix = box.subdir('npm-prefix');
        fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), { recursive: true });
        fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
        const planted = path.join(prefix, 'bin', 'bar');
        fs.writeFileSync(planted, 'inert');

        const exec = makeExecStub((file, args) => {
            if (file === 'npm' && args.join(' ') === 'root -g') {
                return { stdout: `${path.join(prefix, 'lib', 'node_modules')}\n` };
            }
            return { stdout: 'bar 0.1.2\n' };
        });
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const results = await discovery.scan({ force: true });
        const bar = results.find(r => r.id === 'bar');
        assert.equal(bar.installed, true);
        assert.equal(bar.source, 'npm-global');
        assert.equal(bar.binaryPath, planted);

        const npmCalls = exec.calls.filter(c => c.file === 'npm');
        assert.equal(npmCalls.length, 1, 'npm root -g must run exactly once for the whole scan');
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Caching
// ===========================================================================

test('caching returns the same result and force:true rescans', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const exec = makeExecStub(() => ({ stdout: 'foo 1.0.0\n' }));
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            cacheTtlMs: 60000,
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const first = await discovery.scan();
        const callsAfterFirst = exec.calls.length;
        const second = await discovery.scan();
        assert.equal(second, first, 'a warm cache returns the very same array');
        assert.equal(exec.calls.length, callsAfterFirst, 'a cache hit spawns nothing');

        const third = await discovery.scan({ force: true });
        assert.notEqual(third, first, 'force:true rescans');
        assert.ok(exec.calls.length > callsAfterFirst, 'the forced rescan probed again');
        assert.deepEqual(third.map(r => r.installed), first.map(r => r.installed));
    } finally { box.cleanup(); }
});

test('an expired cache rescans on its own', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const exec = makeExecStub(() => ({ stdout: 'foo 1.0.0\n' }));
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            cacheTtlMs: 0,
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const first = await discovery.scan();
        const second = await discovery.scan();
        assert.notEqual(second, first, 'a zero TTL means every scan is fresh');
    } finally { box.cleanup(); }
});

test('a version-less cache does not satisfy a later withVersion scan', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const exec = makeExecStub(() => ({ stdout: 'foo 4.5.6\n' }));
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            cacheTtlMs: 60000,
            catalogue: miniCatalogue(),
            execFileImpl: exec,
        });

        const fast = await discovery.scan({ withVersion: false });
        assert.equal(fast.find(r => r.id === 'foo').version, null);

        const full = await discovery.scan({ withVersion: true });
        assert.equal(full.find(r => r.id === 'foo').version, '4.5.6');

        // ...and the full result now serves the fast path.
        const again = await discovery.scan({ withVersion: false });
        assert.equal(again, full);
    } finally { box.cleanup(); }
});

test('clearCache forces the next scan to re-resolve', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            cacheTtlMs: 60000,
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: 'foo 1.0.0' })),
        });

        const first = await discovery.scan({ withVersion: false });
        discovery.clearCache();
        const second = await discovery.scan({ withVersion: false });
        assert.notEqual(second, first);
    } finally { box.cleanup(); }
});

// ===========================================================================
//  Views: supported vs merely detected
// ===========================================================================

test('getSupported and getUnsupported split installed agents by adapter availability', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');   // has an adapter
        box.plant('bin/bar', 'inert');   // adapter: null
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: '1.0.0' })),
        });

        await discovery.scan({ withVersion: false });

        assert.deepEqual(discovery.getInstalled().map(r => r.id).sort(), ['bar', 'foo']);
        assert.deepEqual(discovery.getSupported().map(r => r.id), ['foo']);
        assert.deepEqual(discovery.getUnsupported().map(r => r.id), ['bar']);
        assert.deepEqual(discovery.getMissing(), []);

        // Installed + adapter:null => detected, reported, explicitly unsupported.
        const bar = discovery.get('bar');
        assert.equal(bar.installed, true);
        assert.equal(bar.supported, false);
        assert.equal(bar.adapter, null);
        assert.equal(bar.error, null, 'no adapter yet is not an error');
    } finally { box.cleanup(); }
});

test('toRegistryEntries returns only supported AND installed agents', async () => {
    const box = makeSandbox();
    try {
        const foo = box.plant('bin/foo', 'inert');
        box.plant('bin/bar', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: 'foo 1.2.3' })),
        });

        await discovery.scan({ force: true });
        const entries = discovery.toRegistryEntries();
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0], {
            id: 'foo',
            key: 'foo',
            name: 'Foo CLI',
            emoji: '\u{1F535}',
            category: 'core',
            adapter: 'FooAgent',
            module: './agents/FooAgent',
            binaryPath: foo,
            source: 'known-path',
            version: '1.2.3',
        });
    } finally { box.cleanup(); }
});

test('toRegistryEntries is empty when a supported agent is not installed', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/bar', 'inert');   // only the adapter-less one exists
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => null),
        });

        await discovery.scan({ withVersion: false });
        assert.deepEqual(discovery.toRegistryEntries(), []);
        assert.deepEqual(discovery.getUnsupported().map(r => r.id), ['bar']);
    } finally { box.cleanup(); }
});

test('summary reports counts plus a one-line banner string', async () => {
    const box = makeSandbox();
    try {
        box.plant('bin/foo', 'inert');
        box.plant('bin/bar', 'inert');
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => ({ stdout: '1.0.0' })),
        });

        await discovery.scan({ withVersion: false });
        const summary = discovery.summary();
        assert.equal(summary.catalogue, 2);
        assert.equal(summary.installed, 2);
        assert.equal(summary.supported, 1);
        assert.equal(summary.unsupported, 1);
        assert.equal(summary.missing, 0);
        assert.equal(typeof summary.line, 'string');
        assert.ok(!summary.line.includes('\n'), 'the banner must be a single line');
        assert.match(summary.line, /\[AgentDiscovery\]/);
        assert.match(summary.line, /foo/);
        assert.match(summary.line, /bar/);
    } finally { box.cleanup(); }
});

test('summary and views are safe to call before any scan', () => {
    const discovery = new AgentDiscovery({ platform: 'linux', env: isolatedEnv() });
    assert.deepEqual(discovery.getInstalled(), []);
    assert.deepEqual(discovery.getSupported(), []);
    assert.deepEqual(discovery.getUnsupported(), []);
    assert.deepEqual(discovery.toRegistryEntries(), []);
    assert.equal(discovery.summary().installed, 0);
    assert.equal(discovery.get('claude'), null);
});

// ===========================================================================
//  Cross-platform simulation (no real filesystem dependency)
// ===========================================================================

test('the injected platform selects that platform\'s candidate list', async () => {
    const box = makeSandbox();
    try {
        const darwinDir = box.subdir('darwin-bin');
        const planted = path.join(darwinDir, 'foo');
        fs.writeFileSync(planted, 'inert');

        const catalogue = miniCatalogue();
        catalogue[0].candidates.darwin = [`${darwinDir.split(path.sep).join('/')}/foo`];
        catalogue[0].candidates.linux = ['/definitely/not/here/foo'];

        const asDarwin = new AgentDiscovery({
            platform: 'darwin', env: isolatedEnv(), catalogue, execFileImpl: makeExecStub(() => null),
        });
        const asLinux = new AgentDiscovery({
            platform: 'linux', env: isolatedEnv(), catalogue, execFileImpl: makeExecStub(() => null),
        });

        assert.equal((await asDarwin.scan({ withVersion: false })).find(r => r.id === 'foo').installed, true);
        assert.equal((await asLinux.scan({ withVersion: false })).find(r => r.id === 'foo').installed, false);
    } finally { box.cleanup(); }
});

test('candidate templates expand injected env tokens and skip unset ones', async () => {
    const box = makeSandbox();
    try {
        const appdata = box.subdir('Roaming');
        fs.mkdirSync(path.join(appdata, 'npm'), { recursive: true });
        const planted = path.join(appdata, 'npm', 'foo.cmd');
        fs.writeFileSync(planted, 'inert');

        const catalogue = miniCatalogue();
        catalogue[0].candidates.win32 = ['{APPDATA}/npm/foo.cmd', '{NOPE_UNSET}/foo.cmd'];

        const discovery = new AgentDiscovery({
            platform: 'win32',
            env: isolatedEnv({ APPDATA: appdata }),
            catalogue,
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').binaryPath, planted);
    } finally { box.cleanup(); }
});

test('a wildcard candidate picks the newest versioned bin directory', async () => {
    const box = makeSandbox();
    try {
        const base = box.subdir('Codex/bin');
        const older = box.plant('Codex/bin/aaa-old/foo.exe', 'old');
        const newer = box.plant('Codex/bin/zzz-new/foo.exe', 'new');
        // Make the mtime ordering unambiguous regardless of write order.
        const past = new Date(Date.now() - 600000);
        fs.utimesSync(older, past, past);

        const catalogue = miniCatalogue();
        catalogue[0].candidates.win32 = [`${base.split(path.sep).join('/')}/*/foo.exe`];

        const discovery = new AgentDiscovery({
            platform: 'win32', env: isolatedEnv(), catalogue, execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').binaryPath, newer);
    } finally { box.cleanup(); }
});

test('a directory shadowing the binary name is not mistaken for an executable', async () => {
    const box = makeSandbox();
    try {
        fs.mkdirSync(path.join(box.dir, 'bin', 'foo'), { recursive: true });
        const discovery = new AgentDiscovery({
            platform: 'linux',
            env: isolatedEnv(),
            extraPaths: [path.join(box.dir, 'bin')],
            catalogue: miniCatalogue(),
            execFileImpl: makeExecStub(() => null),
        });

        const results = await discovery.scan({ withVersion: false });
        assert.equal(results.find(r => r.id === 'foo').installed, false);
    } finally { box.cleanup(); }
});

test('PATH lookup shells out via command -v (never which) on non-windows', async () => {
    const box = makeSandbox();
    try {
        const planted = box.plant('sys/foo', 'inert');
        const exec = makeExecStub((file, args) => {
            if (file === '/bin/sh' && args[1].includes('command -v')) return { stdout: `${planted}\n` };
            return null;
        });
        const discovery = new AgentDiscovery({
            platform: 'linux', env: isolatedEnv(), catalogue: miniCatalogue(), execFileImpl: exec,
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.source, 'path');
        assert.equal(foo.binaryPath, planted);

        const shellCalls = exec.calls.filter(c => c.file === '/bin/sh');
        assert.ok(shellCalls.length > 0);
        for (const call of shellCalls) {
            assert.ok(!/which/.test(call.args[1]), 'must not use `which`');
            assert.ok(call.args[1].includes('"$1"'), 'the bin name must travel as an argv parameter');
        }
    } finally { box.cleanup(); }
});

test('PATH lookup uses `where` on win32', async () => {
    const box = makeSandbox();
    try {
        const planted = box.plant('sys/foo.exe', 'inert');
        const exec = makeExecStub((file, args) => {
            if (file === 'where' && args[0] === 'foo') return { stdout: `${planted}\r\n` };
            return null;
        });
        const discovery = new AgentDiscovery({
            platform: 'win32', env: isolatedEnv(), catalogue: miniCatalogue(), execFileImpl: exec,
        });

        const results = await discovery.scan({ force: true });
        const foo = results.find(r => r.id === 'foo');
        assert.equal(foo.source, 'path');
        assert.equal(foo.binaryPath, planted);
        assert.ok(exec.calls.some(c => c.file === 'where'));
    } finally { box.cleanup(); }
});
