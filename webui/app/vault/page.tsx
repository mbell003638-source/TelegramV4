'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { 
  ArrowLeft, 
  Search, 
  FileText, 
  Copy, 
  Check, 
  MessageSquare,
  BookOpen,
  Globe,
  Network,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
  Layers,
  FolderSync
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

interface VaultItem {
  name: string;
  relativePath: string;
  category: string;
  mtime: number;
  size: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  chats: '#22d3ee',     // Cyan
  notes: '#a78bfa',     // Purple
  journal: '#818cf8',   // Indigo
  goals: '#fbbf24',     // Amber
  sessions: '#34d399',  // Emerald
  default: '#60a5fa'    // Sky blue
};

const CATEGORY_ICONS: Record<string, string> = {
  chats: '💬',
  notes: '📝',
  journal: '📓',
  goals: '🎯',
  sessions: '🔄',
  default: '📄'
};

function getCategoryColor(cat: string) {
  return CATEGORY_COLORS[cat.toLowerCase()] || CATEGORY_COLORS.default;
}

function getCategoryIcon(cat: string) {
  return CATEGORY_ICONS[cat.toLowerCase()] || CATEGORY_ICONS.default;
}

// ----------------------------------------------------
// Interactive Force-Directed 2D Note Graph Component
// ----------------------------------------------------
function ForceGraph({ 
  items, 
  onSelectNode,
  searchQuery,
  filterCategory
}: { 
  items: VaultItem[];
  onSelectNode: (relPath: string) => void;
  searchQuery: string;
  filterCategory: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<any | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });

  // Filter items by selected category
  const filteredItems = useMemo(() => {
    if (filterCategory === 'all') return items;
    return items.filter(i => i.category.toLowerCase() === filterCategory.toLowerCase());
  }, [items, filterCategory]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = canvas.clientWidth;
    let height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;

    // Reset view position to center
    transformRef.current = { x: width / 2, y: height / 2, k: 0.95 };

    // Initialize nodes
    const nodes = filteredItems.map((item, idx) => {
      const angle = (idx / Math.max(1, filteredItems.length)) * Math.PI * 2;
      const dist = 60 + Math.random() * 120;
      return {
        ...item,
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        radius: 7 + Math.min(item.size / 1500, 12),
        color: getCategoryColor(item.category)
      };
    });

    // Create clustering edges (connect nodes in same category)
    const edges: { source: any, target: any }[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].category === nodes[j].category) {
          edges.push({ source: nodes[i], target: nodes[j] });
        }
      }
    }

    let animationFrameId: number;
    let dragNode: any = null;
    let isDraggingCanvas = false;
    let lastMouse = { x: 0, y: 0 };
    let dragDistance = 0;

    const simulate = () => {
      const alpha = 0.04;

      // 1. Node Repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) dist = 0.01;
          const minDist = nodes[i].radius + nodes[j].radius + 30;
          if (dist < minDist * 2.5) {
            const force = -280 / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            nodes[i].vx -= fx;
            nodes[i].vy -= fy;
            nodes[j].vx += fx;
            nodes[j].vy += fy;
          }
        }
      }

      // 2. Intra-category edge attraction
      edges.forEach(edge => {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const desiredDist = 70;
        const force = (dist - desiredDist) * 0.012;
        const fx = (dx / (dist || 1)) * force;
        const fy = (dy / (dist || 1)) * force;
        edge.source.vx += fx;
        edge.source.vy += fy;
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      });

      // 3. Center Gravity Pull
      nodes.forEach(node => {
        const dist = Math.sqrt(node.x * node.x + node.y * node.y);
        node.vx -= (node.x / (dist || 1)) * 0.08;
        node.vy -= (node.y / (dist || 1)) * 0.08;

        // Friction damping
        node.vx *= 0.88;
        node.vy *= 0.88;

        if (node !== dragNode) {
          node.x += node.vx * alpha * 10;
          node.y += node.vy * alpha * 10;
        }
      });
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.save();

      const { x, y, k } = transformRef.current;
      ctx.translate(x, y);
      ctx.scale(k, k);

      // Draw faint background coordinate grid
      ctx.strokeStyle = 'rgba(30, 58, 138, 0.08)';
      ctx.lineWidth = 1 / k;
      const gridSize = 60;
      const bound = 800;
      for (let gx = -bound; gx <= bound; gx += gridSize) {
        ctx.beginPath();
        ctx.moveTo(gx, -bound);
        ctx.lineTo(gx, bound);
        ctx.stroke();
      }
      for (let gy = -bound; gy <= bound; gy += gridSize) {
        ctx.beginPath();
        ctx.moveTo(-bound, gy);
        ctx.lineTo(bound, gy);
        ctx.stroke();
      }

      // Draw Edges with glowing gradient
      edges.forEach(edge => {
        ctx.beginPath();
        ctx.moveTo(edge.source.x, edge.source.y);
        ctx.lineTo(edge.target.x, edge.target.y);
        ctx.strokeStyle = `${edge.source.color}35`; // 20% opacity
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
      });

      // Draw Nodes
      nodes.forEach(node => {
        const isMatch = searchQuery === '' || 
          node.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          node.category.toLowerCase().includes(searchQuery.toLowerCase());

        const opacity = isMatch ? 1.0 : 0.2;

        // Outer glow halo
        const glowRadius = node.radius * (isMatch ? 2.8 : 1.5);
        const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowRadius);
        gradient.addColorStop(0, `${node.color}${Math.floor(opacity * 120).toString(16).padStart(2, '0')}`);
        gradient.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Solid Node Core
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.globalAlpha = opacity;
        ctx.fill();

        // White border
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = (node === dragNode ? 2.5 : 1.2) / k;
        ctx.stroke();
        ctx.globalAlpha = 1.0;

        // Label
        if (k > 0.55 || node === dragNode || isMatch) {
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = isMatch ? '#f8fafc' : '#64748b';
          const label = node.name.length > 20 ? node.name.substring(0, 18) + '…' : node.name;
          ctx.fillText(label, node.x + node.radius + 5, node.y + 3);
        }
      });

      ctx.restore();
    };

    const loop = () => {
      simulate();
      draw();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();

    // Mouse Interaction
    const getGraphPos = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { x, y, k } = transformRef.current;
      return {
        x: (clientX - rect.left - x) / k,
        y: (clientY - rect.top - y) / k,
        rawX: clientX,
        rawY: clientY
      };
    };

    const handleMouseDown = (e: MouseEvent) => {
      const pos = getGraphPos(e.clientX, e.clientY);
      lastMouse = { x: e.clientX, y: e.clientY };
      dragDistance = 0;

      let hitNode = null;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = n.x - pos.x;
        const dy = n.y - pos.y;
        if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
          hitNode = n;
          break;
        }
      }

      if (hitNode) {
        dragNode = hitNode;
      } else {
        isDraggingCanvas = true;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      dragDistance += Math.abs(dx) + Math.abs(dy);

      if (dragNode) {
        const pos = getGraphPos(e.clientX, e.clientY);
        dragNode.x = pos.x;
        dragNode.y = pos.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
      } else if (isDraggingCanvas) {
        transformRef.current.x += dx;
        transformRef.current.y += dy;
        lastMouse = { x: e.clientX, y: e.clientY };
      } else {
        // Hover detection
        const pos = getGraphPos(e.clientX, e.clientY);
        let found = null;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i];
          const ddx = n.x - pos.x;
          const ddy = n.y - pos.y;
          if (ddx * ddx + ddy * ddy <= (n.radius + 6) * (n.radius + 6)) {
            found = n;
            break;
          }
        }
        setHoveredNode(found);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (dragNode && dragDistance < 8) {
        onSelectNode(dragNode.relativePath);
      }
      dragNode = null;
      isDraggingCanvas = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const { x, y, k } = transformRef.current;
      const newK = Math.max(0.15, Math.min(4.0, k * zoomFactor));

      transformRef.current = {
        x: mouseX - (mouseX - x) * (newK / k),
        y: mouseY - (mouseY - y) * (newK / k),
        k: newK
      };
    };

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width;
      canvas.height = height;
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', handleResize);
    };
  }, [filteredItems, onSelectNode, searchQuery]);

  const zoomIn = () => {
    transformRef.current.k = Math.min(4.0, transformRef.current.k * 1.25);
  };
  const zoomOut = () => {
    transformRef.current.k = Math.max(0.15, transformRef.current.k * 0.8);
  };
  const resetView = () => {
    if (!canvasRef.current) return;
    transformRef.current = { 
      x: canvasRef.current.clientWidth / 2, 
      y: canvasRef.current.clientHeight / 2, 
      k: 1.0 
    };
  };

  return (
    <div className="w-full h-full relative bg-[#000000] rounded-2xl overflow-hidden select-none">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full cursor-grab active:cursor-grabbing" 
      />

      {/* Floating Canvas Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-1.5 bg-[#070b1e]/90 backdrop-blur-md border border-blue-900/40 rounded-xl p-1.5 z-10 shadow-lg">
        <button
          onClick={zoomIn}
          className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={zoomOut}
          className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={resetView}
          className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition"
          title="Reset View"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom Floating Legend / Instructions */}
      <div className="absolute bottom-4 left-4 flex flex-wrap items-center gap-3 bg-[#040716]/90 backdrop-blur-md border border-blue-900/40 rounded-xl px-3.5 py-2 text-[11px] font-mono text-gray-400 z-10 shadow-lg">
        <div className="flex items-center gap-1.5 text-sky-300 font-bold">
          <Network className="w-3.5 h-3.5" />
          <span>2D Note Topology</span>
        </div>
        <span>•</span>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-cyan-400" />
          <span>Chats</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-purple-400" />
          <span>Notes</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span>Goals</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>Sessions</span>
        </div>
        <span>•</span>
        <span className="text-gray-500">🖱️ Drag node to pin • Click to read</span>
      </div>

      {/* Hover Node Tooltip */}
      {hoveredNode && (
        <div className="absolute top-4 left-4 bg-[#090e24]/95 border border-sky-400/60 rounded-xl p-3 text-xs font-mono text-white shadow-[0_0_20px_rgba(56,189,248,0.3)] pointer-events-none z-20 animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center gap-2 mb-1">
            <span>{getCategoryIcon(hoveredNode.category)}</span>
            <span className="font-bold text-sky-300 truncate max-w-[200px]">{hoveredNode.name}</span>
          </div>
          <div className="text-[10px] text-gray-400 space-y-0.5">
            <div>Category: <span className="text-purple-300 font-semibold uppercase">{hoveredNode.category}</span></div>
            <div>Size: {(hoveredNode.size / 1024).toFixed(1)} KB</div>
            <div>Modified: {new Date(hoveredNode.mtime).toLocaleDateString()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------
// Main Vault Explorer Page
// ----------------------------------------------------
export default function VaultExplorerPage() {
  const router = useRouter();
  const [items, setItems] = useState<VaultItem[]>([]);
  const [vaultPath, setVaultPath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'reader' | 'graph'>('reader');
  const [graphCategoryFilter, setGraphCategoryFilter] = useState('all');
  const [isFullScreenGraph, setIsFullScreenGraph] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  // Fetch items from Obsidian API
  const fetchVault = async () => {
    try {
      const res = await fetch('/api/vault');
      const data = await res.json();
      if (data.ok) {
        setItems(data.items || []);
        setVaultPath(data.vaultPath || '');
        if (data.items.length > 0 && !selectedFile) {
          loadFile(data.items[0].relativePath);
        }
      }
    } catch (e) {
      console.warn('Could not load vault items:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadFile = async (relPath: string) => {
    setSelectedFile(relPath);
    setLoadingContent(true);
    try {
      const res = await fetch(`/api/vault?path=${encodeURIComponent(relPath)}`);
      const data = await res.json();
      if (data.ok) {
        setFileContent(data.content || '');
      }
    } catch (e) {
      console.warn('Could not read file:', e);
    } finally {
      setLoadingContent(false);
    }
  };

  // Check URL query param (?view=graph)
  useEffect(() => {
    fetchVault();
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'graph') {
        setActiveTab('graph');
      }
    }
  }, []);

  const handleCopyContext = () => {
    if (!fileContent) return;
    navigator.clipboard.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleNodeSelect = (relPath: string) => {
    loadFile(relPath);
    setActiveTab('reader');
    setIsFullScreenGraph(false);
  };

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => ({
      ...prev,
      [cat]: !prev[cat]
    }));
  };

  // Grouped items
  const groupedItems = useMemo(() => {
    const map: Record<string, VaultItem[]> = {};
    items.forEach(item => {
      const cat = item.category || 'notes';
      if (!map[cat]) map[cat] = [];
      map[cat].push(item);
    });
    return map;
  }, [items]);

  const categories = Object.keys(groupedItems);

  return (
    <div className="min-h-screen bg-black text-gray-100 flex flex-col font-sans select-none">
      {/* Top Header */}
      <header className="px-6 py-4 border-b border-blue-950/60 bg-[#02040a]/90 backdrop-blur-md flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="p-2 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-white hover:border-blue-500/50 transition-all"
            title="Return to Mission Control"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-900/40 to-black border border-purple-500/40 flex items-center justify-center text-xl shadow-[0_0_15px_rgba(168,85,247,0.25)]">
              📓
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white">Obsidian Memory Vault</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-950/70 text-purple-300 border border-purple-800/40 uppercase">
                PERSISTENT CONTEXT
              </span>
            </div>
            <p className="text-xs text-gray-400 truncate max-w-md font-mono">{vaultPath}</p>
          </div>
        </div>

        {/* View Mode Tab Switcher */}
        <div className="flex items-center bg-[#090e1f] rounded-xl p-1 border border-blue-900/40 mx-4">
          <button
            onClick={() => { setActiveTab('reader'); setIsFullScreenGraph(false); }}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all font-mono ${
              activeTab === 'reader' 
                ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(37,99,235,0.4)]' 
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Reader Mode</span>
          </button>
          <button
            onClick={() => setActiveTab('graph')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all font-mono ${
              activeTab === 'graph' 
                ? 'bg-purple-600 text-white shadow-[0_0_12px_rgba(168,85,247,0.4)]' 
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            <Network className="w-3.5 h-3.5 text-purple-300" />
            <span>2D Graph View</span>
          </button>
          <Link
            href="/globe"
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 text-sky-400 hover:text-white hover:bg-white/5 transition-all font-mono"
            title="Launch 3D Ultron Globe & Hand Gestures"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>3D Vault Globe</span>
          </Link>
        </div>

        {/* Header Right Actions */}
        <div className="flex items-center gap-3">
          {activeTab === 'graph' && (
            <button
              onClick={() => setIsFullScreenGraph(!isFullScreenGraph)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-purple-800/40 text-purple-300 hover:text-white text-xs font-mono transition-all"
              title={isFullScreenGraph ? 'Exit Fullscreen' : 'Expand to Fullscreen Graph'}
            >
              {isFullScreenGraph ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              <span>{isFullScreenGraph ? 'Split View' : 'Fullscreen'}</span>
            </button>
          )}

          {selectedFile && activeTab === 'reader' && (
            <button
              onClick={handleCopyContext}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-950/60 border border-purple-700/50 text-purple-300 hover:border-purple-400 text-xs font-mono transition-all"
              title="Copy markdown to clipboard"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied!' : 'Copy Context'}</span>
            </button>
          )}

          <Link
            href="/agents/claude"
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all font-mono"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Open in Claude</span>
          </Link>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* Left Sidebar: File List (Hidden in Fullscreen Graph Mode) */}
        {!isFullScreenGraph && (
          <div className="md:col-span-4 flex flex-col gap-4">
            {/* Search Box */}
            <div className="relative">
              <Search className="w-4 h-4 text-gray-500 absolute left-3 top-3" />
              <input
                type="text"
                placeholder="Search notes or memories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#050711] border border-blue-900/50 text-white placeholder-gray-500 text-xs font-mono focus:outline-none focus:border-blue-500"
              />
            </div>

            {/* Mini Stat Bar */}
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#050711] border border-blue-950/80 text-[11px] font-mono text-gray-400">
              <span>{items.length} notes</span>
              <span>{categories.length} categories</span>
              <span>{(items.reduce((acc, i) => acc + i.size, 0) / 1024 / 1024).toFixed(2)} MB</span>
            </div>

            {/* Category Filter for Graph Mode */}
            {activeTab === 'graph' && (
              <div className="flex flex-wrap gap-1.5 p-2 rounded-xl bg-[#050711] border border-purple-900/40">
                <button
                  onClick={() => setGraphCategoryFilter('all')}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold transition ${
                    graphCategoryFilter === 'all'
                      ? 'bg-purple-600 text-white'
                      : 'bg-black/50 text-gray-400 hover:text-white'
                  }`}
                >
                  All ({items.length})
                </button>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setGraphCategoryFilter(cat)}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-semibold flex items-center gap-1 transition ${
                      graphCategoryFilter === cat
                        ? 'bg-purple-600 text-white'
                        : 'bg-black/50 text-gray-400 hover:text-white'
                    }`}
                  >
                    <span>{getCategoryIcon(cat)}</span>
                    <span className="uppercase">{cat}</span>
                    <span>({groupedItems[cat]?.length || 0})</span>
                  </button>
                ))}
              </div>
            )}

            {/* Collapsible File List */}
            <div className="flex-1 bg-[#050711] border border-blue-950/80 rounded-2xl p-3 overflow-y-auto max-h-[70vh] space-y-3">
              {loading ? (
                <div className="text-center py-8 text-xs font-mono text-gray-500">Scanning vault...</div>
              ) : items.length === 0 ? (
                <div className="text-center py-8 text-xs font-mono text-gray-500">No notes found.</div>
              ) : (
                categories.map(cat => {
                  const catItems = groupedItems[cat] || [];
                  const isExpanded = expandedCategories[cat] !== false;
                  return (
                    <div key={cat} className="space-y-1">
                      <button
                        onClick={() => toggleCategory(cat)}
                        className="w-full flex items-center justify-between p-1.5 text-xs font-mono font-bold text-gray-300 hover:text-white transition"
                      >
                        <div className="flex items-center gap-1.5">
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
                          <span>{getCategoryIcon(cat)}</span>
                          <span className="uppercase tracking-wider">{cat}</span>
                          <span className="text-[10px] text-gray-500 font-normal">({catItems.length})</span>
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="space-y-1 pl-2">
                          {catItems.map(item => (
                            <button
                              key={item.relativePath}
                              onClick={() => {
                                loadFile(item.relativePath);
                                setActiveTab('reader');
                              }}
                              className={`w-full p-2 rounded-xl text-left border transition-all ${
                                selectedFile === item.relativePath
                                  ? 'bg-purple-950/60 border-purple-500/70 text-white shadow-[0_0_12px_rgba(168,85,247,0.2)]'
                                  : 'bg-[#090e1f] border-blue-950/60 text-gray-300 hover:border-blue-900'
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium truncate flex items-center gap-1.5">
                                  <FileText className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" style={{color: getCategoryColor(item.category)}} />
                                  {item.name}
                                </span>
                              </div>
                              <div className="text-[10px] font-mono text-gray-500 mt-1 flex items-center justify-between">
                                <span>{new Date(item.mtime).toLocaleDateString()}</span>
                                <span>{(item.size / 1024).toFixed(1)} KB</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Right Pane: Markdown Reader or Graph View */}
        <div className={`${isFullScreenGraph ? 'md:col-span-12' : 'md:col-span-8'} bg-[#050711] border border-blue-900/40 rounded-2xl overflow-hidden flex flex-col h-[75vh]`}>
          {activeTab === 'reader' ? (
            <div className="flex flex-col h-full p-6">
              <div className="flex items-center justify-between pb-4 border-b border-blue-950/80 mb-4">
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-purple-400" />
                  <span className="text-sm font-bold text-white font-mono">{selectedFile || 'Select a note'}</span>
                </div>
                {selectedFile && (
                  <span className="text-[11px] font-mono text-gray-500">
                    Rendered Markdown
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto pr-4 text-sm select-text">
                {loadingContent ? (
                  <div className="text-center py-12 text-gray-500 text-xs font-mono">Loading note content...</div>
                ) : fileContent ? (
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw]}
                      components={{
                        h1: ({children}) => <h1 className="text-xl font-bold text-white mb-3 pb-2 border-b border-blue-900/40">{children}</h1>,
                        h2: ({children}) => <h2 className="text-lg font-bold text-sky-300 mb-2 mt-4">{children}</h2>,
                        h3: ({children}) => <h3 className="text-base font-semibold text-purple-300 mb-2 mt-3">{children}</h3>,
                        p: ({children}) => <p className="text-gray-300 mb-3 leading-relaxed">{children}</p>,
                        a: ({href, children}) => <a href={href} className="text-sky-400 hover:text-sky-300 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                        code: ({className, children, ...props}: any) => {
                          const isInline = !className;
                          return isInline 
                            ? <code className="px-1.5 py-0.5 rounded bg-blue-950/80 text-cyan-300 text-[11px] font-mono border border-blue-900/40" {...props}>{children}</code>
                            : <code className={`block p-4 rounded-xl bg-[#080f24] border border-blue-900/40 text-cyan-200 text-xs font-mono overflow-x-auto mb-3 ${className || ''}`} {...props}>{children}</code>;
                        },
                        pre: ({children}) => <pre className="mb-3">{children}</pre>,
                        ul: ({children}) => <ul className="list-disc list-inside text-gray-300 mb-3 space-y-1">{children}</ul>,
                        ol: ({children}) => <ol className="list-decimal list-inside text-gray-300 mb-3 space-y-1">{children}</ol>,
                        li: ({children}) => <li className="text-gray-300">{children}</li>,
                        blockquote: ({children}) => <blockquote className="border-l-4 border-purple-500 pl-4 py-1 mb-3 text-gray-400 italic bg-purple-950/20 rounded-r-lg">{children}</blockquote>,
                        table: ({children}) => <div className="overflow-x-auto mb-3"><table className="w-full text-xs font-mono border border-blue-900/40 rounded-xl overflow-hidden">{children}</table></div>,
                        th: ({children}) => <th className="px-3 py-2 bg-blue-950/60 text-sky-300 text-left border-b border-blue-900/40 font-semibold">{children}</th>,
                        td: ({children}) => <td className="px-3 py-2 text-gray-300 border-b border-blue-950/40">{children}</td>,
                        hr: () => <hr className="border-blue-900/40 my-4" />,
                        strong: ({children}) => <strong className="text-white font-semibold">{children}</strong>,
                        em: ({children}) => <em className="text-purple-300">{children}</em>,
                      }}
                    >
                      {fileContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500 text-xs font-mono">
                    Select a note from the left to view.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ForceGraph 
              items={items} 
              onSelectNode={handleNodeSelect}
              searchQuery={search}
              filterCategory={graphCategoryFilter}
            />
          )}
        </div>
      </div>
    </div>
  );
}
