// =============================================================================
//  test/satellite.test.js — SatelliteHub + MissionControl satellite HTTP glue
//
//  Hermetic: no listen(), no fetch(), no sockets. Fake req/res objects and an
//  in-process hub. Every assertion is about register / poll / dispatch /
//  response and the auth split (SATELLITE_KEY vs DASHBOARD_TOKEN).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { SatelliteHub, handleSatelliteRoutes, SATELLITE_ACTIONS } = require('../core/SatelliteHub');

const SAT_KEY = 'satellite-secret-key';
const DASH_TOKEN = 'dashboard-secret-token';

function mockRes() {
    const res = new EventEmitter();
    res.statusCode = 0;
    res.headers = null;
    res.body = '';
    res.ended = false;
    res.writeHead = (code, headers) => {
        res.statusCode = code;
        res.headers = headers || null;
    };
    res.end = (data) => {
        res.body = data == null ? '' : String(data);
        res.ended = true;
        res.emit('finish');
    };
    return res;
}

function makeCtx({ hub, token = DASH_TOKEN, body = {}, readError = null } = {}) {
    const sent = { status: null, body: null, count: 0 };
    const ctx = {
        token,
        satelliteHub: hub,
        _sendJson(res, status, obj) {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
            sent.status = status;
            sent.body = obj;
            sent.count += 1;
        },
        _readBody: async () => {
            if (readError) throw readError;
            return body;
        },
    };
    return { ctx, sent };
}

function makeReq({ method = 'POST', headers = {}, ip = '203.0.113.9' } = {}) {
    return {
        method,
        headers,
        url: '/',
        socket: { remoteAddress: ip },
    };
}

function bearer(key) {
    return { authorization: `Bearer ${key}` };
}

async function hit(pathname, { hub, method = 'GET', headers = {}, query = {}, body = {}, token = DASH_TOKEN, readError = null, ip } = {}) {
    const { ctx, sent } = makeCtx({ hub, token, body, readError });
    const req = makeReq({ method, headers, ip });
    const res = mockRes();
    const handled = await handleSatelliteRoutes(ctx, req, res, pathname, query);
    let parsed = sent.body;
    if (parsed == null && res.body) {
        try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
    }
    return { handled, ctx, res, sent, parsed };
}

test('SatelliteHub registers satellites and tracks heartbeat', () => {
    const hub = new SatelliteHub({ offlineTimeoutMs: 1000 });
    const sat = hub.register('win-pc', { hostname: 'MyDesktop', platform: 'win32' }, '192.168.1.50');

    assert.equal(sat.id, 'win-pc');
    assert.equal(sat.hostname, 'MyDesktop');
    assert.equal(sat.platform, 'win32');
    assert.equal(sat.ip, '192.168.1.50');
    assert.equal(hub.hasOnlineSatellite(), true);
    assert.equal(hub.hasOnlineSatellite('win32'), true);
    assert.equal(hub.hasOnlineSatellite('darwin'), false);

    const status = hub.getStatus();
    assert.equal(status.onlineCount, 1);
    assert.equal(status.satellites[0].hostname, 'MyDesktop');
    hub.shutdown();
});

test('SatelliteHub.authenticate is constant-time and never open', () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });
    assert.equal(hub.authenticate(SAT_KEY), true);
    assert.equal(hub.authenticate('wrong-key-xxxxx'), false);
    assert.equal(hub.authenticate(''), false);
    assert.equal(hub.authenticate(null), false);
    assert.equal(hub.authenticate(undefined), false);
    assert.equal(hub.authenticate(SAT_KEY + 'x'), false); // different length must not throw

    hub.authKey = '';
    assert.equal(hub.authenticate(''), false);
    assert.equal(hub.authenticate(SAT_KEY), false);
    hub.shutdown();
});

