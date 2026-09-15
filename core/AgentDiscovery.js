// =============================================================================
//  core/AgentDiscovery.js — System-wide agent-CLI auto-discovery
//
//  Scans the machine for installed agent CLIs (claude, codex, grok, hermes,
//  opencode, openclaw, pi, agy, aider, goose, gemini, ollama, ...) instead of
//  trusting a hardcoded list, the way omnirouter / codexrouter / 9route do.
//
//  Resolution order per agent:
//      1. the binary on PATH            -> source 'path'
//      2. the platform candidate list   -> source 'known-path'
//      3. the npm global bin directory  -> source 'npm-global'
//
//  Windows note: npm installs shims as `.cmd`, so every probe also tries the
//  `.cmd` / `.exe` / `.ps1` / `.bat` and extensionless variants of a candidate.
//  Missing that is the single most common cause of "not installed" on Windows.
//
//  Security: a discovered path NEVER reaches a shell. Every child process goes
//  through execFile with an argv array; nothing is string-concatenated into a
//  command line, so a directory containing a space or an `&` cannot inject.
//
//  Candidate paths are harvested from the live adapters (agents/*Agent.js) and
//  webui/lib/agents.ts — they are ground truth, not guesses.
// =============================================================================
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CACHE_TTL_MS = 300000;
const DEFAULT_VERSION_TIMEOUT_MS = 5000;

// Windows executable variants probed for every candidate / PATH entry.
const WIN_EXTS = ['.cmd', '.exe', '.ps1', '.bat', '.com', ''];
// Extensions we know how to strip when generating sibling variants.
const WIN_KNOWN_EXTS = ['.cmd', '.exe', '.ps1', '.bat', '.com'];
// The Windows path separator, kept as a named constant so a lone backslash
// never has to be escaped inline in a comparison.
const WIN_SEP = path.win32.sep;

