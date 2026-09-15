'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Key, RefreshCw, WifiOff } from 'lucide-react';
import { bridgeUrl } from '@/lib/config';

/** Same keys as AGENT_ENV_MAP in core/AgentOverrides.js — one switch each, never a master. */
const OVERRIDE_AGENTS = [
  { key: 'claude', name: 'Claude Code', emoji: '🟣', role: 'Lead Architect' },
  { key: 'codex', name: 'OpenAI Codex', emoji: '🟢', role: 'Full-Stack Coding' },
  { key: 'grok', name: 'Grok CLI', emoji: '⚪', role: 'Real-Time Telemetry' },
  { key: 'hermes', name: 'Hermes Agent', emoji: '🟠', role: 'Tool Reasoning' },
  { key: 'opencode', name: 'OpenCode CLI', emoji: '🟡', role: 'Multi-Provider Terminal' },
  { key: 'openclaw', name: 'OpenClaw Gateway', emoji: '🦞', role: 'Local Automation' },
  { key: 'pi', name: 'Pi Agent', emoji: '🥧', role: 'Lightweight Subtask Worker' },
  { key: 'antigravity', name: 'Google Antigravity', emoji: '🔵', role: 'Swarm Orchestration' },
] as const;

type AgentKey = (typeof OVERRIDE_AGENTS)[number]['key'];

/** UI-safe describe() payload. `apiKey` is already masked server-side. */
interface OverrideState {
  agentKey: string;
  supported: boolean;
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  hasApiKey: boolean;
  updatedAt: string | null;
}

type BridgeStatus = 'loading' | 'online' | 'offline' | 'unconfigured' | 'error';

const FETCH_TIMEOUT_MS = 8000;

function emptyState(agentKey: string): OverrideState {
  return {
    agentKey,
    supported: true,
    enabled: false,
    providerId: null,
    model: null,
    baseUrl: null,
    apiKey: null,
    hasApiKey: false,
    updatedAt: null,
  };
}

function asOverride(raw: unknown, fallbackKey: string): OverrideState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const agentKey = typeof o.agentKey === 'string' && o.agentKey ? o.agentKey : fallbackKey;
  return {
    agentKey,
    supported: o.supported !== false,
    enabled: o.enabled === true,
    providerId: typeof o.providerId === 'string' ? o.providerId : null,
    model: typeof o.model === 'string' && o.model ? o.model : null,
    baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : null,
    apiKey: typeof o.apiKey === 'string' && o.apiKey ? o.apiKey : null,
    hasApiKey: o.hasApiKey === true,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
  };
}

/** describeAll() is an object keyed by agent; tests sometimes stub an array. */
function parseOverrides(raw: unknown): Record<string, OverrideState> {
  const out: Record<string, OverrideState> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = asOverride(item, '');
      if (parsed && parsed.agentKey) out[parsed.agentKey] = parsed;
    }
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = asOverride(value, key);
    if (parsed) out[key] = parsed;
  }
  return out;
}

