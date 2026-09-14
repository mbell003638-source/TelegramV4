'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { 
  Smartphone, 
  ArrowLeft, 
  RefreshCw, 
  Play, 
  CornerDownLeft, 
  Sliders, 
  ShieldAlert, 
  Volume2, 
  VolumeX, 
  Power, 
  Home, 
  ArrowLeft as BackIcon, 
  Square, 
  Send,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Layers,
  Sparkles,
  MousePointer
} from 'lucide-react';
import ReactiveOrb from '@/components/ReactiveOrb';

interface DeviceItem {
  serial: string;
  status: string;
  model: string;
  product: string;
  isOnline: boolean;
}

interface QuickApp {
  id: string;
  name: string;
  package: string;
  emoji: string;
}

export default function DevicesHubPage() {
  const [loading, setLoading] = useState(true);
  const [adbInstalled, setAdbInstalled] = useState(false);
  const [adbPath, setAdbPath] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [quickApps, setQuickApps] = useState<QuickApp[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [loadingScreenshot, setLoadingScreenshot] = useState(false);
  const [textToSend, setTextToSend] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [orbState, setOrbState] = useState<'idle' | 'device_action' | 'thinking' | 'killswitch'>('idle');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const screenImgRef = useRef<HTMLImageElement | null>(null);

  const fetchDeviceData = async () => {
    try {
      const res = await fetch('http://localhost:3141/api/devices?token=earlyaidopters');
      if (res.ok) {
        const data = await res.json();
        setAdbInstalled(data.adbInstalled);
        setAdbPath(data.adbPath);
        setDevices(data.devices || []);
        setQuickApps(data.quickApps || []);
        if (data.devices && data.devices.length > 0 && !selectedSerial) {
          setSelectedSerial(data.devices[0].serial);
        }
      }
    } catch (e) {
      console.warn('Could not fetch device status:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchScreenshot = async () => {
    if (!adbInstalled) return;
    setLoadingScreenshot(true);
    try {
      const targetParam = selectedSerial ? `&serial=${encodeURIComponent(selectedSerial)}` : '';
      const res = await fetch(`http://localhost:3141/api/devices/screenshot?token=earlyaidopters${targetParam}`);
      if (res.ok) {
        const data = await res.json();
        if (data.screenshot) {
          setScreenshotUrl(data.screenshot);
        }
      }
    } catch (e) {
      console.warn('Screenshot capture error:', e);
    } finally {
      setLoadingScreenshot(false);
    }
  };

  useEffect(() => {
    fetchDeviceData();
  }, []);

  useEffect(() => {
    if (devices.length > 0) {
      fetchScreenshot();
    }
  }, [devices.length, selectedSerial]);

  // Auto refresh loop
  useEffect(() => {
    if (!autoRefresh || devices.length === 0) return;
    const interval = setInterval(() => {
      fetchScreenshot();
    }, 2500);
    return () => clearInterval(interval);
  }, [autoRefresh, devices.length, selectedSerial]);

  const triggerAction = async (payload: any) => {
    setOrbState('device_action');
    setStatusMessage(`Executing ${payload.action}...`);
    try {
      const res = await fetch('http://localhost:3141/api/devices/action?token=earlyaidopters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          serial: selectedSerial,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatusMessage(`Action ${payload.action} executed.`);
        setTimeout(fetchScreenshot, 500);
      } else {
        setStatusMessage(`Action failed: ${data.error}`);
      }
    } catch (e: any) {
      setStatusMessage(`Network error: ${e.message}`);
    } finally {
      setTimeout(() => setOrbState('idle'), 2000);
      setTimeout(() => setStatusMessage(null), 3500);
    }
  };

  // Click on screenshot to tap
  const handleScreenClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = screenImgRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Scale to natural device resolution
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    const devX = Math.round(clickX * scaleX);
    const devY = Math.round(clickY * scaleY);

    triggerAction({ action: 'tap', x: devX, y: devY });
  };

  const handleSendText = () => {
    if (!textToSend.trim()) return;
    triggerAction({ action: 'type', text: textToSend.trim() });
    setTextToSend('');
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 flex flex-col font-sans">
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
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-600/20 via-blue-900/30 to-black border border-amber-500/40 flex items-center justify-center text-xl shadow-[0_0_15px_rgba(245,158,11,0.25)]">
              📱
            </div>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-black ${
                devices.length > 0 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400'
              }`}
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white flex items-center gap-2">
                The Hands <span className="text-xs text-amber-400 font-mono font-normal">ADB Automation Hub</span>
              </h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-950/60 text-amber-300 border border-amber-800/40 uppercase">
                ULTRON PHYSICAL LAYER
              </span>
            </div>
            <p className="text-xs text-gray-400">Autonomous Android screen navigation, input injection, and hardware control.</p>
          </div>
        </div>

        {/* Right Header Status */}
        <div className="flex items-center gap-3">
          <ReactiveOrb size={42} state={orbState} interactive={false} />

          <button
            onClick={fetchScreenshot}
            disabled={loadingScreenshot || devices.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-xs font-mono text-sky-400 hover:border-blue-500/60 disabled:opacity-30 transition-all"
            title="Refresh device screen"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingScreenshot ? 'animate-spin' : ''}`} />
            <span>Capture</span>
          </button>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-3 py-1.5 rounded-xl text-xs font-mono border transition-all ${
              autoRefresh 
                ? 'bg-emerald-950/80 border-emerald-500 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                : 'bg-[#090e1f] border-blue-900/40 text-gray-400 hover:text-white'
            }`}
          >
            {autoRefresh ? 'Auto Live: ON' : 'Auto Live: OFF'}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Device Screen Viewer & Hardware Keys (5 cols) */}
        <div className="lg:col-span-5 flex flex-col items-center">
          <div className="w-full max-w-sm rounded-3xl bg-[#050711] border-2 border-blue-900/60 p-4 shadow-[0_0_30px_rgba(37,99,235,0.15)] flex flex-col items-center relative">
            {/* Phone Top Notch */}
            <div className="w-28 h-4 rounded-full bg-black border border-blue-950 mb-3 flex items-center justify-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-900/80" />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-950" />
            </div>

            {/* Screen Canvas / Image */}
            <div className="w-full aspect-[9/19] bg-black rounded-2xl overflow-hidden border border-blue-950/80 relative flex items-center justify-center group shadow-inner">
              {screenshotUrl ? (
                <div className="relative w-full h-full cursor-crosshair">
                  <img
                    ref={screenImgRef}
                    src={screenshotUrl}
                    alt="Device Screen"
                    onClick={handleScreenClick}
                    className="w-full h-full object-contain select-none"
                  />
                  <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-black/70 border border-blue-500/30 text-[10px] font-mono text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                    <MousePointer className="w-2.5 h-2.5" /> Click to Tap
                  </div>
                </div>
              ) : (
                <div className="p-6 text-center space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-[#090e1f] border border-blue-900/40 flex items-center justify-center text-2xl">
                    📱
                  </div>
                  <div className="text-xs font-mono text-gray-400">
                    {devices.length > 0 
                      ? 'Press "Capture" to pull live frame'
                      : 'No Android device connected via ADB.'}
                  </div>
                  {devices.length > 0 && (
                    <button
                      onClick={fetchScreenshot}
                      className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-mono font-medium"
                    >
                      Initialize Screen
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Android Navigation Bar Buttons */}
            <div className="w-full mt-4 pt-3 border-t border-blue-950/60 flex items-center justify-around">
              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 4 })}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all"
                title="Back (KEYCODE_BACK)"
              >
                <BackIcon className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 3 })}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all"
                title="Home (KEYCODE_HOME)"
              >
                <Home className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 187 })}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all"
                title="App Switcher (KEYCODE_APP_SWITCH)"
              >
                <Square className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 26 })}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-red-950/40 border border-red-900/30 text-red-400 hover:text-red-300 transition-all"
                title="Power / Wake (KEYCODE_POWER)"
              >
                <Power className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Execution Status Toast */}
          {statusMessage && (
            <div className="mt-3 px-4 py-1.5 rounded-xl bg-blue-950/80 border border-blue-800/60 text-sky-300 text-xs font-mono animate-fade-in flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-spin" />
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        {/* Right Column: Controls, Apps, Keystrokes & Diagnostics (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Device Selection & Health Card */}
          <div className="p-5 rounded-2xl bg-[#050711] border border-blue-900/40 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-sky-400" /> Device Telemetry & Bridge
              </h2>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                adbInstalled ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50' : 'bg-amber-950/80 text-amber-400 border-amber-800/50'
              }`}>
                {adbInstalled ? 'ADB ENGINE ACTIVE' : 'ADB PATH SCANNING'}
              </span>
            </div>

            {devices.length > 0 ? (
              <div className="space-y-2">
                <label className="text-xs font-mono text-gray-400">Target Device:</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {devices.map((dev) => (
                    <button
                      key={dev.serial}
                      onClick={() => setSelectedSerial(dev.serial)}
                      className={`p-3 rounded-xl border text-left font-mono transition-all ${
                        selectedSerial === dev.serial
                          ? 'bg-blue-950/70 border-blue-500 text-white shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                          : 'bg-[#090e1f] border-blue-950 text-gray-300 hover:border-blue-900'
                      }`}
                    >
                      <div className="text-xs font-bold text-white flex items-center justify-between">
                        <span>{dev.model}</span>
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">Serial: {dev.serial}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-amber-950/20 border border-amber-900/40 text-xs text-amber-200/90 space-y-2">
                <div className="flex items-center gap-2 font-bold text-amber-400">
                  <AlertTriangle className="w-4 h-4" /> No physical or virtual Android device found.
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  To connect your Android phone:
                </p>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-gray-400 font-mono">
                  <li>Enable Developer Options (Settings &gt; About Phone &gt; Tap Build Number 7 times).</li>
                  <li>Enable <strong>USB Debugging</strong> in Developer Options.</li>
                  <li>Connect via USB cable or Wi-Fi (<code className="text-sky-300">adb connect IP:5555</code>).</li>
                  <li>Press &quot;Allow USB Debugging&quot; on your phone screen prompt.</li>
                </ol>
              </div>
            )}
          </div>

          {/* Quick App Launcher */}
          <div className="p-5 rounded-2xl bg-[#050711] border border-blue-900/40 space-y-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Play className="w-4 h-4 text-emerald-400" /> Quick App Launcher
            </h2>
            <p className="text-xs text-gray-400">Directly launch apps on the phone via monkey intent injection.</p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
              {quickApps.map((app) => (
                <button
                  key={app.id}
                  onClick={() => triggerAction({ action: 'launch', package: app.package })}
                  disabled={devices.length === 0}
                  className="p-3 rounded-xl bg-[#090e1f] border border-blue-950 hover:border-blue-500/50 text-left transition-all disabled:opacity-40 hover:scale-[1.02] flex flex-col gap-1"
                >
                  <span className="text-xl">{app.emoji}</span>
                  <span className="text-xs font-bold text-white">{app.name}</span>
                  <span className="text-[9px] font-mono text-gray-500 truncate">{app.package}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Keystroke & Input Injection */}
          <div className="p-5 rounded-2xl bg-[#050711] border border-blue-900/40 space-y-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <CornerDownLeft className="w-4 h-4 text-sky-400" /> Keystroke & Text Injection
            </h2>
            <p className="text-xs text-gray-400">Send text directly into the active Android input field or search bar.</p>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Enter text to type on phone..."
                value={textToSend}
                onChange={(e) => setTextToSend(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendText()}
                disabled={devices.length === 0}
                className="flex-1 px-3 py-2 rounded-xl bg-[#090e1f] border border-blue-900/50 text-white placeholder-gray-500 text-xs font-mono focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSendText}
                disabled={!textToSend.trim() || devices.length === 0}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)]"
              >
                <Send className="w-3.5 h-3.5" /> Send
              </button>
            </div>
          </div>

          {/* Architecture Card */}
          <div className="p-5 rounded-2xl bg-[#02050f] border border-blue-950 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-sky-400">
              <Layers className="w-4 h-4" /> Sagar Tamang ULTRON Architecture Blueprint
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              In Sagar Tamang&apos;s ULTRON design (&quot;A voice with hands&quot;), mobile devices are orchestrated via an ADB bridge. The vision loop captures the screen, sends frames to Claude or Gemini, calculates button coordinates, and automatically triggers physical taps and keyboard entries.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
