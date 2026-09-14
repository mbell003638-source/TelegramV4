const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
    AgentOverrides,
    getAgentOverrides,
    resetAgentOverrides,
    AGENT_ENV_MAP,
    AGENT_ENV_CONSTANTS,
} = require('../core/AgentOverrides');
const BaseAgent = require('../core/BaseAgent');

const RAW_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

function tempBaseDir() {
    const dir = path.join(os.tmpdir(), `agent-overrides-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Set/unset a process.env var and hand back an exact restore function. */
function stashEnv(names) {
    const saved = {};
    for (const name of names) saved[name] = process.env[name];
    return () => {
        for (const name of names) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    };
}

class FakeAgent extends BaseAgent {
    constructor(key) { super(key, `Fake ${key}`, '🧪'); }
    async onInitialize() {}
    async onStart() {}
    async onStop() {}
    async sendMessage() {}
}

test('toggle ON builds the mapped env overlay for claude, codex and grok', () => {
    const dir = tempBaseDir();
    try {
        const ov = new AgentOverrides(dir);

        ov.enable('claude', { providerId: 'omnirouter', model: 'claude-opus-4', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        const claude = ov.getEnvOverlay('claude');
        assert.equal(claude.ANTHROPIC_BASE_URL, 'https://router.local/v1');
        assert.equal(claude.ANTHROPIC_AUTH_TOKEN, RAW_KEY);
        assert.equal(claude.ANTHROPIC_MODEL, 'claude-opus-4');
        // Claude Code pulls GET /v1/models into its own picker with this on.
        assert.equal(claude.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
        // ANTHROPIC_API_KEY maps to X-Api-Key; setting it alongside
        // ANTHROPIC_AUTH_TOKEN is an auth conflict, so it must stay unset.
        assert.equal('ANTHROPIC_API_KEY' in claude, false);
        assert.equal(claude.OMNIROUTER_ACTIVE, '1');
        assert.equal(ov.isEnabled('claude'), true);

        ov.enable('codex', { providerId: 'omnirouter', model: 'gpt-5', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        const codex = ov.getEnvOverlay('codex');
        assert.equal(codex.OPENAI_BASE_URL, 'https://router.local/v1');
        assert.equal(codex.OPENAI_API_KEY, RAW_KEY);
        assert.equal(codex.OPENAI_MODEL, 'gpt-5');
        assert.equal(codex.OMNIROUTER_ACTIVE, '1');

        ov.enable('grok', { providerId: 'xai', model: 'grok-4', baseUrl: 'https://api.x.ai/v1', apiKey: RAW_KEY });
        const grok = ov.getEnvOverlay('grok');
        assert.equal(grok.XAI_BASE_URL, 'https://api.x.ai/v1');
        assert.equal(grok.XAI_API_KEY, RAW_KEY);
        assert.equal(grok.GROK_MODEL, 'grok-4');

        // antigravity maps one key onto two vars
        ov.enable('antigravity', { providerId: 'google', apiKey: RAW_KEY });
        const anti = ov.getEnvOverlay('antigravity');
        assert.equal(anti.GEMINI_API_KEY, RAW_KEY);
        assert.equal(anti.GOOGLE_API_KEY, RAW_KEY);

        // every overlay key must be declared in AGENT_ENV_MAP (plus the marker)
        for (const key of ['claude', 'codex', 'grok', 'antigravity']) {
            const declared = Object.values(AGENT_ENV_MAP[key]).flat()
                .concat(Object.keys(AGENT_ENV_CONSTANTS[key] || {}));
            for (const name of Object.keys(ov.getEnvOverlay(key))) {
                if (name === 'OMNIROUTER_ACTIVE') continue;
                assert.ok(declared.includes(name), `${name} not declared for ${key}`);
            }
        }

        // unsupported / unknown keys are inert, never throwing on read
        assert.deepEqual(ov.getEnvOverlay('nope'), {});
        assert.throws(() => ov.enable('nope', { apiKey: RAW_KEY }), /Unknown agent key/);
    } finally {
        cleanup(dir);
    }
});

test('toggle OFF yields an empty overlay', () => {
    const dir = tempBaseDir();
    try {
        const ov = new AgentOverrides(dir);

        assert.deepEqual(ov.getEnvOverlay('claude'), {}, 'off by default');

        ov.enable('claude', { providerId: 'omnirouter', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        assert.ok(Object.keys(ov.getEnvOverlay('claude')).length > 0);

        const result = ov.disable('claude');
        assert.equal(result.enabled, false);
        assert.equal(ov.isEnabled('claude'), false);
        assert.deepEqual(ov.getEnvOverlay('claude'), {});
        assert.deepEqual(result.envOverlay, {});
    } finally {
        cleanup(dir);
    }
});

test('lossless revert: unset stays unset, prior values are restored exactly', () => {
    const dir = tempBaseDir();
    const restoreEnv = stashEnv(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'OMNIROUTER_ACTIVE']);
    try {
        resetAgentOverrides();
        const ov = getAgentOverrides(dir);
        const agent = new FakeAgent('claude');

        // Baseline: BASE_URL unset, MODEL has a prior value.
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.OMNIROUTER_ACTIVE;
        process.env.ANTHROPIC_MODEL = 'prior-model';
        process.env.ANTHROPIC_AUTH_TOKEN = 'prior-key';

        ov.enable('claude', { providerId: 'omnirouter', model: 'router-model', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });

        // null (not undefined) records "this var was unset" so it survives JSON.
        const snapshot = ov.get('claude').snapshot;
        assert.equal(snapshot.ANTHROPIC_BASE_URL, null);
        assert.equal(snapshot.ANTHROPIC_MODEL, 'prior-model');
        assert.equal(snapshot.ANTHROPIC_AUTH_TOKEN, 'prior-key');
        assert.equal(snapshot.OMNIROUTER_ACTIVE, null);

        const onEnv = agent.getSpawnEnv();
        assert.equal(onEnv.ANTHROPIC_BASE_URL, 'https://router.local/v1');
        assert.equal(onEnv.ANTHROPIC_MODEL, 'router-model');
        assert.equal(onEnv.ANTHROPIC_AUTH_TOKEN, RAW_KEY);
        assert.equal(onEnv.OMNIROUTER_ACTIVE, '1');
        assert.equal(agent.overrideActive, true);

        const result = ov.disable('claude');
        assert.equal(result.restored.ANTHROPIC_BASE_URL, null, 'null == revert to unset');
        assert.equal(result.restored.ANTHROPIC_MODEL, 'prior-model');
        assert.equal(result.restored.ANTHROPIC_AUTH_TOKEN, 'prior-key');

        const offEnv = agent.getSpawnEnv();
        // Previously-unset var must be ABSENT, not an empty string.
        assert.equal('ANTHROPIC_BASE_URL' in offEnv, false);
        assert.equal(offEnv.ANTHROPIC_BASE_URL, undefined);
        assert.equal('OMNIROUTER_ACTIVE' in offEnv, false);
        // Previously-set vars restored to exactly their prior values.
        assert.equal(offEnv.ANTHROPIC_MODEL, 'prior-model');
        assert.equal(offEnv.ANTHROPIC_AUTH_TOKEN, 'prior-key');
        assert.equal(agent.overrideActive, false);

        // The overlay never touched the parent process env.
        assert.equal(process.env.ANTHROPIC_MODEL, 'prior-model');
        assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
    } finally {
        resetAgentOverrides();
        restoreEnv();
        cleanup(dir);
    }
});

test('describe() masks the api key and never returns it raw', () => {
    const dir = tempBaseDir();
    try {
        const ov = new AgentOverrides(dir);
        const described = ov.enable('hermes', { providerId: 'omnirouter', model: 'hermes-4', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });

        assert.equal(described.enabled, true);
        assert.notEqual(described.apiKey, RAW_KEY);
        assert.equal(described.apiKey, 'sk-or-v...cdef');
        assert.equal(described.hasApiKey, true);
        assert.ok(!JSON.stringify(described).includes(RAW_KEY), 'raw key leaked in describe()');
        assert.ok(!JSON.stringify(ov.describeAll()).includes(RAW_KEY), 'raw key leaked in describeAll()');

        assert.deepEqual(described.envVars, ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'HERMES_MODEL']);
        assert.deepEqual(described.activeEnvVars.sort(), ['HERMES_MODEL', 'OMNIROUTER_ACTIVE', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
        assert.equal(typeof described.updatedAt, 'string');

        // A short key is fully masked rather than mostly revealed.
        ov.enable('pi', { providerId: 'omnirouter', baseUrl: 'https://router.local/v1', apiKey: 'short-key' });
        assert.equal(ov.describe('pi').apiKey, '*********');

        // get() is the raw, server-side accessor.
        assert.equal(ov.get('hermes').apiKey, RAW_KEY);
    } finally {
        cleanup(dir);
    }
});

test('BaseAgent.getSpawnEnv merges overlay over process.env and honours extra', () => {
    const dir = tempBaseDir();
    const restoreEnv = stashEnv(['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OMNIROUTER_ACTIVE', 'AGENT_OVERRIDE_PROBE']);
    try {
        resetAgentOverrides();
        const ov = getAgentOverrides(dir);
        const agent = new FakeAgent('codex');

        process.env.AGENT_OVERRIDE_PROBE = 'from-env';
        process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
        delete process.env.OMNIROUTER_ACTIVE;

        // Toggle off: process.env passes through untouched, extra is merged in.
        const offEnv = agent.getSpawnEnv({ CI: 'true', AGENT_OVERRIDE_PROBE: 'from-extra' });
        assert.equal(offEnv.CI, 'true');
        assert.equal(offEnv.AGENT_OVERRIDE_PROBE, 'from-extra', 'extra wins over process.env');
        assert.equal(offEnv.OPENAI_BASE_URL, 'https://api.openai.com/v1');
        assert.equal('OMNIROUTER_ACTIVE' in offEnv, false);
        assert.ok(Object.keys(offEnv).length > 3, 'process.env passes through');

        // Toggle on: overlay wins over both process.env and extra.
        ov.enable('codex', { providerId: 'omnirouter', model: 'gpt-5', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        const onEnv = agent.getSpawnEnv({ CI: 'true', OPENAI_API_KEY: 'from-extra' });
        assert.equal(onEnv.CI, 'true');
        assert.equal(onEnv.OPENAI_BASE_URL, 'https://router.local/v1', 'overlay wins over process.env');
        assert.equal(onEnv.OPENAI_API_KEY, RAW_KEY, 'overlay wins over extra');
        assert.equal(onEnv.OPENAI_MODEL, 'gpt-5');
        assert.equal(onEnv.OMNIROUTER_ACTIVE, '1');
        assert.equal(onEnv.AGENT_OVERRIDE_PROBE, 'from-env');

        // A different agent is unaffected by codex's toggle.
        const other = new FakeAgent('claude');
        assert.equal(other.overrideActive, false);
        assert.equal('OMNIROUTER_ACTIVE' in other.getSpawnEnv(), false);

        // No-arg call is valid.
        assert.equal(agent.getSpawnEnv().OPENAI_MODEL, 'gpt-5');
    } finally {
        resetAgentOverrides();
        restoreEnv();
        cleanup(dir);
    }
});

test('override state survives a save/load round-trip', () => {
    const dir = tempBaseDir();
    const restoreEnv = stashEnv(['XAI_BASE_URL', 'XAI_API_KEY', 'GROK_MODEL']);
    try {
        process.env.GROK_MODEL = 'prior-grok';
        delete process.env.XAI_BASE_URL;

        const first = new AgentOverrides(dir);
        first.enable('grok', { providerId: 'omnirouter', model: 'grok-4', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        first.enable('opencode', { providerId: 'omnirouter', baseUrl: 'https://router.local/v1', apiKey: RAW_KEY });
        first.disable('opencode');

        assert.ok(fs.existsSync(path.join(dir, 'store', 'agent-overrides.json')));

        const second = new AgentOverrides(dir);
        assert.equal(second.isEnabled('grok'), true);
        assert.equal(second.isEnabled('opencode'), false);
        assert.deepEqual(second.getEnvOverlay('grok'), first.getEnvOverlay('grok'));
        assert.deepEqual(second.getEnvOverlay('opencode'), {});

        const reloaded = second.get('grok');
        assert.equal(reloaded.providerId, 'omnirouter');
        assert.equal(reloaded.apiKey, RAW_KEY);
        // The "was unset" marker survives JSON as null, not as a dropped key.
        assert.equal(reloaded.snapshot.XAI_BASE_URL, null);
        assert.equal(reloaded.snapshot.GROK_MODEL, 'prior-grok');
        assert.deepEqual(second.disable('grok').restored, reloaded.snapshot);
    } finally {
        restoreEnv();
        cleanup(dir);
    }
});
