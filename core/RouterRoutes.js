// =============================================================================
//  core/RouterRoutes.js — OmniRouter & Agent Override HTTP Routes
//
//  Mounted by MissionControl. Kept in its own module so the unified provider
//  gateway and the per-agent toggle can evolve without growing the main
//  request handler.
//
//  Routes:
//    GET/POST/PATCH  /api/router/providers   — provider + key pool management
//    GET/DELETE      /api/router/usage       — token & cost ledger
//    GET             /api/router/models      — aggregated model catalog
//    GET             /api/router/health      — circuit breaker state
//    GET             /api/router/key         — the single master key
//    GET/POST/PATCH  /api/agents/override    — per-agent provider toggle
// =============================================================================

const UpstreamWatch = require('./UpstreamWatch');

// Scheduled tasks carrying this agent_id are the self-improvement sweep, not an
// agent prompt. index.js registers the matching handler on the Scheduler.
const IMPROVE_AGENT_ID = '__improve__';

/**
 * Handle an OmniRouter or agent-override route.
 *
 * @param {object} ctx      MissionControlServer instance (for db, registry, router, broadcast)
 * @param {object} req      Node request
 * @param {object} res      Node response
 * @param {string} pathname Parsed pathname
 * @param {object} query    Parsed query params
 * @returns {Promise<boolean>} true when the request was handled
 */
