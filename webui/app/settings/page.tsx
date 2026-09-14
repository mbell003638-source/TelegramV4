'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Settings as SettingsIcon, 
  FolderSync, 
  RefreshCw, 
  Terminal, 
  Cpu, 
  ShieldCheck, 
  ArrowLeft, 
  Check, 
  Radio, 
  ExternalLink,
  Save,
  Server
} from 'lucide-react';
import { AgentInfo } from '@/lib/types';

export default function SettingsPage() {
  const [vaultPath, setVaultPath] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [savingVault, setSavingVault] = useState(false);
  const [saveVaultSuccess, setSaveVaultSuccess] = useState(false);
  const [bridgeOnline, setBridgeOnline] = useState(false);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.ok) {
        setVaultPath(data.vaultPath || '');
      }
    } catch {}
  };

  const fetchAgents = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      if (data.ok) {
        setAgents(data.agents);
      }
    } catch {}
    finally {
      setScanning(false);
    }
  };

  const checkBridge = async () => {
    try {
      const res = await fetch('http://localhost:3141/api/warroom/voices?token=earlyaidopters', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        setBridgeOnline(true);
      } else {
        setBridgeOnline(false);
      }
    } catch {
      setBridgeOnline(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    fetchAgents();
    checkBridge();
  }, []);

  const handleSaveVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingVault(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultPath }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveVaultSuccess(true);
        setTimeout(() => setSaveVaultSuccess(false), 2500);
      }
    } catch {
      // ignore
    } finally {
      setSavingVault(false);
    }
  };

  const liveAgents = agents.filter(a => a.status === 'live');

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      {/* Top Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="p-2.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-white hover:border-blue-500/50 transition-all"
          title="Return to Mission Control"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight flex items-center gap-2">
            <SettingsIcon className="w-6 h-6 text-sky-400" />
            System Architecture &amp; Settings
          </h1>
          <p className="text-xs text-gray-400 mt-1">
            Configure Obsidian Second Brain persistence, inspect discovered AI binaries, and monitor bridge status.
          </p>
        </div>
      </div>

      {/* Obsidian Vault Configuration */}
      <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <FolderSync className="w-5 h-5 text-purple-400" />
            <span>Obsidian Second Brain Integration</span>
          </div>
          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-purple-950/80 text-purple-300 border border-purple-800">
            AUTO-DIRECTORY PROVISIONING
          </span>
        </div>

        <p className="text-xs text-gray-400 max-w-2xl">
          Specify the absolute root path to your Obsidian vault. Agentic OS automatically creates and manages the <code className="text-sky-300">Agentic OS/chats</code>, <code className="text-sky-300">Agentic OS/goals</code>, and <code className="text-sky-300">Agentic OS/journal</code> directories.
        </p>

        <form onSubmit={handleSaveVault} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              placeholder="C:\Users\username\Documents\ObsidianVault"
              className="flex-1 bg-[#030612] text-white placeholder-gray-600 text-sm font-mono rounded-xl px-4 py-2.5 border border-blue-950 focus:outline-none focus:border-blue-500 transition-all"
            />
            <button
              type="submit"
              disabled={savingVault}
              className={`px-5 py-2.5 rounded-xl text-xs font-bold font-mono transition-all flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(37,99,235,0.3)] ${
                saveVaultSuccess
                  ? 'bg-emerald-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {saveVaultSuccess ? (
                <>
                  <Check className="w-4 h-4 text-emerald-200" />
                  <span>Vault Connected</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>{savingVault ? 'Verifying...' : 'Save Vault Path'}</span>
                </>
              )}
            </button>
          </div>
        </form>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs font-mono text-gray-400">
          <div className="p-2.5 rounded-xl bg-[#030612] border border-blue-950">
            <span className="text-gray-500 block">Chats Folder:</span>
            <span className="text-sky-300 truncate block">.../Agentic OS/chats/</span>
          </div>
          <div className="p-2.5 rounded-xl bg-[#030612] border border-blue-950">
            <span className="text-gray-500 block">Goals File:</span>
            <span className="text-sky-300 truncate block">.../Agentic OS/goals/goals.md</span>
          </div>
          <div className="p-2.5 rounded-xl bg-[#030612] border border-blue-950">
            <span className="text-gray-500 block">Journal Folder:</span>
            <span className="text-sky-300 truncate block">.../Agentic OS/journal/</span>
          </div>
        </div>
      </div>

      {/* Local Agent Binary Scanner */}
      <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Terminal className="w-5 h-5 text-sky-400" />
            <span>AI Engines &amp; CLI Binary Scanner</span>
            <span className="text-xs font-mono text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded-full border border-emerald-800">
              {liveAgents.length} / {agents.length} Detected
            </span>
          </div>

          <button
            onClick={fetchAgents}
            disabled={scanning}
            className="px-3.5 py-1.5 rounded-xl bg-[#080f24] hover:bg-blue-900/40 border border-blue-950 text-xs font-mono text-gray-300 hover:text-white transition-all flex items-center gap-1.5 self-start sm:self-auto"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-sky-400' : ''}`} />
            <span>{scanning ? 'Scanning...' : 'Rescan Local CLIs'}</span>
          </button>
        </div>

        <div className="space-y-2.5">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="p-3.5 rounded-xl bg-[#030612] border border-blue-950/80 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:border-blue-900/60 transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xl p-2 rounded-lg bg-[#070d1e] border border-blue-950">{agent.emoji}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white">{agent.name}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-950 text-sky-400 border border-blue-900/60 uppercase">
                      {agent.id}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate">{agent.role}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                {agent.binaryPath ? (
                  <div className="flex items-center gap-1.5 text-sky-300 bg-[#070d1e] px-2.5 py-1 rounded-lg border border-blue-950 max-w-sm truncate" title={agent.binaryPath}>
                    <Terminal className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                    <span className="truncate">{agent.binaryPath}</span>
                  </div>
                ) : (
                  <span className="text-gray-500 italic">Virtual Bridge Engine</span>
                )}

                <span
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border flex items-center gap-1.5 ${
                    agent.status === 'live'
                      ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                      : agent.status === 'standby'
                      ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                      : 'bg-red-950/80 text-red-400 border-red-800'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${agent.status === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  {agent.status.toUpperCase()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Local Bridge Server Status */}
      <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Server className="w-5 h-5 text-sky-400" />
            <span>Local Bridge Daemon Telemetry</span>
          </div>
          <span 
            className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold border ${
              bridgeOnline 
                ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                : 'bg-amber-950 text-amber-400 border-amber-800'
            }`}
          >
            {bridgeOnline ? 'BRIDGE ACTIVE (PORT 3141)' : 'STANDALONE MODE ACTIVE'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs font-mono">
          <div className="p-3 rounded-xl bg-[#030612] border border-blue-950 space-y-1">
            <span className="text-gray-500 block">Bridge HTTP Port:</span>
            <span className="text-white font-bold">3141</span>
          </div>
          <div className="p-3 rounded-xl bg-[#030612] border border-blue-950 space-y-1">
            <span className="text-gray-500 block">Access Token:</span>
            <span className="text-sky-300">earlyaidopters</span>
          </div>
          <div className="p-3 rounded-xl bg-[#030612] border border-blue-950 space-y-1">
            <span className="text-gray-500 block">Telegram Poller Safety:</span>
            <span className="text-emerald-400 font-bold">DISABLE_TELEGRAM=true (Safe)</span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-[#02050f] border border-blue-950/60 flex items-center justify-between text-xs text-gray-400">
          <span>Mission Control Dashboard URL:</span>
          <a
            href="http://localhost:3141/?token=earlyaidopters"
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-mono"
          >
            <span>http://localhost:3141/?token=earlyaidopters</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
