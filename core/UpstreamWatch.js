// =============================================================================
//  core/UpstreamWatch.js — Reference Project Update Watcher
//
//  The feature set of this Agent OS is drawn from several upstream projects.
//  Those projects keep moving, so this module answers one question on demand:
//  "what landed upstream since we last looked?"
//
//  It only ever READS. It fetches commit metadata and reports what changed; it
//  never merges, never writes to a working tree, and never runs upstream code.
//  Pulling anything in stays a human decision.
//
//  Two modes, chosen per repo:
//    - local  : a clone already on disk -> `git fetch` + `git log` (no API limit)
//    - remote : no clone -> the GitHub commits API over HTTPS (unauthenticated,
//               so subject to rate limiting; a token lifts that)
// =============================================================================
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// The projects this Agent OS draws its feature set from.
const DEFAULT_SOURCES = [
    { id: 'openclaw',        repo: 'openclaw/openclaw',            note: 'Gateway, multi-channel, device reach' },
    { id: 'hermes-agent',    repo: 'NousResearch/hermes-agent',    note: 'Self-improvement loop, FTS5 recall, cron' },
    { id: 'opencodex',       repo: 'lidge-jun/opencodex',          note: 'Universal provider proxy for CLI agents' },
    { id: 'jarvis',          repo: 'microsoft/JARVIS',             note: 'Task planning and model selection' },
    { id: 'fullstack-agent', repo: 'jaredrhod/fullstack-agent',    note: 'Memory vault, voice, visualizer, gestures' },
    { id: 'omniroute',       repo: 'diegosouzapw/OmniRoute',       note: 'Provider failover routing' },
    { id: '9router',         repo: 'decolua/9router',              note: 'Key pool rotation' },
];

const GIT_TIMEOUT_MS = 60000;
const HTTP_TIMEOUT_MS = 20000;

function runGit(args, cwd, timeout = GIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    err.stderr = stderr;
                    return reject(err);
                }
                resolve(String(stdout || '').trim());
            });
    });
}

function httpGetJson(url, headers = {}, timeout = HTTP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                // GitHub rejects requests without a User-Agent.
                'User-Agent': 'TelegramV4-UpstreamWatch',
                Accept: 'application/vnd.github+json',
                ...headers,
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    const err = new Error(`HTTP ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    err.body = body.slice(0, 400);
                    return reject(err);
                }
                try {
                    resolve(JSON.parse(body));
                } catch (parseErr) {
                    reject(new Error(`Malformed JSON from ${url}: ${parseErr.message}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => {
            req.destroy(new Error(`Timed out after ${timeout}ms`));
        });
    });
}