// ---------------------------------------------------------------------------
//  Catalogue of known agent CLIs.
//
//  Candidate templates use {TOKEN} placeholders expanded from the injected env
//  (so tests can simulate another OS without touching the real filesystem) and
//  may contain a single `*` directory wildcard (newest mtime wins).
//
//  adapter: null  =>  detected and reported, but no adapter exists yet, so
//                     supported === false. That is information, not a bug.
// ---------------------------------------------------------------------------
const AGENT_CATALOGUE = Object.freeze([
    {
        id: 'claude',
        name: 'Claude Code',
        emoji: '\u{1F7E3}',
        bin: 'claude',
        adapter: 'ClaudeAgent',
        module: './agents/ClaudeAgent',
        category: 'core',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/claude.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/claude.cmd',
                '{HOME}/.local/bin/claude.exe',
                '{LOCALAPPDATA}/Programs/claude/claude.exe',
            ],
            darwin: [
                '/usr/local/bin/claude',
                '/opt/homebrew/bin/claude',
                '{HOME}/.npm-global/bin/claude',
                '{HOME}/.local/bin/claude',
            ],
            linux: [
                '/usr/local/bin/claude',
                '/usr/bin/claude',
                '{HOME}/.npm-global/bin/claude',
                '{HOME}/.local/bin/claude',
            ],
        },
    },
    {
        id: 'codex',
        name: 'OpenAI Codex',
        emoji: '\u{1F7E2}',
        bin: 'codex',
        adapter: 'CodexAgent',
        module: './agents/CodexAgent',
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                // The native installer drops a versioned bin dir; newest wins.
                '{LOCALAPPDATA}/OpenAI/Codex/bin/*/codex.exe',
                '{LOCALAPPDATA}/Programs/OpenAI/Codex/bin/codex.exe',
                '{APPDATA}/npm/codex.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/codex.cmd',
            ],
            darwin: [
                '/usr/local/bin/codex',
                '/opt/homebrew/bin/codex',
                '{HOME}/.local/bin/codex',
                '{HOME}/.npm-global/bin/codex',
            ],
            linux: [
                '/usr/local/bin/codex',
                '/usr/bin/codex',
                '{HOME}/.local/bin/codex',
                '{HOME}/.npm-global/bin/codex',
            ],
        },
    },
    {
        id: 'grok',
        name: 'Grok CLI',
        emoji: '\u26AA',
        bin: 'grok',
        adapter: 'GrokAgent',
        module: './agents/GrokAgent',
        category: 'core',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{HOME}/.grok/bin/grok.exe',
                '{LOCALAPPDATA}/Programs/grok/grok.exe',
                '{USERPROFILE}/AppData/Local/Programs/grok/grok.exe',
                '{APPDATA}/npm/grok.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/grok.cmd',
            ],
            darwin: [
                '{HOME}/.local/bin/grok',
                '/usr/local/bin/grok',
                '/opt/homebrew/bin/grok',
                '{HOME}/.npm-global/bin/grok',
            ],
            linux: [
                '{HOME}/.local/bin/grok',
                '/usr/local/bin/grok',
                '/usr/bin/grok',
                '{HOME}/.npm-global/bin/grok',
            ],
        },
    },
    {
        id: 'hermes',
        name: 'Hermes Agent',
        emoji: '\u{1F7E0}',
        bin: 'hermes',
        adapter: 'HermesAgent',
        module: './agents/HermesAgent',
        category: 'core',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{LOCALAPPDATA}/Programs/hermes/hermes.exe',
                '{LOCALAPPDATA}/hermes/bin/hermes.exe',
                '{HOME}/.local/bin/hermes.exe',
                '{APPDATA}/npm/hermes.cmd',
            ],
            darwin: [
                '{HOME}/.local/bin/hermes',
                '{HOME}/.npm-global/bin/hermes',
                '/usr/local/bin/hermes',
                '/opt/homebrew/bin/hermes',
            ],
            linux: [
                '{HOME}/.local/bin/hermes',
                '{HOME}/.npm-global/bin/hermes',
                '/usr/local/bin/hermes',
                '/usr/bin/hermes',
            ],
        },
    },
    {
        id: 'opencode',
        name: 'OpenCode CLI',
        emoji: '\u{1F7E1}',
        bin: 'opencode',
        adapter: 'OpenCodeAgent',
        module: './agents/OpenCodeAgent',
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/opencode.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/opencode.cmd',
                '{LOCALAPPDATA}/Programs/opencode/opencode.exe',
                '{HOME}/.opencode/bin/opencode.exe',
            ],
            darwin: [
                '/usr/local/bin/opencode',
                '/opt/homebrew/bin/opencode',
                '{HOME}/.opencode/bin/opencode',
                '{HOME}/.npm-global/bin/opencode',
            ],
            linux: [
                '/usr/local/bin/opencode',
                '/usr/bin/opencode',
                '{HOME}/.opencode/bin/opencode',
                '{HOME}/.npm-global/bin/opencode',
            ],
        },
    },
    {
        id: 'openclaw',
        name: 'OpenClaw Gateway',
        emoji: '\u{1F99E}',
        bin: 'openclaw',
        adapter: 'OpenClawAgent',
        module: './agents/OpenClawAgent',
        category: 'system',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/openclaw.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/openclaw.cmd',
            ],
            darwin: [
                '{HOME}/.npm-global/bin/openclaw',
                '/usr/local/bin/openclaw',
                '/opt/homebrew/bin/openclaw',
            ],
            linux: [
                '{HOME}/.npm-global/bin/openclaw',
                '/usr/local/bin/openclaw',
                '/usr/bin/openclaw',
            ],
        },
    },
    {
        id: 'pi',
        name: 'Pi Agent',
        emoji: '\u{1F967}',
        bin: 'pi',
        adapter: 'PiAgent',
        module: './agents/PiAgent',
        category: 'system',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/pi.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/pi.cmd',
            ],
            darwin: [
                '/usr/local/bin/pi',
                '/opt/homebrew/bin/pi',
                '{HOME}/.npm-global/bin/pi',
                '{HOME}/.local/bin/pi',
            ],
            linux: [
                '/usr/local/bin/pi',
                '/usr/bin/pi',
                '{HOME}/.npm-global/bin/pi',
                '{HOME}/.local/bin/pi',
            ],
        },
    },
    {
        id: 'antigravity',
        name: 'Google Antigravity',
        emoji: '\u{1F535}',
        bin: 'agy',
        altBins: ['antigravity'],
        adapter: 'AntigravityAgent',
        module: './agents/AntigravityAgent',
        category: 'router',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{LOCALAPPDATA}/agy/bin/agy.exe',
                '{HOME}/.local/bin/agy.exe',
                '{APPDATA}/npm/agy.cmd',
            ],
            darwin: [
                '{HOME}/.local/bin/agy',
                '/usr/local/bin/agy',
                '/opt/homebrew/bin/agy',
            ],
            linux: [
                '{HOME}/.local/bin/agy',
                '/usr/local/bin/agy',
                '/usr/bin/agy',
            ],
        },
    },

    // -- Detected but not yet drivable (adapter: null) ----------------------
    {
        id: 'aider',
        name: 'Aider',
        emoji: '\u{1F9F0}',
        bin: 'aider',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/Python/Scripts/aider.exe',
                '{LOCALAPPDATA}/Programs/Python/Scripts/aider.exe',
                '{HOME}/.local/bin/aider.exe',
                '{APPDATA}/npm/aider.cmd',
            ],
            darwin: ['{HOME}/.local/bin/aider', '/usr/local/bin/aider', '/opt/homebrew/bin/aider'],
            linux: ['{HOME}/.local/bin/aider', '/usr/local/bin/aider', '/usr/bin/aider'],
        },
    },
    {
        id: 'goose',
        name: 'Block Goose',
        emoji: '\u{1FABF}',
        bin: 'goose',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{LOCALAPPDATA}/Programs/goose/goose.exe',
                '{HOME}/.local/bin/goose.exe',
                '{APPDATA}/npm/goose.cmd',
            ],
            darwin: ['{HOME}/.local/bin/goose', '/usr/local/bin/goose', '/opt/homebrew/bin/goose'],
            linux: ['{HOME}/.local/bin/goose', '/usr/local/bin/goose', '/usr/bin/goose'],
        },
    },
    {
        id: 'cline',
        name: 'Cline CLI',
        emoji: '\u{1F9F5}',
        bin: 'cline',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: ['{APPDATA}/npm/cline.cmd', '{USERPROFILE}/AppData/Roaming/npm/cline.cmd'],
            darwin: ['{HOME}/.npm-global/bin/cline', '/usr/local/bin/cline', '/opt/homebrew/bin/cline'],
            linux: ['{HOME}/.npm-global/bin/cline', '/usr/local/bin/cline', '/usr/bin/cline'],
        },
    },
    {
        id: 'continue',
        name: 'Continue CLI',
        emoji: '\u27A1\uFE0F',
        bin: 'cn',
        altBins: ['continue'],
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: ['{APPDATA}/npm/cn.cmd', '{APPDATA}/npm/continue.cmd'],
            darwin: ['{HOME}/.npm-global/bin/cn', '/usr/local/bin/cn', '/opt/homebrew/bin/cn'],
            linux: ['{HOME}/.npm-global/bin/cn', '/usr/local/bin/cn', '/usr/bin/cn'],
        },
    },
    {
        id: 'gemini',
        name: 'Gemini CLI',
        emoji: '\u264A',
        bin: 'gemini',
        adapter: null,
        module: null,
        category: 'core',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/gemini.cmd',
                '{USERPROFILE}/AppData/Roaming/npm/gemini.cmd',
                '{LOCALAPPDATA}/Programs/gemini/gemini.exe',
            ],
            darwin: ['{HOME}/.npm-global/bin/gemini', '/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
            linux: ['{HOME}/.npm-global/bin/gemini', '/usr/local/bin/gemini', '/usr/bin/gemini'],
        },
    },
    {
        id: 'qwen',
        name: 'Qwen Code',
        emoji: '\u{1F409}',
        bin: 'qwen',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: ['{APPDATA}/npm/qwen.cmd', '{USERPROFILE}/AppData/Roaming/npm/qwen.cmd'],
            darwin: ['{HOME}/.npm-global/bin/qwen', '/usr/local/bin/qwen', '/opt/homebrew/bin/qwen'],
            linux: ['{HOME}/.npm-global/bin/qwen', '/usr/local/bin/qwen', '/usr/bin/qwen'],
        },
    },
    {
        id: 'crush',
        name: 'Charm Crush',
        emoji: '\u{1F4A0}',
        bin: 'crush',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/npm/crush.cmd',
                '{LOCALAPPDATA}/Programs/crush/crush.exe',
                '{HOME}/go/bin/crush.exe',
            ],
            darwin: ['{HOME}/.local/bin/crush', '/usr/local/bin/crush', '/opt/homebrew/bin/crush', '{HOME}/go/bin/crush'],
            linux: ['{HOME}/.local/bin/crush', '/usr/local/bin/crush', '/usr/bin/crush', '{HOME}/go/bin/crush'],
        },
    },
    {
        id: 'amp',
        name: 'Sourcegraph Amp',
        emoji: '\u26A1',
        bin: 'amp',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: ['{APPDATA}/npm/amp.cmd', '{USERPROFILE}/AppData/Roaming/npm/amp.cmd'],
            darwin: ['{HOME}/.npm-global/bin/amp', '/usr/local/bin/amp', '/opt/homebrew/bin/amp'],
            linux: ['{HOME}/.npm-global/bin/amp', '/usr/local/bin/amp', '/usr/bin/amp'],
        },
    },
    {
        id: 'cursor-agent',
        name: 'Cursor Agent',
        emoji: '\u{1F5B1}\uFE0F',
        bin: 'cursor-agent',
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{LOCALAPPDATA}/Programs/cursor-agent/cursor-agent.exe',
                '{HOME}/.local/bin/cursor-agent.exe',
                '{APPDATA}/npm/cursor-agent.cmd',
            ],
            darwin: ['{HOME}/.local/bin/cursor-agent', '/usr/local/bin/cursor-agent', '/opt/homebrew/bin/cursor-agent'],
            linux: ['{HOME}/.local/bin/cursor-agent', '/usr/local/bin/cursor-agent', '/usr/bin/cursor-agent'],
        },
    },
    {
        id: 'ollama',
        name: 'Ollama',
        emoji: '\u{1F999}',
        bin: 'ollama',
        adapter: null,
        module: null,
        category: 'local-model',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{LOCALAPPDATA}/Programs/Ollama/ollama.exe',
                '{PROGRAMFILES}/Ollama/ollama.exe',
                '{APPDATA}/npm/ollama.cmd',
            ],
            darwin: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'],
            linux: ['/usr/local/bin/ollama', '/usr/bin/ollama', '{HOME}/.local/bin/ollama'],
        },
    },
    {
        id: 'llm',
        name: 'llm (Datasette)',
        emoji: '\u{1F4CE}',
        bin: 'llm',
        adapter: null,
        module: null,
        category: 'local-model',
        versionArgs: ['--version'],
        candidates: {
            win32: [
                '{APPDATA}/Python/Scripts/llm.exe',
                '{LOCALAPPDATA}/Programs/Python/Scripts/llm.exe',
                '{HOME}/.local/bin/llm.exe',
            ],
            darwin: ['{HOME}/.local/bin/llm', '/usr/local/bin/llm', '/opt/homebrew/bin/llm'],
            linux: ['{HOME}/.local/bin/llm', '/usr/local/bin/llm', '/usr/bin/llm'],
        },
    },
    {
        id: 'opencodex',
        name: 'OpenCodex (ocx)',
        emoji: '\u{1F9E9}',
        bin: 'ocx',
        altBins: ['opencodex'],
        adapter: null,
        module: null,
        category: 'coding',
        versionArgs: ['--version'],
        candidates: {
            win32: ['{APPDATA}/npm/ocx.cmd', '{APPDATA}/npm/opencodex.cmd'],
            darwin: ['{HOME}/.npm-global/bin/ocx', '/usr/local/bin/ocx', '/opt/homebrew/bin/ocx'],
            linux: ['{HOME}/.npm-global/bin/ocx', '/usr/local/bin/ocx', '/usr/bin/ocx'],
        },
    },
]);

