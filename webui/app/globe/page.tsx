'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { 
  ArrowLeft, 
  Globe, 
  RotateCw, 
  ZoomIn, 
  ZoomOut, 
  Activity,
  Hand,
  Sparkles,
  Camera,
  CameraOff,
  Maximize2,
  RefreshCw
} from 'lucide-react';
import { HandTracker, GestureState } from '@/lib/handTracker';

interface AgentNodeData {
  id: string;
  name: string;
  emoji: string;
  role: string;
  model: string;
  status: string;
  color: number;
}

export default function GlobePage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  
  const [autoRotate, setAutoRotate] = useState(true);
  const [voiceResonance, setVoiceResonance] = useState(true);
  const [bloomEnabled, setBloomEnabled] = useState(true);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [gestureStatus, setGestureStatus] = useState<string>('Standby');
  const [activeGesture, setActiveGesture] = useState<GestureState | null>(null);
  const [isCameraStarting, setIsCameraStarting] = useState(false);

  const [selectedItem, setSelectedItem] = useState<{
    type: 'agent' | 'memory' | 'core';
    title: string;
    subtitle: string;
    details: string;
    link?: string;
    stats?: Record<string, string | number>;
    tags?: string[];
  } | null>(null);

  const [stats, setStats] = useState({ agents: 8, memories: 42, nodesTotal: 2800 });
  const [agentsList, setAgentsList] = useState<AgentNodeData[]>([]);

  // Three.js internal refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const coreGroupRef = useRef<THREE.Group | null>(null);
  const agentsGroupRef = useRef<THREE.Group | null>(null);
  const memoriesPointsRef = useRef<THREE.Points | null>(null);
  const orbitalRingsRef = useRef<THREE.Group | null>(null);
  const connectionsRef = useRef<THREE.LineSegments | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Mouse & Gesture interaction refs
  const isDraggingRef = useRef(false);
  const previousMousePositionRef = useRef({ x: 0, y: 0 });
  const rotationVelocityRef = useRef({ x: 0, y: 0.002 });
  const zoomLevelRef = useRef(380);

  // Hand tracker instance
  const trackerRef = useRef<HandTracker | null>(null);

  // Agent definitions
  const DEFAULT_AGENTS: AgentNodeData[] = [
    { id: 'claude', name: 'Claude Code', emoji: '🧠', role: 'Architect & Lead Swarm Orchestrator', model: 'claude-3-7-sonnet', status: 'live', color: 0x38bdf8 },
    { id: 'antigravity', name: 'Antigravity', emoji: '✨', role: 'Autonomous Agentic Pair Programmer', model: 'gemini-2.5-pro', status: 'live', color: 0x60a5fa },
    { id: 'grok', name: 'Grok Engine', emoji: '⚡', role: 'Real-time Intelligence & Reasoning', model: 'grok-2', status: 'live', color: 0xe2e8f0 },
    { id: 'hermes', name: 'Hermes Agent', emoji: '🚀', role: 'Full-Stack Execution & Tools', model: 'hermes-3-llama-3.1-70b', status: 'live', color: 0xf97316 },
    { id: 'codex', name: 'OpenAI Codex', emoji: '💻', role: 'Low-latency Synthesizer', model: 'gpt-4o', status: 'standby', color: 0x34d399 },
    { id: 'opencode', name: 'OpenCode Interpreter', emoji: '📜', role: 'Terminal Sandboxing', model: 'deepseek-coder-v2', status: 'standby', color: 0xfacc15 },
    { id: 'openclaw', name: 'OpenClaw Engine', emoji: '🦞', role: 'Distributed Workflows', model: 'claude-3-5-sonnet', status: 'standby', color: 0xf87171 },
    { id: 'pi', name: 'Pi Telemetry', emoji: '🥧', role: 'Ambient Conversational Co-pilot', model: 'inflection-2.5', status: 'standby', color: 0xe879f9 }
  ];

  // Fetch agents and obsidian memories
  useEffect(() => {
    async function loadData() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        if (data.ok && data.agents && data.agents.length > 0) {
          const mapped: AgentNodeData[] = data.agents.map((a: any) => ({
            id: a.id,
            name: a.name,
            emoji: a.emoji || '🤖',
            role: a.role || 'Agent Subsystem',
            model: a.model || 'Unknown',
            status: a.status || 'live',
            color: a.id === 'antigravity' ? 0x60a5fa : a.id === 'claude' ? 0x38bdf8 : a.id === 'grok' ? 0xe2e8f0 : a.id === 'hermes' ? 0xf97316 : 0x34d399
          }));
          setAgentsList(mapped);
          setStats(prev => ({ ...prev, agents: mapped.length }));
        } else {
          setAgentsList(DEFAULT_AGENTS);
        }
      } catch {
        setAgentsList(DEFAULT_AGENTS);
      }

      try {
        const vaultRes = await fetch('/api/vault');
        const vaultData = await vaultRes.json();
        if (vaultData.ok && vaultData.items) {
          setStats(prev => ({ ...prev, memories: vaultData.items.length }));
        }
      } catch {}
    }
    loadData();
  }, []);

  // Hand tracking state callback
  const handleGestureFrame = useCallback((state: GestureState) => {
    setActiveGesture(state);

    if (state.handsDetected === 0) {
      setGestureStatus('Searching for hands...');
      return;
    }

    if (state.isDualPinching) {
      setGestureStatus('Dual Pinch Detected — Zooming');
      zoomLevelRef.current = Math.max(180, Math.min(650, zoomLevelRef.current - state.zoomDelta * 60));
    } else if (state.isPinching) {
      setGestureStatus('Pinch Active — Orbiting Globe');
      if (memoriesPointsRef.current) {
        memoriesPointsRef.current.rotation.y += state.pinchDeltaX * 0.05;
        memoriesPointsRef.current.rotation.x += state.pinchDeltaY * 0.05;
      }
      if (agentsGroupRef.current) {
        agentsGroupRef.current.rotation.y += state.pinchDeltaX * 0.05;
      }
      if (connectionsRef.current) {
        connectionsRef.current.rotation.y += state.pinchDeltaX * 0.05;
      }
      rotationVelocityRef.current = {
        x: state.pinchDeltaY * 0.015,
        y: state.pinchDeltaX * 0.015
      };
    } else {
      setGestureStatus(`${state.handsDetected} Hand${state.handsDetected > 1 ? 's' : ''} Ready (Pinch to grab & spin)`);
    }
  }, []);

  // Start / Stop Hand Gesture Tracking
  const toggleGestures = async () => {
    if (gesturesEnabled) {
      if (trackerRef.current) {
        trackerRef.current.stop();
      }
      setGesturesEnabled(false);
      setGestureStatus('Standby');
      setActiveGesture(null);
      return;
    }

    if (!videoRef.current) return;

    setIsCameraStarting(true);
    setGestureStatus('Initializing MediaPipe AI vision...');

    try {
      if (!trackerRef.current) {
        trackerRef.current = new HandTracker();
      }
      await trackerRef.current.start(videoRef.current, handleGestureFrame);
      setGesturesEnabled(true);
      setGestureStatus('Webcam active — raise hand to control');
    } catch (err: any) {
      console.error('Hand tracking error:', err);
      setGestureStatus(`Error: ${err.message || 'Camera permission denied'}`);
      setGesturesEnabled(false);
    } finally {
      setIsCameraStarting(false);
    }
  };

  // Reset Camera View
  const resetView = () => {
    zoomLevelRef.current = 380;
    if (cameraRef.current) {
      cameraRef.current.position.set(0, 0, 380);
      cameraRef.current.lookAt(0, 0, 0);
    }
    if (memoriesPointsRef.current) {
      memoriesPointsRef.current.rotation.set(0, 0, 0);
    }
    rotationVelocityRef.current = { x: 0, y: 0.002 };
  };

  // Global Keyboard Shortcuts (G: Gesture, B: Bloom, R: Reset)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'g' || e.key === 'G') {
        toggleGestures();
      } else if (e.key === 'b' || e.key === 'B') {
        setBloomEnabled(prev => !prev);
      } else if (e.key === 'r' || e.key === 'R') {
        resetView();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gesturesEnabled]);

  // Cleanup hand tracker on unmount
  useEffect(() => {
    return () => {
      if (trackerRef.current) {
        trackerRef.current.destroy();
      }
    };
  }, []);

  // Initialize Three.js Scene + Postprocessing Bloom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 1. Scene & Fog
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // Super AMOLED pure black
    scene.fog = new THREE.FogExp2(0x000411, 0.0018);
    sceneRef.current = scene;

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 3000);
    camera.position.z = zoomLevelRef.current;
    cameraRef.current = camera;

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 4. Postprocessing Bloom Composer (Ultron Holographic Glow)
    try {
      const composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      composer.addPass(renderPass);

      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        1.15, // strength
        0.45, // radius
        0.14  // threshold
      );
      composer.addPass(bloomPass);
      composerRef.current = composer;
    } catch (e) {
      console.warn('Postprocessing bloom fallback to raw WebGL:', e);
      composerRef.current = null;
    }

    // 5. Center Holographic Geodesic Core (Ultron / JARVIS Architecture)
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);
    coreGroupRef.current = coreGroup;

    // Outer wireframe icosahedron
    const outerIcosaGeo = new THREE.IcosahedronGeometry(70, 2);
    const outerIcosaMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
    });
    const outerIcosa = new THREE.Mesh(outerIcosaGeo, outerIcosaMat);
    coreGroup.add(outerIcosa);

    // Mid wireframe dodecahedron
    const midDodecaGeo = new THREE.DodecahedronGeometry(50, 1);
    const midDodecaMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      wireframe: true,
      transparent: true,
      opacity: 0.48,
    });
    const midDodeca = new THREE.Mesh(midDodecaGeo, midDodecaMat);
    coreGroup.add(midDodeca);

    // Inner glowing octahedral nucleus
    const innerGeo = new THREE.OctahedronGeometry(30, 2);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x60a5fa,
      wireframe: true,
      transparent: true,
      opacity: 0.75,
    });
    const innerCore = new THREE.Mesh(innerGeo, innerMat);
    coreGroup.add(innerCore);

    // 6. Obsidian Memory Vault Point Cloud (Fibonacci Sphere Distribution)
    const particleCount = 2800;
    const pointsGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const radius = 135;
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden ratio angle

    for (let i = 0; i < particleCount; i++) {
      const y = 1 - (i / (particleCount - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = phi * i;

      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;

      const rVar = radius * (0.88 + Math.random() * 0.25);
      positions[i * 3] = x * rVar;
      positions[i * 3 + 1] = y * rVar;
      positions[i * 3 + 2] = z * rVar;

      const randType = Math.random();
      if (randType > 0.85) {
        colors[i * 3] = 0.0;
        colors[i * 3 + 1] = 0.95;
        colors[i * 3 + 2] = 1.0;
      } else if (randType > 0.65) {
        colors[i * 3] = 0.75;
        colors[i * 3 + 1] = 0.52;
        colors[i * 3 + 2] = 0.99;
      } else if (randType > 0.4) {
        colors[i * 3] = 0.22;
        colors[i * 3 + 1] = 0.74;
        colors[i * 3 + 2] = 0.97;
      } else {
        colors[i * 3] = 0.12;
        colors[i * 3 + 1] = 0.23;
        colors[i * 3 + 2] = 0.54;
      }
    }

    pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pointsGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // High quality circular sprite texture
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(56,189,248,0.9)');
    grad.addColorStop(0.7, 'rgba(37,99,235,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    const pointTexture = new THREE.CanvasTexture(canvas);
    const pointsMat = new THREE.PointsMaterial({
      size: 3.5,
      map: pointTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const memoriesPoints = new THREE.Points(pointsGeo, pointsMat);
    scene.add(memoriesPoints);
    memoriesPointsRef.current = memoriesPoints;

    // 7. Orbital Rings
    const ringsGroup = new THREE.Group();
    scene.add(ringsGroup);
    orbitalRingsRef.current = ringsGroup;

    const createOrbitRing = (r: number, rotX: number, rotY: number, color: number, op: number) => {
      const ringGeo = new THREE.BufferGeometry();
      const segments = 128;
      const ringPositions = new Float32Array((segments + 1) * 3);
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        ringPositions[s * 3] = Math.cos(theta) * r;
        ringPositions[s * 3 + 1] = Math.sin(theta) * r;
        ringPositions[s * 3 + 2] = 0;
      }
      ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
      const ringMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: op,
      });
      const line = new THREE.Line(ringGeo, ringMat);
      line.rotation.x = rotX;
      line.rotation.y = rotY;
      return line;
    };

    ringsGroup.add(createOrbitRing(165, Math.PI / 2.2, 0.2, 0x0284c7, 0.4));
    ringsGroup.add(createOrbitRing(175, Math.PI / 3.5, 0.4, 0x38bdf8, 0.3));
    ringsGroup.add(createOrbitRing(185, -Math.PI / 4, 0.1, 0x818cf8, 0.25));

    // 8. Agent Satellite Hubs in Orbit
    const agentsGroup = new THREE.Group();
    scene.add(agentsGroup);
    agentsGroupRef.current = agentsGroup;

    const currentAgents = agentsList.length > 0 ? agentsList : DEFAULT_AGENTS;
    const agentMeshes: THREE.Mesh[] = [];
    const agentOrbitRadius = 175;

    currentAgents.forEach((ag, idx) => {
      const angle = (idx / currentAgents.length) * Math.PI * 2;
      const heightOffset = Math.sin(idx * 1.5) * 35;
      const x = Math.cos(angle) * agentOrbitRadius;
      const z = Math.sin(angle) * agentOrbitRadius;
      const y = heightOffset;

      const agentGeo = new THREE.SphereGeometry(6, 24, 24);
      const agentMat = new THREE.MeshBasicMaterial({
        color: ag.color,
      });
      const mesh = new THREE.Mesh(agentGeo, agentMat);
      mesh.position.set(x, y, z);
      mesh.userData = { isAgent: true, agentData: ag };

      // Glow halo ring
      const ringGlowGeo = new THREE.RingGeometry(8, 9.5, 32);
      const ringGlowMat = new THREE.MeshBasicMaterial({
        color: ag.color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      });
      const ringGlow = new THREE.Mesh(ringGlowGeo, ringGlowMat);
      ringGlow.lookAt(0, 0, 0);
      mesh.add(ringGlow);

      agentsGroup.add(mesh);
      agentMeshes.push(mesh);
    });

    // 9. Dynamic Neural Connection Beams
    const linePositions: number[] = [];
    currentAgents.forEach((ag, idx) => {
      const angle = (idx / currentAgents.length) * Math.PI * 2;
      const x = Math.cos(angle) * agentOrbitRadius;
      const z = Math.sin(angle) * agentOrbitRadius;
      const y = Math.sin(idx * 1.5) * 35;

      linePositions.push(0, 0, 0);
      linePositions.push(x, y, z);

      const nextIdx = (idx + 1) % currentAgents.length;
      const nextAngle = (nextIdx / currentAgents.length) * Math.PI * 2;
      linePositions.push(x, y, z);
      linePositions.push(
        Math.cos(nextAngle) * agentOrbitRadius,
        Math.sin(nextIdx * 1.5) * 35,
        Math.sin(nextAngle) * agentOrbitRadius
      );
    });

    const connGeo = new THREE.BufferGeometry();
    connGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const connMat = new THREE.LineBasicMaterial({
      color: 0x0284c7,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    const connections = new THREE.LineSegments(connGeo, connMat);
    scene.add(connections);
    connectionsRef.current = connections;

    // Raycaster for click/hover node inspection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handleCanvasClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      const intersects = raycaster.intersectObjects(agentMeshes, false);
      if (intersects.length > 0) {
        const hit = intersects[0].object;
        const ag = hit.userData.agentData as AgentNodeData;
        setSelectedItem({
          type: 'agent',
          title: ag.name,
          subtitle: ag.role,
          details: `Direct CLI bridge active.\nModel: ${ag.model}\nStatus: ${ag.status.toUpperCase()}\nObsidian telemetry stream synced.`,
          link: `/agents/${ag.id}`,
          stats: {
            Status: ag.status.toUpperCase(),
            Model: ag.model,
            Latency: '18ms',
            VaultSync: 'Active'
          },
          tags: ['Autonomous Agent', 'CLI Bridge', 'Obsidian Sync']
        });
        return;
      }

      const coreIntersects = raycaster.intersectObject(outerIcosa, false);
      if (coreIntersects.length > 0) {
        setSelectedItem({
          type: 'core',
          title: 'Hive Mind Neural Core',
          subtitle: 'Central Memory & Multi-Agent Bridge',
          details: 'Unified shared memory state linking all active CLI workers, Obsidian Daily Notes, and Mission Control execution threads.',
          link: '/vault',
          stats: {
            Nodes: particleCount,
            ConnectedAgents: currentAgents.length,
            Encryption: 'Local Vault (Zero-Knowledge)',
            Architecture: 'Three-Layer State'
          },
          tags: ['Hive Mind', 'Three.js WebGL', 'Early AI-dopters']
        });
      }
    };

    renderer.domElement.addEventListener('click', handleCanvasClick);

    // Animation Loop
    let clock = new THREE.Clock();

    const animate = () => {
      animFrameIdRef.current = requestAnimationFrame(animate);

      const elapsedTime = clock.getElapsedTime();

      let pulseMultiplier = 1.0;
      if (voiceResonance) {
        pulseMultiplier = 1.0 + Math.sin(elapsedTime * 4.5) * 0.05 + Math.cos(elapsedTime * 2.2) * 0.03;
      }

      if (coreGroupRef.current) {
        outerIcosa.rotation.x = elapsedTime * 0.15;
        outerIcosa.rotation.y = elapsedTime * 0.25;
        outerIcosa.scale.set(pulseMultiplier, pulseMultiplier, pulseMultiplier);

        midDodeca.rotation.x = -elapsedTime * 0.2;
        midDodeca.rotation.z = elapsedTime * 0.3;
        midDodeca.scale.set(pulseMultiplier * 0.95, pulseMultiplier * 0.95, pulseMultiplier * 0.95);

        innerCore.rotation.y = elapsedTime * 0.4;
      }

      if (memoriesPointsRef.current) {
        if (autoRotate && !isDraggingRef.current) {
          memoriesPointsRef.current.rotation.y += 0.0015;
          memoriesPointsRef.current.rotation.x = Math.sin(elapsedTime * 0.2) * 0.05;
        } else {
          memoriesPointsRef.current.rotation.y += rotationVelocityRef.current.y;
          memoriesPointsRef.current.rotation.x += rotationVelocityRef.current.x;
          rotationVelocityRef.current.x *= 0.95;
          rotationVelocityRef.current.y *= 0.95;
        }
      }

      if (orbitalRingsRef.current && autoRotate) {
        orbitalRingsRef.current.rotation.z = elapsedTime * 0.03;
      }

      if (agentsGroupRef.current && autoRotate) {
        agentsGroupRef.current.rotation.y = elapsedTime * 0.08;
      }

      if (connectionsRef.current && autoRotate) {
        connectionsRef.current.rotation.y = elapsedTime * 0.08;
      }

      camera.position.z += (zoomLevelRef.current - camera.position.z) * 0.1;

      // Render with bloom composer if enabled, else plain renderer
      if (bloomEnabled && composerRef.current) {
        composerRef.current.render();
      } else {
        renderer.render(scene, camera);
      }
    };

    animate();

    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const newW = container.clientWidth;
      const newH = container.clientHeight;
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
      if (composerRef.current) {
        composerRef.current.setSize(newW, newH);
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      renderer.domElement.removeEventListener('click', handleCanvasClick);
      renderer.dispose();
      pointsGeo.dispose();
      pointsMat.dispose();
      outerIcosaGeo.dispose();
      outerIcosaMat.dispose();
    };
  }, [agentsList, autoRotate, voiceResonance, bloomEnabled]);

  // Mouse Drag / Orbit Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const deltaX = e.clientX - previousMousePositionRef.current.x;
    const deltaY = e.clientY - previousMousePositionRef.current.y;

    rotationVelocityRef.current = {
      x: deltaY * 0.003,
      y: deltaX * 0.003
    };

    if (memoriesPointsRef.current) {
      memoriesPointsRef.current.rotation.y += deltaX * 0.005;
      memoriesPointsRef.current.rotation.x += deltaY * 0.005;
    }
    if (agentsGroupRef.current) {
      agentsGroupRef.current.rotation.y += deltaX * 0.005;
    }
    if (connectionsRef.current) {
      connectionsRef.current.rotation.y += deltaX * 0.005;
    }

    previousMousePositionRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    zoomLevelRef.current = Math.max(180, Math.min(650, zoomLevelRef.current + e.deltaY * 0.3));
  };

  return (
    <div className="flex flex-col h-screen max-h-screen bg-black text-gray-100 overflow-hidden font-sans select-none">
      {/* Hidden/Live Video Element for MediaPipe Hand Tracking */}
      <video
        ref={videoRef}
        className="hidden"
        playsInline
        muted
      />

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

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-900 to-black border border-blue-500/50 flex items-center justify-center text-sky-400 shadow-[0_0_20px_rgba(56,189,248,0.4)]">
              <Globe className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-white tracking-wide">
                  Obsidian 3D Vault & Hive Mind Globe
                </h1>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-400 border border-cyan-800/40 uppercase">
                  ULTRON / JARVIS CORE
                </span>
              </div>
              <p className="text-xs text-gray-400 font-mono">
                {stats.agents} Swarm Agents • {stats.nodesTotal.toLocaleString()} Knowledge Points • Fullstack MediaPipe Gestures
              </p>
            </div>
          </div>
        </div>

        {/* Right Action Controls */}
        <div className="flex items-center gap-2.5">
          {/* Hand Gestures Toggle Button */}
          <button
            onClick={toggleGestures}
            disabled={isCameraStarting}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-mono font-semibold border transition-all ${
              gesturesEnabled
                ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.4)] animate-pulse'
                : 'bg-[#090e1f] text-gray-300 hover:text-white border-blue-900/60 hover:border-emerald-500/60'
            }`}
            title="Toggle webcam hand gesture interaction (Hotkey: G)"
          >
            {gesturesEnabled ? (
              <Hand className="w-4 h-4 text-emerald-400 animate-bounce" />
            ) : (
              <Camera className="w-4 h-4 text-sky-400" />
            )}
            <span>{isCameraStarting ? 'Starting AI...' : gesturesEnabled ? 'Gestures Active [G]' : 'Hand Gestures [G]'}</span>
          </button>

          {/* Holographic Bloom Toggle */}
          <button
            onClick={() => setBloomEnabled(!bloomEnabled)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border transition-all ${
              bloomEnabled
                ? 'bg-purple-950/80 text-purple-300 border-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.35)]'
                : 'bg-[#090e1f] text-gray-400 border-blue-950/80'
            }`}
            title="Toggle Three.js UnrealBloom holographic post-processing (Hotkey: B)"
          >
            <Sparkles className={`w-3.5 h-3.5 ${bloomEnabled ? 'text-purple-400' : 'text-gray-500'}`} />
            <span>Bloom {bloomEnabled ? 'ON' : 'OFF'} [B]</span>
          </button>

          {/* JARVIS / Ultron Voice Resonance Toggle */}
          <button
            onClick={() => setVoiceResonance(!voiceResonance)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border transition-all ${
              voiceResonance
                ? 'bg-cyan-950/90 text-cyan-300 border-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.4)]'
                : 'bg-[#090e1f] text-gray-400 border-blue-950/80'
            }`}
            title="Simulate holographic voice pulse resonance"
          >
            <Activity className={`w-3.5 h-3.5 ${voiceResonance ? 'text-cyan-400 animate-pulse' : 'text-gray-500'}`} />
            <span>Resonance {voiceResonance ? 'ON' : 'OFF'}</span>
          </button>

          {/* Auto Rotate Button */}
          <button
            onClick={() => setAutoRotate(!autoRotate)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono border transition-all ${
              autoRotate 
                ? 'bg-blue-950/90 text-sky-300 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.3)]' 
                : 'bg-[#090e1f] text-gray-400 border-blue-950/80'
            }`}
            title="Toggle autonomous orbital rotation"
          >
            <RotateCw className={`w-3.5 h-3.5 ${autoRotate ? 'animate-spin' : ''}`} />
            <span>{autoRotate ? 'Orbiting' : 'Paused'}</span>
          </button>

          {/* Reset Camera Button */}
          <button
            onClick={resetView}
            className="p-2 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-white hover:border-blue-500/50 transition-all"
            title="Reset Camera & Rotation (Hotkey: R)"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          {/* Zoom In / Out */}
          <div className="flex items-center gap-1 bg-[#090e1f] border border-blue-900/40 rounded-xl p-1">
            <button
              onClick={() => { zoomLevelRef.current = Math.max(180, zoomLevelRef.current - 50); }}
              className="p-1.5 text-gray-400 hover:text-white transition"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { zoomLevelRef.current = Math.min(650, zoomLevelRef.current + 50); }}
              className="p-1.5 text-gray-400 hover:text-white transition"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main 3D Canvas Area */}
      <div 
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        className="flex-1 relative w-full h-full bg-[#000000] overflow-hidden cursor-grab active:cursor-grabbing"
      >
        {/* Floating HUD Instructions */}
        <div className="absolute bottom-6 left-6 flex items-center gap-3 bg-[#040817]/90 backdrop-blur-md border border-blue-900/50 rounded-2xl px-4 py-2.5 text-xs text-gray-300 pointer-events-none shadow-[0_0_25px_rgba(0,0,0,0.8)] font-mono z-10">
          <span className="text-sky-400 font-bold">⚡ Ultron WebGL</span>
          <span>•</span>
          <span>🖱️ Mouse: Drag & Scroll</span>
          <span>•</span>
          <span className="text-emerald-400">✋ Gesture: Pinch = Spin, 2-Hand = Zoom</span>
          <span>•</span>
          <span className="text-purple-400">⌨️ G: Hand, B: Bloom, R: Reset</span>
        </div>

        {/* Futuristic Hand Tracking HUD Card (when gestures enabled) */}
        {gesturesEnabled && (
          <div className="absolute top-6 left-6 w-80 bg-[#040817]/95 backdrop-blur-md border border-emerald-500/60 rounded-2xl p-4 shadow-[0_0_30px_rgba(16,185,129,0.3)] z-20 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-2.5 border-b border-emerald-950 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                <span className="text-xs font-bold font-mono text-emerald-300 uppercase tracking-wider">
                  MediaPipe Vision HUD
                </span>
              </div>
              <button
                onClick={toggleGestures}
                className="text-gray-400 hover:text-white p-1"
                title="Stop hand gestures"
              >
                <CameraOff className="w-3.5 h-3.5 text-red-400" />
              </button>
            </div>

            {/* Gesture Status */}
            <div className="bg-black/80 rounded-xl p-3 border border-emerald-900/40 mb-3 space-y-2">
              <div className="text-[11px] font-mono text-gray-300 flex items-center justify-between">
                <span>Status:</span>
                <span className="font-bold text-emerald-400 truncate max-w-[180px]">{gestureStatus}</span>
              </div>

              {/* Hand Detection Badges */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className={`p-2 rounded-lg text-center border font-mono text-[10px] ${
                  (activeGesture?.handsDetected ?? 0) > 0
                    ? 'bg-emerald-950/60 border-emerald-500/70 text-emerald-300'
                    : 'bg-black/50 border-gray-800 text-gray-600'
                }`}>
                  ✋ {activeGesture?.handsDetected ?? 0} HAND{(activeGesture?.handsDetected ?? 0) !== 1 ? 'S' : ''}
                </div>

                <div className={`p-2 rounded-lg text-center border font-mono text-[10px] font-bold ${
                  activeGesture?.isDualPinching
                    ? 'bg-cyan-950/80 border-cyan-400 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.5)]'
                    : activeGesture?.isPinching
                    ? 'bg-emerald-950/80 border-emerald-400 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.5)]'
                    : 'bg-black/50 border-gray-800 text-gray-600'
                }`}>
                  {activeGesture?.isDualPinching ? '🔍 DUAL PINCH (ZOOM)' : activeGesture?.isPinching ? '🤏 PINCH (SPIN)' : 'OPEN PALM'}
                </div>
              </div>
            </div>

            {/* Gestures Guide */}
            <div className="text-[10px] font-mono text-gray-400 space-y-1">
              <div>• <strong className="text-emerald-300">Pinch & Move:</strong> grab and orbit the 3D globe</div>
              <div>• <strong className="text-cyan-300">Two Hands Pinch:</strong> pull apart to zoom in, push to zoom out</div>
            </div>
          </div>
        )}

        {/* Floating Node Telemetry Card */}
        {selectedItem && (
          <div className="absolute top-6 right-6 w-84 max-w-sm bg-[#050918]/95 backdrop-blur-md border border-cyan-500/60 rounded-2xl p-5 shadow-[0_0_35px_rgba(6,182,212,0.3)] z-20 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-700/50 uppercase">
                    {selectedItem.type.toUpperCase()}
                  </span>
                  <span className="text-[10px] text-gray-400 font-mono">ID: {selectedItem.title.toLowerCase().replace(/\s+/g, '-')}</span>
                </div>
                <h3 className="text-base font-bold text-white mt-1">{selectedItem.title}</h3>
                <p className="text-xs text-sky-400 font-mono">{selectedItem.subtitle}</p>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="text-gray-400 hover:text-white text-lg p-1"
              >
                &times;
              </button>
            </div>

            {/* Details Box */}
            <div className="p-3 bg-black/70 border border-blue-950 rounded-xl text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed mb-3">
              {selectedItem.details}
            </div>

            {/* Stats Table */}
            {selectedItem.stats && (
              <div className="grid grid-cols-2 gap-2 mb-3">
                {Object.entries(selectedItem.stats).map(([k, v]) => (
                  <div key={k} className="p-2 rounded-lg bg-[#080f24] border border-blue-900/30">
                    <div className="text-[10px] text-gray-400 uppercase font-mono">{k}</div>
                    <div className="text-xs font-bold text-white font-mono truncate">{v}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Tags */}
            {selectedItem.tags && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {selectedItem.tags.map(t => (
                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-950 text-sky-300 border border-blue-800/40 font-mono">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            {/* Action Link */}
            {selectedItem.link && (
              <Link
                href={selectedItem.link}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white text-xs font-semibold shadow-[0_0_15px_rgba(6,182,212,0.4)] transition-all"
              >
                Launch Telemetry Session &rarr;
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
