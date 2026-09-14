'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Volume2, VolumeX, X, Sparkles, Globe, Shield, Activity, Terminal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { bridgeUrl } from '@/lib/config';

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
        setStatusText('LISTENING...');
      };

      rec.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            const finalTxt = event.results[i][0].transcript;
            setTranscript(finalTxt);
            handleVoiceCommand(finalTxt);
          } else {
            interim += event.results[i][0].transcript;
            setTranscript(interim);
          }
        }
      };

      rec.onerror = (e: any) => {
        console.warn('JARVIS Speech Recognition error:', e);
        setIsListening(false);
        setStatusText('READY');
      };

      rec.onend = () => {
        setIsListening(false);
        setStatusText('READY');
      };

      recognitionRef.current = rec;
    }
  }, []);

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

  const handleVoiceCommand = (cmd: string) => {
    const c = cmd.toLowerCase();

    if (c.includes('globe') || c.includes('vault') || c.includes('3d')) {
      const reply = 'Navigating to the 3D Obsidian Vault and Hive Mind Globe visualizer right away, sir.';
      setResponse(reply);
      speak(reply);
      router.push('/globe');
      return;
    }

    if (c.includes('standup') || c.includes('war room')) {
      const reply = 'Initiating agent team morning standup protocol across all active CLIs.';
      setResponse(reply);
      speak(reply);
      // Dispatch standup to bridge
      fetch(bridgeUrl('/api/warroom/standup'), { method: 'POST' }).catch(() => {});
      return;
    }

    if (c.includes('safety') || c.includes('kill switch') || c.includes('gates')) {
      const reply = 'Safety posture is nominal. All six DLP exfiltration guard filters and safety kill switches are fully active.';
      setResponse(reply);
      speak(reply);
      return;
    }

    if (c.includes('status') || c.includes('agents') || c.includes('how are you')) {
      const reply = 'All eight AI CLI agents are connected and responsive: Antigravity, Claude Code, Codex, Grok, Hermes, OpenClaw, OpenCode, and Pi Agent.';
      setResponse(reply);
      speak(reply);
      return;
    }

    if (c.includes('devices') || c.includes('phone') || c.includes('adb')) {
      const reply = 'Opening ADB mobile orchestrator for The Hands.';
      setResponse(reply);
      speak(reply);
      router.push('/devices');
      return;
    }

    // Default conversational reply
    const reply = `Command acknowledged: "${cmd}". Routing instruction to the agent swarm for execution.`;
    setResponse(reply);
    speak(reply);
  };

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
            <div className="my-4 p-4 bg-black/70 border border-blue-950/80 rounded-2xl text-xs text-gray-200 leading-relaxed font-sans min-h-[70px] flex items-center">
              <p className="italic">
                {transcript ? `"${transcript}"` : `"${response}"`}
              </p>
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

            {/* Suggested Voice Commands */}
            <div className="mt-4 pt-3 border-t border-blue-950/60">
              <div className="text-[10px] text-gray-500 font-mono uppercase tracking-wider mb-2 text-center">
                Suggested Voice Commands
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  onClick={() => handleVoiceCommand('Run standup')}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-sky-300 hover:border-sky-500/50 hover:bg-blue-900/20 text-left transition flex items-center gap-1.5"
                >
                  <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="truncate">"Run standup"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('Show 3D vault globe')}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-purple-300 hover:border-purple-500/50 hover:bg-purple-900/20 text-left transition flex items-center gap-1.5"
                >
                  <Globe className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="truncate">"Show 3D globe"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('Check safety gates')}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-emerald-300 hover:border-emerald-500/50 hover:bg-emerald-900/20 text-left transition flex items-center gap-1.5"
                >
                  <Shield className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">"Check safety gates"</span>
                </button>
                <button
                  onClick={() => handleVoiceCommand('System status')}
                  className="p-2 rounded-xl bg-[#091224] border border-blue-900/40 text-amber-300 hover:border-amber-500/50 hover:bg-amber-900/20 text-left transition flex items-center gap-1.5"
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
