'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { 
  Zap, 
  CheckCircle2, 
  Cpu, 
  FolderSync, 
  Send, 
  Radio, 
  Sparkles,
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Play,
  Square,
  Plus,
  Trash2,
  ChevronRight,
  ChevronLeft,
  Video,
  Mic,
  MicOff,
  Volume2,
  Globe,
  Clock,
  RefreshCw,
  Key,
  ExternalLink,
  Activity,
  Users,
  FileText,
  Check,
  Save,
  Bot,
  PhoneOff,
  Network
} from 'lucide-react';
import VoiceButton from '@/components/VoiceButton';
import { AgentInfo } from '@/lib/types';
import { KanbanTask, SafetySwitchesState } from '@/lib/obsidian';

export default function MissionControlHome() {
  const [activeTab, setActiveTab] = useState<'radar' | 'kanban' | 'warroom' | 'audit' | 'providers'>('radar');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [quickPrompt, setQuickPrompt] = useState('');
  const [targetAgent, setTargetAgent] = useState('claude');
  const [dispatching, setDispatching] = useState(false);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState('');

  // Kanban tasks state
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<'critical' | 'high' | 'normal'>('normal');
  const [newTaskAgent, setNewTaskAgent] = useState('claude');

  // Safety switches state
  const [safety, setSafety] = useState<SafetySwitchesState>({
    llm_spawn: true,
    warroom_text: true,
    voice_standup: true,
    mutations: true,
    auto_assign: true,
    scheduler: true,
    master_kill: false,
  });

  // War Room Standup state
  const [standupTopic, setStandupTopic] = useState('Daily Multi-Agent Synchronization & Swarm Health');
  const [standupReports, setStandupReports] = useState<any[]>([]);
  const [isBroadcastingStandup, setIsBroadcastingStandup] = useState(false);
  const [isPlayingVoice, setIsPlayingVoice] = useState(false);
  const [activeSpeakerIndex, setActiveSpeakerIndex] = useState<number | null>(null);

  // Live Meetings state (All 4 Providers)
  const [selectedMeetingProvider, setSelectedMeetingProvider] = useState<'google' | 'daily' | 'pika' | 'recall'>('google');
  const [googleMeetUrl, setGoogleMeetUrl] = useState('');
  const [googleAgent, setGoogleAgent] = useState('hermes');
  const [dailyMeetUrl, setDailyMeetUrl] = useState('');
  const [dailyAgent, setDailyAgent] = useState('claude');
  const [dailyMode, setDailyMode] = useState<'direct' | 'roundtable'>('direct');
  const [dailyAutoBrief, setDailyAutoBrief] = useState(true);
  const [pikaMeetUrl, setPikaMeetUrl] = useState('');
  const [pikaAgent, setPikaAgent] = useState('antigravity');
  const [recallMeetUrl, setRecallMeetUrl] = useState('');
  const [recallAgent, setRecallAgent] = useState('hermes');
  const [isDispatchingMeeting, setIsDispatchingMeeting] = useState(false);
  const [activeMeetingSessions, setActiveMeetingSessions] = useState<any[]>([]);

  // Live Copilot HUD state
  const [copilotActiveSession, setCopilotActiveSession] = useState<any | null>(null);
  const [copilotNotes, setCopilotNotes] = useState<Array<{ speaker: string; text: string; timestamp: string }>>([]);
  const [copilotInput, setCopilotInput] = useState('');
  const [isCopilotListening, setIsCopilotListening] = useState(false);
  const [copilotSaving, setCopilotSaving] = useState(false);
  const [copilotSaveSuccess, setCopilotSaveSuccess] = useState(false);
  const recognitionRef = useRef<any>(null);

  // System Audit Log state
  const [auditLogs, setAuditLogs] = useState<Array<{ id: string; time: string; level: 'info' | 'warn' | 'success'; message: string }>>([
    { id: '1', time: '12:04:18', level: 'success', message: 'Three.js WebGL 3D Globe initialized with 2,800 Fibonacci nodes' },
    { id: '2', time: '12:03:52', level: 'info', message: 'Obsidian vault synchronization active: chats/sessions loaded' },
    { id: '3', time: '12:02:10', level: 'success', message: 'CLI Bridge validated: agy, grok, claude, codex, hermes active' },
    { id: '4', time: '12:00:00', level: 'info', message: 'Mission Control V3 Safety Posture: All kill switches armed' }
  ]);

  // Provider Keys state
  const [providerKeys, setProviderKeys] = useState({
    anthropic: 'sk-ant-api03-••••••••••••••••',
    openai: 'sk-proj-••••••••••••••••',
    openrouter: 'sk-or-v1-••••••••••••••••',
    groq: 'gsk_••••••••••••••••',
    gemini: 'AIzaSy••••••••••••••••',
    deepseek: 'sk-••••••••••••••••'
  });

  useEffect(() => {
    // 0. Sync Tab from URL query parameter
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      const tabParam = sp.get('tab');
      if (tabParam && ['radar', 'kanban', 'warroom', 'audit', 'providers'].includes(tabParam)) {
        setActiveTab(tabParam as any);
      }
    }

    // 1. Fetch Agents
    fetch('/api/agents')
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.agents) {
          setAgents(data.agents);
          const firstLive = data.agents.find((a: AgentInfo) => a.status === 'live');
          if (firstLive) setTargetAgent(firstLive.id);
        }
      })
      .catch(() => {});

    // 2. Fetch Vault Path
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.ok) setVaultPath(data.vaultPath);
      })
      .catch(() => {});

    // 3. Fetch Tasks
    loadTasks();

    // 4. Fetch Safety
    fetch('/api/safety')
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.safety) setSafety(data.safety);
      })
      .catch(() => {});

    // 5. Fetch Active Meeting Sessions
    loadMeetingSessions();
  }, []);

  const loadTasks = async () => {
    setLoadingTasks(true);
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      if (data.ok && data.tasks) setTasks(data.tasks);
    } catch {}
    setLoadingTasks(false);
  };

  const handleToggleSafetySwitch = async (switchKey: keyof SafetySwitchesState) => {
    try {
      const res = await fetch('/api/safety', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ switchKey }),
      });
      const data = await res.json();
      if (data.ok && data.safety) {
        setSafety(data.safety);
        setAuditLogs(prev => [
          {
            id: String(Date.now()),
            time: new Date().toLocaleTimeString(),
            level: 'warn',
            message: `Safety switch "${switchKey}" toggled to ${data.safety[switchKey] ? 'ENABLED' : 'DISABLED'}`
          },
          ...prev
        ]);
      }
    } catch {}
  };

  const handleEmergencyKill = async () => {
    if (!safety.master_kill) {
      if (!confirm('ENGAGE EMERGENCY KILL SWITCH? This immediately halts all background subagents, loops, and mutations.')) return;
      try {
        const res = await fetch('/api/safety', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'emergency_kill' }),
        });
        const data = await res.json();
        if (data.ok) {
          setSafety(data.safety);
          setAuditLogs(prev => [
            {
              id: String(Date.now()),
              time: new Date().toLocaleTimeString(),
              level: 'warn',
              message: 'EMERGENCY KILL SWITCH ENGAGED — ALL SUBPROCESSES SUSPENDED'
            },
            ...prev
          ]);
        }
      } catch {}
    } else {
      // Restore
      try {
        const res = await fetch('/api/safety', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'restore_all' }),
        });
        const data = await res.json();
        if (data.ok) {
          setSafety(data.safety);
          setAuditLogs(prev => [
            {
              id: String(Date.now()),
              time: new Date().toLocaleTimeString(),
              level: 'success',
              message: 'Emergency kill switch disengaged — safety posture nominal'
            },
            ...prev
          ]);
        }
      } catch {}
    }
  };

  const handleQuickDispatch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!quickPrompt.trim() || dispatching) return;

    setDispatching(true);
    setLastResponse(null);

    try {
      const selected = agents.find(a => a.id === targetAgent);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: quickPrompt,
          agentId: targetAgent,
          agentName: selected?.name || targetAgent,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setLastResponse(data.reply);
        setQuickPrompt('');
        setAuditLogs(prev => [
          {
            id: String(Date.now()),
            time: new Date().toLocaleTimeString(),
            level: 'success',
            message: `Dispatched instruction to ${selected?.name || targetAgent}`
          },
          ...prev
        ]);
      }
    } catch (err: any) {
      setLastResponse('Error: Could not reach agent bridge.');
    } finally {
      setDispatching(false);
    }
  };

  // Kanban Handlers
  const handleMoveTask = async (taskId: string, newCol: 'inbox' | 'inprogress' | 'review' | 'completed') => {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_column', taskId, column: newCol }),
      });
      const data = await res.json();
      if (data.ok && data.tasks) setTasks(data.tasks);
    } catch {}
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', taskId }),
      });
      const data = await res.json();
      if (data.ok && data.tasks) setTasks(data.tasks);
    } catch {}
  };

  const handleAutoAssignAll = async () => {
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'auto_assign_all' }),
      });
      const data = await res.json();
      if (data.ok && data.tasks) {
        setTasks(data.tasks);
        setAuditLogs(prev => [
          {
            id: String(Date.now()),
            time: new Date().toLocaleTimeString(),
            level: 'info',
            message: 'Auto-assigned all tasks across active agent specializations'
          },
          ...prev
        ]);
      }
    } catch {}
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTaskTitle,
          description: newTaskDesc,
          priority: newTaskPriority,
          assignedAgent: newTaskAgent,
          column: 'inbox',
        }),
      });
      const data = await res.json();
      if (data.ok && data.tasks) {
        setTasks(data.tasks);
        setNewTaskTitle('');
        setNewTaskDesc('');
        setShowNewTaskModal(false);
      }
    } catch {}
  };

  // War Room Standup Handlers
  const handleBroadcastStandup = async () => {
    setIsBroadcastingStandup(true);
    try {
      const res = await fetch('/api/standup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: standupTopic }),
      });
      const data = await res.json();
      if (data.ok && data.reports) {
        setStandupReports(data.reports);
        setAuditLogs(prev => [
          {
            id: String(Date.now()),
            time: new Date().toLocaleTimeString(),
            level: 'success',
            message: `War Room Standup broadcast complete. ${data.reports.length} agents reported.`
          },
          ...prev
        ]);
      }
    } catch {}
    setIsBroadcastingStandup(false);
  };

  const handlePlayVoiceStandup = () => {
    if (!('speechSynthesis' in window)) {
      alert('Web Speech API is not supported in this browser.');
      return;
    }

    if (isPlayingVoice) {
      window.speechSynthesis.cancel();
      setIsPlayingVoice(false);
      setActiveSpeakerIndex(null);
      return;
    }

    if (standupReports.length === 0) {
      handleBroadcastStandup().then(() => {
        // Standup will populate
      });
      return;
    }

    setIsPlayingVoice(true);
    window.speechSynthesis.cancel();

    let currentIdx = 0;

    const speakNext = () => {
      if (currentIdx >= standupReports.length) {
        setIsPlayingVoice(false);
        setActiveSpeakerIndex(null);
        return;
      }

      setActiveSpeakerIndex(currentIdx);
      const rep = standupReports[currentIdx];
      const speechText = `${rep.agentName}: ${rep.report} Next objective: ${rep.nextStep}`;

      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.rate = 1.05;

      // Unique pitch per agent persona
      if (rep.agentId === 'claude') utterance.pitch = 1.0;
      else if (rep.agentId === 'antigravity') utterance.pitch = 1.2;
      else if (rep.agentId === 'grok') utterance.pitch = 0.85;
      else if (rep.agentId === 'hermes') utterance.pitch = 1.1;
      else utterance.pitch = 0.95;

      utterance.onend = () => {
        currentIdx++;
        speakNext();
      };

      utterance.onerror = () => {
        setIsPlayingVoice(false);
        setActiveSpeakerIndex(null);
      };

      window.speechSynthesis.speak(utterance);
    };

    speakNext();
  };

  const loadMeetingSessions = async () => {
    try {
      const res = await fetch('/api/meetings');
      const data = await res.json();
      if (data.ok && data.sessions) {
        setActiveMeetingSessions(data.sessions);
        if (typeof window !== 'undefined') {
          const sp = new URLSearchParams(window.location.search);
          if (sp.get('copilot') && data.sessions.length > 0 && !copilotActiveSession) {
            const first = data.sessions[0];
            setCopilotActiveSession(first);
            setCopilotNotes([
              {
                speaker: first.agentId.toUpperCase(),
                text: `Hello! I am ${first.agentId.toUpperCase()}. I have joined your ${first.provider.toUpperCase()} meeting session. I am actively listening, recording notes, and standing by for your directives.`,
                timestamp: '05:51:00 PM'
              },
              {
                speaker: 'You (Directive)',
                text: 'Review system architecture and track key decisions.',
                timestamp: '05:51:25 PM'
              },
              {
                speaker: first.agentId.toUpperCase(),
                text: '[Copilot Logged] Directive received: "Review system architecture and track key decisions". Real-time transcription active.',
                timestamp: '05:51:26 PM'
              }
            ]);
          }
        }
      }
    } catch {}
  };

  const startSpeechRecognition = (agentName: string) => {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not supported in this browser.');
      return;
    }

    try {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        const last = event.results.length - 1;
        const transcript = event.results[last][0].transcript.trim();
        if (transcript) {
          setCopilotNotes(prev => [
            ...prev,
            {
              speaker: 'You / Meeting Audio',
              text: transcript,
              timestamp: new Date().toLocaleTimeString()
            }
          ]);
        }
      };

      recognition.onerror = (e: any) => {
        console.warn('[Copilot Speech Recognition]', e);
        setIsCopilotListening(false);
      };

      recognition.onend = () => {
        setIsCopilotListening(false);
      };

      recognition.start();
      recognitionRef.current = recognition;
      setIsCopilotListening(true);
    } catch (err) {
      console.warn('[SpeechRecognition Start Error]', err);
      setIsCopilotListening(false);
    }
  };

  const stopSpeechRecognition = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
    setIsCopilotListening(false);
  };

  const handleDispatchMeeting = async (provider: 'google' | 'daily' | 'pika' | 'recall') => {
    setIsDispatchingMeeting(true);
    let agentId = 'hermes';
    let rawUrl = '';
    let mode = 'direct';
    let autoBrief = true;

    if (provider === 'google') {
      agentId = googleAgent;
      rawUrl = googleMeetUrl;
    } else if (provider === 'daily') {
      agentId = dailyAgent;
      rawUrl = dailyMeetUrl;
      mode = dailyMode;
      autoBrief = dailyAutoBrief;
    } else if (provider === 'pika') {
      agentId = pikaAgent;
      rawUrl = pikaMeetUrl;
    } else if (provider === 'recall') {
      agentId = recallAgent;
      rawUrl = recallMeetUrl;
    }

    try {
      const res = await fetch('/api/meetings/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          agentId,
          meetUrl: rawUrl,
          mode,
          autoBrief
        })
      });
      const data = await res.json();
      if (data.ok && data.session) {
        const session = data.session;
        // 1. Reliably open room in new window/tab
        if (session.meetUrl) {
          window.open(session.meetUrl, '_blank');
        }

        // 2. Open Live Copilot HUD
        setCopilotActiveSession(session);
        const timeNow = new Date().toLocaleTimeString();
        const introGreeting = `Hello! I am ${session.agentId.toUpperCase()}. I have joined your ${provider.toUpperCase()} meeting session. I am actively listening, recording notes, and standing by for your directives.`;
        
        setCopilotNotes([
          {
            speaker: session.agentId.toUpperCase(),
            text: introGreeting,
            timestamp: timeNow
          }
        ]);

        // 3. Spoken voice introduction
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(introGreeting);
          utterance.rate = 1.0;
          utterance.pitch = 1.05;
          window.speechSynthesis.speak(utterance);
        }

        // 4. Auto-start speech recognition / microphone listener
        startSpeechRecognition(session.agentId);

        // 5. Update state and audit logs
        setAuditLogs(prev => [
          {
            id: String(Date.now()),
            time: timeNow,
            level: 'success',
            message: `Dispatched ${session.agentId.toUpperCase()} to ${provider.toUpperCase()} room (${session.meetUrl})`
          },
          ...prev
        ]);

        loadMeetingSessions();
      } else {
        alert(data.error || 'Failed to dispatch meeting');
      }
    } catch (e: any) {
      alert(`Failed to dispatch meeting: ${e.message}`);
    } finally {
      setIsDispatchingMeeting(false);
    }
  };

  const handleSendCopilotDirective = () => {
    if (!copilotInput.trim() || !copilotActiveSession) return;
    const userText = copilotInput.trim();
    const timeNow = new Date().toLocaleTimeString();
    const agentName = copilotActiveSession.agentId.toUpperCase();
    const ackText = `[Copilot Logged] Directive received: "${userText}". Integrated into meeting notes.`;

    setCopilotNotes(prev => [
      ...prev,
      {
        speaker: 'You (Directive)',
        text: userText,
        timestamp: timeNow
      },
      {
        speaker: agentName,
        text: ackText,
        timestamp: timeNow
      }
    ]);
    setCopilotInput('');

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(`Directive acknowledged. Logging ${userText}`);
      utterance.rate = 1.05;
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleSaveCopilotNotes = async () => {
    if (!copilotActiveSession) return;
    setCopilotSaving(true);
    try {
      const res = await fetch('/api/meetings/save-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: copilotActiveSession.agentId,
          provider: copilotActiveSession.provider,
          meetUrl: copilotActiveSession.meetUrl,
          notes: copilotNotes
        })
      });
      const data = await res.json();
      if (data.ok) {
        setCopilotSaveSuccess(true);
        setTimeout(() => setCopilotSaveSuccess(false), 3000);
      }
    } catch {} finally {
      setCopilotSaving(false);
    }
  };

  const handleEndMeetingSession = async (sessionId: string) => {
    try {
      await fetch(`/api/meetings/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (copilotActiveSession?.id === sessionId) {
        setCopilotActiveSession(null);
        stopSpeechRecognition();
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      }
      loadMeetingSessions();
    } catch {}
  };

  const handleClearAllMeetingSessions = async () => {
    if (!confirm('Clear all active meeting sessions?')) return;
    try {
      await fetch('/api/meetings', { method: 'DELETE' });
      setCopilotActiveSession(null);
      stopSpeechRecognition();
      loadMeetingSessions();
    } catch {}
  };

  const liveAgents = agents.filter(a => a.status === 'live');

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6 text-gray-100 font-sans">
      {/* 1. Super AMOLED Hero Banner */}
      <div className="relative rounded-3xl p-6 bg-gradient-to-r from-[#010206] via-[#04091a] to-[#010206] border border-blue-500/30 shadow-[0_0_50px_rgba(37,99,235,0.2)] overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-950/80 text-sky-400 border border-blue-800/60 shadow-[0_0_10px_rgba(56,189,248,0.3)]">
                SUPER AMOLED ENGINE
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                OBSIDIAN ACTIVE
              </span>
              <Link 
                href="/globe"
                className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-950/80 text-cyan-300 border border-cyan-800/60 hover:border-cyan-400 flex items-center gap-1 transition-all"
              >
                <Globe className="w-3 h-3 text-cyan-400" />
                THREE.JS 3D CORE
              </Link>
            </div>

            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white flex items-center gap-3">
              Agentic<span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-blue-600">OS</span> Mission Control
            </h1>
            <p className="text-xs text-gray-400 mt-1 max-w-2xl font-mono">
              Unified nervous system integrating local CLI agents, Obsidian memory persistence, War Room consensus, and V3 safety posture.
            </p>
          </div>

          {/* Emergency Kill Switch */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={handleEmergencyKill}
              className={`px-4 py-2.5 rounded-2xl font-mono text-xs font-bold transition-all flex items-center gap-2 shadow-lg ${
                safety.master_kill
                  ? 'bg-red-600 text-white border border-red-400 shadow-[0_0_25px_rgba(239,68,68,0.8)] animate-pulse'
                  : 'bg-[#150709] hover:bg-[#260c10] text-red-400 border border-red-900/60 hover:border-red-600 shadow-[0_0_15px_rgba(239,68,68,0.2)]'
              }`}
              title="Emergency halt all subagent executions"
            >
              <ShieldAlert className="w-4 h-4" />
              <span>{safety.master_kill ? 'KILL SWITCH ENGAGED' : 'EMERGENCY KILL SWITCH'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. V3 Safety Posture Bar & Kill Switches */}
      <div className="rounded-2xl p-4 bg-[#030612] border border-blue-950/80 shadow-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-gray-300 font-mono">
              V3 Safety Posture
            </span>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
              safety.master_kill 
                ? 'bg-red-950 text-red-400 border-red-800' 
                : 'bg-emerald-950 text-emerald-400 border-emerald-800'
            }`}>
              {safety.master_kill ? 'RESTRICTED' : 'ENFORCING NOMINAL'}
            </span>
          </div>
          <span className="text-[11px] text-gray-500 font-mono">
            Granular Kill Switches & Loop Guard Protection
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[
            { key: 'llm_spawn', label: 'LLM Spawn', desc: 'Process spawning' },
            { key: 'warroom_text', label: 'WarRoom Text', desc: 'Consensus sync' },
            { key: 'voice_standup', label: 'Voice Standup', desc: 'Speech audio' },
            { key: 'mutations', label: 'Mutations', desc: 'Disk modifications' },
            { key: 'auto_assign', label: 'Auto-Assign', desc: 'Task delegation' },
            { key: 'scheduler', label: 'Scheduler', desc: 'Cron jobs' },
          ].map(({ key, label, desc }) => {
            const isEnabled = (safety as any)[key] && !safety.master_kill;
            return (
              <button
                key={key}
                onClick={() => handleToggleSafetySwitch(key as keyof SafetySwitchesState)}
                className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer ${
                  isEnabled
                    ? 'bg-[#060e24] border-blue-900/60 hover:border-blue-500/80'
                    : 'bg-[#150808] border-red-950/80 hover:border-red-800'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold text-gray-200 font-mono">{label}</span>
                  <span className={`w-2 h-2 rounded-full ${
                    isEnabled ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-red-500 shadow-[0_0_6px_#ef4444]'
                  }`} />
                </div>
                <div className="text-[10px] text-gray-500 font-mono truncate">{desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-blue-950/80 pb-2 overflow-x-auto">
        {[
          { id: 'radar', label: 'Swarm Radar & Dispatch', icon: Cpu },
          { id: 'kanban', label: `Kanban Tasks (${tasks.length})`, icon: CheckCircle2 },
          { id: 'warroom', label: 'War Room & Standup', icon: Volume2 },
          { id: 'audit', label: 'Audit Log & Security', icon: Activity },
          { id: 'providers', label: 'Model Providers & Keys', icon: Key },
        ].map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold font-mono transition-all whitespace-nowrap ${
                isActive
                  ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]'
                  : 'text-gray-400 hover:text-white hover:bg-blue-950/40'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: SWARM RADAR & DISPATCH */}
      {activeTab === 'radar' && (
        <div className="space-y-6">
          {/* 4 Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-4 rounded-2xl border border-blue-900/30 bg-[#030614]">
              <div className="flex items-center justify-between text-gray-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider font-mono">Installed CLIs</span>
                <Cpu className="w-4 h-4 text-sky-400" />
              </div>
              <div className="text-2xl font-black text-white font-mono flex items-baseline gap-2">
                {liveAgents.length} <span className="text-xs font-normal text-gray-500">/ {agents.length} live</span>
              </div>
              <div className="text-[10px] text-emerald-400 mt-2 flex items-center gap-1 font-mono">
                <ShieldCheck className="w-3.5 h-3.5" /> Direct binary execution verified
              </div>
            </div>

            <div className="glass-card p-4 rounded-2xl border border-blue-900/30 bg-[#030614]">
              <div className="flex items-center justify-between text-gray-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider font-mono">Obsidian Vault</span>
                <FolderSync className="w-4 h-4 text-purple-400" />
              </div>
              <div className="text-sm font-bold text-white font-mono truncate">
                Agentic OS /
              </div>
              <div className="text-[10px] text-gray-400 mt-2 truncate font-mono" title={vaultPath}>
                {vaultPath || 'Connecting...'}
              </div>
            </div>

            <div className="glass-card p-4 rounded-2xl border border-blue-900/30 bg-[#030614]">
              <div className="flex items-center justify-between text-gray-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider font-mono">Voice Recognition</span>
                <Sparkles className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-2xl font-black text-amber-400 font-mono">
                Zero-Key
              </div>
              <div className="text-[10px] text-gray-400 mt-2 font-mono">
                Native Browser Web Speech API
              </div>
            </div>

            <div className="glass-card p-4 rounded-2xl border border-blue-900/30 bg-[#030614]">
              <div className="flex items-center justify-between text-gray-400 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider font-mono">Bridge Gateway</span>
                <Radio className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-2xl font-black text-emerald-400 font-mono">
                Port 3141
              </div>
              <div className="text-[10px] text-emerald-400 mt-2 font-mono">
                Zero-Telegram conflict isolated
              </div>
            </div>
          </div>

          {/* Obsidian Memory Landscape & Graphical Visualizers Hub */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Card 1: 3D Obsidian Vault & Hive Mind Globe */}
            <div className="glass-card p-5 rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-[#04081c] to-[#010207] relative overflow-hidden group hover:border-cyan-400/60 transition-all shadow-[0_0_25px_rgba(6,182,212,0.15)]">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity pointer-events-none">
                <Globe className="w-32 h-32 text-cyan-400" />
              </div>
              <div className="relative z-10 flex flex-col h-full justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-cyan-950/80 border border-cyan-500/40 flex items-center justify-center text-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.3)]">
                      <Globe className="w-4 h-4 animate-pulse" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        3D Obsidian Vault & Hive Mind Globe
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-700/50 uppercase">
                          ULTRON GESTURES
                        </span>
                      </h3>
                      <p className="text-[11px] text-gray-400 font-mono">2,800 Fibonacci Memory Particles • 8 Agent Satellites</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-300 mb-4 leading-relaxed font-mono">
                    Fullstack 3D WebGL spherical topology with webcam MediaPipe hand gesture tracking (single-hand pinch to spin, two-hand pinch to zoom) and holographic bloom post-processing.
                  </p>
                </div>
                <div className="flex items-center gap-3 pt-3 border-t border-cyan-950/80">
                  <Link
                    href="/globe"
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-mono text-xs font-bold shadow-[0_0_15px_rgba(6,182,212,0.4)] transition-all"
                  >
                    <span>Launch 3D Vault Globe</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-2.5 py-2 rounded-xl border border-cyan-800/40">
                    Hotkeys: G, B, R
                  </span>
                </div>
              </div>
            </div>

            {/* Card 2: 2D Obsidian Memory Topology Graph */}
            <div className="glass-card p-5 rounded-2xl border border-purple-500/30 bg-gradient-to-br from-[#09051c] to-[#020107] relative overflow-hidden group hover:border-purple-400/60 transition-all shadow-[0_0_25px_rgba(168,85,247,0.15)]">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity pointer-events-none">
                <Network className="w-32 h-32 text-purple-400" />
              </div>
              <div className="relative z-10 flex flex-col h-full justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-purple-950/80 border border-purple-500/40 flex items-center justify-center text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.3)]">
                      <Network className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-2">
                        Obsidian 2D Memory Topology Graph
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-700/50 uppercase">
                          FORCE-DIRECTED
                        </span>
                      </h3>
                      <p className="text-[11px] text-gray-400 font-mono">Clustered by Chats, Daily Notes, Goals & Sessions</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-300 mb-4 leading-relaxed font-mono">
                    Interactive canvas graph view mirroring Obsidian native second-brain topology. Drag nodes, filter categories, inspect metadata tooltips, and click any node to read rendered markdown.
                  </p>
                </div>
                <div className="flex items-center gap-3 pt-3 border-t border-purple-950/80">
                  <Link
                    href="/vault?view=graph"
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-mono text-xs font-bold shadow-[0_0_15px_rgba(168,85,247,0.4)] transition-all"
                  >
                    <span>Open Memory Graph View</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <Link
                    href="/vault"
                    className="text-[10px] font-mono text-purple-300 hover:text-white bg-purple-950/60 px-3 py-2 rounded-xl border border-purple-800/40 transition"
                  >
                    Reader Mode
                  </Link>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Agent Dispatcher */}
          <div className="glass-card p-6 rounded-2xl border border-blue-500/20 bg-[#040817]">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-sky-400" />
                <h2 className="text-base font-bold text-white">Quick Swarm Command Center</h2>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 font-medium font-mono">Target Agent:</label>
                <select
                  value={targetAgent}
                  onChange={(e) => setTargetAgent(e.target.value)}
                  className="bg-[#0b1020] border border-blue-900/50 rounded-xl px-3 py-1.5 text-xs text-white outline-none focus:border-blue-500 font-medium cursor-pointer"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.emoji} {a.name} ({a.status})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <form onSubmit={handleQuickDispatch} className="flex gap-3">
              <VoiceButton onTranscript={(txt) => setQuickPrompt((prev) => prev ? `${prev} ${txt}` : txt)} />
              <input
                type="text"
                value={quickPrompt}
                onChange={(e) => setQuickPrompt(e.target.value)}
                placeholder="Type your instruction or click the mic button to speak..."
                className="flex-1 bg-[#02040c] border border-blue-900/40 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500 focus:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all font-sans"
              />
              <button
                type="submit"
                disabled={dispatching || !quickPrompt.trim()}
                className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-all shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center gap-2 font-mono"
              >
                {dispatching ? 'Dispatching...' : 'Dispatch'}
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>

            {lastResponse && (
              <div className="mt-4 p-4 rounded-xl bg-[#02040a] border border-blue-500/30 text-xs text-gray-200 font-mono whitespace-pre-wrap leading-relaxed shadow-[0_0_20px_rgba(59,130,246,0.15)]">
                <div className="text-[10px] text-sky-400 font-bold uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3" /> Response (Logged to Obsidian):
                </div>
                {lastResponse}
              </div>
            )}
          </div>

          {/* Installed Agent Scanner Matrix */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Cpu className="w-5 h-5 text-sky-400" />
                  Installed AI Engine Radar
                </h2>
                <p className="text-xs text-gray-500">Live inspection of verified CLI engines mounted on your local machine.</p>
              </div>
              <span className="text-xs text-gray-400 font-mono">
                {liveAgents.length} Ready
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((agent) => {
                const isLive = agent.status === 'live';
                return (
                  <div
                    key={agent.id}
                    className="glass-card p-5 rounded-2xl border border-blue-900/20 relative group hover:border-blue-500/40 bg-[#030612]"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className="text-3xl p-2 rounded-xl bg-[#080c1a] border border-blue-900/30">{agent.emoji}</span>
                        <div>
                          <h3 className="text-sm font-bold text-white group-hover:text-sky-300 transition-colors">
                            {agent.name}
                          </h3>
                          <span className="text-[10px] text-gray-400 font-medium">{agent.role}</span>
                        </div>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase tracking-wider ${
                          isLive
                            ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800 shadow-[0_0_8px_#34d399]'
                            : agent.status === 'standby'
                            ? 'bg-amber-950/80 text-amber-400 border border-amber-800'
                            : 'bg-gray-900 text-gray-500 border border-gray-800'
                        }`}
                      >
                        {agent.status}
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 line-clamp-2 mb-3">{agent.description}</p>

                    <div className="text-[10px] font-mono text-gray-400 bg-black/60 p-2 rounded-lg border border-gray-900 truncate mb-4">
                      {agent.binaryPath || 'Virtual adapter (bridge-managed)'}
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-gray-900/80">
                      <span className="text-[11px] font-mono text-blue-400 font-semibold">{agent.model}</span>
                      <Link
                        href={`/agents/${agent.id}`}
                        className="text-xs font-semibold text-sky-400 hover:text-white flex items-center gap-1 transition-colors"
                      >
                        <span>Launch Chat</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: KANBAN TASKS & AUTO-ASSIGN */}
      {activeTab === 'kanban' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-sky-400" />
                Mission Control Kanban Tasks
              </h2>
              <p className="text-xs text-gray-400">Autonomous workflow orchestration with 1-click swarm auto-assignment.</p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleAutoAssignAll}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(168,85,247,0.3)] transition-all"
                title="Automatically route unassigned tasks to the best agent persona"
              >
                <Zap className="w-3.5 h-3.5 text-purple-200" />
                <span>⚡ Auto-Assign Swarm</span>
              </button>
              <button
                onClick={() => setShowNewTaskModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ New Task</span>
              </button>
            </div>
          </div>

          {/* Kanban Columns Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { id: 'inbox', title: '📥 Inbox / Backlog', border: 'border-blue-900/40' },
              { id: 'inprogress', title: '⏳ In Progress', border: 'border-amber-900/40' },
              { id: 'review', title: '🔍 Review', border: 'border-purple-900/40' },
              { id: 'completed', title: '✅ Completed', border: 'border-emerald-900/40' },
            ].map((col) => {
              const colTasks = tasks.filter(t => t.column === col.id);
              return (
                <div 
                  key={col.id} 
                  className={`rounded-2xl p-4 bg-[#030614] border ${col.border} flex flex-col min-h-[450px] shadow-sm`}
                >
                  <div className="flex items-center justify-between mb-3 pb-2 border-b border-blue-950/60">
                    <span className="text-xs font-bold text-gray-200 font-mono">{col.title}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-950 text-sky-400">
                      {colTasks.length}
                    </span>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto">
                    {colTasks.map((t) => (
                      <div 
                        key={t.id} 
                        className="p-3.5 rounded-xl bg-[#050a1c] border border-blue-950 hover:border-blue-800/80 transition-all space-y-2 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-xs font-bold text-white leading-snug">{t.title}</h4>
                          <button
                            onClick={() => handleDeleteTask(t.id)}
                            className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-0.5 transition"
                            title="Delete Task"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed font-sans">{t.description}</p>

                        <div className="flex items-center justify-between pt-1 text-[10px] font-mono">
                          <span className={`px-1.5 py-0.5 rounded uppercase font-bold ${
                            t.priority === 'critical' ? 'bg-red-950 text-red-400 border border-red-800' :
                            t.priority === 'high' ? 'bg-amber-950 text-amber-400 border border-amber-800' :
                            'bg-blue-950 text-sky-400'
                          }`}>
                            {t.priority}
                          </span>

                          <span className="text-sky-300 font-bold bg-blue-950/60 px-2 py-0.5 rounded-md border border-blue-900/40">
                            @{t.assignedAgent}
                          </span>
                        </div>

                        {/* Move Task Controls */}
                        <div className="flex items-center justify-between pt-1 border-t border-blue-950/60">
                          {col.id !== 'inbox' ? (
                            <button
                              onClick={() => {
                                const prev = col.id === 'completed' ? 'review' : col.id === 'review' ? 'inprogress' : 'inbox';
                                handleMoveTask(t.id, prev);
                              }}
                              className="text-[10px] text-gray-500 hover:text-sky-400 flex items-center font-mono"
                            >
                              <ChevronLeft className="w-3 h-3" /> Prev
                            </button>
                          ) : <div />}

                          {col.id !== 'completed' ? (
                            <button
                              onClick={() => {
                                const next = col.id === 'inbox' ? 'inprogress' : col.id === 'inprogress' ? 'review' : 'completed';
                                handleMoveTask(t.id, next);
                              }}
                              className="text-[10px] text-gray-500 hover:text-sky-400 flex items-center font-mono"
                            >
                              Next <ChevronRight className="w-3 h-3" />
                            </button>
                          ) : <div />}
                        </div>
                      </div>
                    ))}

                    {colTasks.length === 0 && (
                      <div className="text-center py-10 text-gray-600 text-xs font-mono">
                        No tasks in this lane
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* New Task Modal */}
          {showNewTaskModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
              <div className="w-full max-w-lg bg-[#040817] border border-blue-900/60 rounded-2xl p-6 shadow-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-blue-950 pb-3">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Plus className="w-4 h-4 text-sky-400" /> Create Mission Directive
                  </h3>
                  <button onClick={() => setShowNewTaskModal(false)} className="text-gray-400 hover:text-white">&times;</button>
                </div>

                <form onSubmit={handleCreateTask} className="space-y-4">
                  <div>
                    <label className="text-xs font-mono text-gray-400 block mb-1">Task Title</label>
                    <input
                      type="text"
                      required
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="e.g. Audit DLP security leaks in terminal logging"
                      className="w-full bg-[#02040a] border border-blue-900/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-sans"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-mono text-gray-400 block mb-1">Description & Requirements</label>
                    <textarea
                      rows={3}
                      value={newTaskDesc}
                      onChange={(e) => setNewTaskDesc(e.target.value)}
                      placeholder="Specify execution goals and constraints..."
                      className="w-full bg-[#02040a] border border-blue-900/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 font-sans"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-mono text-gray-400 block mb-1">Priority</label>
                      <select
                        value={newTaskPriority}
                        onChange={(e) => setNewTaskPriority(e.target.value as any)}
                        className="w-full bg-[#02040a] border border-blue-900/50 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                      >
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-mono text-gray-400 block mb-1">Assignee Agent</label>
                      <select
                        value={newTaskAgent}
                        onChange={(e) => setNewTaskAgent(e.target.value)}
                        className="w-full bg-[#02040a] border border-blue-900/50 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                      >
                        <option value="unassigned">Auto / Unassigned</option>
                        {agents.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowNewTaskModal(false)}
                      className="px-4 py-2 rounded-xl text-xs font-mono text-gray-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold font-mono shadow-[0_0_12px_rgba(37,99,235,0.4)]"
                    >
                      Save Task
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: WAR ROOM & LIVE MEETINGS */}
      {activeTab === 'warroom' && (
        <div className="space-y-6">
          {/* Live Meetings & Copilots Suite (All 4 Providers) */}
          <div className="p-6 rounded-2xl bg-[#030614] border border-sky-500/30 shadow-[0_0_30px_rgba(56,189,248,0.15)] space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-950/80 border border-blue-800/40 flex items-center justify-center text-sky-400">
                  <Video className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <span>Live Meetings & Autonomous Copilots</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-950 text-sky-400 border border-blue-800">
                      4 PROVIDERS
                    </span>
                  </h3>
                  <p className="text-xs text-gray-400 font-mono">
                    Dispatch agents to Google Meet, Daily.co / WebRTC, Pika Avatars, or Recall.ai with voice standup and Obsidian note logging.
                  </p>
                </div>
              </div>

              <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${
                activeMeetingSessions.length > 0 ? 'bg-emerald-950 text-emerald-300 border-emerald-500' : 'bg-blue-950 text-gray-400 border-blue-900'
              }`}>
                <span className={`w-2 h-2 rounded-full ${activeMeetingSessions.length > 0 ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
                {activeMeetingSessions.length > 0 ? `${activeMeetingSessions.length} Active Meetings` : 'Standby'}
              </span>
            </div>

            {/* Provider Selector Tabs */}
            <div className="flex flex-wrap gap-2 border-b border-blue-900/40 pb-3">
              {[
                { id: 'google', label: '🎥 Google Meet Direct', desc: 'Official Google Meet Instant Room & Copilot' },
                { id: 'daily', label: '🌐 Daily.co / WebRTC Room', desc: 'Zero-latency Direct & Swarm Roundtable' },
                { id: 'pika', label: '🤖 Avatar Mode (Pika)', desc: 'Real-time AI Video Avatar' },
                { id: 'recall', label: '🎙️ Voice-Only (Recall.ai)', desc: 'Meeting Bot for Meet/Zoom/Teams' },
              ].map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelectedMeetingProvider(p.id as any)}
                  className={`px-3.5 py-2 rounded-xl text-xs font-mono font-semibold transition-all border ${
                    selectedMeetingProvider === p.id
                      ? 'bg-blue-600 text-white border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.35)]'
                      : 'bg-[#060c1d] text-gray-400 border-blue-950 hover:text-gray-200 hover:border-blue-900'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Selected Provider Form */}
            <div className="p-4 rounded-xl bg-[#02040c] border border-blue-950 space-y-3">
              {selectedMeetingProvider === 'google' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-amber-400 font-bold flex items-center gap-1.5">
                      <span>🎥 Official Google Meet Direct</span>
                    </span>
                    <span className="text-gray-500">Instant room at https://meet.google.com/new</span>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <select
                      value={googleAgent}
                      onChange={(e) => setGoogleAgent(e.target.value)}
                      className="w-full sm:w-auto bg-[#0b1020] border border-blue-900/60 rounded-xl px-3 py-2 text-xs text-sky-300 font-mono focus:outline-none"
                    >
                      {agents.map(a => (
                        <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={googleMeetUrl}
                      onChange={(e) => setGoogleMeetUrl(e.target.value)}
                      placeholder="Paste Google Meet URL (e.g. https://meet.google.com/abc-defg-hij), or leave empty for instant room"
                      className="flex-1 w-full bg-[#040816] border border-blue-900/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                    />

                    <button
                      onClick={() => handleDispatchMeeting('google')}
                      disabled={isDispatchingMeeting}
                      className="w-full sm:w-auto px-5 py-2 rounded-xl bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(245,158,11,0.4)] flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{isDispatchingMeeting ? 'Dispatching...' : 'Launch Google Meet & Copilot ↗'}</span>
                    </button>
                  </div>
                </div>
              )}

              {selectedMeetingProvider === 'daily' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-emerald-400 font-bold flex items-center gap-1.5">
                      <span>🌐 Daily.co & WebRTC Instant Room</span>
                    </span>
                    <span className="text-gray-500">Zero-config WebRTC room with Pipecat & Gemini Live</span>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <select
                      value={dailyAgent}
                      onChange={(e) => setDailyAgent(e.target.value)}
                      className="w-full sm:w-auto bg-[#0b1020] border border-blue-900/60 rounded-xl px-3 py-2 text-xs text-sky-300 font-mono focus:outline-none"
                    >
                      {agents.map(a => (
                        <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                      ))}
                    </select>

                    <select
                      value={dailyMode}
                      onChange={(e) => setDailyMode(e.target.value as any)}
                      className="w-full sm:w-auto bg-[#0b1020] border border-blue-900/60 rounded-xl px-3 py-2 text-xs text-emerald-300 font-mono focus:outline-none"
                    >
                      <option value="direct">Direct (1-on-1 with Agent)</option>
                      <option value="roundtable">Swarm Roundtable (Multi-Agent)</option>
                    </select>

                    <input
                      type="text"
                      value={dailyMeetUrl}
                      onChange={(e) => setDailyMeetUrl(e.target.value)}
                      placeholder="Room URL (optional, leave empty for instant live WebRTC room)"
                      className="flex-1 w-full bg-[#040816] border border-blue-900/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                    />

                    <label className="flex items-center gap-1.5 text-xs text-gray-300 font-mono cursor-pointer whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={dailyAutoBrief}
                        onChange={(e) => setDailyAutoBrief(e.target.checked)}
                        className="rounded bg-blue-950 border-blue-800 text-emerald-500"
                      />
                      <span>Auto-brief</span>
                    </label>

                    <button
                      onClick={() => handleDispatchMeeting('daily')}
                      disabled={isDispatchingMeeting}
                      className="w-full sm:w-auto px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(16,185,129,0.4)] flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{isDispatchingMeeting ? 'Creating Room...' : 'Create Room & Dispatch ↗'}</span>
                    </button>
                  </div>
                </div>
              )}

              {selectedMeetingProvider === 'pika' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-blue-400 font-bold flex items-center gap-1.5">
                      <span>🤖 Avatar Mode · Pika</span>
                    </span>
                    <span className="text-gray-500">Real-time AI Video Avatar (~$0.28/m)</span>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <select
                      value={pikaAgent}
                      onChange={(e) => setPikaAgent(e.target.value)}
                      className="w-full sm:w-auto bg-[#0b1020] border border-blue-900/60 rounded-xl px-3 py-2 text-xs text-sky-300 font-mono focus:outline-none"
                    >
                      {agents.map(a => (
                        <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={pikaMeetUrl}
                      onChange={(e) => setPikaMeetUrl(e.target.value)}
                      placeholder="Paste Meet URL (or leave empty for instant room)"
                      className="flex-1 w-full bg-[#040816] border border-blue-900/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                    />

                    <button
                      onClick={() => handleDispatchMeeting('pika')}
                      disabled={isDispatchingMeeting}
                      className="w-full sm:w-auto px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-500 hover:from-blue-500 hover:to-indigo-400 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{isDispatchingMeeting ? 'Dispatching...' : 'Dispatch Pika Avatar ↗'}</span>
                    </button>
                  </div>
                </div>
              )}

              {selectedMeetingProvider === 'recall' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-purple-400 font-bold flex items-center gap-1.5">
                      <span>🎙️ Voice-Only Mode · Recall.ai</span>
                    </span>
                    <span className="text-gray-500">Autonomous voice bot joins Google Meet, Teams, or Zoom</span>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <select
                      value={recallAgent}
                      onChange={(e) => setRecallAgent(e.target.value)}
                      className="w-full sm:w-auto bg-[#0b1020] border border-blue-900/60 rounded-xl px-3 py-2 text-xs text-sky-300 font-mono focus:outline-none"
                    >
                      {agents.map(a => (
                        <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={recallMeetUrl}
                      onChange={(e) => setRecallMeetUrl(e.target.value)}
                      placeholder="Paste Meet URL (e.g. https://meet.google.com/xyz), or leave empty for instant room"
                      className="flex-1 w-full bg-[#040816] border border-blue-900/50 rounded-xl px-4 py-2 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                    />

                    <button
                      onClick={() => handleDispatchMeeting('recall')}
                      disabled={isDispatchingMeeting}
                      className="w-full sm:w-auto px-5 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 hover:from-purple-500 hover:to-pink-400 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(168,85,247,0.4)] flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{isDispatchingMeeting ? 'Dispatching...' : 'Dispatch Recall.ai Bot ↗'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Active Meetings Sessions List */}
            <div className="pt-2 border-t border-blue-950">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider">
                  Active Dispatched Sessions ({activeMeetingSessions.length})
                </span>
                {activeMeetingSessions.length > 0 && (
                  <button
                    onClick={handleClearAllMeetingSessions}
                    className="text-[11px] font-mono text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Clear All &times;
                  </button>
                )}
              </div>

              {activeMeetingSessions.length === 0 ? (
                <div className="p-4 rounded-xl bg-[#02040a] border border-blue-950/40 text-center text-xs text-gray-500 font-mono">
                  No active meetings currently running. Select a provider above to launch your agent copilot.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeMeetingSessions.map(s => (
                    <div
                      key={s.id}
                      className="p-3 rounded-xl bg-[#02040c] border border-blue-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-blue-950 text-sky-400 border border-blue-800">
                          {s.provider}
                        </span>
                        <span className="text-xs font-bold text-white font-mono uppercase">
                          {s.agentId}
                        </span>
                        <a
                          href={s.meetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-sky-400 hover:underline font-mono truncate max-w-xs flex items-center gap-1"
                        >
                          <span className="truncate">{s.meetUrl}</span>
                          <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        </a>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setCopilotActiveSession(s);
                            startSpeechRecognition(s.agentId);
                          }}
                          className="px-3 py-1 rounded-lg bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 text-xs font-mono font-semibold transition-all flex items-center gap-1"
                        >
                          <Activity className="w-3 h-3" />
                          <span>Open Copilot HUD</span>
                        </button>

                        <button
                          onClick={() => handleEndMeetingSession(s.id)}
                          className="px-2.5 py-1 rounded-lg bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-800 text-xs font-mono transition-all"
                          title="End meeting session"
                        >
                          End
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* War Room Standup Section */}
          <div className="p-6 rounded-2xl bg-[#030614] border border-blue-900/30 space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Users className="w-5 h-5 text-sky-400" />
                  War Room Multi-Agent Standup
                </h3>
                <p className="text-xs text-gray-400 font-mono">
                  Broadcast synchronized standup requests and hear spoken reports in distinct AI voices.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleBroadcastStandup}
                  disabled={isBroadcastingStandup}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold font-mono shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isBroadcastingStandup ? 'animate-spin' : ''}`} />
                  <span>{isBroadcastingStandup ? 'Gathering Reports...' : 'Broadcast Standup'}</span>
                </button>

                <button
                  onClick={handlePlayVoiceStandup}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold font-mono transition-all border ${
                    isPlayingVoice
                      ? 'bg-amber-950 text-amber-300 border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.4)] animate-pulse'
                      : 'bg-gradient-to-r from-amber-600 to-orange-500 hover:from-amber-500 hover:to-orange-400 text-white border-transparent shadow-[0_0_15px_rgba(245,158,11,0.3)]'
                  }`}
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>{isPlayingVoice ? 'Stop Voice Standup' : '🔊 Play Voice Standup'}</span>
                </button>
              </div>
            </div>

            {/* Standup Topic Input */}
            <div className="flex items-center gap-2 bg-[#02040a] border border-blue-900/40 rounded-xl px-3 py-1.5">
              <span className="text-xs font-mono text-gray-500">Standup Agenda:</span>
              <input
                type="text"
                value={standupTopic}
                onChange={(e) => setStandupTopic(e.target.value)}
                className="flex-1 bg-transparent text-xs text-sky-300 font-mono focus:outline-none"
              />
            </div>

            {/* Agent Reports Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
              {(standupReports.length > 0 ? standupReports : [
                {
                  agentId: 'claude',
                  agentName: 'Claude Code',
                  emoji: '🧠',
                  status: 'Active',
                  report: 'Orchestrating agent workflows across workspaces. Verified system memory architecture and Obsidian second brain synchronization.',
                  nextStep: 'Refine subagent delegation pipelines and consolidate high-salience knowledge nodes.'
                },
                {
                  agentId: 'antigravity',
                  agentName: 'Antigravity',
                  emoji: '✨',
                  status: 'Active',
                  report: 'Direct pair programming verified. Rebuilt 3D Three.js WebGL globe with Fibonacci particle clouds and holographic Ultron core.',
                  nextStep: 'Maintain zero-latency CLI execution and real-time session persistence.'
                },
                {
                  agentId: 'grok',
                  agentName: 'Grok Engine',
                  emoji: '⚡',
                  status: 'Active',
                  report: 'Real-time intelligence and reasoning telemetry nominal. Low latency response stream validated on local socket.',
                  nextStep: 'Perform continuous sentiment and anomaly detection on background process output.'
                },
                {
                  agentId: 'hermes',
                  agentName: 'Hermes Agent',
                  emoji: '🚀',
                  status: 'Active',
                  report: 'Tool execution engine ready. One-shot YOLO tool pipelines and browser automation adapters calibrated.',
                  nextStep: 'Ready to dispatch to Google Meet or execute external system tasks.'
                }
              ]).map((rep, idx) => {
                const isSpeaking = activeSpeakerIndex === idx;
                return (
                  <div
                    key={rep.agentId}
                    className={`p-4 rounded-2xl border transition-all ${
                      isSpeaking
                        ? 'bg-blue-950/60 border-amber-400 shadow-[0_0_20px_rgba(245,158,11,0.3)] scale-[1.02]'
                        : 'bg-[#02040c] border-blue-950/80 hover:border-blue-800'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{rep.emoji}</span>
                        <h4 className="text-xs font-bold text-white font-mono">{rep.agentName}</h4>
                      </div>
                      {isSpeaking ? (
                        <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse flex items-center gap-1">
                          <Volume2 className="w-2.5 h-2.5" /> SPEAKING
                        </span>
                      ) : (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                          {rep.status}
                        </span>
                      )}
                    </div>

                    <div className="space-y-2 text-[11px] font-mono">
                      <div>
                        <span className="text-gray-500 block text-[10px] uppercase">Completed Turn:</span>
                        <p className="text-gray-300 leading-relaxed font-sans">{rep.report}</p>
                      </div>

                      <div>
                        <span className="text-sky-400 block text-[10px] uppercase">Immediate Target:</span>
                        <p className="text-sky-200 leading-relaxed font-sans">{rep.nextStep}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: AUDIT LOG & SECURITY */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-sky-400" />
                System Audit Stream & DLP Guard
              </h2>
              <p className="text-xs text-gray-400 font-mono">
                Immutable event stream of CLI invocations, vault transactions, and safety interventions.
              </p>
            </div>

            <button
              onClick={() => {
                setAuditLogs(prev => [
                  {
                    id: String(Date.now()),
                    time: new Date().toLocaleTimeString(),
                    level: 'info',
                    message: 'Manual audit scan completed: Zero credential leaks detected.'
                  },
                  ...prev
                ]);
              }}
              className="px-3 py-1.5 rounded-xl bg-[#080f24] border border-blue-900/40 text-sky-300 text-xs font-mono hover:border-blue-500 transition-all"
            >
              Run DLP Leak Scan
            </button>
          </div>

          <div className="rounded-2xl p-4 bg-[#02040c] border border-blue-950/80 space-y-2 max-h-[500px] overflow-y-auto font-mono text-xs">
            {auditLogs.map(log => (
              <div
                key={log.id}
                className="flex items-start gap-3 p-2.5 rounded-xl bg-[#040817] border border-blue-950/60"
              >
                <span className="text-gray-500 text-[10px] mt-0.5">{log.time}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded uppercase font-bold ${
                  log.level === 'success' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                  log.level === 'warn' ? 'bg-amber-950 text-amber-400 border border-amber-800' :
                  'bg-blue-950 text-sky-400 border border-blue-800'
                }`}>
                  {log.level}
                </span>
                <span className="text-gray-200 flex-1 font-sans">{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 5: MODEL PROVIDERS & KEYS */}
      {activeTab === 'providers' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Key className="w-5 h-5 text-sky-400" />
              Model Provider Infrastructure & Environment Keys
            </h2>
            <p className="text-xs text-gray-400 font-mono">
              Secure local environment credentials for multi-provider routing and fallbacks.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { id: 'anthropic', label: 'Anthropic Claude Engine', placeholder: 'ANTHROPIC_API_KEY', val: providerKeys.anthropic },
              { id: 'openai', label: 'OpenAI Codex & GPT-4o', placeholder: 'OPENAI_API_KEY', val: providerKeys.openai },
              { id: 'openrouter', label: 'OpenRouter Fallback Pool', placeholder: 'OPENROUTER_API_KEY', val: providerKeys.openrouter },
              { id: 'groq', label: 'Groq Low Latency LPU', placeholder: 'GROQ_API_KEY', val: providerKeys.groq },
              { id: 'gemini', label: 'Google Gemini Pro / Flash', placeholder: 'GEMINI_API_KEY', val: providerKeys.gemini },
              { id: 'deepseek', label: 'DeepSeek Coder v2 Engine', placeholder: 'DEEPSEEK_API_KEY', val: providerKeys.deepseek },
            ].map(p => (
              <div key={p.id} className="p-4 rounded-2xl bg-[#030614] border border-blue-900/40 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white font-mono">{p.label}</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                    MOUNTED
                  </span>
                </div>
                <div className="flex items-center gap-2 bg-[#02040a] border border-blue-950 rounded-xl px-3 py-2">
                  <input
                    type="password"
                    value={p.val}
                    readOnly
                    className="flex-1 bg-transparent text-xs text-gray-400 font-mono focus:outline-none"
                  />
                  <span className="text-[10px] text-sky-400 font-mono">Configured</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LIVE MEETING COPILOT HUD MODAL */}
      {copilotActiveSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-4xl bg-[#02040c] border border-sky-500/40 rounded-3xl shadow-[0_0_80px_rgba(56,189,248,0.25)] flex flex-col max-h-[90vh] overflow-hidden">
            {/* Modal Header */}
            <div className="p-5 bg-gradient-to-r from-[#030718] via-[#050e2c] to-[#030718] border-b border-blue-900/60 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-950 border border-sky-400/40 flex items-center justify-center text-sky-400">
                  <Video className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    <h3 className="text-base font-bold text-white font-mono uppercase tracking-wide">
                      Live Meeting Copilot · {copilotActiveSession.agentId} · {copilotActiveSession.provider}
                    </h3>
                  </div>
                  <p className="text-xs text-sky-300/80 font-mono">
                    Autonomous meeting copilot actively transcribing and taking structured Obsidian notes
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <a
                  href={copilotActiveSession.meetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-xl bg-blue-950 hover:bg-blue-900 text-sky-300 border border-sky-800 text-xs font-mono font-semibold flex items-center gap-1.5 transition-all shadow-[0_0_12px_rgba(56,189,248,0.2)]"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open Meeting Room ↗</span>
                </a>

                <button
                  onClick={() => setCopilotActiveSession(null)}
                  className="px-3 py-1.5 rounded-xl bg-[#060c1d] hover:bg-[#0c1838] text-gray-400 hover:text-white border border-blue-950 text-xs font-mono"
                  title="Minimize Copilot HUD (keeps running in background)"
                >
                  Minimize
                </button>

                <button
                  onClick={() => handleEndMeetingSession(copilotActiveSession.id)}
                  className="px-3 py-1.5 rounded-xl bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 text-xs font-mono font-semibold flex items-center gap-1.5 transition-all"
                  title="End meeting session and disconnect copilot"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>End Session</span>
                </button>
              </div>
            </div>

            {/* Audio Visualizer & Copilot Control Bar */}
            <div className="px-6 py-4 bg-[#030614] border-b border-blue-900/40 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {/* Audio visualizer orb waves */}
                <div className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-black/60 border border-sky-500/30">
                  <div className={`w-1 bg-sky-400 rounded-full transition-all duration-300 ${isCopilotListening ? 'h-6 animate-pulse' : 'h-2'}`} />
                  <div className={`w-1 bg-blue-400 rounded-full transition-all duration-300 ${isCopilotListening ? 'h-8 animate-bounce' : 'h-3'}`} />
                  <div className={`w-1 bg-teal-400 rounded-full transition-all duration-300 ${isCopilotListening ? 'h-5 animate-pulse' : 'h-2'}`} />
                  <div className={`w-1 bg-emerald-400 rounded-full transition-all duration-300 ${isCopilotListening ? 'h-7 animate-bounce' : 'h-2.5'}`} />
                  <div className={`w-1 bg-sky-400 rounded-full transition-all duration-300 ${isCopilotListening ? 'h-4 animate-pulse' : 'h-2'}`} />
                  <span className="text-[11px] font-mono text-sky-300 ml-2">
                    {isCopilotListening ? 'MIC ACTIVE · TRANSCRIBING AUDIO' : 'MIC PAUSED · STANDBY'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (isCopilotListening) {
                      stopSpeechRecognition();
                    } else {
                      startSpeechRecognition(copilotActiveSession.agentId);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-mono font-semibold flex items-center gap-1.5 transition-all border ${
                    isCopilotListening
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                      : 'bg-blue-950/80 text-gray-300 border-blue-800 hover:text-white'
                  }`}
                >
                  {isCopilotListening ? <Mic className="w-3.5 h-3.5 animate-pulse" /> : <MicOff className="w-3.5 h-3.5" />}
                  <span>{isCopilotListening ? 'Mute Mic' : 'Start Mic Audio'}</span>
                </button>

                <button
                  onClick={() => {
                    if ('speechSynthesis' in window) {
                      window.speechSynthesis.cancel();
                      const greeting = `Hello! I am ${copilotActiveSession.agentId.toUpperCase()}. I have joined your ${copilotActiveSession.provider.toUpperCase()} meeting session. I am actively listening, recording notes, and standing by for your directives.`;
                      const u = new SpeechSynthesisUtterance(greeting);
                      u.rate = 1.05;
                      window.speechSynthesis.speak(u);
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl bg-blue-950 text-sky-300 border border-blue-800 hover:border-sky-500 text-xs font-mono flex items-center gap-1.5 transition-all"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>Replay Voice</span>
                </button>

                <button
                  onClick={handleSaveCopilotNotes}
                  disabled={copilotSaving}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-mono font-semibold flex items-center gap-1.5 transition-all border ${
                    copilotSaveSuccess
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                      : 'bg-gradient-to-r from-blue-600 to-sky-500 text-white border-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.3)]'
                  }`}
                >
                  {copilotSaveSuccess ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{copilotSaving ? 'Saving...' : copilotSaveSuccess ? 'Saved to Obsidian!' : 'Save to Obsidian'}</span>
                </button>
              </div>
            </div>

            {/* Transcript & Notes Feed */}
            <div className="flex-1 p-5 overflow-y-auto space-y-3 bg-[#010208] min-h-[260px] max-h-[400px]">
              {copilotNotes.length === 0 ? (
                <div className="text-center py-10 text-gray-500 font-mono text-xs">
                  No notes recorded yet. Speak into your microphone or type a directive below.
                </div>
              ) : (
                copilotNotes.map((note, idx) => {
                  const isUser = note.speaker.toLowerCase().includes('you');
                  return (
                    <div
                      key={idx}
                      className={`p-3.5 rounded-2xl border ${
                        isUser
                          ? 'bg-[#04081c] border-blue-900/60 text-gray-200'
                          : 'bg-[#020d1e] border-sky-500/30 text-sky-100 shadow-[0_0_15px_rgba(56,189,248,0.05)]'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
                        <span className={`font-bold flex items-center gap-1.5 ${isUser ? 'text-blue-300' : 'text-sky-400'}`}>
                          <span>{isUser ? '👤' : '🤖'}</span>
                          <span>{note.speaker}</span>
                        </span>
                        <span className="text-gray-500">{note.timestamp}</span>
                      </div>
                      <p className="text-xs font-sans leading-relaxed whitespace-pre-wrap">{note.text}</p>
                    </div>
                  );
                })
              )}
            </div>

            {/* Directive Input Box & Quick Actions */}
            <div className="p-4 bg-[#030614] border-t border-blue-900/50 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={copilotInput}
                  onChange={(e) => setCopilotInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSendCopilotDirective();
                  }}
                  placeholder={`Send directive to ${copilotActiveSession.agentId.toUpperCase()} (e.g. 'Summarize deliverables', 'Highlight risks')...`}
                  className="flex-1 bg-[#02040a] border border-blue-900/60 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-sky-400"
                />
                <button
                  onClick={handleSendCopilotDirective}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-mono font-semibold shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              </div>

              <div className="flex items-center gap-2 pt-1 text-[11px] font-mono text-gray-400">
                <span className="text-gray-500">Quick Directives:</span>
                {[
                  'Summarize discussion so far',
                  'Extract key action items',
                  'Identify technical risks'
                ].map((q, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setCopilotInput(q);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-blue-950/60 hover:bg-blue-900 text-sky-300 border border-blue-900/60 hover:border-sky-600 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
