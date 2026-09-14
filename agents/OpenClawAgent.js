// =============================================================================
//  agents/OpenClawAgent.js — OpenClaw CLI Agent (openclaw agent)
// =============================================================================
const { spawn, execSync } = require('child_process');
const BaseAgent = require('../core/BaseAgent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EFFORT_LEVELS, withEffortCapabilities, activeEffort, runCli } = require('../core/ModelCapabilities');

class OpenClawAgent extends BaseAgent {
    constructor(sessionStore) {
        super('openclaw', 'OpenClaw', '🦞');
        this.sessionStore = sessionStore;
        this.openclawPath = null;
        this.process = null;
        this.discoveredModels = null;
        this.lastModelDiscoveryAt = 0;
        this.modelDiscoveryPromise = null;
        this.modelControl = { discovery: 'live', effort: true, flag: '--thinking' };
    }

    async onInitialize() {
        const isWin = process.platform === 'win32';
        const homeDir = os.homedir();

        const candidates = isWin ? [
            path.join(process.env.APPDATA || '', 'npm', 'openclaw.cmd'),
            path.join(homeDir, 'AppData', 'Roaming', 'npm', 'openclaw.cmd')
        ] : [
            path.join(homeDir, '.npm-global', 'bin', 'openclaw'),
            '/usr/local/bin/openclaw',
            '/usr/bin/openclaw'
        ];

        for (const c of candidates) {
            if (c && fs.existsSync(c)) {
                this.openclawPath = c;
                break;
            }
        }

        if (!this.openclawPath) {
            try {
                const whereCmd = isWin ? 'where' : 'which';
                const found = execSync(`${whereCmd} openclaw`, { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim();
                if (fs.existsSync(found)) this.openclawPath = found;
            } catch {}
        }

        if (this.openclawPath) {
            console.log(`[OpenClawAgent] Located openclaw CLI at: ${this.openclawPath}`);
            this.discoverModels().catch(() => {});
        } else {
            this.openclawPath = 'openclaw';
        }
    }

    async onStart() {}

    async discoverModels({ force = false } = {}) {
        if (!this.openclawPath) return null;
        if (!force && this.discoveredModels) return this.discoveredModels;
        if (this.modelDiscoveryPromise) return this.modelDiscoveryPromise;
        this.modelDiscoveryPromise = (async () => {
          try {
            if (force) {
                try {
                    await runCli(this.openclawPath, ['models', 'refresh'], { timeout: 30000 });
                } catch (e) {
                    console.warn(`[OpenClawAgent] Catalog refresh failed; listing cached catalog: ${e.message}`);
                }
            }
            const output = await runCli(this.openclawPath, ['models', 'list', '--json'], {
                timeout: 30000, maxBuffer: 20 * 1024 * 1024,
            });
            const data = JSON.parse(output);
            const models = [withEffortCapabilities({ id: 'default', name: 'Default Model' }, EFFORT_LEVELS.openclaw)];
            for (const item of data.models || []) {
                if (!item.key || item.missing || item.available === false || !String(item.input || '').includes('text')) continue;
                models.push(withEffortCapabilities({ id: item.key, name: item.name || item.key }, EFFORT_LEVELS.openclaw));
            }
            if (models.length > 1) {
                this.sessionStore.setAvailableModels('openclaw', models);
                this.discoveredModels = models;
                this.lastModelDiscoveryAt = Date.now();
            }
            return models;
          } catch (e) {
            console.warn(`[OpenClawAgent] Model discovery failed: ${e.message}`);
            return null;
          } finally {
            this.modelDiscoveryPromise = null;
          }
        })();
        return this.modelDiscoveryPromise;
    }

    async onStop() {
        if (this.process) {
            try { this.process.kill('SIGTERM'); } catch {}
            this.process = null;
        }
    }

    async sendMessage(unifiedMessage) {
        const prompt = unifiedMessage.content.text;
        const chatId = unifiedMessage.chatId;
        const model = this.sessionStore.getActiveModel('openclaw', chatId);
        const effort = activeEffort(this.sessionStore, 'openclaw', model, this.sessionStore.getAvailableModels('openclaw'), chatId);

        this.emitStatus('⏳ Thinking...');

        const args = ['agent', '--agent', 'main', '--message', prompt];
        if (model && model !== 'default' && model !== 'auto') {
            args.push('--model', model);
        }
        if (effort) args.push('--thinking', effort);

        const workspaceRoot = this.sessionStore.getWorkspaceCwd('openclaw', chatId);
        const env = this.getSpawnEnv({ PATH: (os.homedir() + '/.npm-global/bin:' + (process.env.PATH || '')) });

        return new Promise((resolve) => {
            this.process = spawn(this.openclawPath, args, { cwd: workspaceRoot, env });

            let fullResponse = '';
            let buffer = '';

            this.process.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                buffer += text;

                // Clean out plugin warning logs
                const clean = buffer
                    .replace(/\[plugins\][^\n]*\n?/g, '')
                    .replace(/Error: No target session selected[^\n]*\n?/g, '')
                    .trim();

                if (clean && clean !== fullResponse) {
                    fullResponse = clean;
                    this.emitText(fullResponse);
                }
            });

            this.process.stderr.on('data', (chunk) => {
                const errStr = chunk.toString().trim();
                if (errStr && !errStr.includes('ExperimentalWarning') && !errStr.includes('[plugins]')) {
                    console.error(`[OpenClawAgent STDERR] ${errStr}`);
                }
            });

            this.process.on('close', () => {
                this.process = null;
                this.emitFinished(fullResponse.trim());
                resolve();
            });

            this.process.on('error', (err) => {
                console.error(`[OpenClawAgent Error] ${err.message}`);
                this.emitError(err);
                this.process = null;
                resolve();
            });
        });
    }
}

module.exports = OpenClawAgent;
