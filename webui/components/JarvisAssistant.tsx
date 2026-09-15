'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, VolumeX, X, Sparkles, Globe, Shield, Activity, Terminal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { bridgeUrl } from '@/lib/config';

/** True when the bridge/route refused a send because a kill switch is off. */
function isKillSwitchBlock(error: string): boolean {
  return /kill switch|LLM_SPAWN_ENABLED|WARROOM_|DASHBOARD_MUTATIONS|execution paused/i.test(error);
}

export default function JarvisAssistant() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [statusText, setStatusText] = useState('STANDBY');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState(
    'Good day, sir. All swarm agents and memory topologies are online. What is your command?'
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const animIdRef = useRef<number | null>(null);

  // --- Always-listening / wake word ---------------------------------------
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [wakeWord, setWakeWord] = useState('jarvis');
  const [awake, setAwake] = useState(false);

  // Mirrored into refs because the long-lived recognition callbacks below are
  // created once and would otherwise close over stale state.
  const alwaysOnRef = useRef(false);
  const wakeWordRef = useRef('jarvis');
  const awakeRef = useRef(false);
  const restartTimerRef = useRef<any>(null);
  const restartCountRef = useRef(0);
  const stoppingRef = useRef(false);
  const handleVoiceCommandRef = useRef<(cmd: string) => void>(() => {});
  const dispatchingRef = useRef(false);
  const sessionIdRef = useRef(`jarvis_${Date.now()}`);
  const [dispatchBlocked, setDispatchBlocked] = useState('');
  const [isDispatching, setIsDispatching] = useState(false);

  useEffect(() => { alwaysOnRef.current = alwaysOn; }, [alwaysOn]);
  useEffect(() => { wakeWordRef.current = (wakeWord || 'jarvis').toLowerCase().trim(); }, [wakeWord]);
  useEffect(() => { awakeRef.current = awake; }, [awake]);

  // Restore the operator's preference.
  useEffect(() => {
    try {
      const savedOn = localStorage.getItem('jarvis.alwaysOn');
      const savedWord = localStorage.getItem('jarvis.wakeWord');
      if (savedWord) setWakeWord(savedWord);
      if (savedOn === '1') setAlwaysOn(true);
    } catch {
      // private window / storage blocked — fall back to defaults
    }
  }, []);

  // Initialize Web Speech Recognition
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';

      rec.onstart = () => {
        setIsListening(true);
        restartCountRef.current = 0;
        setStatusText(
          alwaysOnRef.current && !awakeRef.current
            ? `WAITING FOR "${wakeWordRef.current.toUpperCase()}"`
            : 'LISTENING...'
        );
      };

      rec.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const text = event.results[i][0].transcript;

          if (!event.results[i].isFinal) {
            interim += text;
            setTranscript(interim);
            continue;
          }

          // Push-to-talk, or already woken: the whole phrase is the command.
          if (!alwaysOnRef.current || awakeRef.current) {
            setTranscript(text);
            setAwake(false);
            awakeRef.current = false;
            handleVoiceCommandRef.current(text);
            continue;
          }

          // Always-listening and dormant: only act once the wake word lands.
          const lower = text.toLowerCase();
          const at = lower.indexOf(wakeWordRef.current);
          if (at === -1) {
            // Ambient speech — show it, but do not dispatch it anywhere.
            setTranscript(text);
            setStatusText(`WAITING FOR "${wakeWordRef.current.toUpperCase()}"`);
            continue;
          }

          const after = text.slice(at + wakeWordRef.current.length).replace(/^[\s,.:;!?-]+/, '');
          if (after) {
            // "Jarvis, do X" arrived in one breath — run it now.
            setTranscript(after);
            handleVoiceCommandRef.current(after);
          } else {
            // Bare wake word — stay awake for the follow-up phrase.
            setAwake(true);
            awakeRef.current = true;
            setTranscript('');
            setStatusText('LISTENING...');
          }
        }
      };

      rec.onerror = (e: any) => {
        const err = e?.error;
        // A silent window just ends the turn; in always-listening mode onend
        // restarts it. Anything permission-related must stop the loop, or it
        // would spin forever against a denied mic.
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          alwaysOnRef.current = false;
          setAlwaysOn(false);
          setStatusText('MIC BLOCKED');
        } else if (err !== 'no-speech' && err !== 'aborted') {
          console.warn('JARVIS Speech Recognition error:', err || e);
        }
        setIsListening(false);
      };

      rec.onend = () => {
        setIsListening(false);
        if (!alwaysOnRef.current || stoppingRef.current) {
          setStatusText('READY');
          return;
        }
        // Browsers end recognition every few seconds, so always-listening means
        // restarting it. Back off progressively so a hard failure cannot spin.
        restartCountRef.current += 1;
        const delay = Math.min(250 * restartCountRef.current, 5000);
        if (restartCountRef.current > 20) {
          setAlwaysOn(false);
          setStatusText('LISTENING STOPPED');
          return;
        }
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          try {
            rec.start();
          } catch {
            // start() throws if it is already running — harmless.
          }
        }, delay);
      };

      recognitionRef.current = rec;
    }

    return () => {
      stoppingRef.current = true;
      clearTimeout(restartTimerRef.current);
      try { recognitionRef.current?.stop(); } catch { /* not running */ }
    };
  }, []);

  // Start or stop the continuous loop when the toggle flips.
  useEffect(() => {
    try { localStorage.setItem('jarvis.alwaysOn', alwaysOn ? '1' : '0'); } catch { /* blocked */ }
    const rec = recognitionRef.current;
    if (!rec) return;

    if (alwaysOn) {
      stoppingRef.current = false;
      restartCountRef.current = 0;
      try { rec.start(); } catch { /* already running */ }
    } else {
      stoppingRef.current = true;
      clearTimeout(restartTimerRef.current);
      setAwake(false);
      try { rec.stop(); } catch { /* not running */ }
      // Allow a later restart once this stop has settled.
      setTimeout(() => { stoppingRef.current = false; }, 300);
    }
  }, [alwaysOn]);

  useEffect(() => {
    try { localStorage.setItem('jarvis.wakeWord', wakeWord); } catch { /* blocked */ }
  }, [wakeWord]);

  // Text-To-Speech function with British Voice
  const speak = (text: string) => {
    if (!ttsEnabled || typeof window === 'undefined' || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();

    // Prefer British English voice for JARVIS persona
    const britishVoice = voices.find(
      v => v.lang === 'en-GB' || v.name.toLowerCase().includes('british') || v.name.toLowerCase().includes('george') || v.name.toLowerCase().includes('daniel')
    );
    if (britishVoice) utterance.voice = britishVoice;
    utterance.rate = 1.05;
    utterance.pitch = 0.95;

    utterance.onstart = () => setStatusText('SPEAKING...');
    utterance.onend = () => setStatusText('READY');

    window.speechSynthesis.speak(utterance);
  };

  // Canvas Arc Reactor / Audio Orb Animation
  useEffect(() => {
    if (!isOpen) {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;

    function drawOrb() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      phase += isListening ? 0.08 : 0.03;

      // Outer rings
      for (let i = 0; i < 4; i++) {
        const r = 24 + i * 16 + Math.sin(phase + i * 0.8) * (isListening ? 6 : 2.5);
        ctx.strokeStyle = `rgba(56, 189, 248, ${0.15 + (i % 2 === 0 ? 0.2 : 0.1)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const startA = phase * (i % 2 === 0 ? 1 : -1) + (i * Math.PI) / 3;
        ctx.arc(cx, cy, r, startA, startA + Math.PI * 1.35);
        ctx.stroke();
      }

      // Center glowing core
      const coreR = 14 + Math.sin(phase * 2) * (isListening ? 4 : 2);
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreR * 2.5);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.3, '#38bdf8');
      grad.addColorStop(0.7, '#0284c7');
      grad.addColorStop(1, 'transparent');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Core bright center
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 0.6, 0, Math.PI * 2);
      ctx.fill();

      animIdRef.current = requestAnimationFrame(drawOrb);
    }

    drawOrb();

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
    };
  }, [isOpen, isListening]);

  const toggleMic = () => {
    if (!recognitionRef.current) {
      alert('Web Speech API is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    // While always-listening, stop() would just be undone by the restart loop.
    // So the mic button means "wake now" — skip the wake word for this turn.
    // Turning the loop off is the Always Listening toggle's job.
    if (alwaysOn) {
      window.speechSynthesis?.cancel();
      setAwake(true);
      awakeRef.current = true;
      setStatusText('LISTENING...');
      try {
        recognitionRef.current.start();
      } catch {
        // Already running — it is listening, which is what we want.
      }
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
    } else {
      window.speechSynthesis?.cancel();
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.warn('Speech start error:', e);
      }
    }
  };

  const reportDispatchFailure = (error: string) => {
    setDispatchBlocked(error);
    setResponse(error);
    setStatusText(isKillSwitchBlock(error) ? 'KILL SWITCH' : 'FAILED');
    speak(error);
  };

  /**
   * POST the remaining phrase to Next `/api/chat`, which proxies to the
   * bridge `POST /api/chat/send`. The browser never spawns a CLI. Failures
   * (including LLM_SPAWN_ENABLED) are shown as-is — never a fabricated reply.
   */
  const dispatchToAgentOs = async (cmd: string) => {
    setIsDispatching(true);
    setDispatchBlocked('');
    setStatusText('DISPATCHING...');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: cmd,
          agentId: 'antigravity',
          agentName: 'Antigravity',
          sessionId: sessionIdRef.current,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; reply?: string; error?: string; reason?: string }
        | null;

      if (data?.ok && typeof data.reply === 'string' && data.reply.trim()) {
        setDispatchBlocked('');
        setResponse(data.reply.trim());
        speak(data.reply.trim());
        setStatusText('READY');
        return;
      }

      const error =
        (data && typeof data.error === 'string' && data.error) ||
        `Dispatch failed (HTTP ${res.status}${data?.reason ? `, ${data.reason}` : ''}). No agent reply.`;
      reportDispatchFailure(error);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      reportDispatchFailure(`Could not reach /api/chat (bridge proxy): ${detail}`);
    } finally {
      dispatchingRef.current = false;
      setIsDispatching(false);
    }
  };

  const handleVoiceCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (dispatchingRef.current) {
      setStatusText('BUSY');
      return;
    }

    const c = trimmed.toLowerCase();

    // Local UI navigation only — these do not pretend to be agent replies.
    if (c.includes('globe') || c.includes('vault') || c.includes('3d')) {
      const note = 'Opening the 3D vault globe.';
      setDispatchBlocked('');
      setResponse(note);
      speak(note);
      router.push('/globe');
      return;
    }

    if (c.includes('devices') || c.includes('phone') || c.includes('adb')) {
      const note = 'Opening the ADB device orchestrator.';
      setDispatchBlocked('');
      setResponse(note);
      speak(note);
      router.push('/devices');
      return;
    }

    // Existing war-room standup path (bridge /api/warroom/standup), not a
    // fabricated success. Kill-switch refusals surface as-is.
    if (c.includes('standup') || c.includes('war room')) {
      dispatchingRef.current = true;
      setIsDispatching(true);
      setDispatchBlocked('');
      setStatusText('DISPATCHING...');
      void (async () => {
        try {
          const res = await fetch(bridgeUrl('/api/warroom/standup'), { method: 'POST' });
          const data = (await res.json().catch(() => null)) as
            | { ok?: boolean; message?: string; error?: string }
            | null;
          if (res.ok && data?.ok !== false) {
            const msg =
              (typeof data?.message === 'string' && data.message.trim()) ||
              'War room standup convened.';
            setDispatchBlocked('');
            setResponse(msg);
            speak(msg);
            setStatusText('READY');
          } else {
            reportDispatchFailure(
              (data && typeof data.error === 'string' && data.error) ||
                `Standup blocked (HTTP ${res.status}).`
            );
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          reportDispatchFailure(`Could not reach war-room standup: ${detail}`);
        } finally {
          dispatchingRef.current = false;
          setIsDispatching(false);
        }
      })();
      return;
    }

    dispatchingRef.current = true;
    void dispatchToAgentOs(trimmed);
  };

  handleVoiceCommandRef.current = handleVoiceCommand;

  return (
    <>
      {/* Floating Arc Reactor Button */}
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen && !response) {
            speak('Good day, sir. All swarm agents and memory topologies are online. What is your command?');
          }
        }}
        className="fixed bottom-6 right-6 z-50 p-3 rounded-full bg-[#051124] border-2 border-sky-400 text-sky-300 shadow-[0_0_25px_rgba(56,189,248,0.5)] hover:shadow-[0_0_35px_rgba(56,189,248,0.8)] hover:scale-105 transition-all flex items-center justify-center group"
        title="J.A.R.V.I.S. Voice Assistant"
      >
        <div className="relative flex items-center justify-center">
          <div className="w-7 h-7 rounded-full border border-sky-300/40 animate-ping absolute"></div>
          <Sparkles className="w-6 h-6 text-sky-300 group-hover:rotate-12 transition-transform" />
        </div>
      </button>

      {/* JARVIS Modal Dialogue */}
      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#040915] border border-blue-600/50 rounded-3xl p-6 shadow-[0_0_50px_rgba(56,189,248,0.25)] relative select-none">
            {/* Close Button */}
            <button
              onClick={() => {
                setIsOpen(false);
                window.speechSynthesis?.cancel();
                if (isListening) recognitionRef.current?.stop();
              }}
              className="absolute top-5 right-5 p-1 text-gray-400 hover:text-white rounded-lg transition"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Title & Badge */}
            <div className="text-center mb-4">
              <h2 className="text-lg font-black tracking-widest text-sky-400">
                J.A.R.V.I.S.
              </h2>
              <p className="text-[10px] text-gray-500 font-mono tracking-wider">
                JUST A RATHER VERY INTELLIGENT SYSTEM • VOICE ASSISTANT
              </p>
            </div>

            {/* Canvas Arc Reactor */}
            <div className="flex flex-col items-center justify-center my-3 relative">
              <canvas
                ref={canvasRef}
                width={180}
                height={180}
                className="w-44 h-44 block"
              />
              <span className="text-[10px] bg-blue-950/80 text-sky-300 border border-blue-700/50 px-3 py-1 rounded-full font-mono font-bold tracking-widest shadow-[0_0_12px_rgba(56,189,248,0.3)] mt-2">
                {statusText}
              </span>
            </div>

            {/* Dialogue Bubble */}
            <div className="my-4 p-4 bg-black/70 border border-blue-950/80 rounded-2xl text-xs text-gray-200 leading-relaxed font-sans min-h-[70px] flex flex-col justify-center gap-2">
              {transcript ? (
                <p className="text-sky-300/80">You: &ldquo;{transcript}&rdquo;</p>
              ) : null}
              <p className="italic">&ldquo;{response}&rdquo;</p>
            </div>

            {/* Action Bar (Mic & Audio Output) */}
            <div className="flex items-center justify-center gap-4 my-3">
              <button
                onClick={toggleMic}
                className={`p-4 rounded-full border-2 transition-all flex items-center justify-center ${
                  isListening
                    ? 'bg-rose-950 border-rose-500 text-rose-300 shadow-[0_0_20px_rgba(244,63,94,0.6)] animate-pulse'
                    : 'bg-blue-950 border-sky-400 text-sky-300 shadow-[0_0_20px_rgba(56,189,248,0.4)] hover:scale-105'
                }`}
                title={isListening ? 'Stop Listening' : 'Click to Speak'}
              >
                {isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </button>

              <button
                onClick={() => {
                  setTtsEnabled(!ttsEnabled);
                  if (ttsEnabled) window.speechSynthesis?.cancel();
                }}
                className={`px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-all ${
                  ttsEnabled
                    ? 'bg-[#09152b] border-blue-800 text-sky-300'
                    : 'bg-gray-900 border-gray-800 text-gray-500'
                }`}
              >
                {ttsEnabled ? <Volume2 className="w-4 h-4 text-sky-400" /> : <VolumeX className="w-4 h-4" />}
                <span>Voice: {ttsEnabled ? 'ON' : 'MUTED'}</span>
              </button>
            </div>

            {/* Always-Listening / Wake Word */}
            <div className="flex items-center justify-center gap-2 mb-3 flex-wrap">
              <button
                onClick={() => setAlwaysOn((v) => !v)}
                className={`px-3 py-2 rounded-xl border text-xs font-semibold flex items-center gap-2 transition-all ${
                  alwaysOn
                    ? 'bg-[#04122a] border-sky-400 text-sky-200 shadow-[0_0_16px_rgba(56,189,248,0.45)]'
                    : 'bg-gray-900 border-gray-800 text-gray-500 hover:border-blue-900'
                }`}
                title={
                  alwaysOn
                    ? `Always listening — say "${wakeWord}" to wake me`
                    : 'Listen continuously and wait for the wake word'
                }
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    alwaysOn
                      ? awake
                        ? 'bg-rose-400 animate-pulse'
                        : 'bg-sky-400 animate-pulse'
                      : 'bg-gray-600'
                  }`}
                />
                <span>Always Listening: {alwaysOn ? (awake ? 'AWAKE' : 'ARMED') : 'OFF'}</span>
              </button>

              <label className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono uppercase tracking-wider">
                <span>Wake word</span>
                <input
                  value={wakeWord}
                  onChange={(e) => setWakeWord(e.target.value)}
                  spellCheck={false}
                  className="w-24 bg-black border border-blue-950 rounded-lg px-2 py-1 text-sky-300
                             text-xs font-semibold tracking-wide outline-none focus:border-sky-500"
                />
              </label>
            </div>

            {alwaysOn && (
              <p className="text-[10px] text-center text-gray-600 font-mono mb-2">
                Speech is processed by your browser. Nothing is sent anywhere until
                &ldquo;{wakeWord}&rdquo; is heard. After that the remaining phrase
                is POSTed to /api/chat (bridge /api/chat/send).
              </p>
            )}

            {dispatchBlocked && (
              <p className="text-[10px] text-center text-rose-400 font-mono mb-2 px-2 leading-relaxed">
                {isKillSwitchBlock(dispatchBlocked)
                  ? `Kill switch blocked this send (LLM_SPAWN_ENABLED etc.): ${dispatchBlocked}`
                  : `Send failed: ${dispatchBlocked}`}
              </p>
            )}

            {isDispatching && !dispatchBlocked && (
              <p className="text-[10px] text-center text-sky-500 font-mono mb-2">
                Dispatching remaining phrase to Agent OS via /api/chat…
              </p>
            )}

            {/* Suggested Voice Commands */}
            <div className="mt-4 pt-3 border-t border-blue-950/60">
              <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider mb-2 text-center">
                Suggested Voice Commands
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  onClick={() => handleVoiceCommand('Run standup')}
                  disabled={isDispatching}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-sky-300 hover:border-sky-500/50 hover:bg-blue-900/20 text-left transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="truncate">"Run standup"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('Show 3D vault globe')}
                  disabled={isDispatching}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-purple-300 hover:border-purple-500/50 hover:bg-purple-900/20 text-left transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Globe className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="truncate">"Show 3D globe"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('Check safety gates')}
                  disabled={isDispatching}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-emerald-300 hover:border-emerald-500/50 hover:bg-emerald-900/20 text-left transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Shield className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">"Check safety gates"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('System status')}
                  disabled={isDispatching}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-amber-300 hover:border-amber-500/50 hover:bg-amber-900/20 text-left transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Terminal className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate">"System status"</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