async function handleRouterRoutes(ctx, req, res, pathname, query) {
    // --- Provider registry: upstream providers and their key pools ---
    if (pathname === '/api/router/providers') {
        if (!ctx.providerRegistry) {
            ctx._sendJson(res, 503, { error: 'Provider registry not configured' });
            return true;
        }

        if (req.method === 'GET') {
            ctx._sendJson(res, 200, { providers: ctx.providerRegistry.maskedView() });
            return true;
        }

        if (req.method === 'POST' || req.method === 'PATCH') {
            const body = await ctx._readBody(req);
            const id = body.id;
            if (!id) {
                ctx._sendJson(res, 400, { error: 'Provider id required' });
                return true;
            }
            try {
                if (body.addKey) {
                    ctx.providerRegistry.addKey(id, body.addKey);
                } else if (body.removeKey !== undefined) {
                    ctx.providerRegistry.removeKey(id, body.removeKey);
                } else if (body.enabled !== undefined) {
                    ctx.providerRegistry.setEnabled(id, !!body.enabled);
                } else {
                    ctx.providerRegistry.upsert(id, body);
                }
                ctx.providerRegistry.save();
                ctx.db.logAudit('router', 'providers', 'provider_updated', `Provider ${id} updated`, false);
                ctx.broadcast('router.providers_updated', { id });
                ctx._sendJson(res, 200, { ok: true, providers: ctx.providerRegistry.maskedView() });
            } catch (err) {
                ctx._sendJson(res, 400, { error: err.message });
            }
            return true;
        }
    }

    // --- Usage ledger: tokens and estimated cost per provider/model ---
    if (pathname === '/api/router/usage') {
        if (!ctx.providerRouter) {
            ctx._sendJson(res, 503, { error: 'Router not configured' });
            return true;
        }
        if (req.method === 'DELETE') {
            ctx.providerRouter.resetUsage();
            ctx.broadcast('router.usage_reset', {});
            ctx._sendJson(res, 200, { ok: true });
            return true;
        }
        ctx._sendJson(res, 200, ctx.providerRouter.getUsageReport());
        return true;
    }

    // --- Aggregated model catalog across every enabled provider ---
    if (pathname === '/api/router/models') {
        if (!ctx.providerRouter) {
            ctx._sendJson(res, 503, { error: 'Router not configured' });
            return true;
        }
        const models = await ctx.providerRouter.listModels({ force: query.force === 'true' });
        ctx._sendJson(res, 200, { models });
        return true;
    }

    // --- Circuit breaker / key health ---
    if (pathname === '/api/router/health') {
        if (!ctx.providerRouter) {
            ctx._sendJson(res, 503, { error: 'Router not configured' });
            return true;
        }
        ctx._sendJson(res, 200, {
            health: ctx.providerRouter.getHealth(),
            keys: ctx.providerRouter.getKeyUsage(),
        });
        return true;
    }

    // --- The single master key that fronts every provider ---
    if (pathname === '/api/router/key' && req.method === 'GET') {
        if (!ctx.providerRouter) {
            ctx._sendJson(res, 503, { error: 'Router not configured' });
            return true;
        }
        // The dashboard token already gated this request, and the operator
        // needs the key verbatim to point external tools at the router.
        ctx._sendJson(res, 200, {
            masterKey: ctx.providerRouter.getMasterKey(),
            baseUrl: `http://127.0.0.1:${ctx.port}/v1`,
        });
        return true;
    }

    // --- Per-agent provider override toggle ---
    //  enabled  => agent is re-pointed at the router (or an explicit provider)
    //  disabled => agent reverts losslessly to its own defaults
    if (pathname === '/api/agents/override') {
        if (!ctx.agentOverrides) {
            ctx._sendJson(res, 503, { error: 'Agent overrides not configured' });
            return true;
        }

        if (req.method === 'GET') {
            ctx._sendJson(res, 200, { overrides: ctx.agentOverrides.describeAll() });
            return true;
        }

        if (req.method === 'POST' || req.method === 'PATCH') {
            const body = await ctx._readBody(req);
            const agentKey = body.agentKey || body.agentId;
            if (!agentKey) {
                ctx._sendJson(res, 400, { error: 'agentKey required' });
                return true;
            }

            try {
                let result;
                if (body.enabled) {
                    // Default to the OmniRouter itself, so a single toggle gives
                    // that agent access to every configured provider at once.
                    const baseUrl = body.baseUrl || `http://127.0.0.1:${ctx.port}/v1`;
                    const apiKey = body.apiKey
                        || (ctx.providerRouter ? ctx.providerRouter.getMasterKey() : null);
                    if (!apiKey) {
                        ctx._sendJson(res, 400, { error: 'No apiKey supplied and router is unavailable' });
                        return true;
                    }
                    result = ctx.agentOverrides.enable(agentKey, {
                        providerId: body.providerId || 'omnirouter',
                        model: body.model,
                        baseUrl,
                        apiKey,
                    });
                } else {
                    result = ctx.agentOverrides.disable(agentKey);
                }

                ctx.db.logAudit(
                    'router',
                    agentKey,
                    'agent_override',
                    `Override ${body.enabled ? 'enabled' : 'disabled'} for ${agentKey}`,
                    false
                );
                ctx.broadcast('router.override_updated', { agentKey, enabled: !!body.enabled });
                ctx._sendJson(res, 200, {
                    ok: true,
                    override: result,
                    overrides: ctx.agentOverrides.describeAll(),
                });
            } catch (err) {
                ctx._sendJson(res, 400, { error: err.message });
            }
            return true;
        }
    }

    // --- Shared searchable memory ---
    //  Any agent can recall what any other agent learned, in any past session.
    if (pathname === '/api/memories/search') {
        if (!ctx.memorySearch) {
            ctx._sendJson(res, 503, { error: 'Memory search not configured' });
            return true;
        }
        const q = query.q || query.query || '';
        const results = ctx.memorySearch.search(q, {
            chatId: query.chatId,
            agentId: query.agentId,
            limit: Number(query.limit) || 20,
        });
        ctx._sendJson(res, 200, { query: q, results, stats: ctx.memorySearch.stats() });
        return true;
    }

    if (pathname === '/api/memories/reindex' && req.method === 'POST') {
        if (!ctx.memorySearch) {
            ctx._sendJson(res, 503, { error: 'Memory search not configured' });
            return true;
        }
        const indexed = ctx.memorySearch.reindexAll();
        ctx.broadcast('memory.reindexed', { indexed });
        ctx._sendJson(res, 200, { ok: true, indexed, stats: ctx.memorySearch.stats() });
        return true;
    }

    // --- Task planner: decompose -> pick a model per subtask -> run -> merge ---
    if (pathname === '/api/planner/plan' && req.method === 'POST') {
        if (!ctx.taskPlanner) {
            ctx._sendJson(res, 503, { error: 'Task planner not configured' });
            return true;
        }
        const body = await ctx._readBody(req);
        const request = (body.request || body.message || '').trim();
        if (!request) {
            ctx._sendJson(res, 400, { error: 'request required' });
            return true;
        }
        try {
            // Plan only — lets the UI show the graph before anything executes.
            const plan = await ctx.taskPlanner.plan(request, { context: body.context });
            ctx._sendJson(res, 200, { ok: true, plan });
        } catch (err) {
            ctx._sendJson(res, 500, { error: err.message });
        }
        return true;
    }

    if (pathname === '/api/planner/run' && req.method === 'POST') {
        if (!ctx.taskPlanner) {
            ctx._sendJson(res, 503, { error: 'Task planner not configured' });
            return true;
        }
        const body = await ctx._readBody(req);
        const request = (body.request || body.message || '').trim();
        if (!request) {
            ctx._sendJson(res, 400, { error: 'request required' });
            return true;
        }
        try {
            const result = await ctx.taskPlanner.run(request, {
                concurrency: Number(body.concurrency) || 3,
                onProgress: (evt) => ctx.broadcast('planner.progress', evt),
            });
            ctx.db.logAudit('planner', 'run', 'plan_executed',
                `Planner executed ${result.plan?.tasks?.length || 0} task(s)`, false);
            ctx._sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            ctx._sendJson(res, 500, { error: err.message });
        }
        return true;
    }

    // --- Scheduler: create, pause and delete recurring tasks ---
    if (pathname === '/api/scheduler/tasks') {
        if (!ctx.scheduler) {
            ctx._sendJson(res, 503, { error: 'Scheduler not configured' });
            return true;
        }
        if (req.method === 'GET') {
            ctx._sendJson(res, 200, { tasks: ctx.db.getScheduledTasks(query.chatId) });
            return true;
        }
        if (req.method === 'POST') {
            const body = await ctx._readBody(req);
            if (!body.schedule || !body.prompt) {
                ctx._sendJson(res, 400, { error: 'schedule (cron) and prompt are required' });
                return true;
            }
            try {
                // Validate the cron up front so a bad expression is rejected
                // here rather than silently never firing.
                ctx.scheduler.parseCron(body.schedule);
                const task = ctx.scheduler.scheduleTask({
                    chatId: body.chatId || '',
                    agentId: body.agentId || 'main',
                    prompt: body.prompt,
                    schedule: body.schedule,
                });
                ctx.broadcast('scheduler.task_created', task);
                ctx._sendJson(res, 200, { ok: true, task });
            } catch (err) {
                ctx._sendJson(res, 400, { error: err.message });
            }
            return true;
        }
    }

    if (pathname.startsWith('/api/scheduler/tasks/')) {
        if (!ctx.scheduler) {
            ctx._sendJson(res, 503, { error: 'Scheduler not configured' });
            return true;
        }
        const id = decodeURIComponent(pathname.slice('/api/scheduler/tasks/'.length));
        if (req.method === 'DELETE') {
            ctx.db.deleteScheduledTask(id);
            ctx.broadcast('scheduler.task_deleted', { id });
            ctx._sendJson(res, 200, { ok: true });
            return true;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
            const body = await ctx._readBody(req);
            const status = body.status === 'paused' ? 'paused' : 'active';
            ctx.db.setScheduledTaskStatus(id, status);
            ctx.broadcast('scheduler.task_updated', { id, status });
            ctx._sendJson(res, 200, { ok: true, id, status });
            return true;
        }
    }

    // --- Self-improvement + upstream update check ---
    //  One control: run the sweep now, or arm it to run on a cron.
    //  The scheduled run rides the normal scheduler via a registered handler
    //  keyed on the IMPROVE_AGENT_ID task marker.
    if (pathname === '/api/improve') {
        if (req.method === 'GET') {
            const task = ctx.db.getScheduledTasks('')
                .find((t) => t.agent_id === IMPROVE_AGENT_ID) || null;
            ctx._sendJson(res, 200, {
                // Armed only while the task exists AND is active, so a paused
                // task never reads as enabled.
                enabled: !!task && task.status === 'active',
                schedule: task ? task.schedule : null,
                nextRun: task ? task.next_run : null,
                lastRun: task ? task.last_run : null,
                lastResult: task ? task.last_result : null,
                sources: ctx.upstreamWatch
                    ? ctx.upstreamWatch.sources.map((s) => ({
                        id: s.id,
                        repo: s.repo,
                        note: s.note,
                        local: !!ctx.upstreamWatch.localClonePath(s),
                    }))
                    : [],
            });
            return true;
        }

        if (req.method === 'POST' || req.method === 'PATCH') {
            const body = await ctx._readBody(req);

            // 1. Run the sweep right now and return the report.
            if (body.runNow) {
                try {
                    const report = await runImprovement(ctx, { acknowledge: !!body.acknowledge });
                    ctx._sendJson(res, 200, { ok: true, ...report });
                } catch (err) {
                    ctx._sendJson(res, 500, { error: err.message });
                }
                return true;
            }

            // 2. Arm or disarm the recurring sweep.
            if (!ctx.scheduler) {
                ctx._sendJson(res, 503, { error: 'Scheduler not configured' });
                return true;
            }
            const existing = ctx.db.getScheduledTasks('')
                .find((t) => t.agent_id === IMPROVE_AGENT_ID) || null;

            if (body.enabled) {
                const schedule = body.schedule || '0 3 * * *'; // daily at 03:00
                try {
                    ctx.scheduler.parseCron(schedule);
                } catch (err) {
                    ctx._sendJson(res, 400, { error: err.message });
                    return true;
                }
                // Replace rather than stack, so arming twice cannot leave two
                // sweeps running against each other.
                if (existing) ctx.db.deleteScheduledTask(existing.id);
                const task = ctx.scheduler.scheduleTask({
                    chatId: '',
                    agentId: IMPROVE_AGENT_ID,
                    prompt: 'Self-improvement sweep and upstream update check',
                    schedule,
                });
                ctx.db.logAudit('improve', 'schedule', 'improve_armed', `Daily improvement armed (${schedule})`, false);
                ctx.broadcast('improve.armed', { schedule, nextRun: task.next_run });
                ctx._sendJson(res, 200, { ok: true, enabled: true, schedule, nextRun: task.next_run });
                return true;
            }

            if (existing) ctx.db.deleteScheduledTask(existing.id);
            ctx.db.logAudit('improve', 'schedule', 'improve_disarmed', 'Daily improvement disarmed', false);
            ctx.broadcast('improve.disarmed', {});
            ctx._sendJson(res, 200, { ok: true, enabled: false });
            return true;
        }
    }

    // --- Upstream check on its own, without the learning pass ---
    if (pathname === '/api/upstream') {
        if (!ctx.upstreamWatch) {
            ctx._sendJson(res, 503, { error: 'Upstream watch not configured' });
            return true;
        }
        if (req.method === 'GET') {
            const result = await ctx.upstreamWatch.checkAll();
            ctx._sendJson(res, 200, { ...result, digest: UpstreamWatch.formatDigest(result) });
            return true;
        }
        if (req.method === 'POST') {
            // Acknowledging marks the current heads as seen, so the next check
            // reports only what is newer.
            const body = await ctx._readBody(req);
            const result = await ctx.upstreamWatch.checkAll();
            const acked = body.acknowledge ? ctx.upstreamWatch.acknowledge(result.reports) : [];
            ctx._sendJson(res, 200, { ...result, acknowledged: acked });
            return true;
        }
    }

    // --- Syncthing: keep the shared brain identical across machines ---
    if (pathname === '/api/sync') {
        if (!ctx.syncthing) {
            ctx._sendJson(res, 503, { error: 'Syncthing bridge not configured' });
            return true;
        }

        if (req.method === 'GET') {
            // overview() never throws; an unreachable daemon is reported, not an error.
            ctx._sendJson(res, 200, await ctx.syncthing.overview());
            return true;
        }

        if (req.method === 'POST' || req.method === 'PATCH') {
            const body = await ctx._readBody(req);
            const action = String(body.action || '').trim();
            try {
                let result;
                switch (action) {
                    case 'add-device':
                        // The device ID must come from the operator. A pairing
                        // request is never auto-accepted: trusting an unknown
                        // ID would hand a stranger the whole vault.
                        result = await ctx.syncthing.addDevice(body.deviceId, body.name, body.addresses);
                        break;
                    case 'share-folder':
                        result = await ctx.syncthing.shareFolder(body.folderId, body.deviceId);
                        break;
                    case 'rescan':
                        result = await ctx.syncthing.rescan(body.folderId || null);
                        break;
                    case 'pause':
                        result = await ctx.syncthing.setPaused(body.folderId, true);
                        break;
                    case 'resume':
                        result = await ctx.syncthing.setPaused(body.folderId, false);
                        break;
                    default:
                        ctx._sendJson(res, 400, {
                            error: `Unknown sync action "${action}". `
                                + 'Expected add-device, share-folder, rescan, pause or resume.',
                        });
                        return true;
                }
                ctx.db.logAudit('sync', action, 'syncthing_action',
                    `Syncthing ${action}: ${JSON.stringify(result).slice(0, 200)}`, false);
                ctx.broadcast('sync.changed', { action, result });
                ctx._sendJson(res, 200, { ok: true, action, result });
            } catch (err) {
                ctx._sendJson(res, 400, { ok: false, action, error: err.message });
            }
            return true;
        }
    }

    return false;
}

