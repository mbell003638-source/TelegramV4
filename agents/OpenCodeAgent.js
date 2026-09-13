const AcpAgentBase = require('../core/AcpAgentBase');
const config = require('../core/config');
const { runCli } = require('../core/ModelCapabilities');

class OpenCodeAgent extends AcpAgentBase {
    constructor(sessionStore) {
        // opencode uses the 'acp' subcommand natively
        super('opencode', 'OpenCode CLI', '🔓', 'opencode', ['acp']);
        this.sessionStore = sessionStore;
        this.modelControl = { discovery: 'live', effort: false };
        this.discoveredModels = null;
        this.modelDiscoveryPromise = null;
    }

    async onInitialize() {
        this.discoverModels().catch(() => {});
    }

    async discoverModels({ force = false } = {}) {
        if (!force && this.discoveredModels) return this.discoveredModels;
        if (this.modelDiscoveryPromise) return this.modelDiscoveryPromise;
        this.modelDiscoveryPromise = (async () => {
          try {
            const output = await runCli(this.resolveBin(), ['models'], {
                timeout: Math.max(config.modelDiscoveryTimeoutMs, 30000),
            });
            const models = parseModelList(output);
            if (models.length > 1) {
                this.sessionStore.setAvailableModels('opencode', models);
                this.discoveredModels = models;
            }
            return models;
          } catch (e) {
            console.warn(`[OpenCodeAgent] Model discovery failed: ${e.message}`);
            return null;
          } finally {
            this.modelDiscoveryPromise = null;
          }
        })();
        return this.modelDiscoveryPromise;
    }
}

function parseModelList(output) {
    const list = [{ id: 'default', name: 'Default Model' }];
    if (!output || typeof output !== 'string') return list;
    output.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && trimmed.includes('/') && !trimmed.startsWith('Usage') && !trimmed.startsWith('Commands')) {
            list.push({ id: trimmed, name: trimmed });
        }
    });
    return list;
}

module.exports = OpenCodeAgent;
module.exports.parseModelList = parseModelList;