test('SatelliteHub delivers command immediately to active long-poll', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-poll';

    let deliveredPayload = null;
    let resEnded = false;
    const res = mockRes();
    res.end = (data) => {
        resEnded = true;
        deliveredPayload = JSON.parse(data);
        EventEmitter.prototype.end?.call?.(res);
        res.ended = true;
        res.body = data;
        res.emit('finish');
    };

    hub.handlePoll(satelliteId, res, { hostname: 'TestPC', platform: 'win32' });

    const dispatchPromise = hub.dispatch('screen.capture', { format: 'png' }, { satelliteId, timeoutMs: 2000 });

    assert.equal(resEnded, true);
    assert.ok(deliveredPayload?.command);
    assert.equal(deliveredPayload.command.action, 'screen.capture');
    const commandId = deliveredPayload.command.commandId;

    hub.handleResponse(satelliteId, {
        commandId,
        success: true,
        result: { base64: 'mock_png_base64_data', hostname: 'TestPC' },
    });

    const result = await dispatchPromise;
    assert.equal(result.base64, 'mock_png_base64_data');
    assert.equal(result.hostname, 'TestPC');
    hub.shutdown();
});

test('SatelliteHub queues a command when the worker is not currently polling', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-queued';
    hub.register(satelliteId, { hostname: 'QueuedPC', platform: 'win32' });

    const dispatchPromise = hub.dispatch('sys.info', {}, { satelliteId, timeoutMs: 2000 });

    let delivered = null;
    const res = mockRes();
    res.end = (data) => {
        delivered = JSON.parse(data);
        res.ended = true;
        res.body = data;
    };

    hub.handlePoll(satelliteId, res, { hostname: 'QueuedPC', platform: 'win32' });

    assert.ok(delivered?.command);
    assert.equal(delivered.command.action, 'sys.info');

    hub.handleResponse(satelliteId, {
        commandId: delivered.command.commandId,
        success: true,
        result: { hostname: 'QueuedPC', cpuCores: 8 },
    });

    const result = await dispatchPromise;
    assert.equal(result.hostname, 'QueuedPC');
    assert.equal(result.cpuCores, 8);
    hub.shutdown();
});

test('SatelliteHub rejects when command execution fails on satellite', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-fail';

    const res = mockRes();
    hub.handlePoll(satelliteId, res, { hostname: 'TestPC', platform: 'win32' });

    const dispatchPromise = hub.dispatch('cmd.exec', { command: 'invalid_cmd' }, { satelliteId, timeoutMs: 2000 });

    const sat = hub.satellites.get(satelliteId);
    const commandId = Array.from(sat.pendingCommands.keys())[0];

    hub.handleResponse(satelliteId, {
        commandId,
        success: false,
        error: 'Command not recognized',
    });

    await assert.rejects(dispatchPromise, /Command not recognized/);
    hub.shutdown();
});

test('SatelliteHub times out when satellite does not respond in time', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-timeout';

    const res = mockRes();
    hub.handlePoll(satelliteId, res, { hostname: 'TestPC', platform: 'win32' });

    const dispatchPromise = hub.dispatch('pc.lock', {}, { satelliteId, timeoutMs: 50 });

    await assert.rejects(dispatchPromise, /timed out/);
    hub.shutdown();
});

test('SatelliteHub detects offline satellites after timeout expires', async () => {
    const hub = new SatelliteHub({ offlineTimeoutMs: 50 });
    hub.register('old-pc', { hostname: 'StalePC', platform: 'win32' });

    assert.equal(hub.hasOnlineSatellite(), true);

    await new Promise(r => setTimeout(r, 60));

    assert.equal(hub.hasOnlineSatellite(), false);
    const status = hub.getStatus();
    assert.equal(status.onlineCount, 0);
    assert.equal(status.satellites[0].online, false);
    hub.shutdown();
});

test('SatelliteHub rejects unknown actions and missing workers', async () => {
    const hub = new SatelliteHub();
    await assert.rejects(hub.dispatch('rm -rf /', {}), /Unsupported satellite action/);
    await assert.rejects(hub.dispatch('sys.info', {}), /No active satellite worker online/);
    hub.register('win-pc', { hostname: 'PC', platform: 'win32' });
    await assert.rejects(
        hub.dispatch('sys.info', {}, { satelliteId: 'other-pc' }),
        /No active satellite worker online/,
    );
    hub.shutdown();
});

