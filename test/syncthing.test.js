const test = require('node:test');
const assert = require('node:assert/strict');

const SyncthingBridge = require('../core/SyncthingBridge');
const { DEVICE_ID_RE, DEFAULT_URL } = SyncthingBridge;

// -----------------------------------------------------------------------------
//  Helpers — hermetic: every request goes through the injected `transport`
//  seam, so nothing here ever touches a real Syncthing instance or network.
// -----------------------------------------------------------------------------

/**
 * Builds a syntactically valid Syncthing device ID (8 dash-separated groups
 * of 7 [A-Z0-9] chars) from a short readable tag, so a test never has to
 * hand-type a 64-character ID and still gets a distinct, deterministic value
 * per tag.
 */
function makeDeviceId(tag) {
    const head = String(tag).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(4, 'X').slice(0, 4);
    const groups = [];
    for (let i = 0; i < 8; i++) {
        groups.push(`${head}${String(i).padStart(3, '0')}`);
    }
    return groups.join('-');
}

/**
 * A SyncthingBridge wired to a fake transport. `responses` maps
 * "METHOD /api/path" — the exact method + apiPath the bridge builds, query
 * string included — to either a resolved value, an Error instance (rejects
 * the call), or a function `(call) => value|Error` for dynamic responses.
 * A call with no matching entry throws loudly instead of hanging or
 * silently resolving, so a forgotten stub fails the test rather than
 * masking a gap. Returns the bridge plus the list of calls it received.
 */
function makeBridge({ apiKey = 'test-api-key', baseUrl = DEFAULT_URL, responses = {} } = {}) {
    const calls = [];
    const transport = async ({ method, url, body, apiKey: sentKey }) => {
        const apiPath = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
        const call = { method, url, apiPath, body, apiKey: sentKey };
        calls.push(call);
        const key = `${method} ${apiPath}`;
        if (!Object.prototype.hasOwnProperty.call(responses, key)) {
            throw new Error(`makeBridge: no response scripted for "${key}"`);
        }
        const entry = responses[key];
        const value = typeof entry === 'function' ? entry(call) : entry;
        if (value instanceof Error) throw value;
        return value;
    };
    const bridge = new SyncthingBridge({ baseUrl, apiKey, transport });
    return { bridge, calls };
}

/**
 * Runs `fn` with SYNCTHING_API_KEY forced unset, restoring whatever was
 * there afterward. The bridge reads process.env directly with no injectable
 * seam for it, so ambient env has to be neutralised by hand for tests that
 * depend on "no key configured".
 */
async function withNoAmbientApiKey(fn) {
    const saved = process.env.SYNCTHING_API_KEY;
    delete process.env.SYNCTHING_API_KEY;
    try {
        return await fn();
    } finally {
        if (saved === undefined) delete process.env.SYNCTHING_API_KEY;
        else process.env.SYNCTHING_API_KEY = saved;
    }
}

// -----------------------------------------------------------------------------
//  Module shape
// -----------------------------------------------------------------------------

test('exports the bridge as both default and named, plus DEVICE_ID_RE and DEFAULT_URL', () => {
    assert.equal(typeof SyncthingBridge, 'function');
    assert.equal(SyncthingBridge.SyncthingBridge, SyncthingBridge, 'named export is the same class as the default');
    assert.ok(DEVICE_ID_RE instanceof RegExp);
    assert.equal(DEFAULT_URL, 'http://127.0.0.1:8384');
});

// -----------------------------------------------------------------------------
//  myStatus()
// -----------------------------------------------------------------------------

test('myStatus() returns deviceId, uptimeSeconds and version', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/system/status': { myID: 'ME-ID-1', uptime: 12345 },
            'GET /rest/system/version': { version: 'v1.27.0' },
        },
    });
    const status = await bridge.myStatus();
    assert.deepEqual(status, { deviceId: 'ME-ID-1', uptimeSeconds: 12345, version: 'v1.27.0' });
});

