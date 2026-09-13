// Shared model/effort capability contract used by every agent adapter.
const { execFile } = require('child_process');
const EFFORT_LEVELS = Object.freeze({
    antigravity: Object.freeze(['low', 'medium', 'high']),
    claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    codex: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    grok: Object.freeze(['low', 'medium', 'high']),
    hermes: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    openclaw: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max', 'ultra']),
    pi: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
});

function withEffortCapabilities(model, levels, options = {}) {
    const reasoningEfforts = [...new Set((levels || []).filter(Boolean))];
    if (!reasoningEfforts.length) return { ...model };
    return {
        ...model,
        reasoningEfforts,
        ...(options.defaultReasoningEffort ? { defaultReasoningEffort: options.defaultReasoningEffort } : {}),
        ...(options.autoReasoningEffort ? { autoReasoningEffort: options.autoReasoningEffort } : {}),
    };
}

function activeEffort(sessionStore, agentKey, modelId, models, chatId) {
    const requested = sessionStore.getReasoningEffort(agentKey, modelId, chatId);
    if (!requested) return null;
    const metadata = (models || []).find(model => model.id === modelId);
    if (!metadata?.reasoningEfforts?.length || !metadata.reasoningEfforts.includes(requested)) return null;
    return requested;
}

function runCli(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            encoding: 'utf8', windowsHide: true,
            timeout: options.timeout || 30000,
            maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
            env: options.env || process.env,
            cwd: options.cwd,
        }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
            } else resolve(stdout);
        });
    });
}

module.exports = { EFFORT_LEVELS, withEffortCapabilities, activeEffort, runCli };