test('duplicate long-poll closes the previous hold with a heartbeat', () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const first = mockRes();
    const second = mockRes();
    hub.handlePoll('win-dup', first, { hostname: 'PC', platform: 'win32' });
    hub.handlePoll('win-dup', second, { hostname: 'PC', platform: 'win32' });

    assert.equal(first.ended, true);
    const payload = JSON.parse(first.body);
    assert.equal(payload.heartbeat, true);
    assert.equal(payload.duplicate, true);
    assert.equal(second.ended, false);
    hub.shutdown();
});

test('handleSatelliteRoutes returns false for unrelated paths without touching res', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });
    for (const p of ['/api/info', '/api/status', '/', '/api/chat']) {
        const { handled, sent, res } = await hit(p, { hub, headers: bearer(SAT_KEY) });
        assert.equal(handled, false, `${p} should not be handled`);
        assert.equal(sent.count, 0);
        assert.equal(res.ended, false);
    }
    hub.shutdown();
});

test('worker routes reject missing, wrong, and dashboard-only tokens', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });

    const none = await hit('/api/satellite/register', {
        hub, method: 'POST', body: { satelliteId: 'win-1' },
    });
    assert.equal(none.handled, true);
    assert.equal(none.sent.status, 401);

    const wrong = await hit('/api/satellite/poll', {
        hub, method: 'POST', headers: bearer('nope'), body: { satelliteId: 'win-1' },
    });
    assert.equal(wrong.sent.status, 401);

    const dash = await hit('/api/satellite/response', {
        hub, method: 'POST', headers: bearer(DASH_TOKEN),
        body: { satelliteId: 'win-1', commandId: 'x' },
    });
    assert.equal(dash.sent.status, 401);

    hub.shutdown();
});

test('register + poll + dispatch + response with the correct keys', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY, pollTimeoutMs: 5000 });

    const reg = await hit('/api/satellite/register', {
        hub,
        method: 'POST',
        headers: bearer(SAT_KEY),
        body: { satelliteId: 'win-office', hostname: 'OfficePC', platform: 'win32', systemInfo: { cpuCores: 16 } },
        ip: '198.51.100.4',
    });
    assert.equal(reg.handled, true);
    assert.equal(reg.sent.status, 200);
    assert.equal(reg.parsed.satellite.id, 'win-office');
    assert.equal(reg.parsed.satellite.hostname, 'OfficePC');
    assert.equal(reg.parsed.satellite.ip, '198.51.100.4');
    assert.equal(hub.hasOnlineSatellite(), true);

    const pollRes = mockRes();
    const { ctx } = makeCtx({
        hub,
        body: { satelliteId: 'win-office', hostname: 'OfficePC', platform: 'win32' },
    });
    const pollHandled = await handleSatelliteRoutes(
        ctx,
        makeReq({ method: 'POST', headers: bearer(SAT_KEY) }),
        pollRes,
        '/api/satellite/poll',
        {},
    );
    assert.equal(pollHandled, true);
    assert.equal(pollRes.ended, false, 'poll must hold until work arrives');

    const dispatchPromise = (async () => {
        const { ctx: dctx, sent } = makeCtx({
            hub,
            token: DASH_TOKEN,
            body: { action: 'sys.info', satelliteId: 'win-office', timeoutMs: 2000 },
        });
        const dres = mockRes();
        await handleSatelliteRoutes(
            dctx,
            makeReq({ method: 'POST', headers: bearer(DASH_TOKEN) }),
            dres,
            '/api/satellite/dispatch',
            {},
        );
        return sent;
    })();

    // Give dispatch a tick to push onto the held poll.
    await new Promise(r => setImmediate(r));
    assert.equal(pollRes.ended, true);
    const delivered = JSON.parse(pollRes.body);
    assert.equal(delivered.command.action, 'sys.info');

    const resp = await hit('/api/satellite/response', {
        hub,
        method: 'POST',
        headers: bearer(SAT_KEY),
        body: {
            satelliteId: 'win-office',
            commandId: delivered.command.commandId,
            success: true,
            result: { hostname: 'OfficePC', cpuCores: 16 },
        },
    });
    assert.equal(resp.sent.status, 200);
    assert.equal(resp.parsed.success, true);

    const dispatched = await dispatchPromise;
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.body.success, true);
    assert.equal(dispatched.body.result.hostname, 'OfficePC');

    const status = await hit('/api/satellite/status', {
        hub, method: 'GET', headers: bearer(DASH_TOKEN),
    });
    assert.equal(status.sent.status, 200);
    assert.equal(status.parsed.onlineCount, 1);
    assert.equal(status.parsed.satellites[0].id, 'win-office');

    hub.shutdown();
});

