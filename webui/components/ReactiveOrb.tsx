'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Volume2, VolumeX, Maximize2, Minimize2, Sparkles, Activity } from 'lucide-react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'device_action' | 'killswitch';

interface ReactiveOrbProps {
  state?: OrbState;
  size?: number;
  interactive?: boolean;
  showControls?: boolean;
  audioElement?: HTMLAudioElement | null;
  className?: string;
}

const STATE_PALETTES: Record<OrbState, { primary: string; secondary: string; glow: string; label: string }> = {
  idle: {
    primary: '#38bdf8', // Neon Sky Blue
    secondary: '#1d4ed8',
    glow: 'rgba(56, 189, 248, 0.4)',
    label: 'STANDBY',
  },
  listening: {
    primary: '#00e5ff', // Electric Cyan
    secondary: '#0284c7',
    glow: 'rgba(0, 229, 255, 0.6)',
    label: 'LISTENING',
  },
  thinking: {
    primary: '#c084fc', // Cyber Purple / Violet
    secondary: '#7e22ce',
    glow: 'rgba(192, 132, 252, 0.5)',
    label: 'THINKING',
  },
  speaking: {
    primary: '#34d399', // Emerald Hologram
    secondary: '#059669',
    glow: 'rgba(52, 211, 153, 0.6)',
    label: 'SPEAKING',
  },
  device_action: {
    primary: '#fbbf24', // Amber Iron Man Arc
    secondary: '#d97706',
    glow: 'rgba(251, 191, 36, 0.6)',
    label: 'DEVICE ACTION',
  },
  killswitch: {
    primary: '#f87171', // Red Alert
    secondary: '#dc2626',
    glow: 'rgba(248, 113, 113, 0.6)',
    label: 'BLOCKED',
  },
};

