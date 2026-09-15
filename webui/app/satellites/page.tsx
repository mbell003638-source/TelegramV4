'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  Satellite,
  Radio,
  Monitor,
  Lock,
  Terminal,
  Info,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { BRIDGE_URL, bridgeUrl } from '@/lib/config';

interface SatelliteInfo {
  id: string;
  hostname: string;
  platform: string;
  ip: string;
  online: boolean;
  lastSeenSecondsAgo: number;
  systemInfo?: {
    cpuCores?: number;
    cpuModel?: string;
    totalMemMb?: number;
    freeMemMb?: number;
    usedMemMb?: number;
    uptimeSeconds?: number;
    arch?: string;
    release?: string;
  };
  pendingCommandsCount?: number;
}

interface HubStatus {
  hub?: string;
  totalRegistered?: number;
  onlineCount?: number;
  satellites?: SatelliteInfo[];
}

const ACTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'sys.info', label: 'System info', hint: 'CPU / RAM / uptime from the worker' },
  { id: 'screen.capture', label: 'Screenshot', hint: 'Capture the remote desktop' },
  { id: 'pc.lock', label: 'Lock workstation', hint: 'Lock the remote Windows session' },
  { id: 'cmd.exec', label: 'Run command', hint: 'PowerShell on the remote PC' },
  { id: 'notify.toast', label: 'Toast', hint: 'Show a local notification on the PC' },
];