test('satellite key cannot dispatch; dashboard token cannot poll when keys differ', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });
    hub.register('win-1', { hostname: 'PC', platform: 'win32' });

    const steal = await hit('/api/satellite/poll', {
        hub, method: 'POST', headers: bearer(DASH_TOKEN),
        body: { satelliteId: 'win-1' },
    });
    assert.equal(steal.sent.status, 401, 'dashboard token must not impersonate a worker');

    const workerDispatch = await hit('/api/satellite/dispatch', {
        hub, method: 'POST', headers: bearer(SAT_KEY),
        body: { action: 'sys.info' },
        token: DASH_TOKEN,
    });
    assert.equal(workerDispatch.sent.status, 401, 'worker key must not dispatch');

    hub.shutdown();
});

test('dispatch rejects unknown actions and missing satelliteId on worker posts', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });

    const badAction = await hit('/api/satellite/dispatch', {
        hub, method: 'POST', headers: bearer(DASH_TOKEN),
        body: { action: 'format.c:' },
    });
    assert.equal(badAction.sent.status, 400);
    assert.match(badAction.parsed.error, /Unsupported satellite action/);

    const noId = await hit('/api/satellite/register', {
        hub, method: 'POST', headers: bearer(SAT_KEY), body: {},
    });
    assert.equal(noId.sent.status, 400);

    const pollNoId = await hit('/api/satellite/poll', {
        hub, method: 'POST', headers: bearer(SAT_KEY), body: {},
    });
    assert.equal(pollNoId.sent.status, 400);

    const noWorker = await hit('/api/satellite/dispatch', {
        hub, method: 'POST', headers: bearer(DASH_TOKEN),
        body: { action: 'sys.info' },
    });
    assert.equal(noWorker.sent.status, 503);

    hub.shutdown();
});

test('query.token is accepted; payload-too-large is 413; 405 on wrong method', async () => {
    const hub = new SatelliteHub({ authKey: SAT_KEY });

    const viaQuery = await hit('/api/satellite/register', {
        hub, method: 'POST', query: { token: SAT_KEY },
        body: { satelliteId: 'win-q', hostname: 'Q' },
    });
    assert.equal(viaQuery.sent.status, 200);

    const tooBig = await hit('/api/satellite/response', {
        hub, method: 'POST', headers: bearer(SAT_KEY),
        readError: new Error('Payload too large'),
        body: { satelliteId: 'win-q', commandId: 'x' },
    });
    assert.equal(tooBig.sent.status, 413);

    const wrongMethod = await hit('/api/satellite/register', {
        hub, method: 'GET', headers: bearer(SAT_KEY),
    });
    assert.equal(wrongMethod.sent.status, 405);

    const missingHub = await hit('/api/satellite/status', {
        hub: null, method: 'GET', headers: bearer(DASH_TOKEN),
    });
    assert.equal(missingHub.sent.status, 503);

    hub.shutdown();
});

test('SATELLITE_ACTIONS matches the worker surface', () => {
    assert.deepEqual([...SATELLITE_ACTIONS].sort(), [
        'cmd.exec', 'notify.toast', 'pc.lock', 'screen.capture', 'sys.info',
    ]);
});
