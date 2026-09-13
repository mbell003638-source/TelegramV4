const test = require('node:test');
const assert = require('node:assert/strict');
const { SatelliteHub } = require('../core/SatelliteHub');

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
});

test('SatelliteHub delivers command immediately to active long-poll', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-poll';

    // Mock HTTP response for the long-poll
    let deliveredPayload = null;
    let resEnded = false;
    const mockRes = {
        writeHead: () => {},
        end: (data) => {
            resEnded = true;
            deliveredPayload = JSON.parse(data);
        },
        on: () => {},
    };

    // Satellite initiates long-poll
    hub.handlePoll(satelliteId, mockRes, { hostname: 'TestPC', platform: 'win32' });

    // Master dispatches a command while poll is waiting
    const dispatchPromise = hub.dispatch('screen.capture', { format: 'png' }, { satelliteId, timeoutMs: 2000 });

    assert.equal(resEnded, true);
    assert.ok(deliveredPayload?.command);
    assert.equal(deliveredPayload.command.action, 'screen.capture');
    const commandId = deliveredPayload.command.commandId;

    // Satellite completes the command and posts response
    hub.handleResponse(satelliteId, {
        commandId,
        success: true,
        result: { base64: 'mock_png_base64_data', hostname: 'TestPC' },
    });

    const result = await dispatchPromise;
    assert.equal(result.base64, 'mock_png_base64_data');
    assert.equal(result.hostname, 'TestPC');
});

test('SatelliteHub rejects when command execution fails on satellite', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-fail';

    const mockRes = {
        writeHead: () => {},
        end: (data) => {},
        on: () => {},
    };

    hub.handlePoll(satelliteId, mockRes, { hostname: 'TestPC', platform: 'win32' });

    const dispatchPromise = hub.dispatch('cmd.exec', { command: 'invalid_cmd' }, { satelliteId, timeoutMs: 2000 });

    const sat = hub.satellites.get(satelliteId);
    const commandId = Array.from(sat.pendingCommands.keys())[0];

    hub.handleResponse(satelliteId, {
        commandId,
        success: false,
        error: 'Command not recognized',
    });

    await assert.rejects(dispatchPromise, /Command not recognized/);
});

test('SatelliteHub times out when satellite does not respond in time', async () => {
    const hub = new SatelliteHub({ pollTimeoutMs: 5000 });
    const satelliteId = 'win-pc-timeout';

    const mockRes = {
        writeHead: () => {},
        end: () => {},
        on: () => {},
    };

    hub.handlePoll(satelliteId, mockRes, { hostname: 'TestPC', platform: 'win32' });

    // Very short timeout
    const dispatchPromise = hub.dispatch('pc.lock', {}, { satelliteId, timeoutMs: 50 });

    await assert.rejects(dispatchPromise, /timed out/);
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
});