test('myStatus() still resolves when the version endpoint rejects (it is .catch-wrapped)', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/system/status': { myID: 'SELF-ID', uptime: 999 },
            'GET /rest/system/version': new Error('version endpoint down'),
        },
    });
    const status = await bridge.myStatus();
    assert.deepEqual(status, { deviceId: 'SELF-ID', uptimeSeconds: 999, version: null });
});

// -----------------------------------------------------------------------------
//  listDevices()
// -----------------------------------------------------------------------------

test('listDevices() merges config devices with live connections; connected is true only when present in the connections map', async () => {
    const laptop = makeDeviceId('LAPT');
    const phone = makeDeviceId('PHON');
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/config/devices': [
                { deviceID: laptop, name: 'Laptop', paused: false, addresses: ['tcp://10.0.0.5:22000'] },
                { deviceID: phone, paused: true },
            ],
            'GET /rest/system/connections': {
                connections: {
                    [laptop]: { connected: true, address: '10.0.0.5:51820' },
                },
            },
        },
    });
    const devices = await bridge.listDevices();
    assert.deepEqual(devices, [
        { deviceId: laptop, name: 'Laptop', paused: false, addresses: ['tcp://10.0.0.5:22000'], connected: true, address: '10.0.0.5:51820' },
        { deviceId: phone, name: '', paused: true, addresses: [], connected: false, address: null },
    ]);
});

// -----------------------------------------------------------------------------
//  listFolders()
// -----------------------------------------------------------------------------

test('listFolders() defaults label to id when absent', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/config/folders': [
                { id: 'vault', path: 'C:\\vault', type: 'sendreceive', devices: [{ deviceID: 'X' }] },
                { id: 'notes', label: 'My Notes', path: 'C:\\notes', type: 'sendonly' },
            ],
        },
    });
    const folders = await bridge.listFolders();
    assert.equal(folders[0].label, 'vault', 'label falls back to id when the folder has none');
    assert.equal(folders[1].label, 'My Notes', 'an explicit label is kept as-is');
    assert.deepEqual(folders[0].devices, ['X']);
    assert.equal(folders[0].paused, false);
});

// -----------------------------------------------------------------------------
//  syncStatus() — inSync truth table
// -----------------------------------------------------------------------------

test('syncStatus() marks inSync true only for needFiles===0 AND state==="idle"', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/db/status?folder=idle-zero': { state: 'idle', needFiles: 0, globalFiles: 10, localFiles: 10 },
            'GET /rest/db/status?folder=idle-three': { state: 'idle', needFiles: 3, globalFiles: 10, localFiles: 7 },
            'GET /rest/db/status?folder=syncing-zero': { state: 'syncing', needFiles: 0, globalFiles: 10, localFiles: 10 },
        },
    });

    const [idleZero] = await bridge.syncStatus('idle-zero');
    assert.equal(idleZero.inSync, true, 'idle with nothing needed is in sync');

    const [idleThree] = await bridge.syncStatus('idle-three');
    assert.equal(idleThree.inSync, false, 'idle but still needing files is not in sync');

    const [syncingZero] = await bridge.syncStatus('syncing-zero');
    assert.equal(syncingZero.inSync, false, 'a mid-transfer folder must never read as complete, even at needFiles===0');
});

test('syncStatus() reports state:"error" and inSync:false for a folder whose status call rejects, without throwing', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/db/status?folder=broken': new Error('folder index unavailable'),
        },
    });
    const result = await bridge.syncStatus('broken');
    assert.equal(result.length, 1);
    assert.equal(result[0].state, 'error');
    assert.equal(result[0].inSync, false);
    assert.match(result[0].error, /folder index unavailable/);
});

test('syncStatus() with no folderId enumerates every folder via listFolders() and isolates per-folder failures', async () => {
    const { bridge } = makeBridge({
        responses: {
            'GET /rest/config/folders': [{ id: 'vault' }, { id: 'notes' }],
            'GET /rest/db/status?folder=vault': { state: 'idle', needFiles: 0 },
            'GET /rest/db/status?folder=notes': new Error('notes db locked'),
        },
    });
    const result = await bridge.syncStatus();
    assert.equal(result.length, 2);
    assert.equal(result.find((r) => r.id === 'vault').inSync, true);
    const notes = result.find((r) => r.id === 'notes');
    assert.equal(notes.state, 'error');
    assert.equal(notes.inSync, false);
});