/**
 * The self-improvement sweep: learn from recent turns, then report what landed
 * in the upstream projects this Agent OS draws its features from.
 *
 * Deliberately read-only with respect to upstream — it reports commits, it does
 * not merge them. Adopting an upstream change stays a human decision.
 */
async function runImprovement(ctx, { acknowledge = false } = {}) {
    const out = { learning: null, upstream: null, digest: null, errors: [] };

    if (ctx.selfImprovement) {
        try {
            out.learning = await ctx.selfImprovement.evaluateAndLearn('');
        } catch (err) {
            out.errors.push(`learning: ${err.message}`);
        }
    }

    if (ctx.upstreamWatch) {
        try {
            out.upstream = await ctx.upstreamWatch.checkAll();
            out.digest = UpstreamWatch.formatDigest(out.upstream);
            if (acknowledge) out.acknowledged = ctx.upstreamWatch.acknowledge(out.upstream.reports);
        } catch (err) {
            out.errors.push(`upstream: ${err.message}`);
        }
    }

    try {
        const insights = out.learning?.promotedRules?.length || 0;
        ctx.db.recordHiveMind('system', 'improve', 'improvement_sweep',
            `Self-improvement sweep: ${insights} rule(s) learned; `
            + `${out.upstream ? out.upstream.withUpdates : 0}/${out.upstream ? out.upstream.total : 0} upstream project(s) have new commits.`);
    } catch (err) {
        out.errors.push(`record: ${err.message}`);
    }

    return out;
}

module.exports = { handleRouterRoutes, runImprovement, IMPROVE_AGENT_ID };
