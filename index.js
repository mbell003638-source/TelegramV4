// =============================================================================
//  index.js — Telegram AI Bridge v4 Main Orchestrator
//
//  Initializes the session store, agent registry, action router, and gateway.
// =============================================================================
require('dotenv').config();

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// =============================================================================
//  DNS OVERRIDE — Bypass ISP DNS Hijacking for Telegram API (Windows only)
// =============================================================================
if (process.platform === 'win32') {
    const { Resolver } = require('dns');
    const resolver = new Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);

    const originalLookup = dns.lookup;
    dns.lookup = function(hostname, options, callback) {
        if (hostname === 'api.telegram.org') {
            let opt = options;
            let cb = callback;
            if (typeof options === 'function') {
                cb = options;
                opt = {};
            }

            return originalLookup.call(dns, hostname, options, (err, address, family) => {
                const isHijacked = !err && (
                    (typeof address === 'string' && address === '49.44.79.236') ||
                    (Array.isArray(address) && address.some(addr => (addr.address === '49.44.79.236' || addr === '49.44.79.236')))
                );

                if (err || isHijacked) {
                    return resolver.resolve4('api.telegram.org', (fallbackErr, addresses) => {
                        const resolvedIp = (!fallbackErr && addresses && addresses.length > 0) ? addresses[0] : '149.154.166.110';
                        if (opt.all) return cb(null, [{ address: resolvedIp, family: 4 }]);
                        return cb(null, resolvedIp, 4);
                    });
                }

                return cb(err, address, family);
            });
        }
        return originalLookup.call(dns, hostname, options, callback);
    };
}

const path = require('path');
const fs = require('fs');
const net = require('net');
const config = require('./core/config');
const { rotateLogs } = require('./core/logRotation');

rotateLogs(config.logFile, config.logMaxBytes, config.logBackups);
const logRotationTimer = setInterval(() => rotateLogs(config.logFile, config.logMaxBytes, config.logBackups), 60000);
logRotationTimer.unref();

// =============================================================================
//  SINGLETON — TCP port lock (prevents duplicate instances)
// =============================================================================
const LOCK_PORT = config.lockPort;
const lockServer = net.createServer();
lockServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        if (process.env.DISABLE_TELEGRAM === 'true' || process.env.ALLOW_CONCURRENT_HUD === 'true') {
            console.log(`[Singleton] Port ${LOCK_PORT} in use; running in Standalone Web HUD mode.`);
            return;
        }
        const msg = 'Another v4 instance is already running (port lock). Exiting with code 2.';
        console.error(`[${new Date().toISOString()}] ${msg}`);
        try { fs.appendFileSync('crash.log', `[${new Date().toISOString()}] ${msg}\n`); } catch(e) {}
        process.exit(2);
    }
});
    lockServer.listen(LOCK_PORT, config.lockHost, () => {
    console.log(`Singleton lock acquired on port ${LOCK_PORT}`);
});

