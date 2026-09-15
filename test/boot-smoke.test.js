// =============================================================================
//  test/boot-smoke.test.js — Hermetic boot: every core/ and agents/ module loads
//
//  Does not require index.js (lock port, Telegram, log rotation).
//  Does not bind sockets, spawn agents/CLIs, or touch store/ or sessions/.
// =============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'core');
const AGENTS_DIR = path.join(ROOT, 'agents');

/**
 * Modules that construct process-wide state the first time they are required.
 * Isolated as named subtests so a load failure is attributed to the right file.
 * None of these bind a port or write into store/ or sessions/.
 */
const IMPORT_TIME_SIDE_EFFECTS = Object.freeze({
    'WorkspaceManager.js': 'new WorkspaceManager() may mkdirSync(<repo>/workspaces/)',
    'TruncationEngine.js': 'new TruncationEngine() may mkdirSync(<repo>/workspaces/outputs/)',
    'EventBus.js': 'new ChannelEventBus() singleton (in-memory)',
    'AgentPool.js': 'new AgentPool() singleton (in-memory; reads config.maxConcurrentAgents)',
    'SatelliteHub.js': 'new SatelliteHub() singleton (in-memory)',
    'LoopGuard.js': 'new LoopGuard() singleton (in-memory)',
    'SecurityApprovalGate.js': 'new SecurityApprovalGate() singleton (in-memory)',
    'HermesToolEngine.js': 'new HermesToolEngine() singleton (in-memory; pulls TruncationEngine/LoopGuard/SecurityApprovalGate)',
});

const EXPECTED_CONFIG_KEYS = Object.freeze([
    'baseDir',
    'lockPort',
    'lockHost',
    'desktopHost',
    'desktopPort',
    'desktopPath',
    'desktopTimeoutMs',
    'agentTimeoutMs',
    'shellCommandTimeoutMs',
    'shellCommandMaxOutputBytes',
    'toolApprovalTimeoutMs',
    'reconnectBaseDelayMs',
    'reconnectMaxDelayMs',
    'queueNoticeThreshold',
    'streamUpdateIntervalMs',
    'typingRefreshIntervalMs',
    'telegramIpFamily',
    'telegramKeepAliveMs',
    'dropPendingUpdates',
    'mediaTimeoutMs',
    'mediaMaxBytes',
    'uploadRetentionHours',
    'modelCacheTtlMs',
    'modelDiscoveryTimeoutMs',
    'logFile',
    'logMaxBytes',
    'logBackups',
    'maxConcurrentAgents',
]);

function listJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
        .map((entry) => entry.name)
        .sort();
}

function loadJs(absPath) {
    let exported;
    assert.doesNotThrow(() => {
        exported = require(absPath);
    }, `require(${path.relative(ROOT, absPath)}) threw`);
    assert.notEqual(exported, undefined);
    assert.notEqual(exported, null);
    return exported;
}

function rmTemp(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
        // Windows can keep a sqlite handle long enough for EPERM; never fail the test.
    }
}

// ---------------------------------------------------------------------------
//  1. Import-time constructors — load these first so the sweep hits cache.
// ---------------------------------------------------------------------------

test('modules with import-time constructors load (documented side effects)', async (t) => {
    for (const [file, note] of Object.entries(IMPORT_TIME_SIDE_EFFECTS)) {
        await t.test(`core/${file} — ${note}`, () => {
            assert.ok(fs.existsSync(path.join(CORE_DIR, file)), `missing core/${file}`);
            loadJs(path.join(CORE_DIR, file));
        });
    }
});

// ---------------------------------------------------------------------------
//  2. Every real core/*.js file require()s. Skip nothing.
// ---------------------------------------------------------------------------

test('every core/*.js module require()s without throwing', async (t) => {
    const files = listJs(CORE_DIR);
    assert.ok(files.length > 0, 'expected core/*.js files');
    for (const must of ['config.js', 'MissionControl.js', 'RouterRoutes.js', 'SwarmRoutes.js', 'Database.js']) {
        assert.ok(files.includes(must), `core/ listing missed ${must}`);
    }

    for (const file of files) {
        const note = IMPORT_TIME_SIDE_EFFECTS[file];
        const title = note ? `${file} [import-time: ${note}]` : file;
        await t.test(title, () => {
            loadJs(path.join(CORE_DIR, file));
        });
    }

    const indexPath = path.join(ROOT, 'index.js');
    assert.equal(
        Object.prototype.hasOwnProperty.call(require.cache, indexPath),
        false,
        'index.js must not enter require.cache',
    );
});

