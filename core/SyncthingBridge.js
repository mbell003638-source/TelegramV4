// =============================================================================
//  core/SyncthingBridge.js — Syncthing Control for Multi-Setup Sync
//
//  Keeps the shared brain identical across machines: the Obsidian vault, the
//  memory store, and the workspace folders. Syncthing does the actual
//  replication (peer to peer, no cloud, no account); this module drives its
//  local REST API so the Agent OS can see and manage that sync.
//
//  Talks to a Syncthing instance the operator already runs (default
//  http://127.0.0.1:8384). The API key is in Syncthing's own
//  Settings > GUI > API Key, or config.xml as <apikey>.
//
//  Deliberately conservative: it reads status freely, but every mutating call
//  (adding a device, sharing a folder, pausing) is an explicit method the
//  caller has to invoke. It never auto-accepts a pairing request, because
//  accepting an unknown device ID would hand a stranger the whole vault.
// =============================================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_URL = 'http://127.0.0.1:8384';
const REQUEST_TIMEOUT_MS = 15000;

// A Syncthing device ID is 8 groups of 7 chars, dash separated, often with
// check characters. Validate loosely but reject obvious junk.
const DEVICE_ID_RE = /^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/i;

class SyncthingBridge {
    constructor({ baseUrl, apiKey, transport } = {}) {
        this.baseUrl = String(baseUrl || process.env.SYNCTHING_URL || DEFAULT_URL).replace(/\/+$/, '');
        this.apiKey = apiKey || process.env.SYNCTHING_API_KEY || null;
        // Injectable for tests; defaults to a builtin http/https request.
        this.transport = typeof transport === 'function' ? transport : null;
    }

    get isConfigured() {
        return !!this.apiKey;
    }

    /**
     * Try to find the API key in Syncthing's own config.xml, so a local
     * install works without the operator copying it by hand.
     */
    static discoverApiKey() {
        const candidates = [];
        const home = os.homedir();
        if (process.platform === 'win32') {
            candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Syncthing', 'config.xml'));
            candidates.push(path.join(process.env.APPDATA || '', 'Syncthing', 'config.xml'));
        } else if (process.platform === 'darwin') {
            candidates.push(path.join(home, 'Library', 'Application Support', 'Syncthing', 'config.xml'));
        }
        candidates.push(path.join(home, '.config', 'syncthing', 'config.xml'));
        candidates.push(path.join(home, '.local', 'state', 'syncthing', 'config.xml'));

        for (const file of candidates) {
            try {
                if (!file || !fs.existsSync(file)) continue;
                const xml = fs.readFileSync(file, 'utf8');
                const match = xml.match(/<apikey>([^<]+)<\/apikey>/i);
                if (match && match[1].trim()) {
                    return { apiKey: match[1].trim(), configPath: file };
                }
            } catch {
                // unreadable candidate — keep looking
            }
        }
        return null;
    }