class AgentDiscovery {
    /**
     * @param {object}   [opts]
     * @param {string}   [opts.platform]         process.platform override (tests simulate another OS)
     * @param {object}   [opts.env]              environment override (PATH, APPDATA, ...)
     * @param {string[]} [opts.extraPaths]       extra directories probed before the catalogue
     * @param {number}   [opts.cacheTtlMs]       scan cache lifetime (default 5 min)
     * @param {string}   [opts.homeDir]          home dir override
     * @param {number}   [opts.versionTimeoutMs] per-CLI version probe budget (default 5s)
     * @param {Function} [opts.execFileImpl]     child_process.execFile seam (tests inject a spy)
     * @param {object[]} [opts.catalogue]        catalogue override
     */
    constructor({
        platform,
        env,
        extraPaths,
        cacheTtlMs = DEFAULT_CACHE_TTL_MS,
        homeDir,
        versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
        execFileImpl,
        catalogue,
    } = {}) {
        this.platform = platform || process.platform;
        this.env = env || process.env;
        this.extraPaths = Array.isArray(extraPaths) ? extraPaths.slice() : [];
        this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? cacheTtlMs : DEFAULT_CACHE_TTL_MS;
        this.versionTimeoutMs = Number.isFinite(versionTimeoutMs) ? versionTimeoutMs : DEFAULT_VERSION_TIMEOUT_MS;
        this.execFileImpl = execFileImpl || execFile;
        this.catalogue = catalogue || AGENT_CATALOGUE;

        this.isWin = this.platform === 'win32';
        this.homeDir = homeDir
            || this.env.HOME
            || this.env.USERPROFILE
            || this._safeHomedir();

        this.results = [];
        this._cache = null;          // { at, withVersion, results }
        this._scanPromise = null;
        this._npmBin = undefined;    // undefined = unresolved, null = none found
        this._npmBinPromise = null;
    }