export const ReactiveOrb: React.FC<ReactiveOrbProps> = ({
  state = 'idle',
  size = 80,
  interactive = true,
  showControls = false,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const rotRef = useRef({ x: 0.2, y: 0.3 });
  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  const palette = STATE_PALETTES[state] || STATE_PALETTES.idle;
  const currentSize = isExpanded ? 320 : size;

  // Setup Web Audio Mic Analyser
  const toggleMic = async () => {
    if (micActive) {
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      setMicActive(false);
      setAudioLevel(0);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      setMicActive(true);
    } catch (e) {
      console.warn('Microphone access denied or unsupported:', e);
      setMicActive(false);
    }
  };

  useEffect(() => {
    return () => {
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  // 3D Canvas Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let time = 0;

    // Generate sphere points
    const points: Array<{ x: number; y: number; z: number }> = [];
    const rings = 12;
    const segments = 20;
    const baseRadius = currentSize * 0.38;

    for (let i = 0; i <= rings; i++) {
      const theta = (i * Math.PI) / rings;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      for (let j = 0; j < segments; j++) {
        const phi = (j * 2 * Math.PI) / segments;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        points.push({
          x: baseRadius * sinTheta * cosPhi,
          y: baseRadius * cosTheta,
          z: baseRadius * sinTheta * sinPhi,
        });
      }
    }

    const freqData = new Uint8Array(32);

    const render = () => {
      time += 0.02;

      // Extract real-time audio amplitude if mic or state active
      let amp = 0;
      if (analyserRef.current && micActive) {
        analyserRef.current.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < freqData.length; i++) sum += freqData[i];
        amp = (sum / freqData.length) / 255;
        setAudioLevel(amp);
      } else if (state === 'speaking' || state === 'thinking') {
        // Simulated natural voice harmonic pulse
        amp = (Math.sin(time * 6) * 0.15 + Math.cos(time * 11) * 0.1 + 0.25);
      } else {
        // Subtle idle respiration
        amp = (Math.sin(time * 2) * 0.05 + 0.05);
      }

      // Auto rotation
      if (!isDraggingRef.current) {
        rotRef.current.y += 0.012;
        rotRef.current.x = 0.25 + Math.sin(time * 0.5) * 0.1;
      }

      const rx = rotRef.current.x;
      const ry = rotRef.current.y;

      // Clear Canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // Draw background glow aura
      const pulseRadius = (currentSize * 0.42) * (1 + amp * 0.35);
      const grad = ctx.createRadialGradient(cx, cy, pulseRadius * 0.2, cx, cy, pulseRadius * 1.3);
      grad.addColorStop(0, palette.glow);
      grad.addColorStop(0.5, 'rgba(0,0,0,0.2)');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, pulseRadius * 1.3, 0, Math.PI * 2);
      ctx.fill();

      // Project & Render 3D Wireframe Points
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);

      const projected = points.map((p, idx) => {
        // Apply dynamic audio vertex displacement
        const wave = Math.sin(time * 4 + idx * 0.1) * (amp * baseRadius * 0.4);
        const px = p.x * (1 + wave / baseRadius);
        const py = p.y * (1 + wave / baseRadius);
        const pz = p.z * (1 + wave / baseRadius);

        // Y rotation
        const x1 = px * cosY - pz * sinY;
        const z1 = pz * cosY + px * sinY;

        // X rotation
        const y2 = py * cosX - z1 * sinX;
        const z2 = z1 * cosX + py * sinX;

        // Perspective
        const fov = 300;
        const scale = fov / (fov + z2);
        return {
          x: cx + x1 * scale,
          y: cy + y2 * scale,
          z: z2,
          scale,
        };
      });

      // Sort points back to front for depth
      projected.sort((a, b) => a.z - b.z);

      // Draw particle points & subtle lines
      projected.forEach((p, index) => {
        const alpha = Math.max(0.15, Math.min(0.9, (p.z + baseRadius) / (baseRadius * 2)));
        const pointSize = Math.max(1, (1.8 + amp * 2.5) * p.scale);

        ctx.fillStyle = index % 3 === 0 ? palette.primary : palette.secondary;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, pointSize, 0, Math.PI * 2);
        ctx.fill();
      });

      // Core center pulsar
      ctx.globalAlpha = 0.8 + amp * 0.2;
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, (currentSize * 0.14) * (1 + amp * 0.5));
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.3, palette.primary);
      coreGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, (currentSize * 0.14) * (1 + amp * 0.5), 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1.0;
      animId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animId);
  }, [currentSize, palette, state, micActive]);

  // Mouse Drag Interaction for 3D rotation
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!interactive) return;
    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    rotRef.current.y += dx * 0.01;
    rotRef.current.x += dy * 0.01;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  return (
    <div className={`relative inline-flex flex-col items-center select-none ${className}`}>
      {/* 3D Canvas Orb Container */}
      <div
        className="relative cursor-grab active:cursor-grabbing group"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ width: currentSize, height: currentSize }}
      >
        <canvas
          ref={canvasRef}
          width={currentSize}
          height={currentSize}
          className="rounded-full transition-transform duration-300 group-hover:scale-105"
        />

        {/* State Tag Overlay */}
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/80 border border-blue-500/30 backdrop-blur-md flex items-center gap-1.5 shadow-[0_0_10px_rgba(0,0,0,0.8)]">
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: palette.primary }}
          />
          <span className="text-[9px] font-mono font-bold tracking-wider" style={{ color: palette.primary }}>
            {palette.label}
          </span>
        </div>
      </div>

      {/* Floating HUD Controls */}
      {showControls && (
        <div className="flex items-center gap-2 mt-2 px-3 py-1 rounded-xl bg-[#090e1f]/90 border border-blue-900/40 backdrop-blur-md">
          <button
            onClick={toggleMic}
            className={`p-1.5 rounded-lg border transition-all ${
              micActive
                ? 'bg-blue-600/30 border-blue-400 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.4)]'
                : 'bg-black/50 border-blue-950 text-gray-400 hover:text-white'
            }`}
            title={micActive ? 'Disconnect Audio Input' : 'Connect Real-Time Mic Analyser'}
          >
            {micActive ? <Volume2 className="w-3.5 h-3.5 animate-pulse" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-lg bg-black/50 border border-blue-950 text-gray-400 hover:text-white transition-all"
            title={isExpanded ? 'Minimize HUD' : 'Expand Holographic HUD'}
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {micActive && (
            <div className="flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-sky-400 animate-pulse" />
              <div className="w-12 h-1.5 bg-blue-950 rounded-full overflow-hidden border border-blue-900/50">
                <div
                  className="h-full bg-gradient-to-r from-sky-400 to-blue-600 transition-all duration-75"
                  style={{ width: `${Math.min(100, Math.round(audioLevel * 200))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReactiveOrb;