    _request(method, apiPath, body = null) {
        if (this.transport) {
            return this.transport({ method, url: this.baseUrl + apiPath, body, apiKey: this.apiKey });
        }
        if (!this.apiKey) {
            return Promise.reject(new Error('Syncthing API key not configured (SYNCTHING_API_KEY)'));
        }

        const url = new URL(this.baseUrl + apiPath);
        const client = url.protocol === 'https:' ? https : http;
        const payload = body === null ? null : JSON.stringify(body);

        return new Promise((resolve, reject) => {
            const req = client.request({
                method,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                headers: {
                    'X-API-Key': this.apiKey,
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
                // A self-signed GUI cert is the norm for a local Syncthing.
                rejectUnauthorized: false,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 403) {
                        return reject(new Error('Syncthing rejected the API key (403)'));
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`Syncthing HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                    if (!data) return resolve(null);
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data); // some endpoints return plain text
                    }
                });
            });
            req.on('error', (err) => reject(
                new Error(`Syncthing unreachable at ${this.baseUrl}: ${err.message}`)
            ));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error(`Syncthing timed out after ${REQUEST_TIMEOUT_MS}ms`));
            });
            if (payload) req.write(payload);
            req.end();
        });
    }

    // --- Read -------------------------------------------------------------

    /** This machine's own device ID and version. */
    async myStatus() {
        const [status, version] = await Promise.all([
            this._request('GET', '/rest/system/status'),
            this._request('GET', '/rest/system/version').catch(() => null),
        ]);
        return {
            deviceId: status?.myID || null,
            uptimeSeconds: status?.uptime ?? null,
            version: version?.version || null,
        };
    }

    async listDevices() {
        const [devices, connections] = await Promise.all([
            this._request('GET', '/rest/config/devices'),
            this._request('GET', '/rest/system/connections').catch(() => null),
        ]);
        const conns = connections?.connections || {};
        return (Array.isArray(devices) ? devices : []).map((d) => ({
            deviceId: d.deviceID,
            name: d.name || '',
            paused: !!d.paused,
            addresses: d.addresses || [],
            connected: !!conns[d.deviceID]?.connected,
            address: conns[d.deviceID]?.address || null,
        }));
    }

    async listFolders() {
        const folders = await this._request('GET', '/rest/config/folders');
        return (Array.isArray(folders) ? folders : []).map((f) => ({
            id: f.id,
            label: f.label || f.id,
            path: f.path,
            type: f.type,
            paused: !!f.paused,
            devices: (f.devices || []).map((d) => d.deviceID),
        }));
    }

    /** Sync completion for one folder, or every folder. */
    async syncStatus(folderId = null) {
        const folders = folderId ? [{ id: folderId }] : await this.listFolders();
        const out = [];
        for (const folder of folders) {
            try {
                const st = await this._request('GET', `/rest/db/status?folder=${encodeURIComponent(folder.id)}`);
                out.push({
                    id: folder.id,
                    state: st?.state || 'unknown',
                    needFiles: st?.needFiles ?? 0,
                    globalFiles: st?.globalFiles ?? 0,
                    localFiles: st?.localFiles ?? 0,
                    // "idle" with nothing needed is the only real "in sync".
                    inSync: (st?.needFiles ?? 0) === 0 && (st?.state || '') === 'idle',
                    errors: st?.errors ?? 0,
                });
            } catch (err) {
                out.push({ id: folder.id, state: 'error', error: err.message, inSync: false });
            }
        }
        return out;
    }

    /** Pending device/folder invitations. Reported, never auto-accepted. */
    async pending() {
        const [devices, folders] = await Promise.all([
            this._request('GET', '/rest/cluster/pending/devices').catch(() => ({})),
            this._request('GET', '/rest/cluster/pending/folders').catch(() => ({})),
        ]);
        return {
            devices: Object.entries(devices || {}).map(([deviceId, info]) => ({
                deviceId, name: info?.name || '', address: info?.address || null,
            })),
            folders: Object.entries(folders || {}).map(([folderId, info]) => ({
                folderId, offeredBy: Object.keys(info?.offeredBy || {}),
            })),
        };
    }

    /** One call for a dashboard tile. Never throws. */
    async overview() {
        if (!this.isConfigured && !this.transport) {
            return { configured: false, reachable: false, reason: 'SYNCTHING_API_KEY not set' };
        }
        try {
            const [me, devices, folders] = await Promise.all([
                this.myStatus(), this.listDevices(), this.listFolders(),
            ]);
            const sync = await this.syncStatus();
            return {
                configured: true,
                reachable: true,
                me,
                devices,
                folders,
                sync,
                allInSync: sync.length > 0 && sync.every((s) => s.inSync),
                pending: await this.pending().catch(() => ({ devices: [], folders: [] })),
            };
        } catch (err) {
            return { configured: this.isConfigured, reachable: false, reason: err.message };
        }
    }

    // --- Mutate -----------------------------------------------------------

    /**
     * Introduce another setup. This grants that device access to whatever
     * folders it is later shared into, so the ID must come from the operator,
     * never from an unverified pairing request.
     */
    async addDevice(deviceId, name = '', addresses = ['dynamic']) {
        const id = String(deviceId || '').trim().toUpperCase();
        if (!DEVICE_ID_RE.test(id)) {
            throw new Error('That does not look like a Syncthing device ID (expected 8 dash-separated groups)');
        }
        const existing = await this.listDevices().catch(() => []);
        if (existing.some((d) => String(d.deviceId).toUpperCase() === id)) {
            return { ok: true, alreadyPresent: true, deviceId: id };
        }
        await this._request('POST', '/rest/config/devices', {
            deviceID: id,
            name: name || id.slice(0, 7),
            addresses: Array.isArray(addresses) && addresses.length ? addresses : ['dynamic'],
        });
        return { ok: true, deviceId: id, name };
    }

    /** Share an existing folder with a device that is already known. */
    async shareFolder(folderId, deviceId) {
        const id = String(deviceId || '').trim().toUpperCase();
        if (!DEVICE_ID_RE.test(id)) throw new Error('Invalid Syncthing device ID');

        const folder = await this._request('GET', `/rest/config/folders/${encodeURIComponent(folderId)}`);
        if (!folder || !folder.id) throw new Error(`No such Syncthing folder: ${folderId}`);

        const devices = Array.isArray(folder.devices) ? folder.devices : [];
        if (devices.some((d) => String(d.deviceID).toUpperCase() === id)) {
            return { ok: true, alreadyShared: true, folderId, deviceId: id };
        }
        // PATCH replaces the device list, so send the existing entries plus the
        // new one — sending only the new one would unshare everyone else.
        await this._request('PATCH', `/rest/config/folders/${encodeURIComponent(folderId)}`, {
            devices: [...devices, { deviceID: id }],
        });
        return { ok: true, folderId, deviceId: id };
    }

    /** Force a rescan, e.g. right after the agent writes to the vault. */
    async rescan(folderId = null) {
        const q = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
        await this._request('POST', `/rest/db/scan${q}`);
        return { ok: true, folderId: folderId || 'all' };
    }

    async setPaused(folderId, paused) {
        await this._request('PATCH', `/rest/config/folders/${encodeURIComponent(folderId)}`, {
            paused: !!paused,
        });
        return { ok: true, folderId, paused: !!paused };
    }
}

module.exports = SyncthingBridge;
module.exports.SyncthingBridge = SyncthingBridge;
module.exports.DEVICE_ID_RE = DEVICE_ID_RE;
module.exports.DEFAULT_URL = DEFAULT_URL;
