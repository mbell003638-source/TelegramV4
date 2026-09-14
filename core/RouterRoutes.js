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

    return false;
}

module.exports = { handleRouterRoutes };
