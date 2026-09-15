const test = require('node:test');
const assert = require('node:assert/strict');

const SyncthingBridge = require('../core/SyncthingBridge');
const { DEVICE_ID_RE, DEFAULT_URL } = require('../core/SyncthingBridge');

// -----------------------------------------------------------------------------
//  Helpers — hermetic. Every request goes through the injected transport, so no
//  socket is ever opened and no real Syncthing instance is needed.
// -----------------------------------------------------------------------------

/** A syntactically valid device id: 8 dash-separated groups of 7 chars. */
function validId(seed = 'A') {
    const group = (seed + '234567').slice(0, 7).toUpperCase();
    return Array.from({ length: 8 }, () => group).join('-');
}

/**
 * Bridge whose transport answers from `routes` and records every call.
 *
 * A route value may be a plain object (resolved), a function (called with the
 * request), or an Error instance (rejected) so a test can script a failure.
 */
function makeBridge(routes = {}, opts = {}) {
    const calls = [];
    const transport = async (req) => {
        calls.push(req);
        // Match on the longest registered path that the url ends with/contains,
        // so '/rest/db/status?folder=x' can be scripted as '/rest/db/status'.
        const key = Object.keys(routes)
            .filter((k) => req.url.includes(k))
            .sort((a, b) => b.length - a.length)[0];
        const entry = key === undefined ? undefined : routes[key];
        const value = typeof entry === 'function' ? await entry(req, calls) : entry;
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`no route scripted for ${req.method} ${req.url}`);
        return value;
    };
    const bridge = new SyncthingBridge({
        apiKey: opts.apiKey === undefined ? 'test-api-key' : opts.apiKey,
        baseUrl: opts.baseUrl,
        transport,
    });
    return { bridge, calls };
}

const methodsOf = (calls, verb) => calls.filter((c) => c.method === verb);

// ===========================================================================
//  Read paths
// ===========================================================================

test('myStatus returns identity and version', async () => {
    const { bridge } = makeBridge({
        '/rest/system/status': { myID: 'DEVICE-ID-HERE', uptime: 4242 },
        '/rest/system/version': { version: 'v1.27.0' },
    });
    const status = await bridge.myStatus();
    assert.equal(status.deviceId, 'DEVICE-ID-HERE');
    assert.equal(status.uptimeSeconds, 4242);
    assert.equal(status.version, 'v1.27.0');
});

test('myStatus still resolves when the version call fails', async () => {
    // The version lookup is .catch-wrapped on purpose: an older daemon that
    // lacks the endpoint must not make identity unavailable.
    const { bridge } = makeBridge({
        '/rest/system/status': { myID: 'ONLY-ID', uptime: 1 },
        '/rest/system/version': new Error('404'),
    });
    const status = await bridge.myStatus();
    assert.equal(status.deviceId, 'ONLY-ID');
    assert.equal(status.version, null);
});

test('listDevices marks connected only for devices in the connections map', async () => {
    const a = validId('A');
    const b = validId('B');
    const { bridge } = makeBridge({
        '/rest/config/devices': [
            { deviceID: a, name: 'laptop', addresses: ['dynamic'] },
            { deviceID: b, name: 'vps', addresses: ['tcp://1.2.3.4:22000'], paused: true },
        ],
        '/rest/system/connections': { connections: { [a]: { connected: true, address: '10.0.0.5:22000' } } },
    });

    const devices = await bridge.listDevices();
    const byId = Object.fromEntries(devices.map((d) => [d.deviceId, d]));
    assert.equal(byId[a].connected, true);
    assert.equal(byId[a].address, '10.0.0.5:22000');
    assert.equal(byId[b].connected, false, 'absent from connections means not connected');
    assert.equal(byId[b].paused, true);
});

test('listFolders defaults a missing label to the folder id', async () => {
    const { bridge } = makeBridge({
        '/rest/config/folders': [
            { id: 'vault', path: '/data/vault', type: 'sendreceive', devices: [{ deviceID: validId('A') }] },
            { id: 'notes', label: 'My Notes', path: '/data/notes', devices: [] },
        ],
    });
    const folders = await bridge.listFolders();
    const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
    assert.equal(byId.vault.label, 'vault', 'falls back to the id');
    assert.equal(byId.notes.label, 'My Notes');
    assert.deepEqual(byId.vault.devices, [validId('A')]);
});

// ===========================================================================
//  inSync — a mid-transfer folder must never read as complete
// ===========================================================================