// -----------------------------------------------------------------------------
//  addDevice() — device ID validation
// -----------------------------------------------------------------------------

test('addDevice() rejects malformed device IDs without ever calling the transport', async () => {
    const valid = makeDeviceId('GOOD');
    const sevenGroups = valid.split('-').slice(0, 7).join('-');
    const invalidChar = '!' + valid.slice(1);

    const cases = {
        'empty string': '',
        'too short': 'short',
        'wrong shape': 'ABC-DEF',
        'only 7 groups': sevenGroups,
        'invalid character': invalidChar,
    };

    for (const [label, id] of Object.entries(cases)) {
        const { bridge, calls } = makeBridge({ responses: {} });
        await assert.rejects(
            () => bridge.addDevice(id),
            /does not look like a Syncthing device ID/i,
            `expected "${label}" (${id}) to be rejected`,
        );
        assert.equal(calls.length, 0, `"${label}" must not reach the transport at all`);
    }
});

test('addDevice() returns {alreadyPresent:true} and issues no POST for a device that already exists', async () => {
    const existing = makeDeviceId('EXST');
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/devices': [{ deviceID: existing, name: 'Existing Box' }],
            'GET /rest/system/connections': { connections: {} },
        },
    });
    const result = await bridge.addDevice(existing.toLowerCase());
    assert.deepEqual(result, { ok: true, alreadyPresent: true, deviceId: existing });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no POST must be issued for an already-known device');
});

// -----------------------------------------------------------------------------
//  addDevice() — happy path
// -----------------------------------------------------------------------------

test('addDevice() upper-cases lowercase input and POSTs the new device', async () => {
    const lower = makeDeviceId('MIXD').toLowerCase();
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/devices': [],
            'GET /rest/system/connections': { connections: {} },
            'POST /rest/config/devices': null,
        },
    });
    const result = await bridge.addDevice(lower, 'My Phone');
    assert.deepEqual(result, { ok: true, deviceId: lower.toUpperCase(), name: 'My Phone' });

    const post = calls.find((c) => c.method === 'POST' && c.apiPath === '/rest/config/devices');
    assert.ok(post, 'a POST must be issued for a genuinely new device');
    assert.equal(post.body.deviceID, lower.toUpperCase(), 'the id sent upstream is upper-cased');
    assert.equal(post.body.name, 'My Phone');
    assert.deepEqual(post.body.addresses, ['dynamic']);
});

test('addDevice() with no name falls back to the id prefix in the POST, but echoes the empty name back to the caller', async () => {
    const id = makeDeviceId('NONM').toLowerCase();
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/devices': [],
            'GET /rest/system/connections': { connections: {} },
            'POST /rest/config/devices': null,
        },
    });
    const result = await bridge.addDevice(id);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.body.name, id.toUpperCase().slice(0, 7), 'POST falls back to the first 7 chars of the id');
    // Minor inconsistency, documented as evidence rather than fixed: the
    // method's return value echoes the *input* name ('') instead of the
    // effective name it just sent upstream, so a caller relying on the
    // return value would not learn what Syncthing actually stored.
    assert.equal(result.name, '', 'return value echoes the empty input name rather than the effective name used');
});

// -----------------------------------------------------------------------------
//  shareFolder()
// -----------------------------------------------------------------------------

test('shareFolder() rejects an invalid device id before making any request', async () => {
    const { bridge, calls } = makeBridge({ responses: {} });
    await assert.rejects(() => bridge.shareFolder('vault', 'not-a-device-id'), /Invalid Syncthing device ID/);
    assert.equal(calls.length, 0);
});

test('shareFolder() throws for a folder that does not exist', async () => {
    const id = makeDeviceId('GHST');
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/folders/ghost': null,
        },
    });
    await assert.rejects(() => bridge.shareFolder('ghost', id), /No such Syncthing folder: ghost/);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0, 'a missing folder must never be PATCHed');
});

