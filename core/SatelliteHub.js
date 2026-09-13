// =============================================================================
//  core/SatelliteHub.js — Satellite Worker Orchestration Hub
//
//  Coordinates distributed satellite workers (e.g. Windows desktop daemon)
//  connected to the Cloud VPS Master over secure HTTP long-polling.
//
//  Features:
//    - NAT/Firewall-Proof: Satellite makes outbound HTTP calls to VPS.
//    - Promise-based dispatch: satelliteHub.dispatch('screen.capture', ...)
//    - Automatic heartbeat & offline detection (>45s inactivity)
//    - Zero external dependencies (pure Node.js)
// =============================================================================

class SatelliteHub {
    constructor({ authKey = null, pollTimeoutMs = 30000, offlineTimeoutMs = 45000 } = {}) {
        this.authKey = authKey || process.env.SATELLITE_KEY || process.env.DASHBOARD_TOKEN || 'admin';
        this.pollTimeoutMs = pollTimeoutMs;
        this.offlineTimeoutMs = offlineTimeoutMs;
        this.satellites = new Map();
        this.pendingQueues = new Map(); // satelliteId -> array of queued commands
    }

    /**
     * Authenticate an incoming satellite request.
     */
    authenticate(reqKey) {
        if (!this.authKey) return true;
        return reqKey === this.authKey;
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

// Global singleton instance
const globalSatelliteHub = new SatelliteHub();

module.exports = {
    SatelliteHub,
    globalSatelliteHub,
};
