// =============================================================================
//  core/SatelliteHub.js — Satellite Worker Orchestration Hub
//
//  Coordinates distributed satellite workers (e.g. Windows desktop daemon)
//  connected to the Cloud VPS Master over secure HTTP long-polling.
//
//  Features:
//    - NAT/Firewall-Proof: Satellite makes outbound HTTP calls to the VPS.
//    - Promise-based dispatch: satelliteHub.dispatch('screen.capture', ...)
//    - Automatic heartbeat & offline detection (>45s inactivity)
//    - Zero external dependencies (pure Node.js)
//
//  HTTP surface (mounted by MissionControl *before* the dashboard token gate):
//    POST /api/satellite/register   — worker enroll / heartbeat   (SATELLITE_KEY)
//    POST /api/satellite/poll       — worker long-poll for work   (SATELLITE_KEY)
//    POST /api/satellite/response   — worker returns a result     (SATELLITE_KEY)
//    GET  /api/satellite/status     — master lists workers        (DASHBOARD_TOKEN)
//    POST /api/satellite/dispatch   — master sends a command      (DASHBOARD_TOKEN)
//
//  The VPS cannot dial a NAT'd PC. A worker must be started on that machine
//  and poll out. Worker routes accept only SATELLITE_KEY (falling back to
//  DASHBOARD_TOKEN when SATELLITE_KEY is unset). A leaked dashboard URL
//  therefore cannot impersonate a worker and steal queued commands when the
//  two keys differ. Master routes require the dashboard token.
// =============================================================================

const crypto = require('crypto');

const SATELLITE_ACTIONS = Object.freeze([
    'screen.capture',
    'pc.lock',
    'cmd.exec',
    'notify.toast',
    'sys.info',
]);

const WORKER_PATHS = new Set([
    '/api/satellite/register',
    '/api/satellite/poll',
    '/api/satellite/response',
]);

const MASTER_PATHS = new Set([
    '/api/satellite/status',
    '/api/satellite/dispatch',
]);

const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_DISPATCH_TIMEOUT_MS = 120000;

