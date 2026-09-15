// =============================================================================
//  test/device-automation.test.js — Android / Android TV / Google TV ADB driver
//
//  Hermetic: every adb invocation goes through an injected `exec` stub. Nothing
//  here locates a real adb, talks to a device, or opens a network socket.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeviceAutomation, getDeviceAutomation } = require('../core/DeviceAutomation');

// Fake path is quoted in every command; spaces prove the quotes are required.
const FAKE_ADB = 'C:\\Program Files\\fake-adb\\adb.exe';

/** Named remote buttons with a real keycode. `netflix: 0` is excluded. */
const NAMED_KEYCODES = {
    up: 19, down: 20, left: 21, right: 22, ok: 23, select: 23, enter: 66,
    back: 4, home: 3, menu: 82, search: 84,
    play_pause: 85, stop: 86, next: 87, previous: 88,
    rewind: 89, fast_forward: 90,
    volume_up: 24, volume_down: 25, mute: 164,
    power: 26, sleep: 223, wakeup: 224,
    channel_up: 166, channel_down: 167,
    tv: 170, guide: 172, info: 165, captions: 175,
    dpad_center: 23,
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * DeviceAutomation wired to a fake `exec`. `script` may be a function
 * `({ cmd, options }) => { stdout, stderr?, error? }`, a string/Buffer
 * stdout, or an object. Unscripted commands get a success stdout derived
 * from the verb so happy-path tests stay short. Never calls real exec.
 */
function makeDevice(opts = {}) {
    const calls = [];
    const defaultScript = ({ cmd }) => {
        if (/\bconnect\b/.test(cmd)) return { stdout: 'connected to 192.168.1.50:5555' };
        if (/\bpair\b/.test(cmd)) return { stdout: 'Successfully paired to 192.168.1.50:37123' };
        if (/\bdisconnect\b/.test(cmd)) return { stdout: 'disconnected 192.168.1.50:5555' };
        if (/\btcpip\b/.test(cmd)) return { stdout: 'restarting in TCP mode port: 5555' };
        if (/screencap/.test(cmd)) return { stdout: Buffer.alloc(128, 0x89) };
        if (/\bdevices\b/.test(cmd)) {
            return { stdout: 'List of devices attached\nemulator-5554 device product:sdk model:sdk_gphone\n' };
        }
        return { stdout: '' };
    };
    const script = opts.script || defaultScript;

    const execFn = (cmd, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        calls.push({ cmd, options });
        let reply;
        try {
            reply = typeof script === 'function' ? script({ cmd, options, calls }) : script;
        } catch (err) {
            callback(err, '', err.message);
            return;
        }
        if (reply == null) reply = { stdout: '' };
        if (typeof reply === 'string' || Buffer.isBuffer(reply)) reply = { stdout: reply };
        const err = reply.error || reply.err || null;
        const stdout = reply.stdout !== undefined ? reply.stdout : '';
        const stderr = reply.stderr !== undefined ? reply.stderr : '';
        callback(err, stdout, stderr);
    };

    const device = new DeviceAutomation({
        adbPath: opts.adbPath !== undefined ? opts.adbPath : FAKE_ADB,
        exec: opts.exec || execFn,
    });
    if (opts.selectedDevice) device.selectedDevice = opts.selectedDevice;
    return { device, calls };
}

function lastCall(calls) {
    assert.ok(calls.length > 0, 'expected at least one adb invocation');
    return calls[calls.length - 1];
}

function assertQuotedAdb(cmd) {
    assert.equal(typeof cmd, 'string');
    assert.ok(cmd.startsWith(`"${FAKE_ADB}"`), `adb path must be quoted, got: ${cmd}`);
}

function assertCmdContains(cmd, fragment) {
    assertQuotedAdb(cmd);
    assert.ok(cmd.includes(fragment), `expected ${JSON.stringify(fragment)} in: ${cmd}`);
}

// ---------------------------------------------------------------------------
//  Module shape — no-arg production path is not exercised (that locates adb).
// ---------------------------------------------------------------------------

test('exports DeviceAutomation and a lazy singleton factory', () => {
    assert.equal(typeof DeviceAutomation, 'function');
    assert.equal(typeof getDeviceAutomation, 'function');
    assert.equal(typeof DeviceAutomation.REMOTE_KEYS, 'object');
    // Do not call getDeviceAutomation() or `new DeviceAutomation()`: both locate adb.
});

test('REMOTE_KEYS has 30 usable named buttons (netflix is a 0-placeholder)', () => {
    const keys = DeviceAutomation.REMOTE_KEYS;
    const usable = Object.keys(keys).filter((k) => keys[k] > 0);
    assert.equal(usable.length, 30);
    assert.equal(keys.netflix, 0);
    for (const [name, code] of Object.entries(NAMED_KEYCODES)) {
        assert.equal(keys[name], code, `${name} should be KEYCODE ${code}`);
    }
});

test('getRemoteKeys lists the 30 usable names and hides netflix', () => {
    const { device } = makeDevice();
    const names = device.getRemoteKeys();
    assert.equal(names.length, 30);
    assert.equal(names.includes('netflix'), false);
    assert.ok(names.includes('home'));
    assert.ok(names.includes('play_pause'));
    assert.ok(names.includes('mute'));
});

// ---------------------------------------------------------------------------
//  connect / disconnect
// ---------------------------------------------------------------------------

test('connect(host, port) builds adb connect host:port (default 5555)', async () => {
    const { device, calls } = makeDevice();
    const result = await device.connect('192.168.1.50');
    assert.equal(result.success, true);
    assert.equal(result.target, '192.168.1.50:5555');
    assert.equal(calls.length, 1);
    assertQuotedAdb(calls[0].cmd);
    assert.match(calls[0].cmd, /connect 192\.168\.1\.50:5555$/);
    assert.equal(calls[0].options.timeout, 15000);
});

test('connect respects an explicit port', async () => {
    const { device, calls } = makeDevice();
    const result = await device.connect('10.0.0.8', 5557);
    assert.equal(result.target, '10.0.0.8:5557');
    assertCmdContains(calls[0].cmd, 'connect 10.0.0.8:5557');
});

test('connect keeps host:port when the host already includes a port', async () => {
    const { device, calls } = makeDevice();
    const result = await device.connect('10.0.0.8:5556', 9999);
    assert.equal(result.target, '10.0.0.8:5556');
    assertCmdContains(calls[0].cmd, 'connect 10.0.0.8:5556');
    assert.equal(calls[0].cmd.includes('9999'), false);
});

test('connect treats "already connected" as success and forces a rescan', async () => {
    const { device, calls } = makeDevice({
        script: () => ({ stdout: 'already connected to 192.168.1.50:5555' }),
    });
    device.lastScanTime = 123;
    const result = await device.connect('192.168.1.50', 5555);
    assert.equal(result.success, true);
    assert.equal(device.lastScanTime, 0);
    assertCmdContains(calls[0].cmd, 'connect 192.168.1.50:5555');
});

test('connect inspects stdout: a failed connect with exit 0 is still an error', async () => {
    const { device } = makeDevice({
        script: () => ({ stdout: 'failed to connect to 192.168.1.50:5555' }),
    });
    await assert.rejects(
        () => device.connect('192.168.1.50'),
        /Could not connect to 192\.168\.1\.50:5555/,
    );
});

test('connect refuses an empty host without shelling out', async () => {
    const { device, calls } = makeDevice();
    await assert.rejects(() => device.connect(''), /host or IP address is required/);
    await assert.rejects(() => device.connect('   '), /host or IP address is required/);
    assert.equal(calls.length, 0);
});

test('disconnect builds adb disconnect host:port and clears a matching selection', async () => {
    const { device, calls } = makeDevice({ selectedDevice: '192.168.1.50:5555' });
    const result = await device.disconnect('192.168.1.50');
    assert.equal(result.success, true);
    assert.equal(result.target, '192.168.1.50:5555');
    assert.equal(device.selectedDevice, null);
    assertCmdContains(calls[0].cmd, 'disconnect 192.168.1.50:5555');
    assert.equal(calls[0].options.timeout, 10000);
});

// ---------------------------------------------------------------------------
//  pairWireless / enableTcpip
// ---------------------------------------------------------------------------

test('pairWireless builds adb pair host:pairingPort code', async () => {
    const { device, calls } = makeDevice();
    const result = await device.pairWireless('192.168.1.50', 37123, '847291');
    assert.equal(result.success, true);
    assert.equal(result.target, '192.168.1.50:37123');
    assertQuotedAdb(calls[0].cmd);
    assert.match(calls[0].cmd, /pair 192\.168\.1\.50:37123 847291$/);
    assert.equal(calls[0].options.timeout, 30000);
});

test('pairWireless refuses codes that are not exactly 6 digits', async () => {
    const { device, calls } = makeDevice();
    for (const bad of ['', '12345', '1234567', 'abcdef', '84729a', '12 3456', null, undefined]) {
        await assert.rejects(
            () => device.pairWireless('192.168.1.50', 37123, bad),
            /6-digit pairing code/,
        );
    }
    assert.equal(calls.length, 0);
});

test('pairWireless throws when adb does not report a successful pair', async () => {
    const { device } = makeDevice({
        script: () => ({ stdout: 'Failed: wrong pairing code' }),
    });
    await assert.rejects(
        () => device.pairWireless('10.0.0.8', 37123, '111111'),
        /Pairing with 10\.0\.0\.8:37123 failed/,
    );
});

test('enableTcpip asks the device to listen on the given TCP port', async () => {
    const { device, calls } = makeDevice();
    const result = await device.enableTcpip();
    assert.equal(result.success, true);
    assert.equal(result.port, 5555);
    assertQuotedAdb(calls[0].cmd);
    assert.match(calls[0].cmd, /tcpip 5555$/);
    assert.equal(calls[0].options.timeout, 15000);
});

test('enableTcpip passes -s serial and a custom port', async () => {
    const { device, calls } = makeDevice();
    const result = await device.enableTcpip(5556, 'emulator-5554');
    assert.equal(result.port, 5556);
    assertCmdContains(calls[0].cmd, '-s emulator-5554');
    assert.match(calls[0].cmd, /tcpip 5556$/);
});

// ---------------------------------------------------------------------------
//  remoteKey
// ---------------------------------------------------------------------------

test('remoteKey maps named buttons (home/back/up/down/ok/play_pause/mute) to KEYCODEs', async () => {
    const samples = {
        home: 3,
        back: 4,
        up: 19,
        down: 20,
        ok: 23,
        play_pause: 85,
        mute: 164,
    };
    for (const [name, code] of Object.entries(samples)) {
        const { device, calls } = makeDevice();
        await device.remoteKey(name);
        assertCmdContains(lastCall(calls).cmd, `shell input keyevent ${code}`);
    }
});

test('remoteKey maps every usable named key to a keyevent', async () => {
    for (const [name, code] of Object.entries(NAMED_KEYCODES)) {
        const { device, calls } = makeDevice();
        const result = await device.remoteKey(name);
        assert.equal(result.success, true);
        assertCmdContains(lastCall(calls).cmd, `shell input keyevent ${code}`);
    }
});

test('remoteKey normalizes case, spaces, and hyphens', async () => {
    const aliases = [
        ['Home', 3],
        [' BACK ', 4],
        ['play pause', 85],
        ['PLAY-PAUSE', 85],
        ['volume up', 24],
        ['Volume-Down', 25],
        ['fast forward', 90],
    ];
    for (const [name, code] of aliases) {
        const { device, calls } = makeDevice();
        await device.remoteKey(name);
        assertCmdContains(lastCall(calls).cmd, `shell input keyevent ${code}`);
    }
});

test('remoteKey passes a raw numeric keycode through', async () => {
    const { device, calls } = makeDevice();
    await device.remoteKey(66);
    assertCmdContains(calls[0].cmd, 'shell input keyevent 66');

    const again = makeDevice();
    await again.device.remoteKey('19');
    assertCmdContains(again.calls[0].cmd, 'shell input keyevent 19');
});

test('remoteKey refuses unknown names (and the netflix 0-placeholder)', async () => {
    const { device, calls } = makeDevice();
    await assert.rejects(() => device.remoteKey('banana'), /Unknown remote key "banana"/);
    await assert.rejects(() => device.remoteKey('play'), /Unknown remote key "play"/);
    await assert.rejects(() => device.remoteKey('netflix'), /Unknown remote key "netflix"/);
    await assert.rejects(() => device.remoteKey(''), /Unknown remote key/);
    await assert.rejects(() => device.remoteKey(null), /Unknown remote key/);
    assert.equal(calls.length, 0);
});

test('remoteKey forwards an explicit serial to pressKey', async () => {
    const { device, calls } = makeDevice();
    await device.remoteKey('ok', '192.168.1.50:5555');
    assertCmdContains(calls[0].cmd, '-s "192.168.1.50:5555"');
    assertCmdContains(calls[0].cmd, 'shell input keyevent 23');
});

// ---------------------------------------------------------------------------
//  screenshot / tap / swipe / text / launch argument shaping
// ---------------------------------------------------------------------------

test('captureScreenshot shapes exec-out screencap -p and returns a PNG data URI', async () => {
    const png = Buffer.alloc(128, 0x89);
    const { device, calls } = makeDevice({
        script: () => ({ stdout: png }),
        selectedDevice: '192.168.1.50:5555',
    });
    const uri = await device.captureScreenshot();
    assert.equal(uri, `data:image/png;base64,${png.toString('base64')}`);
    assertQuotedAdb(calls[0].cmd);
    assertCmdContains(calls[0].cmd, '-s "192.168.1.50:5555"');
    assertCmdContains(calls[0].cmd, 'exec-out screencap -p');
    assert.equal(calls[0].options.encoding, 'buffer');
});

test('captureScreenshot uses the targetSerial argument when given', async () => {
    const { device, calls } = makeDevice({
        script: () => ({ stdout: Buffer.alloc(128, 1) }),
    });
    await device.captureScreenshot('emulator-5554');
    assertCmdContains(calls[0].cmd, '-s "emulator-5554"');
    assertCmdContains(calls[0].cmd, 'exec-out screencap -p');
});

test('captureScreenshot rejects a tiny buffer', async () => {
    const { device } = makeDevice({
        script: () => ({ stdout: Buffer.alloc(8, 0) }),
    });
    await assert.rejects(() => device.captureScreenshot(), /Invalid image buffer/);
});

test('tap rounds coordinates and shapes shell input tap', async () => {
    const { device, calls } = makeDevice({ selectedDevice: 'tv-1' });
    await device.tap(10.9, 20.1);
    assertCmdContains(calls[0].cmd, '-s "tv-1"');
    assert.match(calls[0].cmd, /shell input tap 11 20$/);
});

test('tap uses an explicit serial and integer coords', async () => {
    const { device, calls } = makeDevice();
    await device.tap(100, 200, 'emulator-5554');
    assertCmdContains(calls[0].cmd, '-s "emulator-5554"');
    assert.match(calls[0].cmd, /shell input tap 100 200$/);
});

test('swipe shapes shell input swipe with default duration 300', async () => {
    const { device, calls } = makeDevice();
    await device.swipe(0, 10.4, 100.6, 200);
    assert.match(calls[0].cmd, /shell input swipe 0 10 101 200 300$/);
});

test('swipe forwards durationMs and serial', async () => {
    const { device, calls } = makeDevice();
    await device.swipe(1, 2, 3, 4, 800, '192.168.1.50:5555');
    assertCmdContains(calls[0].cmd, '-s "192.168.1.50:5555"');
    assert.match(calls[0].cmd, /shell input swipe 1 2 3 4 800$/);
});

test('inputText encodes spaces as %s and strips &|<>', async () => {
    const { device, calls } = makeDevice();
    await device.inputText('hello world');
    assert.match(calls[0].cmd, /shell input text "hello%sworld"$/);

    const special = makeDevice();
    await special.device.inputText('a&b|c<d>e');
    assert.match(special.calls[0].cmd, /shell input text "abcde"$/);
});

test('inputText quotes the payload and can target a serial', async () => {
    const { device, calls } = makeDevice();
    await device.inputText('ok', 'emulator-5554');
    assertCmdContains(calls[0].cmd, '-s "emulator-5554"');
    assert.match(calls[0].cmd, /shell input text "ok"$/);
});

test('launchApp shapes monkey -p package LAUNCHER 1', async () => {
    const { device, calls } = makeDevice();
    await device.launchApp('com.netflix.ninja');
    assertQuotedAdb(calls[0].cmd);
    assertCmdContains(calls[0].cmd, 'shell monkey -p com.netflix.ninja -c android.intent.category.LAUNCHER 1');
});

test('launchApp forwards an explicit serial', async () => {
    const { device, calls } = makeDevice();
    await device.launchApp('com.google.android.youtube.tv', '192.168.1.50:5555');
    assertCmdContains(calls[0].cmd, '-s "192.168.1.50:5555"');
    assertCmdContains(calls[0].cmd, 'shell monkey -p com.google.android.youtube.tv -c android.intent.category.LAUNCHER 1');
});

// ---------------------------------------------------------------------------
//  TV package helper
// ---------------------------------------------------------------------------

test('getTvApps lists Android TV / Google TV packages', () => {
    const { device } = makeDevice();
    const apps = device.getTvApps();
    assert.ok(Array.isArray(apps));
    assert.ok(apps.length >= 5);
    const byId = Object.fromEntries(apps.map((a) => [a.id, a]));
    assert.equal(byId.youtube_tv.package, 'com.google.android.youtube.tv');
    assert.equal(byId.netflix.package, 'com.netflix.ninja');
    assert.equal(byId.primevideo.package, 'com.amazon.amazonvideo.livingroom');
    assert.equal(byId.disneyplus.package, 'com.disney.disneyplus');
    assert.equal(byId.spotify.package, 'com.spotify.tv.android');
    assert.equal(byId.plex.package, 'com.plexapp.android');
    assert.equal(byId.tv_settings.package, 'com.android.tv.settings');
    for (const app of apps) {
        assert.equal(typeof app.id, 'string');
        assert.equal(typeof app.name, 'string');
        assert.equal(typeof app.package, 'string');
        assert.ok(app.package.includes('.'), `${app.id} needs a real Android package name`);
    }
});

test('injected exec is the only runner — production child_process.exec is never called', async () => {
    let ran = 0;
    const exec = (cmd, options, callback) => {
        ran += 1;
        if (typeof options === 'function') callback = options;
        callback(null, 'connected to 10.0.0.1:5555', '');
    };
    const device = new DeviceAutomation({ adbPath: FAKE_ADB, exec });
    await device.connect('10.0.0.1');
    await device.remoteKey('home');
    assert.equal(ran, 2);
});
