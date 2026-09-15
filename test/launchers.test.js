// =============================================================================
//  test/launchers.test.js — Dual-process launchers + WebUI redirect
// =============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AssistantDatabase } = require('../core/Database');
const MissionControlServer = require('../core/MissionControl');

const ROOT = path.resolve(__dirname, '..');
const START_SH = path.join(ROOT, 'start.sh');
const START_PS1 = path.join(ROOT, 'start.ps1');
const START_COMMAND = path.join(ROOT, 'start.command');
const SATELLITE_SH = path.join(ROOT, 'satellite', 'start_satellite.sh');
const START_HIDDEN_VBS = path.join(ROOT, 'start_hidden.vbs');

function readUtf8(file) {
    return fs.readFileSync(file, 'utf8');
}

function firstLine(text) {
    return text.split(/\r?\n/, 1)[0];
}

function resolveBash() {
    const onPath = spawnSync('bash', ['-c', 'echo ok'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
    });
    if (onPath.status === 0) return 'bash';
    const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

const BASH = resolveBash();

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-launchers-'));
    return new AssistantDatabase(path.join(dir, 'test.db'));
}

test('start.sh exists, is bash, starts node index.js and webui, no Windows drive paths', () => {
    assert.equal(fs.existsSync(START_SH), true, 'start.sh must exist at repo root');
    const text = readUtf8(START_SH);
    assert.equal(firstLine(text), '#!/usr/bin/env bash');
    assert.match(text, /set -e/);
    assert.match(text, /node index\.js/);
    assert.match(text, /webui/);
    assert.equal(text.includes('C:\\'), false, 'start.sh must not hardcode C:\\ paths');
});

test('start.ps1 exists and starts node', () => {
    assert.equal(fs.existsSync(START_PS1), true, 'start.ps1 must exist at repo root');
    const text = readUtf8(START_PS1);
    assert.match(text, /node/i);
    assert.match(text, /index\.js/);
    assert.match(text, /webui/i);
});

test('start.command execs start.sh', () => {
    assert.equal(fs.existsSync(START_COMMAND), true);
    const text = readUtf8(START_COMMAND);
    assert.equal(firstLine(text), '#!/usr/bin/env bash');
    assert.match(text, /exec \.\/start\.sh/);
    assert.match(text, /chmod \+x/);
});

test('satellite/start_satellite.sh exists and reads VPS_URL / SATELLITE_KEY', () => {
    assert.equal(fs.existsSync(SATELLITE_SH), true);
    const text = readUtf8(SATELLITE_SH);
    assert.equal(firstLine(text), '#!/usr/bin/env bash');
    assert.match(text, /VPS_URL/);
    assert.match(text, /SATELLITE_KEY/);
    assert.match(text, /desktop-worker\.js/);
});

test('start_hidden.vbs uses the script folder, not a hardcoded telegram-bridge-v4 path', () => {
    assert.equal(fs.existsSync(START_HIDDEN_VBS), true);
    const text = readUtf8(START_HIDDEN_VBS);
    assert.equal(text.includes('telegram-bridge-v4'), false);
    assert.match(text, /ScriptFullName|scriptDir|CurrentDirectory/);
    assert.match(text, /process_guard\.js/);
});

test('bash -n start.sh and satellite/start_satellite.sh when bash is available', { skip: !BASH }, () => {
    const start = spawnSync(BASH, ['-n', START_SH], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
    });
    assert.equal(start.status, 0, start.stderr || start.error?.message || 'bash -n start.sh failed');

    const sat = spawnSync(BASH, ['-n', SATELLITE_SH], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
    });
    assert.equal(sat.status, 0, sat.stderr || sat.error?.message || 'bash -n satellite/start_satellite.sh failed');
});

test('GET / 302s to WEBUI_ORIGIN with token; /legacy serves HUD; DASHBOARD_UI=legacy keeps /', async () => {
    const prevUi = process.env.DASHBOARD_UI;
    const prevOrigin = process.env.WEBUI_ORIGIN;
    delete process.env.DASHBOARD_UI;
    process.env.WEBUI_ORIGIN = 'http://127.0.0.1:3000';

    const db = tempDb();
    const server = new MissionControlServer({
        database: db,
        sessionStore: {
            getActiveAgent: () => 'antigravity',
            getRecentTurns: () => [],
        },
        agents: { antigravity: { name: 'Antigravity', emoji: '🤖' } },
        port: 3171,
        token: 'redir_token',
    });

    try {
        const started = await server.start();
        assert.equal(started, true);

        const redir = await fetch('http://127.0.0.1:3171/?token=redir_token', { redirect: 'manual' });
        assert.equal(redir.status, 302);
        assert.equal(redir.headers.get('location'), 'http://127.0.0.1:3000/?token=redir_token');

        const noToken = await fetch('http://127.0.0.1:3171/', { redirect: 'manual' });
        assert.equal(noToken.status, 302);
        assert.equal(noToken.headers.get('location'), 'http://127.0.0.1:3000/');

        const legacy = await fetch('http://127.0.0.1:3171/legacy?token=redir_token', { redirect: 'manual' });
        assert.equal(legacy.status, 200);
        assert.match(String(legacy.headers.get('content-type')), /text\/html/);

        const api = await fetch('http://127.0.0.1:3171/api/info?token=redir_token');
        assert.equal(api.status, 200);
        const info = await api.json();
        assert.equal(info.status, 'online');

        process.env.DASHBOARD_UI = 'legacy';
        const rootLegacy = await fetch('http://127.0.0.1:3171/?token=redir_token', { redirect: 'manual' });
        assert.equal(rootLegacy.status, 200);
        assert.match(String(rootLegacy.headers.get('content-type')), /text\/html/);
    } finally {
        await server.stop();
        if (prevUi === undefined) delete process.env.DASHBOARD_UI;
        else process.env.DASHBOARD_UI = prevUi;
        if (prevOrigin === undefined) delete process.env.WEBUI_ORIGIN;
        else process.env.WEBUI_ORIGIN = prevOrigin;
    }
});
