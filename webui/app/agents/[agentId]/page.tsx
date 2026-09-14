'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { 
  Send, 
  ArrowLeft, 
  FolderSync, 
  Trash2, 
  Cpu, 
  Sparkles, 
  Check, 
  Copy, 
  ChevronDown,
  Terminal,
  ShieldCheck,
  Zap,
  CornerDownLeft,
  History,
  Plus,
  X,
  MessageSquare
} from 'lucide-react';
import VoiceButton from '@/components/VoiceButton';
import { AgentInfo, ChatMessage } from '@/lib/types';
import ReactiveOrb, { OrbState } from '@/components/ReactiveOrb';

const KNOWN_AGENTS: Record<string, AgentInfo> = {
  antigravity: {
    id: 'antigravity',
    name: 'Google Antigravity',
    emoji: '🔵',
    role: 'Swarm Orchestration & Codebase Indexing',
    model: 'gemini-3.7-pro',
    availableModels: ['default', 'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.6-flash-high', 'claude-sonnet-4-6'],
    status: 'live',
    description: 'Google Deepmind Advanced Agentic Coding engine with multi-agent coordination, subagents, and skills.',
    category: 'router',
    binaryPath: 'C:\\Users\\just2\\AppData\\Local\\agy\\bin\\agy.exe'
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    emoji: '🟣',
    role: 'Lead Architect & Strategic Planning',
    model: 'claude-opus-5',
    availableModels: ['default', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-3-7-sonnet'],
    status: 'live',
    description: 'Anthropic Claude Code CLI subprocess with autonomous tool execution.',
    category: 'core',
    binaryPath: 'C:\\Users\\just2\\.local\\bin\\claude.exe'
  },
  grok: {
    id: 'grok',
    name: 'Grok CLI',
    emoji: '⚪',
    role: 'Real-Time Telemetry & Analysis',
    model: 'grok-4.6',
    availableModels: ['default', 'grok-4.6', 'grok-4.5'],
    status: 'live',
    description: 'xAI Grok terminal intelligence with real-time web telemetry and uncensored analysis.',
    category: 'core',
    binaryPath: 'C:\\Users\\just2\\.grok\\bin\\grok.exe'
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes Agent',
    emoji: '🟠',
    role: 'Tool Reasoning & Scratchpad Planning',
    model: 'hermes-3-llama-3.1-70b',
    availableModels: ['default'],
    status: 'live',
    description: 'Nous Research Hermes agent with scratchpad and function call synthesis.',
    category: 'core',
    binaryPath: 'C:\\Users\\just2\\AppData\\Local\\hermes\\bin\\hermes.exe'
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    emoji: '🟢',
    role: 'Full-Stack Coding & Test Execution',
    model: 'gpt-5.6-luna',
    availableModels: ['default', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'],
    status: 'live',
    description: 'High-speed coding execution engine with full filesystem access.',
    category: 'coding',
    binaryPath: 'C:\\Users\\just2\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
  }
};

export default function AgentChatPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = typeof params?.agentId === 'string' ? params.agentId : '';

  const initialAgent = KNOWN_AGENTS[agentId.toLowerCase()] || null;
  const [agent, setAgent] = useState<AgentInfo | null>(initialAgent);
  const [loadingAgent, setLoadingAgent] = useState(!initialAgent);
  const [selectedModel, setSelectedModel] = useState<string>(initialAgent?.model || '');
  const [selectedEffort, setSelectedEffort] = useState<string>('medium');
  const [customModelMode, setCustomModelMode] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialAgent ? [{
    id: 'welcome',
    role: 'agent',
    speaker: initialAgent.name,
    text: `Greetings. I am ${initialAgent.name}, operating as ${initialAgent.role}. Direct CLI execution and Obsidian sync are active. What objective are we executing?`,
    timestamp: Date.now(),
    agentId: initialAgent.id,
  }] : []);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedBadge, setSavedBadge] = useState(false);
  const [sessionId, setSessionId] = useState<string>(() => `session_${Date.now()}`);
  const [sessions, setSessions] = useState<any[]>([]);
  const [showSessionsDrawer, setShowSessionsDrawer] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadSessionsList = async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/sessions?agentId=${agentId}`);
      const data = await res.json();
      if (data.ok && data.sessions) {
        setSessions(data.sessions);
      }
    } catch {}
  };

  const handleCreateNewSession = (customId?: string | React.MouseEvent) => {
    const newId = (typeof customId === 'string' && customId) ? customId : `session_${Date.now()}`;
    setSessionId(newId);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/agents/${agentId}?session=${newId}`);
    }
    if (agent) {
      setMessages([
        {
          id: 'welcome',
          role: 'agent',
          speaker: agent.name,
          text: `New session initialized. Greetings, I am ${agent.name}, operating as ${agent.role}. Direct CLI execution and Obsidian sync are active. What objective are we executing?`,
          timestamp: Date.now(),
          agentId: agent.id,
        }
      ]);
    }
    setShowSessionsDrawer(false);
    loadSessionsList();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId, sessionId: newId } }));
    }
  };

  const handleSelectSession = async (sId: string) => {
    setSessionId(sId);
    setShowSessionsDrawer(false);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/agents/${agentId}?session=${sId}`);
      window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId, sessionId: sId } }));
    }
    try {
      const res = await fetch(`/api/sessions?agentId=${agentId}&sessionId=${sId}`);
      const data = await res.json();
      if (data.ok && data.messages && data.messages.length > 0) {
        setMessages(data.messages);
      } else if (agent) {
        setMessages([
          {
            id: 'welcome',
            role: 'agent',
            speaker: agent.name,
            text: `Session ${sId} initialized. Greetings, I am ${agent.name}, operating as ${agent.role}. Direct CLI execution and Obsidian sync are active. What objective are we executing?`,
            timestamp: Date.now(),
            agentId: agent.id,
          }
        ]);
      }
    } catch {
      if (agent) {
        setMessages([
          {
            id: 'welcome',
            role: 'agent',
            speaker: agent.name,
            text: `Session ${sId} initialized. Greetings, I am ${agent.name}, operating as ${agent.role}. Direct CLI execution and Obsidian sync are active. What objective are we executing?`,
            timestamp: Date.now(),
            agentId: agent.id,
          }
        ]);
      }
    }
  };

  const handleDeleteSession = async (sId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this conversation session?')) return;
    try {
      await fetch(`/api/sessions?agentId=${agentId}&sessionId=${sId}`, { method: 'DELETE' });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId } }));
      }
      if (sessionId === sId) {
        handleCreateNewSession();
      } else {
        loadSessionsList();
      }
    } catch {}
  };

  useEffect(() => {
    if (!agentId) return;

    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      const urlSession = sp.get('session');
      if (urlSession) {
        setSessionId(urlSession);
        handleSelectSession(urlSession);
      }
    }

    loadSessionsList();

    const handlePopState = () => {
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        const sId = sp.get('session');
        if (sId) {
          handleSelectSession(sId);
        }
      }
    };
    window.addEventListener('popstate', handlePopState);

    fetch('/api/agents')
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.agents) {
          const found = data.agents.find((a: AgentInfo) => a.id.toLowerCase() === agentId.toLowerCase());
          if (found) {
            setAgent(found);
            setSelectedModel(found.model);
            if (found.activeEffort) setSelectedEffort(found.activeEffort);
          }
        }
      })
      .finally(() => setLoadingAgent(false));

    return () => window.removeEventListener('popstate', handlePopState);
  }, [agentId]);

  const handleModelChange = async (newModel: string) => {
    if (newModel === '__custom__') {
      setCustomModelMode(true);
      return;
    }
    setSelectedModel(newModel);
    if (!agent) return;
    try {
      await fetch(`/api/agents/${agent.id}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModel, effort: selectedEffort }),
      });
    } catch {}
  };

  const handleApplyCustomModel = async () => {
    const trimmed = customModelInput.trim();
    if (!trimmed || !agent) return;
    setSelectedModel(trimmed);
    setCustomModelMode(false);
    try {
      await fetch(`/api/agents/${agent.id}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: trimmed, effort: selectedEffort }),
      });
    } catch {}
  };

  const handleEffortChange = async (newEffort: string) => {
    setSelectedEffort(newEffort);
    if (!agent) return;
    try {
      await fetch(`/api/agents/${agent.id}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, effort: newEffort }),
      });
    } catch {}
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend !== undefined ? textToSend : input).trim();
    if (!text || isSending || !agent) return;

    const userMsg: ChatMessage = {
      id: 'user-' + Date.now(),
      role: 'user',
      speaker: 'You',
      text,
      timestamp: Date.now(),
      agentId: agent.id,
    };

    setMessages(prev => [...prev, userMsg]);
    if (textToSend === undefined) setInput('');
    setIsSending(true);
    setOrbState('thinking');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          agentId: agent.id,
          agentName: agent.name,
          model: selectedModel,
          sessionId,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        const agentMsg: ChatMessage = {
          id: 'agent-' + Date.now(),
          role: 'agent',
          speaker: agent.name,
          text: data.reply,
          timestamp: data.timestamp || Date.now(),
          agentId: agent.id,
        };
        setMessages(prev => [...prev, agentMsg]);
        
        // Trigger speaking orb state
        setOrbState('speaking');
        setTimeout(() => setOrbState('idle'), 3500);

        // Show brief Obsidian saved badge
        setSavedBadge(true);
        setTimeout(() => setSavedBadge(false), 2500);
        loadSessionsList();
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('sessions-updated', { detail: { agentId: agent.id, sessionId } }));
        }
      } else {
        setOrbState('killswitch');
        setTimeout(() => setOrbState('idle'), 3000);

        const errorMsg: ChatMessage = {
          id: 'err-' + Date.now(),
          role: 'agent',
          speaker: agent.name,
          text: `[Error from bridge]: ${data.error || 'Execution failure'}`,
          timestamp: Date.now(),
          agentId: agent.id,
        };
        setMessages(prev => [...prev, errorMsg]);
      }
    } catch (err: any) {
      setOrbState('killswitch');
      setTimeout(() => setOrbState('idle'), 3000);

      const netErrorMsg: ChatMessage = {
        id: 'net-err-' + Date.now(),
        role: 'agent',
        speaker: agent.name,
        text: `[Network Error]: Unable to reach local agent bridge on port 3141. Ensure bridge is running in standalone mode.`,
        timestamp: Date.now(),
        agentId: agent.id,
      };
      setMessages(prev => [...prev, netErrorMsg]);
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const clearChat = () => {
    if (!agent) return;
    setMessages([
      {
        id: 'welcome-' + Date.now(),
        role: 'agent',
        speaker: agent.name,
        text: `Chat cleared. Ready for next directive.`,
        timestamp: Date.now(),
        agentId: agent.id,
      }
    ]);
  };

  const quickPrompts = [
    { label: '⚡ Code Review', prompt: 'Perform a comprehensive code review of our recent changes, focusing on reliability and edge cases.' },
    { label: '📐 Architecture Plan', prompt: 'Design an architectural plan for integrating a new telemetry endpoint with rate limiting.' },
    { label: '🧪 Write Unit Tests', prompt: 'Generate robust unit test suites covering the core execution handler and failure paths.' },
    { label: '🛡️ Security Audit', prompt: 'Audit the current subsystem configuration for potential credential leaks or unescaped inputs.' },
  ];

  if (loadingAgent) {
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          <div className="text-xs font-mono text-gray-400">Loading agent telemetry...</div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center space-y-4">
        <div className="text-4xl">⚠️</div>
        <h2 className="text-xl font-bold text-white">Agent Not Found</h2>
        <p className="text-sm text-gray-400">The agent identifier &quot;{agentId}&quot; does not match any registered engines.</p>
        <Link 
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500"
        >
          <ArrowLeft className="w-4 h-4" /> Return to Mission Control
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen max-h-screen bg-black text-gray-100 overflow-hidden">
      {/* Top Header Bar */}
      <header className="flex-none px-6 py-4 border-b border-blue-950/60 bg-[#02040a]/90 backdrop-blur-md flex items-center justify-between z-20">
        <div className="flex items-center gap-4">
          <Link 
            href="/"
            className="p-2 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-white hover:border-blue-500/50 transition-all"
            title="Return to Mission Control"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="relative">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-950 to-black border border-blue-500/40 flex items-center justify-center text-2xl shadow-[0_0_15px_rgba(37,99,235,0.3)]">
              {agent.emoji}
            </div>
            <span 
              className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-black ${
                agent.status === 'live' 
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' 
                  : agent.status === 'standby'
                  ? 'bg-amber-400'
                  : 'bg-red-500'
              }`} 
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white">{agent.name}</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-950/80 text-sky-400 border border-blue-800/40 uppercase">
                {agent.status === 'live' ? 'CLI CONNECTED' : agent.status}
              </span>
            </div>
            <p className="text-xs text-gray-400 truncate max-w-md">{agent.role}</p>
          </div>
        </div>

        {/* Header Right Controls */}
        <div className="flex items-center gap-3">
          {/* 3D Reactive Holographic Audio Orb */}
          <ReactiveOrb size={44} state={orbState} interactive={false} className="mr-0.5" />

          {/* Model Selector */}
          {customModelMode ? (
            <div className="flex items-center gap-1 bg-[#090e1f] border border-blue-500/70 rounded-xl px-2.5 py-1 shadow-[0_0_12px_rgba(59,130,246,0.3)]">
              <input
                type="text"
                placeholder="e.g. claude-opus-5"
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                className="bg-transparent text-sky-300 text-xs font-mono focus:outline-none w-36"
                onKeyDown={(e) => e.key === 'Enter' && handleApplyCustomModel()}
                autoFocus
              />
              <button
                onClick={handleApplyCustomModel}
                className="text-[10px] bg-blue-600 hover:bg-blue-500 text-white px-2 py-0.5 rounded font-mono font-semibold"
              >
                Apply
              </button>
              <button
                onClick={() => setCustomModelMode(false)}
                className="text-[10px] text-gray-400 hover:text-white px-1 font-mono"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="relative flex items-center">
              <select
                value={selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                aria-label="Select Model"
                className="appearance-none bg-[#090e1f] border border-blue-900/50 text-sky-300 text-xs font-mono font-medium rounded-xl px-3 py-1.5 pr-8 hover:border-blue-500/60 focus:outline-none focus:border-blue-500 transition-all cursor-pointer shadow-[0_0_10px_rgba(37,99,235,0.15)]"
              >
                {agent.availableModels.map((m: any) => {
                  const id = typeof m === 'string' ? m : m.id;
                  const name = typeof m === 'string' ? m : (m.name || m.id);
                  return (
                    <option key={id} value={id} className="bg-[#050814] text-gray-200">
                      {name}
                    </option>
                  );
                })}
                <option value="__custom__" className="bg-[#050814] text-sky-400 font-semibold">
                  + Custom Model...
                </option>
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-sky-400 absolute right-2.5 pointer-events-none" />
            </div>
          )}

          {/* Reasoning Effort Selector (When supported) */}
          {(() => {
            const currentModelObj = agent.availableModels.find(
              (m: any) => (typeof m === 'string' ? m : m.id) === selectedModel
            );
            const efforts: string[] =
              (currentModelObj && typeof currentModelObj === 'object' && currentModelObj.reasoningEfforts) ||
              agent.reasoningEfforts ||
              [];
            if (!efforts || efforts.length === 0) return null;
            return (
              <div className="relative flex items-center">
                <select
                  value={selectedEffort}
                  onChange={(e) => handleEffortChange(e.target.value)}
                  aria-label="Reasoning Effort"
                  className="appearance-none bg-[#0c0d24] border border-purple-900/50 text-purple-300 text-xs font-mono font-medium rounded-xl px-2.5 py-1.5 pr-7 hover:border-purple-500/60 focus:outline-none focus:border-purple-500 transition-all cursor-pointer shadow-[0_0_10px_rgba(168,85,247,0.15)]"
                  title="Reasoning Effort"
                >
                  {efforts.map((effort) => (
                    <option key={effort} value={effort} className="bg-[#050814] text-purple-200">
                      Effort: {effort}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-purple-400 absolute right-2 pointer-events-none" />
              </div>
            );
          })()}

          {/* Obsidian Sync Status */}
          <div 
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] font-mono border transition-all ${
              savedBadge 
                ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]' 
                : 'bg-[#090e1f] text-gray-400 border-blue-950/80'
            }`}
            title="Auto-saving conversation turns to Obsidian vault"
          >
            <FolderSync className={`w-3.5 h-3.5 ${savedBadge ? 'animate-spin text-emerald-400' : 'text-purple-400'}`} />
            <span className="hidden sm:inline">{savedBadge ? 'Synced to Vault' : 'Obsidian Sync'}</span>
          </div>

          {/* New Session Button */}
          <button
            onClick={handleCreateNewSession}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-[0_0_12px_rgba(37,99,235,0.4)] transition-all"
            title="Start a fresh conversation session"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden md:inline">New Session</span>
          </button>

          {/* Sessions Drawer Button */}
          <button
            onClick={() => {
              loadSessionsList();
              setShowSessionsDrawer(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-blue-900/50 hover:border-blue-500/60 text-sky-300 text-xs font-mono transition-all"
            title="View saved conversation sessions"
          >
            <History className="w-3.5 h-3.5 text-sky-400" />
            <span>Sessions ({sessions.length})</span>
          </button>

          {/* Clear Chat */}
          <button
            onClick={clearChat}
            className="p-2 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-red-400 hover:border-red-900/50 transition-all"
            title="Clear Chat History"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Binary Path Sub-banner */}
      {agent.binaryPath && (
        <div className="flex-none bg-[#030612] px-6 py-1.5 border-b border-blue-950/40 flex items-center justify-between text-[11px] font-mono text-gray-400">
          <div className="flex items-center gap-2 truncate">
            <Terminal className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
            <span className="text-gray-500">Binary:</span>
            <span className="text-sky-300 truncate">{agent.binaryPath}</span>
          </div>
          <div className="flex items-center gap-1.5 text-emerald-400 flex-shrink-0">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Authenticated</span>
          </div>
        </div>
      )}

      {/* Horizontal Session Tabs Bar */}
      <div className="flex-none bg-[#020409] border-b border-blue-950/70 px-4 py-2 flex items-center gap-2 overflow-x-auto scrollbar-none z-10">
        <button
          onClick={() => handleCreateNewSession()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-blue-950/90 hover:bg-blue-900 text-sky-300 border border-sky-800 hover:border-sky-500 transition-all shadow-[0_0_12px_rgba(56,189,248,0.2)] flex-shrink-0 cursor-pointer"
          title="Create brand new conversation session"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Session</span>
        </button>

        <div className="h-4 w-[1px] bg-blue-950 flex-shrink-0 mx-1" />

        {/* Scrollable list of active session tabs */}
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none py-0.5">
          {sessions.map((s) => {
            const isActive = sessionId === s.id;
            return (
              <div
                key={s.id}
                onClick={() => handleSelectSession(s.id)}
                className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-all cursor-pointer flex-shrink-0 border select-none ${
                  isActive
                    ? 'bg-[#091535] text-sky-200 border-sky-400/90 shadow-[0_0_15px_rgba(56,189,248,0.3)] font-semibold'
                    : 'bg-[#030714] text-gray-400 border-blue-950/70 hover:text-gray-200 hover:border-blue-900'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-cyan-400 animate-pulse' : 'bg-gray-600'}`} />
                <MessageSquare className={`w-3 h-3 ${isActive ? 'text-sky-400' : 'text-gray-500'}`} />
                <span className="truncate max-w-[160px]" title={s.title || s.id}>
                  {s.title || s.id}
                </span>
                {s.messageCount !== undefined && s.messageCount > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${isActive ? 'bg-blue-950 text-sky-300' : 'bg-[#0b1020] text-gray-500'}`}>
                    {s.messageCount}
                  </span>
                )}
                <button
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity p-0.5 rounded text-gray-500 ml-1"
                  title="Delete this session"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* If the current session is fresh and not yet in the saved sessions list, display it as an active fresh tab */}
          {!sessions.some(s => s.id === sessionId) && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono bg-[#091535] text-sky-200 border border-sky-400/90 shadow-[0_0_15px_rgba(56,189,248,0.3)] font-semibold flex-shrink-0 select-none"
            >
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <MessageSquare className="w-3 h-3 text-sky-400" />
              <span className="truncate max-w-[160px]">
                {sessionId.replace('session_', 'Current Session #')}
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded font-mono bg-blue-950 text-sky-300">
                fresh
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Main Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          return (
            <div
              key={msg.id}
              className={`flex gap-3 max-w-4xl ${isUser ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}
            >
              {/* Avatar */}
              <div className="flex-none">
                <div 
                  className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold border shadow-sm ${
                    isUser 
                      ? 'bg-blue-600 border-blue-400 text-white shadow-[0_0_12px_rgba(59,130,246,0.5)]' 
                      : 'bg-[#090e1f] border-blue-800/60 text-sky-400'
                  }`}
                >
                  {isUser ? 'U' : agent.emoji}
                </div>
              </div>

              {/* Bubble */}
              <div className="space-y-1 max-w-[85%]">
                <div className={`flex items-center gap-2 text-[10px] font-mono text-gray-400 ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <span>{msg.speaker || (isUser ? 'You' : agent.name)}</span>
                  <span>•</span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>

                <div 
                  className={`p-4 rounded-2xl relative group text-sm leading-relaxed border ${
                    isUser
                      ? 'bg-gradient-to-br from-blue-900/60 to-blue-950/80 border-blue-700/50 text-white rounded-tr-none shadow-[0_0_20px_rgba(37,99,235,0.2)]'
                      : 'bg-[#050914] border-blue-950/80 text-gray-200 rounded-tl-none hover:border-blue-900/60 transition-all'
                  }`}
                >
                  <div className="whitespace-pre-wrap font-sans text-[13.5px] select-text">
                    {msg.text}
                  </div>

                  {/* Copy snippet button */}
                  <button
                    onClick={() => copyToClipboard(msg.text, msg.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 border border-blue-900/40 text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Copy message"
                  >
                    {copiedId === msg.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* Agent Generating Indicator */}
        {isSending && (
          <div className="flex gap-3 max-w-4xl mr-auto">
            <div className="w-8 h-8 rounded-xl bg-[#090e1f] border border-blue-800/60 flex items-center justify-center text-sm">
              {agent.emoji}
            </div>
            <div className="p-3.5 rounded-2xl bg-[#050914] border border-blue-900/50 rounded-tl-none flex items-center gap-2 text-xs text-sky-400 font-mono">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
              <span>{agent.name} is synthesizing response...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Prompts Bar */}
      <div className="flex-none px-6 py-2 bg-[#02040a] border-t border-blue-950/40 flex items-center gap-2 overflow-x-auto no-scrollbar">
        <span className="text-[10px] font-mono uppercase text-gray-500 flex items-center gap-1 flex-shrink-0">
          <Zap className="w-3 h-3 text-amber-400" /> Presets:
        </span>
        {quickPrompts.map((qp, idx) => (
          <button
            key={idx}
            onClick={() => handleSend(qp.prompt)}
            disabled={isSending}
            className="flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-mono bg-[#070d1e] hover:bg-blue-900/40 text-gray-300 hover:text-sky-300 border border-blue-950 hover:border-blue-700/60 transition-all disabled:opacity-50"
          >
            {qp.label}
          </button>
        ))}
      </div>

      {/* Chat Input Bar */}
      <div className="flex-none p-4 bg-[#02040a] border-t border-blue-950/80">
        <div className="max-w-5xl mx-auto relative rounded-2xl bg-[#050916] border border-blue-900/50 focus-within:border-blue-500/80 focus-within:shadow-[0_0_25px_rgba(59,130,246,0.3)] transition-all flex items-end gap-2 p-2">
          {/* Voice Input Button */}
          <div className="pb-1 pl-1">
            <VoiceButton
              onTranscript={(text) => {
                setInput(prev => prev ? `${prev} ${text}` : text);
              }}
              onListeningChange={(listening) => {
                setOrbState(listening ? 'listening' : 'idle');
              }}
            />
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agent.name} or speak via microphone (Shift+Enter for newline)...`}
            className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm p-2 resize-none focus:outline-none max-h-32 min-h-[40px]"
          />

          {/* Send Button */}
          <div className="pb-1 pr-1">
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isSending}
              className="p-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 hover:from-blue-500 hover:to-sky-400 text-white disabled:opacity-30 disabled:pointer-events-none transition-all shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center justify-center"
              title="Send instruction (Enter)"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="max-w-5xl mx-auto mt-2 flex items-center justify-between text-[11px] text-gray-500 font-mono px-2">
          <span>Connected via local CLI bridge</span>
          <span className="flex items-center gap-1 text-purple-400/80">
            <FolderSync className="w-3 h-3" /> Auto-syncing to Obsidian/Agentic OS/chats
          </span>
        </div>
      </div>

      {/* Sessions Drawer Slide-over */}
      {showSessionsDrawer && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
            onClick={() => setShowSessionsDrawer(false)}
          />

          {/* Drawer Content */}
          <div className="relative w-full max-w-md h-full bg-[#02040a] border-l border-blue-900/40 shadow-2xl flex flex-col z-10">
            {/* Drawer Header */}
            <div className="p-4 border-b border-blue-950/60 flex items-center justify-between bg-[#040817]/80">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-950/80 border border-blue-800/40 flex items-center justify-center text-sky-400">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    Sessions History
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-950 text-sky-400 border border-blue-800/40">
                      {sessions.length}
                    </span>
                  </h3>
                  <p className="text-[11px] text-gray-400 font-mono">{agent.name} • Obsidian Vault</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleCreateNewSession}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all shadow-[0_0_10px_rgba(37,99,235,0.4)]"
                  title="New Session"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New</span>
                </button>
                <button
                  onClick={() => setShowSessionsDrawer(false)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-blue-950/50 transition-all"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Sessions List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {sessions.length === 0 ? (
                <div className="text-center py-12 space-y-3 text-gray-500">
                  <MessageSquare className="w-8 h-8 mx-auto opacity-40 text-sky-400" />
                  <p className="text-xs font-mono">No prior sessions recorded yet.</p>
                  <button
                    onClick={handleCreateNewSession}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-mono"
                  >
                    <Plus className="w-3.5 h-3.5" /> Start New Session
                  </button>
                </div>
              ) : (
                sessions.map((s) => {
                  const isActive = s.sessionId === sessionId;
                  return (
                    <div
                      key={s.sessionId}
                      onClick={() => handleSelectSession(s.sessionId)}
                      className={`group relative p-3 rounded-xl border transition-all cursor-pointer ${
                        isActive
                          ? 'bg-blue-950/40 border-sky-500/80 shadow-[0_0_15px_rgba(56,189,248,0.2)]'
                          : 'bg-[#050916] border-blue-950/60 hover:border-blue-800/60 hover:bg-[#070e24]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {isActive && (
                              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40">
                                ACTIVE
                              </span>
                            )}
                            <span className="text-[11px] font-mono text-gray-400">
                              {new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} • {new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <span className="text-[10px] font-mono text-gray-500">
                              ({s.messageCount} msgs)
                            </span>
                          </div>
                          <p className="text-xs text-gray-200 line-clamp-2 leading-relaxed font-sans">
                            {s.title || 'Conversation Session'}
                          </p>
                        </div>

                        <button
                          onClick={(e) => handleDeleteSession(s.sessionId, e)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-950/30 transition-all flex-shrink-0"
                          title="Delete Session"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Drawer Footer */}
            <div className="p-3 border-t border-blue-950/60 bg-[#040817]/60 flex items-center justify-between text-[11px] font-mono text-gray-500">
              <span>Obsidian chats/sessions</span>
              <span className="text-sky-400">{agent.name} engine</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