// -----------------------------------------------------------------------------
//  shareFolder() — MUST preserve existing devices (PATCH replaces the list)
// -----------------------------------------------------------------------------

test('shareFolder() PATCH body includes the pre-existing devices AND the new one', async () => {
    const deviceA = makeDeviceId('AAAA');
    const deviceB = makeDeviceId('BBBB');
    const newDevice = makeDeviceId('CCCC');
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/folders/vault': {
                id: 'vault',
                label: 'Vault',
                devices: [{ deviceID: deviceA }, { deviceID: deviceB }],
            },
            'PATCH /rest/config/folders/vault': null,
        },
    });

    const result = await bridge.shareFolder('vault', newDevice);
    assert.deepEqual(result, { ok: true, folderId: 'vault', deviceId: newDevice });

    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'a PATCH must be issued');
    assert.deepEqual(
        patch.body,
        { devices: [{ deviceID: deviceA }, { deviceID: deviceB }, { deviceID: newDevice }] },
        'the PATCH must resend every existing device plus the new one — Syncthing PATCH replaces the whole list',
    );

    // Belt-and-braces: spell out the data-loss-shaped failure mode directly,
    // independent of the deepEqual above, so a future refactor that changes
    // ordering (but drops a device) still gets caught.
    const patchedIds = patch.body.devices.map((d) => d.deviceID);
    assert.ok(patchedIds.includes(deviceA), 'pre-existing device A must survive the PATCH');
    assert.ok(patchedIds.includes(deviceB), 'pre-existing device B must survive the PATCH');
    assert.ok(patchedIds.includes(newDevice), 'the newly shared device must be included');
    assert.equal(patchedIds.length, 3, 'no device may be dropped or duplicated');
});