for (const c of [
    { name: 'idle with nothing needed is in sync', state: 'idle', needFiles: 0, expected: true },
    { name: 'idle but files still needed is NOT in sync', state: 'idle', needFiles: 3, expected: false },
    { name: 'syncing with nothing needed is NOT in sync', state: 'syncing', needFiles: 0, expected: false },
]) {
    test(`syncStatus: ${c.name}`, async () => {
        const { bridge } = makeBridge({
            '/rest/config/folders': [{ id: 'vault', path: '/v', devices: [] }],
            '/rest/db/status': { state: c.state, needFiles: c.needFiles, globalFiles: 10, localFiles: 10 - c.needFiles },
        });
        const [row] = await bridge.syncStatus();
        assert.equal(row.inSync, c.expected);
        assert.equal(row.state, c.state);
    });
}

test('syncStatus reports a failing folder as errored instead of throwing', async () => {
    const { bridge } = makeBridge({
        '/rest/config/folders': [{ id: 'vault', path: '/v', devices: [] }],
        '/rest/db/status': new Error('folder is paused'),
    });
    const [row] = await bridge.syncStatus();
    assert.equal(row.state, 'error');
    assert.equal(row.inSync, false);
    assert.match(String(row.error), /paused/);
});

// ===========================================================================
//  addDevice — validation, because a bad id would be written into config
// ===========================================================================

test('addDevice rejects a malformed device id', async () => {
    const { bridge, calls } = makeBridge({ '/rest/config/devices': [] });
    for (const bad of ['', 'short', 'ABC-DEF', validId('A').split('-').slice(0, 7).join('-'), 'ABCDEF!-1234567-1234567-1234567-1234567-1234567-1234567-1234567']) {
        await assert.rejects(
            () => bridge.addDevice(bad, 'nope'),
            /device ID/i,
            `expected ${JSON.stringify(bad)} to be rejected`,
        );
    }
    assert.equal(methodsOf(calls, 'POST').length, 0, 'nothing may be written for an invalid id');
});

test('DEVICE_ID_RE accepts a well-formed id and rejects a 7-group one', () => {
    assert.ok(DEVICE_ID_RE.test(validId('A')));
    assert.ok(!DEVICE_ID_RE.test(validId('A').split('-').slice(0, 7).join('-')));
    assert.equal(typeof DEFAULT_URL, 'string');
});

test('addDevice is idempotent: an existing device issues no POST', async () => {
    const id = validId('A');
    const { bridge, calls } = makeBridge({
        '/rest/config/devices': [{ deviceID: id, name: 'laptop' }],
        '/rest/system/connections': { connections: {} },
    });
    const result = await bridge.addDevice(id, 'laptop');
    assert.equal(result.alreadyPresent, true);
    assert.equal(methodsOf(calls, 'POST').length, 0);
});

test('addDevice upper-cases a lowercase id before use', async () => {
    const id = validId('A');
    const { bridge, calls } = makeBridge({
        '/rest/config/devices': (req) => (req.method === 'POST' ? {} : []),
        '/rest/system/connections': { connections: {} },
    });
    const result = await bridge.addDevice(id.toLowerCase(), 'laptop');
    assert.equal(result.deviceId, id, 'stored id is upper-cased');
    const post = methodsOf(calls, 'POST')[0];
    assert.equal(post.body.deviceID, id);
});

// ===========================================================================
//  shareFolder — THE critical one
// ===========================================================================

test('shareFolder preserves the devices a folder is already shared with', async () => {
    // Syncthing's PATCH REPLACES the folder's device list. Sending only the new
    // device would silently unshare everyone else — a data-loss-shaped bug, and
    // the single most important property in this module.
    const existingA = validId('A');
    const existingB = validId('B');
    const incoming = validId('C');

    const { bridge, calls } = makeBridge({
        '/rest/config/folders/vault': (req) => {
            if (req.method === 'PATCH') return {};
            return { id: 'vault', path: '/v', devices: [{ deviceID: existingA }, { deviceID: existingB }] };
        },
    });

    const result = await bridge.shareFolder('vault', incoming);
    assert.equal(result.ok, true);

    const patch = methodsOf(calls, 'PATCH')[0];
    assert.ok(patch, 'a PATCH must be issued');
    const sent = patch.body.devices.map((d) => String(d.deviceID).toUpperCase());
    assert.ok(sent.includes(existingA), 'pre-existing device A must survive');
    assert.ok(sent.includes(existingB), 'pre-existing device B must survive');
    assert.ok(sent.includes(incoming), 'the new device must be added');
    assert.equal(sent.length, 3, 'exactly the union, nothing dropped or duplicated');
});

