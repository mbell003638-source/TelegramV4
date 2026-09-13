const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function parseGrokSessionList(stdout) {
    const items = [];
    if (!stdout) return items;
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        const match = trimmed.match(/^([0-9a-f-]{20,36})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/i);
        if (!match) continue;
        items.push({
            agent: 'grok',
            id: match[1],
            updatedAt: match[3],
            title: (match[5] || '').trim() || '(no summary)',
        });
    }
    return items;
}

function normalizeCwd(cwd) {
    if (!cwd) return null;
    let value = String(cwd).trim();
    if (!value) return null;
    if (value.startsWith('file://')) {
        try { value = decodeURIComponent(value.slice('file://'.length)); } catch { value = value.slice('file://'.length); }
    }
    try {
        if (fs.existsSync(value) && fs.statSync(value).isDirectory()) return path.resolve(value);
    } catch { /* ignore */ }
    return null;
}

function resolveUserCwd(input, homeDir = os.homedir()) {
    let value = String(input || '').trim();
    if (!value) return null;
    const aliases = {
        home: homeDir,
        '~': homeDir,
        bot: path.join(homeDir, 'telegram-bridge-v4'),
        bridge: path.join(homeDir, 'telegram-bridge-v4'),
        default: process.env.WORKSPACE_ROOT || homeDir,
    };
    if (aliases[value.toLowerCase()]) value = aliases[value.toLowerCase()];
    if (value.startsWith('~/')) value = path.join(homeDir, value.slice(2));
    if (!path.isAbsolute(value)) value = path.resolve(homeDir, value);
    return normalizeCwd(value);
}

function findGrokSessionCwd(homeDir, sessionId) {
    const root = path.join(homeDir, '.grok', 'sessions');
    if (!sessionId || !fs.existsSync(root)) return null;
    const files = walkFiles(root, (name, full) => full.includes(sessionId));
    for (const file of files) {
        let dir = path.dirname(file);
        if (path.basename(dir) === sessionId) dir = path.dirname(dir);
        const encoded = path.basename(dir);
        try {
            const decoded = decodeURIComponent(encoded);
            const cwd = normalizeCwd(decoded);
            if (cwd) return cwd;
        } catch { /* ignore */ }
    }
    return null;
}

function clipTitle(text, max = 60) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return '(no summary)';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isInjectedPromptPrefix(text) {
    return /^(Persistent shared memories|Shared recent conversation|New shared memories to retain)\b/i.test(String(text || '').trim());
}

function peelSharedPrompt(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (!isInjectedPromptPrefix(value)) return value;
    const marker = '\n---\n';
    const idx = value.lastIndexOf(marker);
    if (idx === -1) return '';
    return value.slice(idx + marker.length).replace(/^\n+/, '').trim();
}

function usableUserTitle(text) {
    const value = peelSharedPrompt(text);
    if (!value || value.startsWith('<') || isInjectedPromptPrefix(value)) return '';
    return value;
}

function extractUserTitle(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const content = obj.message?.content || obj.content || obj.text || obj.payload?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '').join(' ');
    }
    return '';
}

function extractRecordRole(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return obj.payload?.role || obj.payload?.item?.role || obj.item?.role || obj.role || '';
}

function readFirstJsonLines(file, maxBytes = 24000) {
    try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(maxBytes, fs.statSync(file).size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        return buf.slice(0, n).toString('utf8').split('\n');
    } catch {
        return [];
    }
}

function readJsonlObjects(file, { maxObjects = 40, maxBytes = 262144 } = {}) {
    const objects = [];
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const buf = Buffer.alloc(Math.min(maxBytes, size));
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const text = buf.slice(0, n).toString('utf8');
            const lines = text.split('\n');
            const complete = (n === size || text.endsWith('\n')) ? lines : lines.slice(0, -1);
            for (const line of complete) {
                if (!line.trim()) continue;
                try { objects.push(JSON.parse(line)); } catch { /* skip truncated/invalid */ }
                if (objects.length >= maxObjects) break;
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return objects;
    }
    return objects;
}

function walkFiles(dir, matcher, acc = []) {
    if (!dir || !fs.existsSync(dir)) return acc;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, matcher, acc);
        else if (matcher(entry.name, full)) acc.push(full);
    }
    return acc;
}

function listGrokSessionsFromDisk(homeDir = os.homedir(), limit = 20) {
    const root = path.join(homeDir, '.grok', 'sessions');
    const files = walkFiles(root, (name) => name === 'summary.json');
    const items = [];
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const id = data.info?.id || path.basename(path.dirname(file));
            if (!id) continue;
            items.push({
                agent: 'grok',
                id,
                title: clipTitle(data.session_summary || data.info?.title || ''),
                updatedAt: data.last_active_at || data.updated_at || '',
                cwd: normalizeCwd(data.info?.cwd) || findGrokSessionCwd(homeDir, id),
            });
        } catch { /* skip unreadable summaries */ }
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items.slice(0, limit);
}