export default function SatellitesPage() {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [action, setAction] = useState('sys.info');
  const [command, setCommand] = useState('hostname');
  const [toastTitle, setToastTitle] = useState('ClaudeClaw');
  const [toastMessage, setToastMessage] = useState('Task complete');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  const workerCmd = `node satellite/desktop-worker.js --url ${BRIDGE_URL} --key YOUR_SATELLITE_KEY --id windows-desktop`;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(bridgeUrl('/api/satellite/status'));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: HubStatus = await res.json();
      setStatus(data);
      setError(null);
      setSelectedId((prev) => {
        if (prev && (data.satellites || []).some((s) => s.id === prev)) return prev;
        const firstOnline = (data.satellites || []).find((s) => s.online);
        return firstOnline?.id || data.satellites?.[0]?.id || '';
      });
    } catch (e: any) {
      setError(e.message || 'Could not reach satellite hub');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 5000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(workerCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setDispatching(true);
    setDispatchError(null);
    setResult(null);
    const params: Record<string, string> = {};
    if (action === 'cmd.exec') params.command = command;
    if (action === 'notify.toast') {
      params.title = toastTitle;
      params.message = toastMessage;
    }
    if (action === 'screen.capture') params.format = 'png';
    try {
      const res = await fetch(bridgeUrl('/api/satellite/dispatch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          params,
          satelliteId: selectedId || undefined,
          timeoutMs: action === 'cmd.exec' ? 30000 : 20000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(data.result);
      fetchStatus();
    } catch (err: any) {
      setDispatchError(err.message || 'Dispatch failed');
    } finally {
      setDispatching(false);
    }
  };

  const satellites = status?.satellites || [];
  const onlineCount = status?.onlineCount ?? 0;

  return (
    <div className="flex flex-col min-h-full">
      <header className="px-6 py-4 border-b border-[#121929] flex items-center justify-between bg-[#03050a]">
        <div className="flex items-center gap-3">
          <Link href="/" className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/[0.04]">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="w-9 h-9 rounded-xl bg-cyan-950/80 border border-cyan-800/50 flex items-center justify-center">
            <Satellite className="w-4 h-4 text-cyan-300" />
          </div>
          <div>
            <div className="text-sm font-black tracking-wider text-white">SATELLITES</div>
            <p className="text-xs text-gray-400">
              Remote workers polling this VPS — {onlineCount} online
            </p>
          </div>
        </div>
        <button
          onClick={fetchStatus}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-xs font-mono text-sky-400 hover:border-blue-500/60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </header>

      <div className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 space-y-4">
          {error && (
            <div className="rounded-2xl border border-red-900/50 bg-red-950/40 px-4 py-3 text-xs text-red-300 font-mono flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {loading && !status ? (
            <div className="text-xs font-mono text-gray-500">Contacting satellite hub…</div>
          ) : satellites.length === 0 ? (
            <div className="rounded-3xl border border-blue-900/40 bg-[#050711] p-8 text-center space-y-3">
              <Radio className="w-8 h-8 text-cyan-500 mx-auto" />
              <div className="text-sm font-semibold text-white">No workers registered</div>
              <p className="text-xs text-gray-400 max-w-md mx-auto">
                The VPS cannot dial a NAT&apos;d PC. Start the satellite worker on the second machine so it can poll this hub.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {satellites.map((sat) => {
                const selected = sat.id === selectedId;
                const mem = sat.systemInfo;
                return (
                  <button
                    key={sat.id}
                    onClick={() => setSelectedId(sat.id)}
                    className={`w-full text-left rounded-2xl border p-4 transition-all ${
                      selected
                        ? 'bg-cyan-950/40 border-cyan-500/50 shadow-[0_0_20px_rgba(34,211,238,0.12)]'
                        : 'bg-[#050711] border-blue-900/40 hover:border-blue-500/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`inline-block w-2.5 h-2.5 rounded-full ${
                            sat.online
                              ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                              : 'bg-gray-600'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white truncate">{sat.hostname}</div>
                          <div className="text-[11px] font-mono text-gray-400 truncate">
                            {sat.id} · {sat.platform} · {sat.ip}
                          </div>
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md border ${
                        sat.online
                          ? 'text-emerald-300 border-emerald-800/50 bg-emerald-950/40'
                          : 'text-gray-400 border-gray-800 bg-black'
                      }`}>
                        {sat.online ? 'ONLINE' : `seen ${sat.lastSeenSecondsAgo}s ago`}
                      </span>
                    </div>
                    {mem && (mem.totalMemMb || mem.cpuCores) && (
                      <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-mono text-gray-400">
                        <div>CPU {mem.cpuCores || '—'} cores</div>
                        <div>
                          RAM {mem.freeMemMb ?? '—'} / {mem.totalMemMb ?? '—'} MB free
                        </div>
                        <div>queue {sat.pendingCommandsCount || 0}</div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          <form onSubmit={handleDispatch} className="rounded-3xl border border-blue-900/40 bg-[#050711] p-5 space-y-4">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest">Dispatch</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-[11px] font-mono text-gray-400 space-y-1">
                Action
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  className="w-full bg-black border border-blue-900/40 rounded-xl px-3 py-2 text-xs text-white"
                >
                  {ACTIONS.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </label>
              <div className="text-[11px] text-gray-500 flex items-end pb-2">
                {ACTIONS.find((a) => a.id === action)?.hint}
              </div>
            </div>
            {action === 'cmd.exec' && (
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="PowerShell command"
                className="w-full bg-black border border-blue-900/40 rounded-xl px-3 py-2 text-xs font-mono text-white"
              />
            )}
            {action === 'notify.toast' && (
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={toastTitle}
                  onChange={(e) => setToastTitle(e.target.value)}
                  placeholder="Title"
                  className="bg-black border border-blue-900/40 rounded-xl px-3 py-2 text-xs text-white"
                />
                <input
                  value={toastMessage}
                  onChange={(e) => setToastMessage(e.target.value)}
                  placeholder="Message"
                  className="bg-black border border-blue-900/40 rounded-xl px-3 py-2 text-xs text-white"
                />
              </div>
            )}
            <button
              type="submit"
              disabled={dispatching || onlineCount === 0}
              className="px-4 py-2 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-xs font-semibold"
            >
              {dispatching ? 'Waiting on worker…' : `Run on ${selectedId || 'first online worker'}`}
            </button>
            {dispatchError && (
              <div className="text-xs text-red-400 font-mono">{dispatchError}</div>
            )}
            {result && (
              <div className="rounded-xl border border-blue-900/40 bg-black p-3 space-y-2">
                {result.base64 && result.format === 'png' ? (
                  <img
                    alt="Remote screenshot"
                    src={`data:image/png;base64,${result.base64}`}
                    className="w-full rounded-lg border border-blue-950"
                  />
                ) : (
                  <pre className="text-[11px] font-mono text-sky-200 whitespace-pre-wrap break-all max-h-72 overflow-auto">
                    {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </form>
        </div>

        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-3xl border border-blue-900/40 bg-[#050711] p-5 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
              <Monitor className="w-3.5 h-3.5 text-cyan-400" />
              Connect a second PC
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              This VPS cannot reach a machine behind NAT. You have to start the worker
              on that PC so it long-polls <span className="font-mono text-sky-300">{BRIDGE_URL}</span>.
              The token is <span className="font-mono text-sky-300">SATELLITE_KEY</span> from the VPS
              <span className="font-mono"> .env</span> (falls back to <span className="font-mono">DASHBOARD_TOKEN</span>).
            </p>
            <div className="relative">
              <pre className="text-[11px] font-mono text-sky-200 bg-black border border-blue-900/40 rounded-xl p-3 pr-10 whitespace-pre-wrap break-all">
                {workerCmd}
              </pre>
              <button
                onClick={handleCopy}
                className="absolute top-2 right-2 p-1.5 rounded-lg text-gray-400 hover:text-white"
                title="Copy"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <ul className="text-[11px] text-gray-500 space-y-1.5 list-disc pl-4">
              <li>Copy <span className="font-mono">satellite/</span> onto the second PC (Node.js installed).</li>
              <li>Replace <span className="font-mono">YOUR_SATELLITE_KEY</span> with the VPS secret. Do not paste it here.</li>
              <li>Leave the worker running. If it dies, the master has nobody to dispatch to.</li>
            </ul>
          </div>

          <div className="rounded-3xl border border-blue-900/40 bg-[#050711] p-5 space-y-2 text-[11px] text-gray-400">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
              <Info className="w-3.5 h-3.5 text-sky-400" />
              Capabilities
            </div>
            <div className="flex items-center gap-2"><Monitor className="w-3.5 h-3.5 text-sky-400" /> Screenshot of the remote desktop</div>
            <div className="flex items-center gap-2"><Lock className="w-3.5 h-3.5 text-amber-400" /> Lock the Windows workstation</div>
            <div className="flex items-center gap-2"><Terminal className="w-3.5 h-3.5 text-emerald-400" /> PowerShell / cmd on the remote PC</div>
            <p className="pt-2 text-gray-500">
              Telegram: <span className="font-mono">/screen</span>, <span className="font-mono">/lock</span>,
              <span className="font-mono"> /win</span>, <span className="font-mono">/satellite</span>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
