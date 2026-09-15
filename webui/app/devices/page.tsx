'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  Play,
  Pause,
  CornerDownLeft,
  Sliders,
  Volume2,
  VolumeX,
  Power,
  Home,
  ArrowLeft as BackIcon,
  Square,
  Send,
  AlertTriangle,
  Layers,
  Sparkles,
  MousePointer,
  Wifi,
  Tv,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
} from 'lucide-react';
import ReactiveOrb from '@/components/ReactiveOrb';
import { bridgeUrl } from '@/lib/config';

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

const TV_REMOTE_KEYS = [
  { key: 'up', label: 'Up' },
  { key: 'down', label: 'Down' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
  { key: 'ok', label: 'OK' },
  { key: 'back', label: 'Back' },
  { key: 'home', label: 'Home' },
  { key: 'mute', label: 'Mute' },
  { key: 'volume_up', label: 'Vol+' },
  { key: 'volume_down', label: 'Vol-' },
  { key: 'play_pause', label: 'Play/Pause' },
  { key: 'power', label: 'Power' },
] as const;

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
  const [wifiHost, setWifiHost] = useState('');
  const [wifiPort, setWifiPort] = useState('5555');
  const [pairHost, setPairHost] = useState('');
  const [pairPort, setPairPort] = useState('');
  const [pairCode, setPairCode] = useState('');
  const screenImgRef = useRef<HTMLImageElement | null>(null);

  const busy = orbState === 'device_action';
  const hasDevice = adbInstalled && devices.length > 0;
  const remoteReady = hasDevice && !!selectedSerial;

  const fetchDeviceData = async () => {
    try {
      const res = await fetch(bridgeUrl('/api/devices'));
      if (res.ok) {
        const data = await res.json();
        const list: DeviceItem[] = data.devices || [];
        setAdbInstalled(Boolean(data.adbInstalled));
        setAdbPath(data.adbPath || null);
        setDevices(list);
        setQuickApps(data.quickApps || []);
        setSelectedSerial((current) => {
          if (current && list.some((d) => d.serial === current)) return current;
          return list[0]?.serial ?? null;
        });
        if (!data.adbInstalled) {
          setScreenshotUrl(null);
        }
      } else {
        setAdbInstalled(false);
        setAdbPath(null);
        setDevices([]);
        setSelectedSerial(null);
        setScreenshotUrl(null);
      }
    } catch (e) {
      console.warn('Could not fetch device status:', e);
      setAdbInstalled(false);
      setAdbPath(null);
      setDevices([]);
      setSelectedSerial(null);
      setScreenshotUrl(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchScreenshot = async () => {
    if (!adbInstalled || devices.length === 0) return;
    setLoadingScreenshot(true);
    try {
      const res = await fetch(bridgeUrl('/api/devices/screenshot', selectedSerial ? { serial: selectedSerial } : undefined));
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
    if (hasDevice) {
      fetchScreenshot();
    } else {
      setScreenshotUrl(null);
    }
  }, [hasDevice, selectedSerial]);

  // Auto refresh loop
  useEffect(() => {
    if (!autoRefresh || !hasDevice) return;
    const interval = setInterval(() => {
      fetchScreenshot();
    }, 2500);
    return () => clearInterval(interval);
  }, [autoRefresh, hasDevice, selectedSerial]);

  const triggerAction = async (payload: Record<string, unknown>) => {
    setOrbState('device_action');
    setStatusMessage(`Executing ${payload.action}...`);
    try {
      const body: Record<string, unknown> = { ...payload };
      if (selectedSerial && payload.action !== 'connect' && payload.action !== 'pair') {
        body.serial = selectedSerial;
      }
      const res = await fetch(bridgeUrl('/api/devices/action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        setStatusMessage(`Action ${payload.action} executed.`);
        if (payload.action === 'connect' || payload.action === 'pair' || payload.action === 'tcpip') {
          if (payload.action === 'connect' && data.result?.target) {
            setSelectedSerial(String(data.result.target));
          }
          setTimeout(fetchDeviceData, 400);
        } else {
          setTimeout(fetchScreenshot, 500);
        }
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

  const handleWirelessConnect = () => {
    const host = wifiHost.trim();
    if (!host || !adbInstalled) return;
    triggerAction({ action: 'connect', host, port: Number(wifiPort) || 5555 });
  };

  const handleWirelessPair = () => {
    const host = pairHost.trim();
    const code = pairCode.trim();
    if (!host || !pairPort.trim() || !/^\d{6}$/.test(code) || !adbInstalled) return;
    triggerAction({ action: 'pair', host, pairingPort: Number(pairPort), code });
  };

  const handleEnableTcpip = () => {
    if (!remoteReady) return;
    triggerAction({ action: 'tcpip', port: Number(wifiPort) || 5555 });
  };

  const handleRemoteKey = (key: string) => {
    if (!remoteReady) return;
    triggerAction({ action: 'remote', key });
  };

  const emptyScreenshotCopy = loading
    ? 'Querying ADB bridge…'
    : !adbInstalled
      ? 'No device is connected. adb is not on PATH.'
      : devices.length > 0
        ? 'Press "Capture" to pull live frame'
        : 'No Android or Android TV device is connected.';

  const fieldClass =
    'w-full px-3 py-2 rounded-xl bg-[#090e1f] border border-blue-900/50 text-white placeholder-gray-500 text-xs font-mono focus:outline-none focus:border-blue-500 disabled:opacity-40';
  const remoteBtnClass =
    'flex flex-col items-center justify-center gap-0.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-300 hover:text-sky-300 hover:border-blue-500/50 disabled:opacity-30 disabled:hover:text-gray-300 disabled:hover:border-blue-900/40 transition-all';

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
                hasDevice ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-red-500'
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
            <p className="text-xs text-gray-400">USB phones, wireless ADB, and Android TV / Google TV remote keys.</p>
          </div>
        </div>

        {/* Right Header Status */}
        <div className="flex items-center gap-3">
          <ReactiveOrb size={42} state={orbState} interactive={false} />

          <button
            onClick={fetchDeviceData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-xs font-mono text-gray-300 hover:border-blue-500/60 disabled:opacity-30 transition-all"
            title="Rescan adb devices"
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>Scan</span>
          </button>

          <button
            onClick={fetchScreenshot}
            disabled={loadingScreenshot || !hasDevice}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-xs font-mono text-sky-400 hover:border-blue-500/60 disabled:opacity-30 transition-all"
            title="Refresh device screen"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingScreenshot ? 'animate-spin' : ''}`} />
            <span>Capture</span>
          </button>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            disabled={!hasDevice}
            className={`px-3 py-1.5 rounded-xl text-xs font-mono border transition-all disabled:opacity-30 ${
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
              {screenshotUrl && hasDevice ? (
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
                    {!adbInstalled && !loading ? '⛔' : '📱'}
                  </div>
                  <div className="text-xs font-mono text-gray-400">{emptyScreenshotCopy}</div>
                  {hasDevice && (
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
                disabled={!remoteReady}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all disabled:opacity-30"
                title="Back (KEYCODE_BACK)"
              >
                <BackIcon className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 3 })}
                disabled={!remoteReady}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all disabled:opacity-30"
                title="Home (KEYCODE_HOME)"
              >
                <Home className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 187 })}
                disabled={!remoteReady}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-blue-900/40 border border-blue-900/30 text-gray-300 hover:text-sky-400 transition-all disabled:opacity-30"
                title="App Switcher (KEYCODE_APP_SWITCH)"
              >
                <Square className="w-4 h-4" />
              </button>

              <button
                onClick={() => triggerAction({ action: 'key', keyCode: 26 })}
                disabled={!remoteReady}
                className="p-2.5 rounded-xl bg-[#090e1f] hover:bg-red-950/40 border border-red-900/30 text-red-400 hover:text-red-300 transition-all disabled:opacity-30"
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
                loading
                  ? 'bg-slate-950/80 text-slate-400 border-slate-800/50'
                  : adbInstalled
                    ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50'
                    : 'bg-red-950/80 text-red-400 border-red-800/50'
              }`}>
                {loading ? 'QUERYING BRIDGE' : adbInstalled ? 'ADB ENGINE ACTIVE' : 'ADB NOT ON PATH'}
              </span>
            </div>

            {loading ? (
              <div className="p-4 rounded-xl bg-[#090e1f] border border-blue-950 text-xs font-mono text-gray-400">
                Asking the bridge for a real adb scan. No device is assumed connected.
              </div>
            ) : !adbInstalled ? (
              <div className="p-4 rounded-xl bg-red-950/20 border border-red-900/40 text-xs text-red-100/90 space-y-2">
                <div className="flex items-center gap-2 font-bold text-red-400">
                  <AlertTriangle className="w-4 h-4" /> adb is missing — no device is connected.
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  This hub shells out to a real <code className="text-sky-300">adb</code> binary. Nothing here is a
                  simulator, and no device is pretended to be online.
                </p>
                <p className="text-[11px] leading-relaxed text-gray-400">
                  CI Android SDK docs, Gradle wrappers, and the local <code className="text-sky-300">android/</code> tree
                  in this repo are unrelated. They will not make a phone or TV show up on this page.
                </p>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-gray-400 font-mono">
                  <li>Install Google&apos;s Android <strong>platform-tools</strong>.</li>
                  <li>Put <code className="text-sky-300">adb</code> on PATH (so <code className="text-sky-300">adb version</code> works in a shell).</li>
                  <li>Restart the bridge, then press Scan. Until then this list stays empty.</li>
                </ol>
                {adbPath ? (
                  <p className="text-[10px] font-mono text-gray-500">Reported path: {adbPath}</p>
                ) : null}
              </div>
            ) : devices.length > 0 ? (
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
                        <span>{dev.model || 'Unknown model'}</span>
                        <span className={`w-2 h-2 rounded-full ${dev.isOnline ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">Serial: {dev.serial}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{dev.status}{dev.product ? ` · ${dev.product}` : ''}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-amber-950/20 border border-amber-900/40 text-xs text-amber-200/90 space-y-2">
                <div className="flex items-center gap-2 font-bold text-amber-400">
                  <AlertTriangle className="w-4 h-4" /> adb is installed, but no device is connected.
                </div>
                <p className="text-[11px] leading-relaxed text-gray-300">
                  USB phone, wireless debugging, or an Android TV / Google TV on the LAN — none of them are on the
                  current <code className="text-sky-300">adb devices</code> list.
                </p>
                <ol className="list-decimal list-inside space-y-1 text-[11px] text-gray-400 font-mono">
                  <li>USB: enable Developer Options, USB debugging, then authorize this machine.</li>
                  <li>Wireless: pair (Android 11+) then connect with the form below (default port 5555).</li>
                  <li>TV: Settings → Developer options → Network debugging, then connect host:port.</li>
                </ol>
                {adbPath ? (
                  <p className="text-[10px] font-mono text-gray-500">Using {adbPath}</p>
                ) : null}
              </div>
            )}
          </div>

          {/* Wireless ADB — phones and TVs on the LAN */}
          <div className="p-5 rounded-2xl bg-[#050711] border border-blue-900/40 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Wifi className="w-4 h-4 text-sky-400" /> Wireless ADB
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                Android TV / Google TV have no USB cable. Dial them over the network the same way as wireless
                debugging on a phone.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <form
                className="p-3 rounded-xl bg-[#090e1f] border border-blue-950 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleWirelessConnect();
                }}
              >
                <div className="text-[11px] font-mono font-bold text-sky-300">Connect (adb connect)</div>
                <label className="block text-[10px] font-mono text-gray-500">Host / IP</label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="192.168.1.50"
                  value={wifiHost}
                  onChange={(e) => setWifiHost(e.target.value)}
                  disabled={!adbInstalled || busy}
                  className={fieldClass}
                />
                <label className="block text-[10px] font-mono text-gray-500">Port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="5555"
                  value={wifiPort}
                  onChange={(e) => setWifiPort(e.target.value)}
                  disabled={!adbInstalled || busy}
                  className={fieldClass}
                />
                <button
                  type="submit"
                  disabled={!adbInstalled || busy || !wifiHost.trim()}
                  className="w-full px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold"
                >
                  Connect
                </button>
                <button
                  type="button"
                  onClick={handleEnableTcpip}
                  disabled={!remoteReady || busy}
                  className="w-full px-3 py-1.5 rounded-xl bg-[#050711] border border-blue-900/40 hover:border-blue-500/50 disabled:opacity-40 text-[10px] font-mono text-gray-300"
                  title="Ask a USB-attached device to listen on TCP so it can be unplugged"
                >
                  Enable TCP/IP on selected USB device
                </button>
              </form>

              <form
                className="p-3 rounded-xl bg-[#090e1f] border border-blue-950 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleWirelessPair();
                }}
              >
                <div className="text-[11px] font-mono font-bold text-amber-300">Pair (Android 11+)</div>
                <p className="text-[10px] text-gray-500 leading-relaxed">
                  Pairing port is not the connect port. The device shows both.
                </p>
                <label className="block text-[10px] font-mono text-gray-500">Host / IP</label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="192.168.1.50"
                  value={pairHost}
                  onChange={(e) => setPairHost(e.target.value)}
                  disabled={!adbInstalled || busy}
                  className={fieldClass}
                />
                <label className="block text-[10px] font-mono text-gray-500">Pairing port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  placeholder="37123"
                  value={pairPort}
                  onChange={(e) => setPairPort(e.target.value)}
                  disabled={!adbInstalled || busy}
                  className={fieldClass}
                />
                <label className="block text-[10px] font-mono text-gray-500">6-digit code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={!adbInstalled || busy}
                  className={`${fieldClass} tracking-[0.35em]`}
                />
                <button
                  type="submit"
                  disabled={!adbInstalled || busy || !pairHost.trim() || !pairPort.trim() || !/^\d{6}$/.test(pairCode)}
                  className="w-full px-3 py-2 rounded-xl bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white text-xs font-semibold"
                >
                  Pair
                </button>
              </form>
            </div>
          </div>

          {/* TV Remote — named keys via remoteKey, never tap */}
          <div className="p-5 rounded-2xl bg-[#050711] border border-blue-900/40 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Tv className="w-4 h-4 text-amber-400" /> TV Remote
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                Android TV / Google TV have no touchscreen. These buttons send named remote keys
                (<code className="text-sky-300">remoteKey</code>), not taps.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-6">
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  title="D-pad Up"
                  disabled={!remoteReady || busy}
                  onClick={() => handleRemoteKey('up')}
                  className={`${remoteBtnClass} w-12 h-12`}
                >
                  <ChevronUp className="w-5 h-5" />
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    title="D-pad Left"
                    disabled={!remoteReady || busy}
                    onClick={() => handleRemoteKey('left')}
                    className={`${remoteBtnClass} w-12 h-12`}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    title="OK / Select"
                    disabled={!remoteReady || busy}
                    onClick={() => handleRemoteKey('ok')}
                    className="w-14 h-14 rounded-full bg-blue-950/80 border border-blue-500/60 text-white text-xs font-bold hover:bg-blue-900 disabled:opacity-30 shadow-[0_0_18px_rgba(37,99,235,0.25)] transition-all flex flex-col items-center justify-center gap-0.5"
                  >
                    <Circle className="w-3 h-3" />
                    OK
                  </button>
                  <button
                    type="button"
                    title="D-pad Right"
                    disabled={!remoteReady || busy}
                    onClick={() => handleRemoteKey('right')}
                    className={`${remoteBtnClass} w-12 h-12`}
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>
                <button
                  type="button"
                  title="D-pad Down"
                  disabled={!remoteReady || busy}
                  onClick={() => handleRemoteKey('down')}
                  className={`${remoteBtnClass} w-12 h-12`}
                >
                  <ChevronDown className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 w-full">
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('back')} className={`${remoteBtnClass} py-2.5 px-2`} title="Back">
                  <BackIcon className="w-4 h-4" />
                  <span className="text-[9px] font-mono">Back</span>
                </button>
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('home')} className={`${remoteBtnClass} py-2.5 px-2`} title="Home">
                  <Home className="w-4 h-4" />
                  <span className="text-[9px] font-mono">Home</span>
                </button>
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('mute')} className={`${remoteBtnClass} py-2.5 px-2`} title="Mute">
                  <VolumeX className="w-4 h-4" />
                  <span className="text-[9px] font-mono">Mute</span>
                </button>
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('volume_down')} className={`${remoteBtnClass} py-2.5 px-2`} title="Volume down">
                  <span className="text-sm font-bold leading-none">−</span>
                  <span className="text-[9px] font-mono">Vol−</span>
                </button>
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('volume_up')} className={`${remoteBtnClass} py-2.5 px-2`} title="Volume up">
                  <Volume2 className="w-4 h-4" />
                  <span className="text-[9px] font-mono">Vol+</span>
                </button>
                <button type="button" disabled={!remoteReady || busy} onClick={() => handleRemoteKey('play_pause')} className={`${remoteBtnClass} py-2.5 px-2`} title="Play / Pause">
                  <span className="flex items-center gap-0.5">
                    <Play className="w-3 h-3" />
                    <Pause className="w-3 h-3" />
                  </span>
                  <span className="text-[9px] font-mono">Play/Pause</span>
                </button>
                <button
                  type="button"
                  disabled={!remoteReady || busy}
                  onClick={() => handleRemoteKey('power')}
                  className={`${remoteBtnClass} py-2.5 px-2 text-red-400 hover:text-red-300 border-red-900/40 hover:border-red-500/50`}
                  title="Power"
                >
                  <Power className="w-4 h-4" />
                  <span className="text-[9px] font-mono">Power</span>
                </button>
              </div>
            </div>
            {!remoteReady && (
              <p className="text-[10px] font-mono text-gray-500">
                {TV_REMOTE_KEYS.map((k) => k.key).join(' · ')} — idle until a real adb device is selected.
              </p>
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
                  disabled={!hasDevice}
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
                disabled={!hasDevice}
                className="flex-1 px-3 py-2 rounded-xl bg-[#090e1f] border border-blue-900/50 text-white placeholder-gray-500 text-xs font-mono focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSendText}
                disabled={!textToSend.trim() || !hasDevice}
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
              In Sagar Tamang&apos;s ULTRON design (&quot;A voice with hands&quot;), mobile devices are orchestrated via an ADB bridge. The vision loop captures the screen, sends frames to Claude or Gemini, calculates button coordinates, and automatically triggers physical taps and keyboard entries. TVs skip the vision/tap loop and use the remote-key cluster instead.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