class UpstreamWatch {
    /**
     * @param {object}   opts
     * @param {string}   opts.baseDir     where state is persisted
     * @param {string}   opts.clonesDir   where sibling clones live (default: baseDir/..)
     * @param {Array}    opts.sources     override the watched project list
     * @param {string}   opts.githubToken optional, lifts the API rate limit
     */
    constructor({ baseDir, clonesDir, sources, githubToken } = {}) {
        this.baseDir = baseDir || path.resolve(__dirname, '..');
        // Clones sit beside the project (C:\Ai\openclaw next to C:\Ai\TelegramV4).
        this.clonesDir = clonesDir || path.resolve(this.baseDir, '..');
        this.sources = Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES;
        this.githubToken = githubToken || process.env.GITHUB_TOKEN || null;
        this.statePath = path.join(this.baseDir, 'store', 'upstream-watch.json');
        this.state = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.statePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
                if (parsed && typeof parsed === 'object') return parsed;
            }
        } catch (err) {
            console.warn('[UpstreamWatch] Could not read upstream-watch.json:', err.message);
        }
        return { version: 1, seen: {} };
    }

    _save() {
        try {
            const dir = path.dirname(this.statePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
        } catch (err) {
            console.warn('[UpstreamWatch] Could not persist upstream-watch.json:', err.message);
        }
    }

    /** Path to a local clone of this source, or null when there is none. */
    localClonePath(source) {
        const dir = path.join(this.clonesDir, source.id);
        try {
            return fs.existsSync(path.join(dir, '.git')) ? dir : null;
        } catch {
            return null;
        }
    }

    /**
     * Check one project. Returns a report, never throws — a source that cannot
     * be reached is reported as an error entry so one failure cannot abort a
     * sweep across every project.
     */
    async checkSource(source) {
        const seen = this.state.seen[source.id] || {};
        const report = {
            id: source.id,
            repo: source.repo,
            note: source.note || '',
            mode: null,
            lastSeenSha: seen.sha || null,
            headSha: null,
            newCommits: [],
            newCount: 0,
            upToDate: false,
            error: null,
        };

        try {
            const clone = this.localClonePath(source);
            if (clone) {
                report.mode = 'local';
                await this._checkLocal(clone, report);
            } else {
                report.mode = 'remote';
                await this._checkRemote(source, report);
            }

            report.newCount = report.newCommits.length;
            // Without a prior sha there is no baseline, so this is a first look
            // rather than a claim that nothing changed.
            report.upToDate = !!report.lastSeenSha && report.headSha === report.lastSeenSha;
        } catch (err) {
            report.error = err.message;
        }

        return report;
    }

    async _checkLocal(clone, report) {
        // Fetch metadata only; the working tree is never touched.
        try {
            await runGit(['fetch', '--quiet', 'origin'], clone);
        } catch (err) {
            // A detached/offline clone can still be inspected at its current head.
            console.warn(`[UpstreamWatch] fetch failed for ${report.id}: ${err.message}`);
        }

        let ref = 'origin/HEAD';
        try {
            await runGit(['rev-parse', '--verify', '--quiet', 'origin/HEAD'], clone);
        } catch {
            // Shallow clones often lack origin/HEAD; fall back to a real branch.
            ref = 'origin/main';
            try {
                await runGit(['rev-parse', '--verify', '--quiet', 'origin/main'], clone);
            } catch {
                ref = 'HEAD';
            }
        }

        report.headSha = await runGit(['rev-parse', ref], clone);

        const range = report.lastSeenSha ? `${report.lastSeenSha}..${ref}` : `${ref} -20`;
        const args = report.lastSeenSha
            ? ['log', '--no-merges', '--pretty=%H%x1f%an%x1f%aI%x1f%s', range]
            : ['log', '--no-merges', '--pretty=%H%x1f%an%x1f%aI%x1f%s', '-20', ref];

        let out = '';
        try {
            out = await runGit(args, clone);
        } catch (err) {
            // An unknown baseline sha (force-push, or a shallow clone that never
            // contained it) must not look like "no changes".
            console.warn(`[UpstreamWatch] log ${range} failed for ${report.id}: ${err.message}`);
            out = await runGit(['log', '--no-merges', '--pretty=%H%x1f%an%x1f%aI%x1f%s', '-20', ref], clone);
            report.baselineMissing = true;
        }

        report.newCommits = out.split(/\r?\n/).filter(Boolean).map((line) => {
            const [sha, author, date, subject] = line.split('\x1f');
            return { sha, shortSha: String(sha || '').slice(0, 8), author, date, subject };
        });
    }

    async _checkRemote(source, report) {
        const headers = this.githubToken ? { Authorization: `Bearer ${this.githubToken}` } : {};
        const url = `https://api.github.com/repos/${source.repo}/commits?per_page=20`;
        const commits = await httpGetJson(url, headers);
        if (!Array.isArray(commits)) throw new Error('Unexpected API response');

        const mapped = commits.map((c) => ({
            sha: c.sha,
            shortSha: String(c.sha || '').slice(0, 8),
            author: c.commit?.author?.name || c.author?.login || 'unknown',
            date: c.commit?.author?.date || null,
            subject: String(c.commit?.message || '').split('\n')[0],
        }));

        report.headSha = mapped.length ? mapped[0].sha : null;

        if (!report.lastSeenSha) {
            report.newCommits = mapped;
            return;
        }
        const idx = mapped.findIndex((c) => c.sha === report.lastSeenSha);
        // Not finding the baseline in the last 20 means it is older than the
        // window, not that everything is new — report the window and say so.
        if (idx === -1) {
            report.newCommits = mapped;
            report.baselineOlderThanWindow = true;
        } else {
            report.newCommits = mapped.slice(0, idx);
        }
    }

    /** Check every watched project. Always resolves. */
    async checkAll() {
        const reports = [];
        for (const source of this.sources) {
            reports.push(await this.checkSource(source));
        }
        const withNew = reports.filter((r) => !r.error && r.newCount > 0);
        return {
            checkedAt: Date.now(),
            total: reports.length,
            withUpdates: withNew.length,
            errored: reports.filter((r) => r.error).length,
            reports,
        };
    }

    /**
     * Record the current head of each reported source as seen, so the next
     * sweep reports only what is newer. Call this once the operator has
     * actually reviewed a report.
     */
    acknowledge(reports = []) {
        const acked = [];
        for (const report of reports) {
            if (!report || report.error || !report.headSha) continue;
            this.state.seen[report.id] = { sha: report.headSha, at: new Date().toISOString() };
            acked.push(report.id);
        }
        if (acked.length) this._save();
        return acked;
    }

    /** A compact operator-facing digest of a checkAll() result. */
    static formatDigest(result) {
        if (!result || !Array.isArray(result.reports)) return 'No upstream report available.';
        const lines = [];
        for (const r of result.reports) {
            if (r.error) {
                lines.push(`- ${r.id}: could not check (${r.error})`);
                continue;
            }
            if (r.upToDate || r.newCount === 0) {
                lines.push(`- ${r.id}: up to date`);
                continue;
            }
            const scope = r.lastSeenSha ? `${r.newCount} new commit(s)` : `latest ${r.newCount} commit(s), first look`;
            lines.push(`- ${r.id}: ${scope} [${r.mode}]`);
            for (const c of r.newCommits.slice(0, 5)) {
                lines.push(`    ${c.shortSha}  ${c.subject}`);
            }
            if (r.newCount > 5) lines.push(`    ...and ${r.newCount - 5} more`);
        }
        return lines.join('\n');
    }
}

module.exports = UpstreamWatch;
module.exports.UpstreamWatch = UpstreamWatch;
module.exports.DEFAULT_SOURCES = DEFAULT_SOURCES;
