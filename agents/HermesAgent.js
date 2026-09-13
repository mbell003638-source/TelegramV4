// =============================================================================
//  agents/HermesAgent.js — Hermes CLI Agent (hermes -z)
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EFFORT_LEVELS, withEffortCapabilities, activeEffort } = require('../core/ModelCapabilities');

class HermesAgent extends BaseAgent {
    constructor(sessionStore) {
        super('hermes', 'Hermes', '🪽');
        this.sessionStore = sessionStore;
        this.hermesPath = null;
        this.process = null;
        this.modelControl = { discovery: 'configured', effort: true, flag: '--reasoning' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'hermes', 'hermes.exe'),
            path.join(homeDir, '.local', 'bin', 'hermes.exe'),
            path.join(process.env.APPDATA || '', 'npm', 'hermes.cmd')
        ] : [
            path.join(homeDir, '.local', 'bin', 'hermes'),
            path.join(homeDir, '.npm-global', 'bin', 'hermes'),
            '/usr/local/bin/hermes',
            '/usr/bin/hermes'
        ];

        for (const c of candidates) {
            if (c && fs.existsSync(c)) {
                this.hermesPath = c;
                break;
            }
        }

        if (!this.hermesPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} hermes`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.hermesPath = found;
            } catch {}
        }

        if (this.hermesPath) {
            console.log(`[HermesAgent] Located hermes CLI at: ${this.hermesPath}`);
            await this.discoverModels();
        } else {
            this.hermesPath = 'hermes';
        }
    }

    async onStart() {}

    async discoverModels() {
        try {
            const configFile = path.join(os.homedir(), '.hermes', 'config.yaml');
            const models = parseHermesConfiguredModels(fs.readFileSync(configFile, 'utf8'));
            if (models.length > 1) this.sessionStore.setAvailableModels('hermes', models);
            return models;
        } catch (e) {
            console.warn(`[HermesAgent] Configured model discovery failed: ${e.message}`);
            return null;
        }
    }

    async onStop() {
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch {}
            this.process = null;
        }
    }

    clearSession(chatId) {
        if (chatId) {
            this.sessionStore.clearSession('hermes', chatId);
        }
    }

    async sendMessage(unifiedMessage) {
        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const sessionId = this.sessionStore.getSession('hermes', chatId);
        const model = this.sessionStore.getActiveModel('hermes', chatId);
        const effort = activeEffort(this.sessionStore, 'hermes', model, this.sessionStore.getAvailableModels('hermes'), chatId);

        this.emitStatus('⏳ Thinking...');

        const args = ['-z', prompt, '--yolo'];
        if (sessionId) {
            args.push('--resume', sessionId);
        } else {
            args.push('--continue');
        }
        if (model && model !== 'default' && model !== 'auto') {
            args.push('-m', model);
        }
        if (effort) args.push('--reasoning', effort);

        const workspaceRoot = this.sessionStore.getWorkspaceCwd('hermes', chatId);
        const env = {
            ...process.env,
            PATH: (os.homedir() + '/.local/bin:' + os.homedir() + '/.npm-global/bin:' + (process.env.PATH || ''))
        };

        return new Promise((resolve) => {
            this.process = spawn(this.hermesPath, args, { cwd: workspaceRoot, env });

            let fullResponse = '';
            let buffer = '';

            this.process.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                buffer += text;

                // Clean out terminal control sequences and borders
                const clean = buffer
                    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
                    .replace(/(?:\x1b|\u001b)?\][0-9]+;[^\x07\x1b]+(?:\x07|\x1b\\|\b)?/g, '')
                    .replace(/[\u2500-\u25FF]/g, '')
                    .trim();

                if (clean && clean !== fullResponse) {
                    fullResponse = clean;
                    this.emitText(fullResponse);
                }
            });

            this.process.stderr.on('data', (chunk) => {
                const errStr = chunk.toString().trim();
                if (errStr && !errStr.includes('ExperimentalWarning')) {
                    console.error(`[HermesAgent STDERR] ${errStr}`);
                }
            });

            this.process.on('close', () => {
                this.process = null;
                this.emitFinished(fullResponse.trim());
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[HermesAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

function parseHermesConfiguredModels(content) {
    const pairs = [];
    let section = '';
    let provider = '';
    let model = '';
    const add = () => {
        if (!model) return;
        const id = provider ? `${provider}/${model}` : model;
        if (!pairs.some(item => item.id === id)) pairs.push({ id, name: id });
        model = '';
    };
    for (const line of String(content || '').split('\n')) {
        if (/^model:\s*$/.test(line)) { add(); section = 'model'; provider = ''; continue; }
        if (/^fallback_providers:\s*$/.test(line)) { add(); section = 'fallback'; provider = ''; continue; }
        if (/^[^\s#]/.test(line)) { add(); section = ''; provider = ''; continue; }
        if (section === 'model') {
            const providerMatch = line.match(/^\s{2}provider:\s*(.+?)\s*$/);
            const modelMatch = line.match(/^\s{2}default:\s*(.+?)\s*$/);
            if (providerMatch) provider = providerMatch[1];
            if (modelMatch) model = modelMatch[1];
        } else if (section === 'fallback') {
            const providerMatch = line.match(/^\s*-\s*provider:\s*(.+?)\s*$/);
            const modelMatch = line.match(/^\s+model:\s*(.+?)\s*$/);
            if (providerMatch) { add(); provider = providerMatch[1]; }
            if (modelMatch) { model = modelMatch[1]; add(); }
        }
    }
    add();
    return [
        withEffortCapabilities({ id: 'default', name: 'Default Model' }, EFFORT_LEVELS.hermes),
        ...pairs.map(item => withEffortCapabilities(item, EFFORT_LEVELS.hermes)),
    ];
}

module.exports = HermesAgent;
module.exports.parseHermesConfiguredModels = parseHermesConfiguredModels;