test('shareFolder is idempotent for a device already shared', async () => {
    const id = validId('A');
    const { bridge, calls } = makeBridge({
        '/rest/config/folders/vault': { id: 'vault', path: '/v', devices: [{ deviceID: id }] },
    });
    const result = await bridge.shareFolder('vault', id);
    assert.equal(result.alreadyShared, true);
    assert.equal(methodsOf(calls, 'PATCH').length, 0);
});

test('shareFolder rejects an invalid id and an unknown folder', async () => {
    const { bridge } = makeBridge({ '/rest/config/folders/vault': { id: 'vault', devices: [] } });
    await assert.rejects(() => bridge.shareFolder('vault', 'not-an-id'), /device ID/i);

    const { bridge: b2 } = makeBridge({ '/rest/config/folders/ghost': null });
    await assert.rejects(() => b2.shareFolder('ghost', validId('A')), /folder/i);
});

// ===========================================================================
//  Configuration and failure handling
// ===========================================================================

test('an unconfigured bridge rejects rather than sending an unauthenticated request', async () => {
    const bare = new SyncthingBridge({ apiKey: null });
    assert.equal(bare.isConfigured, false);
    await assert.rejects(() => bare.myStatus(), /API key/i);
});

test('overview never throws: unconfigured', async () => {
    const bare = new SyncthingBridge({ apiKey: null });
    const view = await bare.overview();
    assert.equal(view.configured, false);
    assert.equal(view.reachable, false);
    assert.ok(view.reason, 'a reason must be given');
});

test('overview never throws: daemon unreachable', async () => {
    // A daemon that is down fails EVERY call, not one of them. overview() fires
    // status/devices/folders in parallel, so scripting only one would leave the
    // reported reason dependent on which rejection happened to land first.
    const bridge = new SyncthingBridge({
        apiKey: 'test-api-key',
        transport: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8384'); },
    });
    const view = await bridge.overview();
    assert.equal(view.reachable, false);
    assert.match(String(view.reason), /ECONNREFUSED/);
});

test('overview allInSync is false when any folder lags', async () => {
    const { bridge } = makeBridge({
        '/rest/system/status': { myID: 'X', uptime: 1 },
        '/rest/system/version': { version: 'v1' },
        '/rest/config/devices': [],
        '/rest/system/connections': { connections: {} },
        '/rest/config/folders': [
            { id: 'a', path: '/a', devices: [] },
            { id: 'b', path: '/b', devices: [] },
        ],
        '/rest/db/status': (req) => (req.url.includes('folder=a')
            ? { state: 'idle', needFiles: 0 }
            : { state: 'syncing', needFiles: 5 }),
        '/rest/cluster/pending/devices': {},
        '/rest/cluster/pending/folders': {},
    });
    const view = await bridge.overview();
    assert.equal(view.reachable, true);
    assert.equal(view.allInSync, false, 'one lagging folder makes the whole view out of sync');
});

test('pending tolerates both endpoints failing', async () => {
    const { bridge } = makeBridge({
        '/rest/cluster/pending/devices': new Error('boom'),
        '/rest/cluster/pending/folders': new Error('boom'),
    });
    const pending = await bridge.pending();
    assert.deepEqual(pending.devices, []);
    assert.deepEqual(pending.folders, []);
});

test('rescan and setPaused issue the right calls', async () => {
    const { bridge, calls } = makeBridge({
        '/rest/db/scan': {},
        '/rest/config/folders/vault': {},
    });
    await bridge.rescan('vault');
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/rest/db/scan') && c.url.includes('folder=vault')));

    await bridge.setPaused('vault', true);
    const patch = methodsOf(calls, 'PATCH')[0];
    assert.equal(patch.body.paused, true);
});

test('discoverApiKey never throws and returns null or a well-formed result', () => {
    // It reads real platform paths, so the outcome depends on whether Syncthing
    // is installed here. Assert only the contract, never a machine-specific value.
    const found = SyncthingBridge.discoverApiKey();
    if (found !== null) {
        assert.equal(typeof found.apiKey, 'string');
        assert.equal(typeof found.configPath, 'string');
        assert.ok(found.apiKey.length > 0);
    }
});