function listGrokSessions(homeDir = os.homedir(), limit = 20) {
    const fromDisk = listGrokSessionsFromDisk(homeDir, limit);
    if (fromDisk.length) return fromDisk;

    const grok = path.join(homeDir, '.local', 'bin', 'grok');
    const bin = fs.existsSync(grok) ? grok : 'grok';
    try {
        const stdout = execFileSync(bin, ['sessions', 'list', '-n', String(limit)], {
            encoding: 'utf8',
            timeout: 8000,
            windowsHide: true,
            cwd: process.env.WORKSPACE_ROOT || homeDir,
        });
        return parseGrokSessionList(stdout).slice(0, limit).map((item) => ({
            ...item,
            cwd: findGrokSessionCwd(homeDir, item.id),
        }));
    } catch (e) {
        console.warn(`[sessionCatalog] grok sessions list failed: ${e.message}`);
        return [];
    }
}

function listClaudeSessions(homeDir = os.homedir(), limit = 20) {
    const root = path.join(homeDir, '.claude', 'projects');
    const files = walkFiles(root, (name) => name.endsWith('.jsonl'));
    const items = files.map((file) => {
        const stat = fs.statSync(file);
        const id = path.basename(file, '.jsonl');
        let title = '';
        let cwd = null;
        for (const line of readFirstJsonLines(file)) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.cwd && !cwd) cwd = normalizeCwd(obj.cwd);
                if (obj.type === 'user' && !obj.isMeta) {
                    title = usableUserTitle(extractUserTitle(obj));
                    if (title) break;
                }
            } catch { /* skip */ }
        }
        return { agent: 'claude', id, title: clipTitle(title), updatedAt: stat.mtime.toISOString(), cwd };
    });
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items.slice(0, limit);
}

function listCodexSessions(homeDir = os.homedir(), limit = 20) {
    const root = path.join(homeDir, '.codex', 'sessions');
    const files = walkFiles(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
    const items = files.map((file) => {
        const stat = fs.statSync(file);
        const match = path.basename(file).match(/([0-9a-f-]{20,36})\.jsonl$/i);
        const id = match ? match[1] : path.basename(file, '.jsonl');
        let title = '';
        let cwd = null;
        for (const obj of readJsonlObjects(file, { maxObjects: 60, maxBytes: 512 * 1024 })) {
            if (obj.type === 'session_meta' && obj.payload?.cwd && !cwd) {
                cwd = normalizeCwd(obj.payload.cwd);
            }
            const role = extractRecordRole(obj);
            if (role && role !== 'user') continue;
            const raw = extractUserTitle(obj.payload?.item || obj.payload || obj.item || obj);
            const next = usableUserTitle(raw);
            if (next) { title = next; break; }
        }
        return { agent: 'codex', id, title: clipTitle(title || 'Codex session'), updatedAt: stat.mtime.toISOString(), cwd };
    });
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items.slice(0, limit);
}

function listAgySessions(homeDir = os.homedir(), limit = 20) {
    const db = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    if (!fs.existsSync(db)) return [];
    try {
        const py = `import sqlite3,json; con=sqlite3.connect(${JSON.stringify(db)}); rows=con.execute("select conversation_id, title, preview, last_modified_time, workspace_uris from conversation_summaries order by last_modified_time desc limit ${Number(limit)}").fetchall();
def cwd(raw):
    try:
        uris=json.loads(raw or "[]")
        if uris: return uris[0]
    except Exception:
        return ""
    return ""
print(json.dumps([{"id":r[0],"title":(r[1] or r[2] or "Antigravity session"),"updatedAt":r[3],"cwd":cwd(r[4])} for r in rows]))`;
        const stdout = execFileSync('python3', ['-c', py], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const rows = JSON.parse(stdout);
        return rows.map((row) => ({
            agent: 'antigravity',
            id: row.id,
            title: clipTitle(row.title),
            updatedAt: row.updatedAt || '',
            cwd: normalizeCwd(row.cwd),
        }));
    } catch {
        const dir = path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations');
        const files = walkFiles(dir, (name) => name.endsWith('.db') && !name.includes('-shm') && !name.includes('-wal'));
        return files.map((file) => {
            const stat = fs.statSync(file);
            return { agent: 'antigravity', id: path.basename(file, '.db'), title: 'Antigravity session', updatedAt: stat.mtime.toISOString() };
        }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    }
}

function listAllSessions(homeDir = os.homedir(), limitPerAgent = 12) {
    return [
        ...listGrokSessions(homeDir, limitPerAgent),
        ...listClaudeSessions(homeDir, limitPerAgent),
        ...listCodexSessions(homeDir, limitPerAgent),
        ...listAgySessions(homeDir, limitPerAgent),
    ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

module.exports = {
    parseGrokSessionList,
    listGrokSessions,
    listGrokSessionsFromDisk,
    listClaudeSessions,
    listCodexSessions,
    listAgySessions,
    listAllSessions,
    clipTitle,
    peelSharedPrompt,
    usableUserTitle,
    normalizeCwd,
    resolveUserCwd,
    findGrokSessionCwd,
};
