'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { 
  LayoutDashboard, 
  CheckSquare, 
  BookOpen, 
  Settings, 
  FolderSync, 
  ChevronRight,
  ChevronDown,
  Sparkles,
  Zap,
  Smartphone,
  Satellite,
  Globe,
  MessageSquare,
  Trash2
} from 'lucide-react';
import { AgentInfo } from '@/lib/types';

const INITIAL_AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    emoji: '🟣',
    role: 'Lead Architect & Strategic Planning',
    model: 'claude-opus-5',
    availableModels: ['default', 'claude-opus-5'],
    status: 'live',
    description: 'Anthropic Claude Code CLI subprocess with autonomous tool execution.',
    category: 'core',
    binaryPath: null
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    emoji: '🟢',
    role: 'Full-Stack Coding & Test Execution',
    model: 'gpt-5.6-luna',
    availableModels: ['default'],
    status: 'live',
    description: 'High-speed coding execution engine with full filesystem access.',
    category: 'coding',
    binaryPath: null
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    emoji: '🔵',
    role: 'Swarm Orchestration & Codebase Indexing',
    model: 'gemini-3.7-pro',
    availableModels: ['default'],
    status: 'live',
    description: 'Google Deepmind Advanced Agentic Coding engine.',
    category: 'router',
    binaryPath: null
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    emoji: '⚪',
    role: 'Real-Time Telemetry & Analysis',
    model: 'grok-4.6',
    availableModels: ['default', 'grok-4.6'],
    status: 'live',
    description: 'xAI Grok terminal intelligence with real-time web telemetry.',
    category: 'core',
    binaryPath: null
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    emoji: '🟠',
    role: 'Tool Reasoning & Scratchpad Planning',
    model: 'hermes-3-llama-3.1-70b',
    availableModels: ['default'],
    status: 'live',
    description: 'Nous Research Hermes agent with scratchpad and function call synthesis.',
    category: 'core',
    binaryPath: null
  },
  {
    id: 'opencode',
    name: 'OpenCode CLI',
    emoji: '🟡',
    role: 'Multi-Provider Terminal Assistant',
    model: 'deepseek-coder-v2',
    availableModels: ['default'],
    status: 'live',
    description: 'OpenCode terminal engine supporting OpenRouter, DeepSeek, and Anthropic.',
    category: 'coding',
    binaryPath: null
  },
  {
    id: 'openclaw',
    name: 'OpenClaw Gateway',
    emoji: '🦞',
    role: 'Local Automation & Hardware Controller',
    model: 'openclaw-v4-universal',
    availableModels: ['default'],
    status: 'live',
    description: 'Self-hosted agent gateway and daemon connecting local hardware.',
    category: 'system',
    binaryPath: null
  },
  {
    id: 'pi',
    name: 'Pi Agent',
    emoji: '🥧',
    role: 'Lightweight Subtask Worker',
    model: 'inflection-2.5',
    availableModels: ['default'],
    status: 'live',
    description: 'Ultra-fast subtask execution engine for micro-delegation.',
    category: 'system',
    binaryPath: null
  }
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const currentAgentFromPath = pathname.startsWith('/agents/') ? pathname.split('/')[2] : '';
  const [agents, setAgents] = useState<AgentInfo[]>(INITIAL_AGENTS);
  const [vaultPath, setVaultPath] = useState<string>('');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>(() => {
    return currentAgentFromPath ? { [currentAgentFromPath]: true } : {};
  });
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, any[]>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/agents')
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.agents) setAgents(data.agents);
      })
      .catch(() => {});

    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.ok) setVaultPath(data.vaultPath);
      })
      .catch(() => {});
  }, []);

  const loadSessionsForAgent = async (agentId: string) => {
    try {
      const res = await fetch(`/api/sessions?agentId=${agentId}`);
      const data = await res.json();
      if (data.ok && data.sessions) {
        setSessionsByAgent(prev => ({ ...prev, [agentId]: data.sessions }));
      }
    } catch {}
  };

  // Sync active agent and its sessions when URL pathname or search changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      setActiveSessionId(sp.get('session'));
    }

    if (pathname.startsWith('/agents/')) {
      const currentAgentId = pathname.split('/')[2];
      if (currentAgentId) {
        setExpandedAgents(prev => ({ ...prev, [currentAgentId]: true }));
        loadSessionsForAgent(currentAgentId);
      }
    }
  }, [pathname]);

  // Listen for session updates from chat page
  useEffect(() => {
    const handleSessionsUpdated = (e: any) => {
      const aId = e.detail?.agentId;
      if (aId) {
        loadSessionsForAgent(aId);
      } else if (pathname.startsWith('/agents/')) {
        const currentAgentId = pathname.split('/')[2];
        if (currentAgentId) loadSessionsForAgent(currentAgentId);
      }

      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        setActiveSessionId(sp.get('session'));
      }
    };

    window.addEventListener('sessions-updated', handleSessionsUpdated);
    return () => window.removeEventListener('sessions-updated', handleSessionsUpdated);
  }, [pathname]);

  const handleNewSession = (agentId: string) => {
    const newSessionId = `session_${Date.now()}`;
    setActiveSessionId(newSessionId);
    setExpandedAgents(prev => ({ ...prev, [agentId]: true }));
    router.push(`/agents/${agentId}?session=${newSessionId}`);
    window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId, sessionId: newSessionId } }));
  };

  const handleSelectSession = (agentId: string, sId: string) => {
    setActiveSessionId(sId);
    router.push(`/agents/${agentId}?session=${sId}`);
  };

  const handleDeleteSession = async (agentId: string, sId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm('Delete this conversation session?')) return;
    try {
      await fetch(`/api/sessions?agentId=${agentId}&sessionId=${sId}`, { method: 'DELETE' });
      loadSessionsForAgent(agentId);
      window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId } }));
      if (activeSessionId === sId) {
        handleNewSession(agentId);
      }
    } catch {}
  };

  const toggleAgentExpand = (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setExpandedAgents(prev => {
      const nextState = !prev[agentId];
      if (nextState) loadSessionsForAgent(agentId);
      return { ...prev, [agentId]: nextState };
    });
  };

  const liveCount = agents.filter(a => a.status === 'live').length;

  return (
    <aside className="w-64 h-screen bg-[#000000] border-r border-[#121929] flex flex-col z-30 select-none">
      {/* Top Brand / Logo */}
      <div className="p-4 border-b border-[#121929] flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-800 flex items-center justify-center text-white shadow-[0_0_15px_rgba(37,99,235,0.5)] group-hover:shadow-[0_0_25px_rgba(56,189,248,0.7)] transition-all">
            <Zap className="w-5 h-5 text-sky-300" />
          </div>
          <div>
            <div className="text-sm font-black tracking-wider text-white flex items-center gap-1.5">
              AGENTIC<span className="text-sky-400">OS</span>
            </div>
            <div className="text-[10px] text-gray-500 font-mono flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              {liveCount} / {agents.length || 8} CLIs LIVE
            </div>
          </div>
        </Link>
      </div>

      {/* Main Navigation */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* Core Sections */}
        <div>
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 font-mono">
            Control Plane
          </div>
          <div className="space-y-1">
            <Link
              href="/"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <LayoutDashboard className="w-4 h-4 text-blue-400" />
                <span>Mission Control</span>
              </div>
            </Link>

            <Link
              href="/goals"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/goals'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <CheckSquare className="w-4 h-4 text-emerald-400" />
                <span>Goals & Tasks</span>
              </div>
              <span className="text-[10px] bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 px-1.5 py-0.5 rounded-md font-mono">
                Obsidian
              </span>
            </Link>

            <Link
              href="/journal"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/journal'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <BookOpen className="w-4 h-4 text-sky-400" />
                <span>Daily Journal</span>
              </div>
              <span className="text-[10px] bg-sky-950/60 text-sky-400 border border-sky-800/40 px-1.5 py-0.5 rounded-md font-mono">
                Voice
              </span>
            </Link>

            <Link
              href="/devices"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/devices'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Smartphone className="w-4 h-4 text-amber-400" />
                <span>The Hands (ADB)</span>
              </div>
              <span className="text-[10px] bg-amber-950/60 text-amber-300 border border-amber-800/40 px-1.5 py-0.5 rounded-md font-mono">
                ULTRON
              </span>
            </Link>

            <Link
              href="/satellites"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/satellites'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Satellite className="w-4 h-4 text-cyan-400" />
                <span>Satellites</span>
              </div>
              <span className="text-[10px] bg-cyan-950/60 text-cyan-300 border border-cyan-800/40 px-1.5 py-0.5 rounded-md font-mono">
                VPS
              </span>
            </Link>

            <Link
              href="/vault"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/vault'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <FolderSync className="w-4 h-4 text-purple-400" />
                <span>Memory Vault</span>
              </div>
              <span className="text-[10px] bg-purple-950/60 text-purple-300 border border-purple-800/40 px-1.5 py-0.5 rounded-md font-mono">
                Notes
              </span>
            </Link>

            <Link
              href="/globe"
              className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                pathname === '/globe'
                  ? 'bg-blue-600/15 text-sky-400 border border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Globe className="w-4 h-4 text-sky-400" />
                <span>3D Vault Globe</span>
              </div>
              <span className="text-[10px] bg-sky-950/60 text-sky-300 border border-sky-800/40 px-1.5 py-0.5 rounded-md font-mono">
                3D
              </span>
            </Link>
          </div>
        </div>

        {/* AI Agent Swarm Sections */}
        <div>
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 font-mono flex items-center justify-between">
            <span>AI Agents Swarm</span>
            <Sparkles className="w-3 h-3 text-sky-400" />
          </div>
          <div className="space-y-1.5">
            {agents.map((agent) => {
              const isCurrentAgent = pathname === `/agents/${agent.id}`;
              const isExpanded = expandedAgents[agent.id] ?? isCurrentAgent;
              const isLive = agent.status === 'live';
              const agentSessions = sessionsByAgent[agent.id] || [];

              return (
                <div key={agent.id} className="space-y-1">
                  <div
                    onClick={() => {
                      router.push(`/agents/${agent.id}`);
                      setExpandedAgents(prev => ({ ...prev, [agent.id]: true }));
                      loadSessionsForAgent(agent.id);
                    }}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                      isCurrentAgent
                        ? 'bg-blue-600/20 text-white border border-blue-500/40 shadow-[0_0_20px_rgba(59,130,246,0.25)]'
                        : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-base">{agent.emoji}</span>
                      <span className="truncate">{agent.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          isLive
                            ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                            : agent.status === 'standby'
                            ? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]'
                            : 'bg-gray-600'
                        }`}
                        title={agent.status}
                      />
                      <button
                        onClick={(e) => toggleAgentExpand(agent.id, e)}
                        className="text-gray-500 hover:text-white p-0.5 rounded transition"
                        title={isExpanded ? 'Collapse sessions' : 'Expand sessions'}
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Sessions Sub-Tree under the Agent */}
                  {isExpanded && (
                    <div className="ml-3 pl-2.5 border-l border-blue-900/40 space-y-1 py-1">
                      {/* Past Sessions List (New Session is handled by the tab bar on the chat page) */}
                      {agentSessions.length > 0 && (
                        <div className="space-y-0.5 max-h-48 overflow-y-auto pr-1">
                          {agentSessions.map((s) => {
                            const isActive = isCurrentAgent && activeSessionId === s.id;
                            return (
                              <div
                                key={s.id}
                                onClick={() => handleSelectSession(agent.id, s.id)}
                                className={`group flex items-center justify-between px-2 py-1.5 rounded-lg text-[11px] font-mono cursor-pointer transition-all ${
                                  isActive
                                    ? 'bg-blue-600/30 text-white font-semibold border border-sky-400/60 shadow-[0_0_12px_rgba(56,189,248,0.35)]'
                                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]'
                                }`}
                                title={s.title || 'Session'}
                              >
                                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                  <MessageSquare className={`w-3 h-3 shrink-0 ${isActive ? 'text-sky-300' : 'text-gray-600'}`} />
                                  <span className="truncate">{s.title || 'Conversation'}</span>
                                </div>
                                <button
                                  onClick={(e) => handleDeleteSession(agent.id, s.id, e)}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-500 hover:text-red-400 transition shrink-0 ml-1"
                                  title="Delete Session"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer Obsidian Vault Status */}
      <div className="p-3 border-t border-[#121929] bg-[#03050a] space-y-2">
        <Link
          href="/settings"
          className="flex items-center justify-between p-2 rounded-xl text-xs text-gray-400 hover:text-white hover:bg-white/[0.04] transition-all"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FolderSync className="w-4 h-4 text-purple-400 shrink-0" />
            <div className="truncate">
              <div className="text-[11px] font-semibold text-gray-300">Obsidian Vault</div>
              <div className="text-[9px] text-gray-400 truncate font-mono">{vaultPath || 'Connecting...'}</div>
            </div>
          </div>
          <Settings className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        </Link>
      </div>
    </aside>
  );
}