// ---------------------------------------------------------------------------
//  3. Every real agents/*.js file require()s. Skip nothing. Do not instantiate.
// ---------------------------------------------------------------------------

test('every agents/*.js module require()s without throwing', async (t) => {
    const files = listJs(AGENTS_DIR);
    assert.ok(files.length > 0, 'expected agents/*.js files');

    for (const file of files) {
        await t.test(file, () => {
            const exported = loadJs(path.join(AGENTS_DIR, file));
            assert.equal(typeof exported, 'function', `${file} should export a class`);
        });
    }
});

// ---------------------------------------------------------------------------
//  4. config.js is a real config object.
// ---------------------------------------------------------------------------

test('core/config.js exports the expected config object', () => {
    const config = require('../core/config');
    assert.equal(typeof config, 'object');
    for (const key of EXPECTED_CONFIG_KEYS) {
        assert.ok(key in config, `config missing key ${key}`);
        assert.notEqual(config[key], undefined, `config.${key} is undefined`);
    }

    assert.equal(typeof config.baseDir, 'string');
    assert.ok(path.isAbsolute(config.baseDir));
    assert.equal(typeof config.lockPort, 'number');
    assert.ok(config.lockPort >= 1);
    assert.equal(typeof config.lockHost, 'string');
    assert.ok(config.lockHost.length > 0);
    assert.equal(typeof config.dropPendingUpdates, 'boolean');
    assert.equal(typeof config.maxConcurrentAgents, 'number');
    assert.ok(config.maxConcurrentAgents >= 1);
    assert.equal(typeof config.agentTimeoutMs, 'number');
    assert.ok(config.agentTimeoutMs >= 1000);
    assert.equal(typeof config.logFile, 'string');
    assert.equal(typeof config.logMaxBytes, 'number');
    assert.equal(typeof config.logBackups, 'number');
});

// ---------------------------------------------------------------------------
//  5. MissionControl / RouterRoutes / SwarmRoutes are loadable functions.
//     Do not instantiate MissionControl (constructor calls getDeviceAutomation).
// ---------------------------------------------------------------------------

test('MissionControl, RouterRoutes, and SwarmRoutes export functions', () => {
    const MissionControl = require('../core/MissionControl');
    assert.equal(typeof MissionControl, 'function');

    const RouterRoutes = require('../core/RouterRoutes');
    assert.equal(typeof RouterRoutes, 'object');
    assert.equal(typeof RouterRoutes.handleRouterRoutes, 'function');
    assert.equal(typeof RouterRoutes.runImprovement, 'function');

    const SwarmRoutes = require('../core/SwarmRoutes');
    assert.equal(typeof SwarmRoutes, 'object');
    assert.equal(typeof SwarmRoutes.handleSwarmRoutes, 'function');
    assert.equal(typeof SwarmRoutes.authenticatePeer, 'function');
});

// ---------------------------------------------------------------------------
//  6. package.json test script.
// ---------------------------------------------------------------------------

test('package.json test script is node --test test/*.test.js', () => {
    const pkg = require('../package.json');
    assert.equal(pkg.scripts && pkg.scripts.test, 'node --test test/*.test.js');
});

// ---------------------------------------------------------------------------
//  7. node:sqlite works via AssistantDatabase in a temp file — never store/.
// ---------------------------------------------------------------------------

test('AssistantDatabase opens sqlite in a temp file and closes', () => {
    const { AssistantDatabase } = require('../core/Database');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-smoke-'));
    const dbPath = path.join(dir, 'boot-smoke.db');
    let database;
    try {
        database = new AssistantDatabase(dbPath);
        assert.ok(database.db, 'expected a node:sqlite handle');
        const row = database.db.prepare('SELECT 1 AS ok').get();
        assert.equal(row.ok, 1);
        assert.ok(fs.existsSync(dbPath));
        assert.equal(path.resolve(dbPath).startsWith(path.resolve(path.join(ROOT, 'store'))), false);
    } finally {
        try {
            if (database && database.db && typeof database.db.close === 'function') {
                database.db.close();
            }
        } catch {
            // already closed
        }
        rmTemp(dir);
    }
});