process.on('uncaughtException', (err) => {
    fs.appendFileSync('crash.log', `[UNCAUGHT EXCEPTION] ${err.stack}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    fs.appendFileSync('crash.log', `[UNHANDLED REJECTION] ${reason}\n`);
});

if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
        console.log(`[${new Date().toISOString()}] SIGHUP received (console disconnect) — ignoring, staying alive.`);
    });
}

const Gateway = require('./core/Gateway');
const ActionExecutor = require('./core/ActionExecutor');
const SessionStore = require('./core/SessionStore');
const { getDatabase } = require('./core/Database');
const MissionControlServer = require('./core/MissionControl');
const ProviderRegistry = require('./core/ProviderRegistry');
const ProviderRouter = require('./core/ProviderRouter');
const { getAgentOverrides } = require('./core/AgentOverrides');
const WhatsAppGateway = require('./core/WhatsAppGateway');
const Scheduler = require('./core/Scheduler');
const MemorySearch = require('./core/MemorySearch');
const TaskPlanner = require('./core/TaskPlanner');
const SelfImprovementEngine = require('./core/SelfImprovement');
const UpstreamWatch = require('./core/UpstreamWatch');
const SyncthingBridge = require('./core/SyncthingBridge');
const AgentDelegation = require('./core/AgentDelegation');
const Council = require('./core/Council');
const InstanceSync = require('./core/InstanceSync');
const SkillRegistry = require('./core/SkillRegistry');
const GoalEngine = require('./core/GoalEngine');
const QuotaTracker = require('./core/QuotaTracker');
const MeetingBot = require('./core/MeetingBot');
const AgentDiscovery = require('./core/AgentDiscovery');
const { globalHermesEngine } = require('./core/HermesToolEngine');
const { runImprovement, IMPROVE_AGENT_ID } = require('./core/RouterRoutes');

// Agent implementations
const AntigravityAgent = require('./agents/AntigravityAgent');
const OpenCodeAgent = require('./agents/OpenCodeAgent');
const CodexAgent = require('./agents/CodexAgent');
const ClaudeAgent = require('./agents/ClaudeAgent');
const OpenClawAgent = require('./agents/OpenClawAgent');
const HermesAgent = require('./agents/HermesAgent');
const PiAgent = require('./agents/PiAgent');
const GrokAgent = require('./agents/GrokAgent');

// =============================================================================
//  CONFIG
// =============================================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID ? parseInt(process.env.ALLOWED_USER_ID, 10) : null;

if (!BOT_TOKEN) {
    console.log('ℹ️ TELEGRAM_BOT_TOKEN not set. Running in Standalone Mission Control Web UI mode.');
}

// =============================================================================
//  INITIALIZE
// =============================================================================
async function main() {
    console.log('=== Telegram Bridge v4 ===');

    // 1. Create SessionStore
    const sessionStore = new SessionStore(config.baseDir);

    // 2. Register Agents
    const agents = {
        antigravity: new AntigravityAgent(sessionStore),
        opencode: new OpenCodeAgent(sessionStore),
        codex: new CodexAgent(sessionStore),
        claude: new ClaudeAgent(sessionStore),
        openclaw: new OpenClawAgent(sessionStore),
        hermes: new HermesAgent(sessionStore),
        pi: new PiAgent(sessionStore),
        grok: new GrokAgent(sessionStore),
    };

    // Initialize all agents in parallel (CLI lookups / model discovery).
    await Promise.all(Object.values(agents).map(agent =>
        typeof agent.initialize === 'function'
            ? agent.initialize().catch(err => console.warn(`[AgentInit] ${agent.name}: ${err.message}`))
            : Promise.resolve()
    ));

    // Warm the last-used agent in the background so the first user message
    // does not pay initialize()+start() again.
    const activeKey = sessionStore.getActiveAgent();
    const activeAgent = agents[activeKey];
    if (activeAgent && typeof activeAgent.ensureRunning === 'function') {
        activeAgent.ensureRunning().catch(err => console.warn(`[AgentWarm] ${activeAgent.name}: ${err.message}`));
    }

    // 3. Create ActionExecutor
    const actionExecutor = new ActionExecutor(sessionStore, agents);

    // 4. Create Gateway and wire messageHandler
    // 4. Initialize unified SQLite database & start Mission Control Dashboard
    const database = getDatabase(path.join(config.baseDir, 'store'));
    // 4b. OmniRouter — one master key in front of every configured provider
    //     (OpenRouter catalog/accounting + OmniRoute failover + 9router key pools)
    const providerRegistry = new ProviderRegistry(config.baseDir);
    const providerRouter = new ProviderRouter({
        registry: providerRegistry,
        strategy: process.env.OMNIROUTER_STRATEGY || 'priority',
    });
    const agentOverrides = getAgentOverrides(config.baseDir);

    // 4c. Searchable shared memory — any agent can recall what any other
    //     agent learned, in any past session (FTS5, LIKE fallback).
    const memorySearch = new MemorySearch({ database });

    // 4d. Task planner: decompose a request, pick a model per subtask,
    //     execute respecting dependencies, then synthesize one answer.
    const taskPlanner = new TaskPlanner({
        router: providerRouter,
        agents,
        database,
    });

    // 4e. Self-improvement sweep + upstream update watcher. The watcher only
    //     ever reads: it reports what landed in the reference projects, it
    //     never merges anything, so adopting a change stays a human call.
    const selfImprovement = new SelfImprovementEngine({
        database,
        sessionStore,
        baseDir: config.baseDir,
    });
    const upstreamWatch = new UpstreamWatch({ baseDir: config.baseDir });

    // 4f. Syncthing: replicate the vault and memory store between setups,
    //     peer to peer. The API key is read from the env, or discovered
    //     from a local Syncthing config.xml so a normal install needs no
    //     manual copying.
    let syncthingKey = process.env.SYNCTHING_API_KEY || null;
    if (!syncthingKey) {
        const found = SyncthingBridge.discoverApiKey();
        if (found) {
            syncthingKey = found.apiKey;
            console.log(`[Syncthing] API key discovered in ${found.configPath}`);
        }
    }
    const syncthing = new SyncthingBridge({ apiKey: syncthingKey });

    // 4g. Agent-to-agent delegation. The inter_agent_tasks table existed but
    //     nothing ever read or wrote it, so one agent could not hand work to
    //     another. Depth and cycle guards keep A->B->A from looping forever.
    const delegation = new AgentDelegation({
        database,
        agents,
        actionExecutor,
    });

    // 4h. Council: pose a question to several agents and synthesise their real
    //     positions. Replaces a deleted module that returned hardcoded prose
    //     as if it were genuine agent output.
    const council = new Council({
        agents,
        actionExecutor,
        router: providerRouter,
        database,
    });

    // 4i. Skills: reusable procedures, shareable between agents and machines.
    const skills = new SkillRegistry({ baseDir: config.baseDir, database });

    // 4j. Opt-in sharing of memories/skills/config with other instances.
    //     Nothing is shared until a peer is added WITH explicit scopes.
    const instanceSync = new InstanceSync({
        database,
        baseDir: config.baseDir,
        selfId: process.env.INSTANCE_ID || null,
        sharedSecret: process.env.INSTANCE_SHARED_SECRET || process.env.INSTANCE_SYNC_SECRET || null,
    });

    // 4k. Quota tracking. This app runs on subscriptions with session and
    //     weekly limits, not per-token billing, so knowing which provider
    //     still has headroom matters more than knowing what it cost.
    const quota = new QuotaTracker({ database, baseDir: config.baseDir });

    // 4l. Goal engine: the spine. A goal persists across sessions and is
    //     advanced one step at a time, so progress is durable and
    //     observable rather than trapped inside one long call.
    const goals = new GoalEngine({
        database,
        planner: taskPlanner,
        delegation,
        council,
        memorySearch,
        skills,
    });

    // 4m. Meeting bot. Refuses to pretend: with no RECALL_API_KEY it reports
    //     that it is unconfigured rather than claiming an agent joined.
    const meetingBot = new MeetingBot({
        apiKey: process.env.RECALL_API_KEY || null,
        database,
        memorySearch,
        webhookSecret: process.env.RECALL_WEBHOOK_SECRET || null,
    });

    // 4n. Discover every agent CLI installed on this machine, not just the
    //     eight registered above. Detected-but-unsupported ones are still
    //     reported, because knowing a tool is present is useful.
    const discovery = new AgentDiscovery({});

    const dashboardPort = Number(process.env.DASHBOARD_PORT) || 3141;
    const dashboardToken = process.env.DASHBOARD_TOKEN || 'admin';
    const missionControl = new MissionControlServer({
        database,
        sessionStore,
        actionExecutor,
        agents,
        port: dashboardPort,
        token: dashboardToken,
        providerRouter,
        providerRegistry,
        agentOverrides,
        memorySearch,
        taskPlanner,
        selfImprovement,
        upstreamWatch,
        syncthing,
        delegation,
        council,
        instanceSync,
        skills,
        goals,
        quota,
        meetingBot,
        discovery,
    });
    await missionControl.start().catch((err) => {
        console.warn(`[MissionControl] Could not bind port ${dashboardPort}: ${err.message}`);
    });

    // 5. Optional Telegram Gateway (runs if BOT_TOKEN is configured)
    let gateway = null;
    if (BOT_TOKEN && process.env.DISABLE_TELEGRAM !== 'true') {
        try {
            const messageHandler = actionExecutor.getMessageHandler();
            gateway = new Gateway(BOT_TOKEN, messageHandler, ALLOWED_USER_ID, path.join(config.baseDir, 'uploads'));
            actionExecutor.setShellNotifier((chatId, text, options) => {
                if (gateway?.bot?.telegram) {
                    return gateway.bot.telegram.sendMessage(chatId, text, options);
                }
            });
            await gateway.start();
            console.log('🤖 Telegram Gateway online and polling.');
        } catch (err) {
            console.warn(`⚠️ [Gateway] Telegram bot could not connect (${err.message}). Web Mission Control remains fully functional.`);
        }
    } else {
        console.log('ℹ️ Running in Web Mission Control standalone mode (no Telegram token configured).');
    }

    // 5a. Cron scheduler — executes due scheduled_tasks. Before this the

    //     table and its UI existed but nothing ever ran a task.

    const scheduler = new Scheduler({

        database,

        actionExecutor,

        killSwitches: missionControl.killSwitches,

    });

    scheduler.start();
    // Attached after construction because the scheduler needs
    // missionControl's kill switches.
    missionControl.scheduler = scheduler;
    council.killSwitches = missionControl.killSwitches;

    // Goals make progress on the scheduler rather than in a long-lived loop,
    // so a restart never loses one mid-flight.
    if (typeof goals.registerWithScheduler === 'function') {
        try {
            goals.registerWithScheduler(scheduler);
        } catch (err) {
            console.warn(`[GoalEngine] Could not register with scheduler: ${err.message}`);
        }
    }

    // The Hermes tool engine was previously referenced only from a test file.
    // Wire its orchestration tools to the real collaborators. Each agent CLI
    // keeps its own native toolset; these are the tools that only make sense
    // at the layer above them.
    if (typeof globalHermesEngine.configure === 'function') {
        globalHermesEngine.configure({
            memorySearch,
            database,
            delegation,
            skills,
            agents,
            scheduler,
            devices: missionControl.deviceAutomation,
            syncthing,
            meetingBot,
            goalEngine: goals,
        });
    }

    // The improvement sweep is not an agent prompt, so it gets its own
    // handler on the same cron machinery.
    scheduler.registerTaskHandler(IMPROVE_AGENT_ID, async () => {
        // acknowledge: the scheduled pass marks upstream heads as seen so
        // the next run reports only what is newer than this one.
        const report = await runImprovement(missionControl, { acknowledge: true });
        const learned = report.learning?.promotedRules?.length || 0;
        const updated = report.upstream ? report.upstream.withUpdates : 0;
        return `Learned ${learned} rule(s); ${updated} upstream project(s) have new commits.`
            + (report.digest ? `\n${report.digest}` : '');
    });


    // 5b. Optional WhatsApp Cloud API Gateway (webhook rides on Mission Control)

    let whatsapp = null;

    if (process.env.DISABLE_WHATSAPP !== 'true') {

        whatsapp = WhatsAppGateway.fromEnv({

            messageHandler: actionExecutor.getMessageHandler(),

            uploadsDir: path.join(config.baseDir, 'uploads'),

        });

        if (whatsapp && await whatsapp.start()) {

            missionControl.whatsappWebhook = whatsapp.createWebhookHandler();

            console.log(`📱 WhatsApp Gateway online at ${whatsapp.webhookPath}`);

        } else {

            whatsapp = null;

        }

    }


    console.log('✅ System Online. Architecture:');
    console.log(`   Mission Control Web UI: http://localhost:${dashboardPort}/?token=${dashboardToken}`);
    if (gateway) {
        console.log('   Control Plane: Dual (Telegram Bot + Mission Control Web UI)');
    } else {
        console.log('   Control Plane: Mission Control Web UI (Browser)');
    }
    console.log(`   Registered agents: ${Object.keys(agents).join(', ')}`);
    console.log(`   Active agent: ${sessionStore.getActiveAgent()}`);
    const enabledProviders = providerRegistry.getAll().filter(p => p.enabled).map(p => p.id);
    console.log(`   OmniRouter: ${enabledProviders.length ? enabledProviders.join(', ') : 'no providers configured yet'}`);
    console.log(`   OpenAI-compatible endpoint: http://localhost:${dashboardPort}/v1  (key via /api/router/key)`);
    const activeOverrides = Object.entries(agentOverrides.describeAll()).filter(([, v]) => v.enabled).map(([k]) => k);
    if (activeOverrides.length) console.log(`   Provider overrides active: ${activeOverrides.join(', ')}`);
    if (whatsapp) console.log('   Channels: Telegram + WhatsApp + Web');
    console.log(`   Memory recall: ${memorySearch.stats().mode} (${memorySearch.stats().indexed} indexed)`);
    console.log('   Scheduler: running');
    console.log(`   Syncthing: ${syncthing.isConfigured ? 'configured' : 'not configured (set SYNCTHING_API_KEY)'}`);
    console.log(`   Skills: ${skills.stats().count} registered`);
    console.log(`   Peers: ${instanceSync.listPeers().length} instance(s) paired`);
    try {
        const g = goals.summary();
        console.log(`   Goals: ${g.total || 0} tracked`);
    } catch (e) { /* summary is cosmetic */ }
    console.log(`   Meeting bot: ${meetingBot.isConfigured ? 'configured' : 'not configured (set RECALL_API_KEY)'}`);
    // Discovery runs in the background: probing every CLI for a version is
    // slow, and nothing above depends on the result.
    discovery.scan({ withVersion: false })
        .then((found) => {
            const installed = found.filter((a) => a.installed);
            const extra = installed.filter((a) => !a.supported).map((a) => a.id);
            console.log(`   Agent CLIs found: ${installed.length}` + (extra.length ? ` (detected without an adapter: ${extra.join(', ')})` : ''));
        })
        .catch((err) => console.warn(`[AgentDiscovery] scan failed: ${err.message}`));

    // Stop the scheduler cleanly so an in-flight task is not orphaned.
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            scheduler.stop().catch(() => {});
            process.exit(0);
        });
    }
}

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