async function callOverride(
  method: 'GET' | 'POST',
  body?: { agentKey: string; enabled: boolean; model?: string }
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null; networkError: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(bridgeUrl('/api/agents/override'), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data, networkError: false };
  } catch {
    return { ok: false, status: 0, data: null, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

export default function AgentOverrideToggles() {
  const [status, setStatus] = useState<BridgeStatus>('loading');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, OverrideState>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [draftModels, setDraftModels] = useState<Record<string, string>>({});

  const applyMap = useCallback((raw: unknown) => {
    setOverrides(parseOverrides(raw));
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    setStatusDetail(null);
    const result = await callOverride('GET');
    if (result.networkError) {
      setStatus('offline');
      setStatusDetail('Bridge is offline. Overrides were not read and no switch was changed.');
      return;
    }
    if (result.status === 503) {
      setStatus('unconfigured');
      setStatusDetail(
        typeof result.data?.error === 'string'
          ? result.data.error
          : 'Agent overrides are not configured on the bridge.'
      );
      return;
    }
    if (!result.ok) {
      setStatus('error');
      setStatusDetail(
        typeof result.data?.error === 'string'
          ? result.data.error
          : `Bridge rejected GET /api/agents/override with HTTP ${result.status}.`
      );
      return;
    }
    applyMap(result.data?.overrides);
    setStatus('online');
    setRowErrors({});
  }, [applyMap]);

  useEffect(() => {
    load();
  }, [load]);

  const setPendingKey = (agentKey: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(agentKey);
      else next.delete(agentKey);
      return next;
    });
  };

  const handleToggle = async (agentKey: AgentKey, enabled: boolean) => {
    if (status !== 'online' || pending.has(agentKey)) return;
    setPendingKey(agentKey, true);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[agentKey];
      return next;
    });

    const model = draftModels[agentKey]?.trim();
    const body: { agentKey: string; enabled: boolean; model?: string } = { agentKey, enabled };
    if (enabled && model) body.model = model;

    const result = await callOverride('POST', body);

    if (result.networkError) {
      setStatus('offline');
      setStatusDetail('Bridge went offline. The switch was not changed.');
      setRowErrors((prev) => ({
        ...prev,
        [agentKey]: 'Bridge is offline — toggle was not applied.',
      }));
      setPendingKey(agentKey, false);
      return;
    }

    if (!result.ok || result.data?.ok === false) {
      const message =
        (typeof result.data?.error === 'string' && result.data.error) ||
        `Toggle failed (HTTP ${result.status}). The switch was not changed.`;
      setRowErrors((prev) => ({ ...prev, [agentKey]: message }));
      setPendingKey(agentKey, false);
      return;
    }

    if (result.data?.overrides) applyMap(result.data.overrides);
    else if (result.data?.override) {
      const parsed = asOverride(result.data.override, agentKey);
      if (parsed) setOverrides((prev) => ({ ...prev, [agentKey]: parsed }));
    }
    setPendingKey(agentKey, false);
  };

  const enabledCount = OVERRIDE_AGENTS.filter((a) => overrides[a.key]?.enabled).length;
  const switchesLive = status === 'online';

  return (
    <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <Key className="w-5 h-5 text-sky-400" />
          <span>OmniRouter Per-Agent Key</span>
          <span
            className={`text-xs font-mono px-2 py-0.5 rounded-full border ${
              switchesLive
                ? 'text-emerald-400 bg-emerald-950/80 border-emerald-800'
                : status === 'loading'
                ? 'text-sky-400 bg-blue-950/80 border-blue-800'
                : 'text-amber-400 bg-amber-950/80 border-amber-800'
            }`}
          >
            {status === 'loading'
              ? 'READING BRIDGE'
              : switchesLive
              ? `${enabledCount} / ${OVERRIDE_AGENTS.length} ROUTED`
              : status === 'offline'
              ? 'BRIDGE OFFLINE'
              : status === 'unconfigured'
              ? 'NOT CONFIGURED'
              : 'BRIDGE ERROR'}
          </span>
        </div>

        <button
          onClick={load}
          disabled={status === 'loading'}
          className="px-3.5 py-1.5 rounded-xl bg-[#080f24] hover:bg-blue-900/40 border border-blue-950 text-xs font-mono text-gray-300 hover:text-white transition-all flex items-center gap-1.5 self-start sm:self-auto disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${status === 'loading' ? 'animate-spin text-sky-400' : ''}`} />
          <span>{status === 'loading' ? 'Reading...' : 'Refresh Overrides'}</span>
        </button>
      </div>

      <p className="text-xs text-gray-400 max-w-3xl">
        One switch per agent — not a master switch. ON re-points that CLI at the router&apos;s
        single master API key (applied server-side). OFF restores the agent&apos;s own defaults.
        The raw key never leaves the bridge; only the masked value is shown.
      </p>

      {status !== 'online' && status !== 'loading' && (
        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-[#150808] border border-red-950/80 text-xs text-amber-200">
          {status === 'offline' ? (
            <WifiOff className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          )}
          <div>
            <div className="font-bold text-amber-300">
              {status === 'offline'
                ? 'Bridge offline — switches are disabled'
                : status === 'unconfigured'
                ? 'Overrides unavailable on this bridge'
                : 'Could not load override state'}
            </div>
            <div className="text-amber-200/80 mt-0.5 font-mono">
              {statusDetail || 'The bridge did not confirm this action. Nothing was changed.'}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        {OVERRIDE_AGENTS.map((agent) => {
          const state = overrides[agent.key] || emptyState(agent.key);
          const isPending = pending.has(agent.key);
          const canToggle = switchesLive && state.supported && !isPending;
          const rowError = rowErrors[agent.key];

          return (
            <div
              key={agent.key}
              className="p-3.5 rounded-xl bg-[#030612] border border-blue-950/80 space-y-2.5 hover:border-blue-900/60 transition-all"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xl p-2 rounded-lg bg-[#070d1e] border border-blue-950">
                    {agent.emoji}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-white">{agent.name}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-sky-400 border border-blue-900/60 uppercase">
                        {agent.key}
                      </span>
                      {state.enabled && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-600/20 text-sky-300 border border-blue-500/40">
                          USING MASTER KEY
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 truncate">{agent.role}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 self-start md:self-auto">
                  {isPending && (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" />
                  )}
                  <span className="text-[10px] font-mono font-bold text-gray-500 uppercase w-8 text-right">
                    {state.enabled ? 'ON' : 'OFF'}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state.enabled}
                    aria-label={`Route ${agent.name} through the OmniRouter master key`}
                    disabled={!canToggle}
                    onClick={() => handleToggle(agent.key, !state.enabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-all ${
                      state.enabled
                        ? 'bg-blue-600 border-blue-400/70 shadow-[0_0_12px_rgba(37,99,235,0.55)]'
                        : 'bg-[#0a1224] border-blue-950'
                    } ${canToggle ? 'cursor-pointer hover:border-blue-500/80' : 'opacity-40 cursor-not-allowed'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        state.enabled ? 'translate-x-[22px]' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {state.enabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] font-mono">
                  <div className="px-2.5 py-1.5 rounded-lg bg-[#070d1e] border border-blue-950 text-gray-400">
                    <span className="text-gray-600 block">Provider</span>
                    <span className="text-sky-300">{state.providerId || 'omnirouter'}</span>
                  </div>
                  <div className="px-2.5 py-1.5 rounded-lg bg-[#070d1e] border border-blue-950 text-gray-400">
                    <span className="text-gray-600 block">API key</span>
                    <span className="text-sky-300">
                      {state.apiKey || (state.hasApiKey ? 'set (masked)' : 'not set')}
                    </span>
                  </div>
                  <div className="px-2.5 py-1.5 rounded-lg bg-[#070d1e] border border-blue-950 text-gray-400">
                    <span className="text-gray-600 block">Model</span>
                    <span className="text-sky-300">{state.model || 'router default'}</span>
                  </div>
                </div>
              )}

              {!state.enabled && switchesLive && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draftModels[agent.key] || ''}
                    onChange={(e) =>
                      setDraftModels((prev) => ({ ...prev, [agent.key]: e.target.value }))
                    }
                    placeholder="model (optional) — sent only when you turn this on"
                    disabled={!canToggle}
                    className="flex-1 bg-[#02050f] text-white placeholder-gray-700 text-[11px] font-mono rounded-lg px-3 py-1.5 border border-blue-950 focus:outline-none focus:border-blue-500 transition-all disabled:opacity-50"
                  />
                </div>
              )}

              {rowError && (
                <div className="text-[11px] font-mono text-red-400 bg-red-950/40 border border-red-900/60 rounded-lg px-2.5 py-1.5">
                  {rowError}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