function tokensEqual(a, b) {
    try {
        if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
        const left = Buffer.from(a, 'utf8');
        const right = Buffer.from(b, 'utf8');
        if (left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function extractPresentedToken(req, query = {}) {
    const headers = (req && req.headers) || {};
    const header = headers.authorization || headers.Authorization;
    if (typeof header === 'string') {
        const match = header.match(/^Bearer\s+(.+)$/i);
        if (match) return match[1].trim();
    }
    if (query && typeof query.token === 'string' && query.token) return query.token;
    return '';
}

function clientIp(req) {
    return (req && req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

class SatelliteHub {
    constructor({ authKey = null, pollTimeoutMs = 30000, offlineTimeoutMs = 45000 } = {}) {
        this.authKey = authKey || process.env.SATELLITE_KEY || process.env.DASHBOARD_TOKEN || 'admin';
        this.pollTimeoutMs = pollTimeoutMs;
        this.offlineTimeoutMs = offlineTimeoutMs;
        this.satellites = new Map();
        this.pendingQueues = new Map(); // satelliteId -> array of queued commands
    }

    /**
     * Authenticate an incoming satellite worker request.
     * Empty keys never succeed — a missing secret is a closed door, not an open one.
     */
    authenticate(reqKey) {
        if (!this.authKey) return false;
        return tokensEqual(reqKey, this.authKey);
    }

    /**
     * Register or update a satellite's heartbeat & system metadata.
     */
    register(satelliteId, metadata = {}, ip = '127.0.0.1') {
        const now = Date.now();
        let satellite = this.satellites.get(satelliteId);

        if (!satellite) {
            satellite = {
                id: satelliteId,
                hostname: metadata.hostname || 'unknown',
                platform: metadata.platform || 'win32',
                registeredAt: now,
                lastSeen: now,
                ip,
                systemInfo: metadata.systemInfo || {},
                pendingCommands: new Map(),
                activePollRes: null,
                pollTimer: null,
            };
            this.satellites.set(satelliteId, satellite);
            console.log(`[SatelliteHub] Registered new satellite: ${satelliteId} (${satellite.hostname}, ${satellite.platform}) from ${ip}`);
        } else {
            satellite.lastSeen = now;
            satellite.ip = ip;
            if (metadata.hostname) satellite.hostname = metadata.hostname;
            if (metadata.platform) satellite.platform = metadata.platform;
            if (metadata.systemInfo) satellite.systemInfo = metadata.systemInfo;
        }

        return satellite;
    }

    /**
     * Handle incoming long-poll from a satellite worker.
     */
    handlePoll(satelliteId, res, metadata = {}, ip = '127.0.0.1') {
        const satellite = this.register(satelliteId, metadata, ip);

        // If there was an existing held poll, close it cleanly
        if (satellite.activePollRes) {
            try {
                if (satellite.pollTimer) clearTimeout(satellite.pollTimer);
                satellite.activePollRes.writeHead(200, { 'Content-Type': 'application/json' });
                satellite.activePollRes.end(JSON.stringify({ heartbeat: true, duplicate: true }));
            } catch (_) {}
            satellite.activePollRes = null;
        }

        // Check if there's a command queued up for this satellite
        const queue = this.pendingQueues.get(satelliteId) || [];
        if (queue.length > 0) {
            const nextCmd = queue.shift();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ command: nextCmd }));
            return;
        }

        // Hold the connection open (long-poll)
        satellite.activePollRes = res;
        satellite.pollTimer = setTimeout(() => {
            if (satellite.activePollRes === res) {
                satellite.activePollRes = null;
                satellite.pollTimer = null;
                try {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ heartbeat: true }));
                } catch (_) {}
            }
        }, this.pollTimeoutMs);

        // If client terminates connection abruptly
        res.on('close', () => {
            if (satellite.activePollRes === res) {
                if (satellite.pollTimer) clearTimeout(satellite.pollTimer);
                satellite.activePollRes = null;
                satellite.pollTimer = null;
            }
        });
    }

    /**
     * Handle command completion response returned by a satellite.
     */
    handleResponse(satelliteId, { commandId, success, result, error }) {
        const satellite = this.satellites.get(satelliteId);
        if (!satellite) {
            return { error: 'Unknown satellite' };
        }

        satellite.lastSeen = Date.now();
        const pending = satellite.pendingCommands.get(commandId);
        if (!pending) {
            return { error: 'Command not found or expired' };
        }

        clearTimeout(pending.timer);
        satellite.pendingCommands.delete(commandId);

        if (success) {
            pending.resolve(result);
        } else {
            pending.reject(new Error(error || 'Satellite execution failed'));
        }

        return { success: true };
    }

    /**
     * Dispatch a command to a remote satellite.
     * Returns a Promise resolving with the satellite's execution result.
     */
    dispatch(action, params = {}, { satelliteId = null, timeoutMs = 20000 } = {}) {
        if (!SATELLITE_ACTIONS.includes(action)) {
            return Promise.reject(new Error(`Unsupported satellite action: ${action}`));
        }

        return new Promise((resolve, reject) => {
            const target = this._resolveTargetSatellite(satelliteId);
            if (!target) {
                return reject(new Error('No active satellite worker online'));
            }

            const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const command = { commandId, action, params };

            const timer = setTimeout(() => {
                target.pendingCommands.delete(commandId);
                reject(new Error(`Satellite command '${action}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            target.pendingCommands.set(commandId, {
                resolve,
                reject,
                timer,
                action,
                createdAt: Date.now(),
            });

            // If the satellite currently has an open long-poll connection, deliver immediately
            if (target.activePollRes) {
                if (target.pollTimer) clearTimeout(target.pollTimer);
                const res = target.activePollRes;
                target.activePollRes = null;
                target.pollTimer = null;
                try {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ command }));
                    return;
                } catch (err) {
                    console.warn(`[SatelliteHub] Failed pushing to active long-poll: ${err.message}`);
                }
            }

            // Otherwise queue it for the next poll cycle
            if (!this.pendingQueues.has(target.id)) {
                this.pendingQueues.set(target.id, []);
            }
            this.pendingQueues.get(target.id).push(command);
        });
    }

    /**
     * Check if at least one satellite is currently online.
     */
    hasOnlineSatellite(platform = null) {
        const now = Date.now();
        for (const sat of this.satellites.values()) {
            if (now - sat.lastSeen <= this.offlineTimeoutMs) {
                if (!platform || sat.platform === platform) return true;
            }
        }
        return false;
    }

    /**
     * Get list of currently online satellites.
     */
    getOnlineSatellites() {
        const now = Date.now();
        const list = [];
        for (const sat of this.satellites.values()) {
            const isOnline = now - sat.lastSeen <= this.offlineTimeoutMs;
            list.push({
                id: sat.id,
                hostname: sat.hostname,
                platform: sat.platform,
                ip: sat.ip,
                online: isOnline,
                lastSeenSecondsAgo: Math.floor((now - sat.lastSeen) / 1000),
                systemInfo: sat.systemInfo,
                pendingCommandsCount: sat.pendingCommands.size,
            });
        }
        return list;
    }

    /**
     * Get aggregate hub status.
     */
    getStatus() {
        const satellites = this.getOnlineSatellites();
        const onlineCount = satellites.filter(s => s.online).length;
        return {
            hub: 'online',
            totalRegistered: satellites.length,
            onlineCount,
            satellites,
        };
    }

    /**
     * Drop held long-polls and pending timers. Tests call this so node:test
     * does not hang on leftover pollTimeoutMs handles.
     */
    shutdown() {
        for (const sat of this.satellites.values()) {
            if (sat.pollTimer) {
                clearTimeout(sat.pollTimer);
                sat.pollTimer = null;
            }
            if (sat.activePollRes) {
                try {
                    sat.activePollRes.writeHead(200, { 'Content-Type': 'application/json' });
                    sat.activePollRes.end(JSON.stringify({ heartbeat: true, shutdown: true }));
                } catch (_) {}
                sat.activePollRes = null;
            }
            for (const pending of sat.pendingCommands.values()) {
                if (pending.timer) clearTimeout(pending.timer);
                try { pending.reject(new Error('Satellite hub shutting down')); } catch (_) {}
            }
            sat.pendingCommands.clear();
        }
        this.pendingQueues.clear();
    }

    _resolveTargetSatellite(preferredId) {
        const now = Date.now();
        if (preferredId) {
            const sat = this.satellites.get(preferredId);
            if (sat && (now - sat.lastSeen <= this.offlineTimeoutMs)) return sat;
            return null;
        }

        // Default to first online Windows satellite, or any online satellite
        let fallback = null;
        for (const sat of this.satellites.values()) {
            if (now - sat.lastSeen <= this.offlineTimeoutMs) {
                if (sat.platform === 'win32') return sat;
                if (!fallback) fallback = sat;
            }
        }
        return fallback;
    }
}

async function readJsonBody(ctx, req, res, maxBytes) {
    try {
        if (typeof ctx._readBody === 'function') {
            return await ctx._readBody(req, { maxBytes });
        }
        return {};
    } catch (err) {
        if (err && /too large/i.test(err.message || '')) {
            ctx._sendJson(res, 413, { error: 'Payload too large' });
            return null;
        }
        throw err;
    }
}

/**
 * MissionControl satellite HTTP glue. Returns true when the path is owned
 * (including 401/405), false when MissionControl should keep routing.
 *
 * Worker paths skip the dashboard token and require SATELLITE_KEY.
 * Master paths require DASHBOARD_TOKEN and reject a satellite-only key.
 */
async function handleSatelliteRoutes(ctx, req, res, pathname, query) {
    if (!WORKER_PATHS.has(pathname) && !MASTER_PATHS.has(pathname)) return false;

    const hub = ctx.satelliteHub;
    if (!hub) {
        ctx._sendJson(res, 503, { error: 'Satellite hub not configured' });
        return true;
    }

    const presented = extractPresentedToken(req, query);
    const isWorkerPath = WORKER_PATHS.has(pathname);

    if (isWorkerPath) {
        if (!hub.authenticate(presented)) {
            ctx._sendJson(res, 401, { error: 'Unauthorized' });
            return true;
        }
    } else if (!ctx.token || !tokensEqual(presented, ctx.token)) {
        ctx._sendJson(res, 401, { error: 'Unauthorized' });
        return true;
    }

    const method = (req.method || 'GET').toUpperCase();

    if (pathname === '/api/satellite/register') {
        if (method !== 'POST') {
            ctx._sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const body = await readJsonBody(ctx, req, res);
        if (body === null) return true;
        const satelliteId = body.satelliteId || query.satelliteId;
        if (!satelliteId || typeof satelliteId !== 'string') {
            ctx._sendJson(res, 400, { error: 'satelliteId required' });
            return true;
        }
        const sat = hub.register(satelliteId, {
            hostname: body.hostname || query.hostname,
            platform: body.platform || query.platform,
            systemInfo: body.systemInfo || {},
        }, clientIp(req));
        ctx._sendJson(res, 200, {
            success: true,
            satellite: {
                id: sat.id,
                hostname: sat.hostname,
                platform: sat.platform,
                ip: sat.ip,
            },
        });
        return true;
    }

    if (pathname === '/api/satellite/poll') {
        if (method !== 'POST' && method !== 'GET') {
            ctx._sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const body = method === 'POST' ? await readJsonBody(ctx, req, res) : {};
        if (body === null) return true;
        const satelliteId = body.satelliteId || query.satelliteId;
        if (!satelliteId || typeof satelliteId !== 'string') {
            ctx._sendJson(res, 400, { error: 'satelliteId required' });
            return true;
        }
        const metadata = {
            hostname: body.hostname || query.hostname,
            platform: body.platform || query.platform || 'win32',
            systemInfo: body.systemInfo || {},
        };
        hub.handlePoll(satelliteId, res, metadata, clientIp(req));
        return true;
    }

    if (pathname === '/api/satellite/response') {
        if (method !== 'POST') {
            ctx._sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const body = await readJsonBody(ctx, req, res, RESPONSE_MAX_BYTES);
        if (body === null) return true;
        const satelliteId = body.satelliteId || query.satelliteId;
        if (!satelliteId || typeof satelliteId !== 'string') {
            ctx._sendJson(res, 400, { error: 'satelliteId required' });
            return true;
        }
        if (!body.commandId) {
            ctx._sendJson(res, 400, { error: 'commandId required' });
            return true;
        }
        const result = hub.handleResponse(satelliteId, body);
        if (result && result.error) {
            ctx._sendJson(res, 404, result);
            return true;
        }
        ctx._sendJson(res, 200, result);
        return true;
    }

    if (pathname === '/api/satellite/status') {
        if (method !== 'GET' && method !== 'POST') {
            ctx._sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        ctx._sendJson(res, 200, hub.getStatus());
        return true;
    }

    if (pathname === '/api/satellite/dispatch') {
        if (method !== 'POST') {
            ctx._sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const body = await readJsonBody(ctx, req, res);
        if (body === null) return true;
        const action = body.action;
        if (!action || typeof action !== 'string') {
            ctx._sendJson(res, 400, { error: 'action required' });
            return true;
        }
        if (!SATELLITE_ACTIONS.includes(action)) {
            ctx._sendJson(res, 400, { error: `Unsupported satellite action: ${action}` });
            return true;
        }
        const rawTimeout = Number(body.timeoutMs);
        const timeoutMs = Number.isFinite(rawTimeout)
            ? Math.min(Math.max(rawTimeout, 1000), MAX_DISPATCH_TIMEOUT_MS)
            : 20000;
        try {
            const result = await hub.dispatch(action, body.params || {}, {
                satelliteId: body.satelliteId || null,
                timeoutMs,
            });
            ctx._sendJson(res, 200, { success: true, result });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            const status = /timed out/i.test(msg) ? 504 : /no active satellite/i.test(msg) ? 503 : 400;
            ctx._sendJson(res, status, { error: msg });
        }
        return true;
    }

    return true;
}

// Global singleton instance
const globalSatelliteHub = new SatelliteHub();

module.exports = {
    SatelliteHub,
    globalSatelliteHub,
    handleSatelliteRoutes,
    SATELLITE_ACTIONS,
};