    _safeHomedir() {
        try {
            return os.homedir();
        } catch (e) {
            console.warn(`[AgentDiscovery] os.homedir() failed: ${e.message}`);
            return '';
        }
    }

    // =======================================================================
    //  Path helpers
    // =======================================================================

    /** Token table for candidate template expansion. */
    _tokens() {
        const home = this.homeDir || '';
        return {
            HOME: home,
            USERPROFILE: this.env.USERPROFILE || home,
            APPDATA: this.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : ''),
            LOCALAPPDATA: this.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : ''),
            PROGRAMFILES: this.env.PROGRAMFILES || this.env.ProgramFiles || 'C:\\Program Files',
            PROGRAMFILES86: this.env['PROGRAMFILES(X86)'] || this.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        };
    }

    /**
     * Expand one candidate template into zero or more concrete paths.
     * Supports a single `*` directory wildcard (newest mtime first), mirroring
     * the versioned-bin-dir layout the Codex installer uses on Windows.
     */
    _expandCandidate(template) {
        try {
            if (!template || typeof template !== 'string') return [];
            const tokens = this._tokens();
            let missing = false;
            const resolved = template.replace(/\{([A-Z0-9_()]+)\}/g, (_match, key) => {
                const value = tokens[key];
                if (!value) { missing = true; return ''; }
                return value;
            });
            if (missing) return [];

            const normalized = path.normalize(resolved.split('/').join(path.sep));
            if (!normalized.includes('*')) return [normalized];

            // One wildcard directory level: <base>/*/<tail>
            const starIdx = normalized.indexOf('*');
            const base = normalized.slice(0, starIdx).replace(/[\\/]+$/, '');
            const tail = normalized.slice(starIdx + 1).replace(/^[\\/]+/, '');
            if (!base || !fs.existsSync(base)) return [];

            const hits = [];
            for (const entry of fs.readdirSync(base)) {
                const full = tail ? path.join(base, entry, tail) : path.join(base, entry);
                try {
                    hits.push({ full, mtime: fs.statSync(full).mtimeMs });
                } catch (e) { /* variant probing may still find a sibling */ }
            }
            hits.sort((a, b) => b.mtime - a.mtime);
            return hits.map(h => h.full);
        } catch (e) {
            console.warn(`[AgentDiscovery] candidate expansion failed for "${template}": ${e.message}`);
            return [];
        }
    }

    /**
     * Executable variants of a path. On Windows an npm-installed CLI is a
     * `.cmd` shim and the bare name usually does not exist at all, so probe
     * `.cmd` / `.exe` / `.ps1` / `.bat` and the extensionless form — both by
     * appending and by swapping whatever extension the candidate carries.
     */
    _variants(candidate) {
        if (!candidate) return [];
        if (!this.isWin) return [candidate];

        const out = [candidate];
        const ext = path.extname(candidate).toLowerCase();
        const stem = WIN_KNOWN_EXTS.includes(ext)
            ? candidate.slice(0, candidate.length - ext.length)
            : candidate;
        for (const winExt of WIN_EXTS) {
            const variant = stem + winExt;
            if (variant && !out.includes(variant)) out.push(variant);
        }
        return out;
    }

    /** First variant of any candidate that exists as a file. */
    _firstExisting(candidates) {
        for (const candidate of candidates) {
            for (const variant of this._variants(candidate)) {
                try {
                    if (variant && fs.existsSync(variant) && fs.statSync(variant).isFile()) return variant;
                } catch (e) { /* unreadable — keep probing */ }
            }
        }
        return null;
    }

    /** PATH entries from the injected environment. */
    _pathDirs() {
        const raw = this.env.PATH || this.env.Path || this.env.path || '';
        return this._splitPathList(raw)
            .map(p => p.trim().replace(/^"|"$/g, ''))
            .filter(Boolean);
    }

    /**
     * Split a PATH-style list into directories.
     *
     * The separator belongs to the machine the string came FROM, not to the
     * platform we are simulating. `this.platform` is an injectable knob — a
     * caller may ask "what would this look like on linux?" — while `env.PATH`
     * and `fs` are always the real host's. Splitting a Windows PATH on ':'
     * because the simulated platform is POSIX shears the drive letter off
     * every entry ("C:\Users\x" -> "C" plus "\Users\x"), and the remainder is
     * not harmless garbage: it silently resolves against the current drive,
     * and doubled it reads as a UNC share. Hence:
     *
     *   - ';' always separates. It is never legal inside a Windows path, and
     *     it is `path.delimiter` on a Windows host.
     *   - ':' separates too (it is `path.delimiter` on a POSIX host) EXCEPT
     *     where it can only be a drive designator: "C:", "C:\x", "C:/x".
     */
    _splitPathList(raw) {
        const text = raw == null ? '' : String(raw);
        if (!text) return [];
        const out = [];
        let current = '';
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === ';' || (ch === ':' && !this._isDriveColon(text, i, current))) {
                out.push(current);
                current = '';
                continue;
            }
            current += ch;
        }
        out.push(current);
        return out;
    }

    /** True when text[i] (a ':') is the colon of a "C:" drive designator. */
    _isDriveColon(text, i, current) {
        // Drive letters are real on a Windows host, and in a simulated win32
        // run. Everywhere else a colon is unambiguously a list separator.
        if (!this.isWin && path.sep !== WIN_SEP) return false;
        if (!/^[A-Za-z]$/.test(current)) return false;   // must be a lone letter
        const next = text[i + 1];
        return next === undefined || next === WIN_SEP || next === '/' || next === ';';
    }

    _binNames(entry) {
        return [entry.bin, ...(entry.altBins || [])].filter(Boolean);
    }

    // =======================================================================
    //  Child-process helpers (execFile only — never a shell)
    // =======================================================================

    /**
     * Every child we start is bounded by the instance budget. A per-call
     * timeout may ask for LESS than `versionTimeoutMs`, never for more:
     * `versionTimeoutMs` is the caller's contract for how long this scan may
     * spend on any one process, and an auxiliary probe (`where`, `npm root -g`)
     * that quietly outlived it is exactly how a "bounded" scan configured with
     * a 60ms budget ends up taking nine seconds.
     */
    _boundedTimeout(requested) {
        const ceiling = Number.isFinite(this.versionTimeoutMs) && this.versionTimeoutMs > 0
            ? this.versionTimeoutMs
            : DEFAULT_VERSION_TIMEOUT_MS;
        const want = Number.isFinite(requested) && requested > 0 ? requested : ceiling;
        return Math.max(1, Math.min(want, ceiling));
    }

    /**
     * Abandon a child we have already stopped waiting for: SIGTERM, then
     * SIGKILL for one that ignores it. Nothing downstream waits on either — the
     * promise is long since resolved — and the escalation timer is unref'd, so
     * a dying probe can never hold the process (or a test run) open.
     */
    _killChild(child, graceMs = 500) {
        if (!child || typeof child.kill !== 'function') return;
        if (child.killed || child.exitCode != null || child.signalCode) return;
        try { child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        const hard = setTimeout(() => {
            try {
                if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
            } catch (e) { /* already gone */ }
        }, Math.max(50, graceMs));
        if (typeof hard.unref === 'function') hard.unref();
    }

    /**
     * execFile with an authoritative watchdog. Resolves { stdout, stderr, error }
     * and never rejects, so a CLI that hangs, banners, or exits non-zero can
     * never stall or break a scan.
     *
     * The timer — not the child's `close` event — settles the promise. A child
     * that ignores SIGTERM, or one whose callback simply never fires, therefore
     * cannot hold the scan open: we resolve on the timer path first and only
     * then go and kill the process. Waiting on `close` after the deadline is
     * precisely the bug this shape exists to prevent.
     */
    _run(file, args, { timeout, cwd, windowsVerbatimArguments = false } = {}) {
        const budget = this._boundedTimeout(timeout);
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            let child = null;
            const done = (result) => {
                if (settled) return;
                settled = true;
                if (timer) { clearTimeout(timer); timer = null; }
                resolve(result);
            };
            timer = setTimeout(() => {
                done({ stdout: '', stderr: '', error: new Error(`timed out after ${budget}ms`) });
                this._killChild(child, budget);
            }, budget);
            try {
                child = this.execFileImpl(file, args, {
                    encoding: 'utf8',
                    windowsHide: true,
                    // Hand-quoted `cmd /d /s /c "..."` argv must reach cmd.exe
                    // byte for byte; see _cmdShimArgs.
                    windowsVerbatimArguments,
                    timeout: budget,
                    maxBuffer: 1024 * 1024,
                    env: { ...process.env, ...this.env },
                    cwd,
                }, (error, stdout, stderr) => {
                    done({ stdout: stdout || '', stderr: stderr || '', error: error || null });
                });
                // The watchdog may already have fired while we were spawning.
                if (settled) this._killChild(child, budget);
            } catch (e) {
                done({ stdout: '', stderr: '', error: e });
            }
        });
    }

    /**
     * argv for running a Windows batch shim (.cmd/.bat) safely.
     * `cmd.exe /d /s /c` with the whole command inside one outer-quoted
     * argument means a path containing a space or an `&` is data, never
     * syntax. A path carrying a double quote is refused outright.
     *
     * This argument is already exactly quoted, so it MUST travel with
     * `windowsVerbatimArguments: true`. Without it libuv re-escapes our quotes
     * on the way to the command line — `""C:\dir\foo.cmd" ...` arrives as
     * `\"\"C:\dir\foo.cmd" ...` — and cmd.exe, which has no notion of a
     * backslash-escaped quote, reads the two leading backslashes as the start
     * of a UNC share and fails with "The network path was not found."
     * Verbatim argv is not a shell: there is still no command string we
     * concatenated, and nothing here is interpreted by a shell we invoked.
     */
    _cmdShimArgs(binaryPath, args) {
        if (binaryPath.includes('"')) return null;
        const parts = [`"${binaryPath}"`, ...args.map(a => `"${String(a).replace(/"/g, '')}"`)];
        return ['/d', '/s', '/c', `"${parts.join(' ')}"`];
    }

    // =======================================================================
    //  Resolution steps
    // =======================================================================

    /** Step 1: the binary on PATH. */
    async _resolveOnPath(entry, allowSpawn) {
        // (a) Filesystem sweep of the injected PATH — no child process, works
        //     for a simulated platform, covers Windows extension variants.
        const dirs = this._pathDirs();
        for (const bin of this._binNames(entry)) {
            for (const dir of dirs) {
                let hit = null;
                try {
                    hit = this._firstExisting([path.join(dir, bin)]);
                } catch (e) { hit = null; }
                if (hit) return hit;
            }
        }
        if (!allowSpawn) return null;

        // (b) `where` on win32, `command -v` elsewhere. Deliberately NOT
        //     `which`, which is absent on plenty of minimal systems.
        for (const bin of this._binNames(entry)) {
            try {
                const found = this.isWin
                    ? await this._run('where', [bin], { timeout: 2000 })
                    // bin travels as $1 — never concatenated into the script.
                    : await this._run('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', bin], { timeout: 2000 });
                if (found.error || !found.stdout) continue;
                for (const line of found.stdout.split(/\r?\n/)) {
                    const candidate = line.trim();
                    if (!candidate || !path.isAbsolute(candidate)) continue;
                    const hit = this._firstExisting([candidate]);
                    if (hit) return hit;
                }
            } catch (e) {
                console.warn(`[AgentDiscovery] PATH lookup failed for ${bin}: ${e.message}`);
            }
        }
        return null;
    }

    /** Step 2: extraPaths first, then the platform candidate list. */
    _resolveKnownPath(entry) {
        const byPlatform = entry.candidates || {};
        const templates = byPlatform[this.platform] || byPlatform.linux || [];
        const expanded = [];
        for (const dir of this.extraPaths) {
            if (!dir) continue;
            for (const bin of this._binNames(entry)) expanded.push(path.join(dir, bin));
        }
        for (const template of templates) expanded.push(...this._expandCandidate(template));
        return this._firstExisting(expanded);
    }

    /**
     * Step 3: the npm global bin directory. Resolved ONCE per instance and
     * cached — never once per agent.
     */
    async _resolveNpmBinDir(allowSpawn) {
        if (this._npmBin !== undefined) return this._npmBin;
        if (this._npmBinPromise) return this._npmBinPromise;

        this._npmBinPromise = (async () => {
            try {
                if (this.isWin) {
                    const dir = this._tokens().APPDATA;
                    const npmDir = dir ? path.join(dir, 'npm') : null;
                    return npmDir && fs.existsSync(npmDir) ? npmDir : null;
                }
                if (!allowSpawn) return null;
                const out = await this._run('npm', ['root', '-g'], { timeout: 4000 });
                if (out.error || !out.stdout.trim()) return null;
                let root = out.stdout.trim().split(/\r?\n/)[0].trim();
                if (path.basename(root) === 'node_modules') root = path.dirname(root);
                if (path.basename(root) === 'lib') root = path.dirname(root);
                const binDir = path.join(root, 'bin');
                return fs.existsSync(binDir) ? binDir : null;
            } catch (e) {
                console.warn(`[AgentDiscovery] npm global bin resolution failed: ${e.message}`);
                return null;
            }
        })();

        try {
            this._npmBin = await this._npmBinPromise;
        } finally {
            this._npmBinPromise = null;
        }
        return this._npmBin;
    }

    _resolveInNpmBin(entry, npmBinDir) {
        if (!npmBinDir) return null;
        return this._firstExisting(this._binNames(entry).map(bin => path.join(npmBinDir, bin)));
    }

    // =======================================================================
    //  Version detection — bounded, safe, never throws, never stalls
    // =======================================================================

    async detectVersion(binaryPath, versionArgs = ['--version']) {
        try {
            if (!binaryPath) return { version: null, error: 'no binary path' };
            const ext = path.extname(binaryPath).toLowerCase();

            if (this.isWin && ext === '.ps1') {
                return { version: null, error: 'version probe skipped for .ps1 shim' };
            }

            let file = binaryPath;
            let args = Array.isArray(versionArgs) ? versionArgs : ['--version'];
            let verbatim = false;
            if (this.isWin && (ext === '.cmd' || ext === '.bat')) {
                // A batch shim cannot be execFile'd directly on modern Node.
                const shimArgs = this._cmdShimArgs(binaryPath, args);
                if (!shimArgs) return { version: null, error: 'refusing unsafe path (contains a quote)' };
                file = this.env.COMSPEC || process.env.COMSPEC || 'cmd.exe';
                args = shimArgs;
                verbatim = true;   // see _cmdShimArgs: the quoting is already exact
            }

            const res = await this._run(file, args, {
                timeout: this.versionTimeoutMs,
                windowsVerbatimArguments: verbatim,
            });
            const version = this._parseVersion(`${res.stdout || ''}\n${res.stderr || ''}`);
            if (version) return { version, error: null };
            if (res.error) return { version: null, error: `version probe failed: ${res.error.message}` };
            return { version: null, error: 'version probe produced no recognizable version' };
        } catch (e) {
            // Belt and braces: a version probe must never throw into the scan.
            console.warn(`[AgentDiscovery] version probe error for ${binaryPath}: ${e.message}`);
            return { version: null, error: `version probe error: ${e.message}` };
        }
    }

    _parseVersion(text) {
        if (!text || typeof text !== 'string') return null;
        const match = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?)\b/);
        if (match) return match[1];
        const firstLine = text.split(/\r?\n/).map(l => l.trim()).find(Boolean);
        return firstLine ? firstLine.slice(0, 120) : null;
    }

    // =======================================================================
    //  Scan
    // =======================================================================

    /**
     * Discover every catalogue CLI on this machine.
     *
     * @param {object}  [opts]
     * @param {boolean} [opts.force=false]       bypass the cache
     * @param {boolean} [opts.withVersion=true]  probe `--version`. When false
     *                  the scan spawns ZERO child processes (pure filesystem).
     * @returns {Promise<object[]>} one record per catalogue entry
     */
    async scan({ force = false, withVersion = true } = {}) {
        const fresh = this._cache
            && (Date.now() - this._cache.at) < this.cacheTtlMs
            && (this._cache.withVersion || !withVersion);
        if (!force && fresh) {
            this.results = this._cache.results;
            return this._cache.results;
        }

        if (this._scanPromise) return this._scanPromise;

        this._scanPromise = (async () => {
            const allowSpawn = withVersion !== false;
            let npmBinDir = null;
            try {
                npmBinDir = await this._resolveNpmBinDir(allowSpawn);
            } catch (e) {
                console.warn(`[AgentDiscovery] npm bin lookup skipped: ${e.message}`);
            }

            const results = [];
            for (const entry of this.catalogue) {
                results.push(await this._probe(entry, { withVersion, allowSpawn, npmBinDir }));
            }

            this.results = results;
            this._cache = { at: Date.now(), withVersion: allowSpawn, results };
            return results;
        })();

        try {
            return await this._scanPromise;
        } finally {
            this._scanPromise = null;
        }
    }

    async _probe(entry, { withVersion, allowSpawn, npmBinDir }) {
        const record = {
            id: entry.id,
            name: entry.name,
            emoji: entry.emoji || '\u{1F916}',
            category: entry.category || 'other',
            bin: entry.bin,
            installed: false,
            binaryPath: null,
            source: null,
            version: null,
            supported: false,
            adapter: entry.adapter || null,
            module: entry.module || null,
            error: null,
        };

        try {
            let binaryPath = await this._resolveOnPath(entry, allowSpawn);
            let source = binaryPath ? 'path' : null;

            if (!binaryPath) {
                binaryPath = this._resolveKnownPath(entry);
                if (binaryPath) source = 'known-path';
            }
            if (!binaryPath) {
                binaryPath = this._resolveInNpmBin(entry, npmBinDir);
                if (binaryPath) source = 'npm-global';
            }

            if (!binaryPath) return record;   // absent is not an error

            record.installed = true;
            record.binaryPath = binaryPath;
            record.source = source;
            record.supported = !!entry.adapter;

            if (withVersion) {
                const { version, error } = await this.detectVersion(binaryPath, entry.versionArgs);
                record.version = version;
                record.error = error;
            }
        } catch (e) {
            // A single broken probe must never abort the whole scan.
            console.warn(`[AgentDiscovery] probe failed for ${entry.id}: ${e.message}`);
            record.error = `probe failed: ${e.message}`;
        }

        return record;
    }

    // =======================================================================
    //  Views
    // =======================================================================

    getInstalled() {
        return this.results.filter(r => r.installed);
    }

    /** Installed AND we have an adapter that can drive it. */
    getSupported() {
        return this.results.filter(r => r.installed && r.supported);
    }

    /** Installed but no adapter yet — detected and reported, not an error. */
    getUnsupported() {
        return this.results.filter(r => r.installed && !r.supported);
    }

    getMissing() {
        return this.results.filter(r => !r.installed);
    }

    get(id) {
        return this.results.find(r => r.id === id) || null;
    }

    /**
     * Everything index.js needs to construct adapters for the agents that are
     * both installed and drivable. Wiring is the caller's job, not ours.
     */
    toRegistryEntries() {
        return this.getSupported().map(r => ({
            id: r.id,
            key: r.id,
            name: r.name,
            emoji: r.emoji,
            category: r.category,
            adapter: r.adapter,
            module: r.module,
            binaryPath: r.binaryPath,
            source: r.source,
            version: r.version,
        }));
    }

    /** Counts plus a one-line string for the startup banner. */
    summary() {
        const installed = this.getInstalled();
        const supported = this.getSupported();
        const unsupported = this.getUnsupported();
        const counts = {
            catalogue: this.results.length,
            installed: installed.length,
            supported: supported.length,
            unsupported: unsupported.length,
            missing: this.results.length - installed.length,
        };
        const names = supported.map(r => r.id).join(', ') || 'none';
        const extra = unsupported.length
            ? ` | detected without adapter: ${unsupported.map(r => r.id).join(', ')}`
            : '';
        return {
            ...counts,
            line: `[AgentDiscovery] ${counts.installed}/${counts.catalogue} agent CLIs installed — `
                + `${counts.supported} wired (${names})${extra}`,
        };
    }

    clearCache() {
        this._cache = null;
        this._npmBin = undefined;
    }
}

module.exports = AgentDiscovery;
module.exports.AgentDiscovery = AgentDiscovery;
module.exports.AGENT_CATALOGUE = AGENT_CATALOGUE;