test('shareFolder() returns {alreadyShared:true} and issues no PATCH for a device already on the folder', async () => {
    const deviceA = makeDeviceId('AAAA');
    const { bridge, calls } = makeBridge({
        responses: {
            'GET /rest/config/folders/vault': { id: 'vault', devices: [{ deviceID: deviceA }] },
        },
    });
    const result = await bridge.shareFolder('vault', deviceA.toLowerCase());
    assert.deepEqual(result, { ok: true, alreadyShared: true, folderId: 'vault', deviceId: deviceA });
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

// -----------------------------------------------------------------------------
//  No key, no transport
// -----------------------------------------------------------------------------

test('with no apiKey and no transport, a request rejects with a clear message instead of hanging or going out unauthenticated', async () => {
    await withNoAmbientApiKey(async () => {
        const bridge = new SyncthingBridge({});
        assert.equal(bridge.isConfigured, false);
        await assert.rejects(() => bridge.myStatus(), /Syncthing API key not configured/);
    });
});

// -----------------------------------------------------------------------------
//  overview() — never throws
// -----------------------------------------------------------------------------

test('overview() never throws: unconfigured short-circuits cleanly, and a failing transport reports reachable:false with a reason', async () => {
    await withNoAmbientApiKey(async () => {
        const bridge = new SyncthingBridge({});
        const result = await bridge.overview();
        assert.deepEqual(result, { configured: false, reachable: false, reason: 'SYNCTHING_API_KEY not set' });
    });

    const { bridge: failing } = makeBridge({
        responses: {
            'GET /rest/system/status': new Error('connection refused'),
            'GET /rest/system/version': { version: 'irrelevant' },
            'GET /rest/config/devices': [],
            'GET /rest/system/connections': { connections: {} },
            'GET /rest/config/folders': [],
        },
    });
    const result2 = await failing.overview();
    assert.equal(result2.configured, true, 'an apiKey is set, so configured reflects that even though it is unreachable');
    assert.equal(result2.reachable, false);
    assert.match(result2.reason, /connection refused/);
});

// -----------------------------------------------------------------------------
//  overview() — allInSync
// -----------------------------------------------------------------------------

test('overview() sets allInSync true only when every folder is in sync', async () => {
    const baseline = {
        'GET /rest/system/status': { myID: 'ME', uptime: 50 },
        'GET /rest/system/version': { version: 'v1.28.0' },
        'GET /rest/config/devices': [],
        'GET /rest/system/connections': { connections: {} },
        'GET /rest/cluster/pending/devices': {},
        'GET /rest/cluster/pending/folders': {},
    };

    const { bridge: allSynced } = makeBridge({
        responses: {
            ...baseline,
            'GET /rest/config/folders': [{ id: 'vault' }, { id: 'notes' }],
            'GET /rest/db/status?folder=vault': { state: 'idle', needFiles: 0 },
            'GET /rest/db/status?folder=notes': { state: 'idle', needFiles: 0 },
        },
    });
    const synced = await allSynced.overview();
    assert.equal(synced.reachable, true);
    assert.equal(synced.allInSync, true, 'every folder idle with nothing needed means fully in sync');

    const { bridge: mixed } = makeBridge({
        responses: {
            ...baseline,
            'GET /rest/config/folders': [{ id: 'vault' }, { id: 'notes' }],
            'GET /rest/db/status?folder=vault': { state: 'idle', needFiles: 0 },
            'GET /rest/db/status?folder=notes': { state: 'syncing', needFiles: 4 },
        },
    });
    const result = await mixed.overview();
    assert.equal(result.reachable, true);
    assert.equal(result.allInSync, false, 'one folder still syncing must flip allInSync to false');
});

// -----------------------------------------------------------------------------
//  pending()
// -----------------------------------------------------------------------------

test('pending() maps devices/folders into arrays and tolerates both endpoints rejecting', async () => {
    const offeredBy = makeDeviceId('OFFR');
    const { bridge: ok } = makeBridge({
        responses: {
            'GET /rest/cluster/pending/devices': { [offeredBy]: { name: 'Bobs-Phone', address: 'dynamic' } },
            'GET /rest/cluster/pending/folders': { shared: { offeredBy: { [offeredBy]: {} } } },
        },
    });
    const result = await ok.pending();
    assert.deepEqual(result.devices, [{ deviceId: offeredBy, name: 'Bobs-Phone', address: 'dynamic' }]);
    assert.deepEqual(result.folders, [{ folderId: 'shared', offeredBy: [offeredBy] }]);

    const { bridge: failing } = makeBridge({
        responses: {
            'GET /rest/cluster/pending/devices': new Error('devices endpoint down'),
            'GET /rest/cluster/pending/folders': new Error('folders endpoint down'),
        },
    });
    const result2 = await failing.pending();
    assert.deepEqual(result2, { devices: [], folders: [] });
});

// -----------------------------------------------------------------------------
//  discoverApiKey()
// -----------------------------------------------------------------------------

test('discoverApiKey() never throws and, if it finds anything, returns a generic {apiKey, configPath} shape', () => {
    let result;
    assert.doesNotThrow(() => { result = SyncthingBridge.discoverApiKey(); });
    if (result === null) {
        assert.equal(result, null);
    } else {
        assert.equal(typeof result.apiKey, 'string');
        assert.ok(result.apiKey.length > 0);
        assert.equal(typeof result.configPath, 'string');
    }
});

// -----------------------------------------------------------------------------
//  rescan() / setPaused() — thin passthroughs, covered for completeness
// -----------------------------------------------------------------------------

test('rescan() targets a single folder or, with none given, every folder', async () => {
    const { bridge, calls } = makeBridge({
        responses: {
            'POST /rest/db/scan?folder=vault': null,
            'POST /rest/db/scan': null,
        },
    });
    assert.deepEqual(await bridge.rescan('vault'), { ok: true, folderId: 'vault' });
    assert.deepEqual(await bridge.rescan(), { ok: true, folderId: 'all' });
    assert.equal(calls.length, 2);
});

test("setPaused() PATCHes the folder's paused flag and echoes it back", async () => {
    const { bridge, calls } = makeBridge({
        responses: {
            'PATCH /rest/config/folders/vault': null,
        },
    });
    const result = await bridge.setPaused('vault', true);
    assert.deepEqual(result, { ok: true, folderId: 'vault', paused: true });
    assert.deepEqual(calls[0].body, { paused: true });
});
