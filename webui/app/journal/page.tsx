'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  BookOpen, 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight, 
  Calendar, 
  Save, 
  FolderSync, 
  Sun, 
  Moon, 
  Sparkles, 
  Check,
  FileText
} from 'lucide-react';
import VoiceButton from '@/components/VoiceButton';
import { JournalEntry } from '@/lib/types';

export default function JournalPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [morningFocus, setMorningFocus] = useState('');
  const [content, setContent] = useState('');
  const [eveningWins, setEveningWins] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const loadJournal = async (date: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/journal?date=${date}`);
      const data = await res.json();
      if (data.ok && data.entry) {
        setMorningFocus(data.entry.morningFocus || '');
        setContent(data.entry.content || '');
        setEveningWins(data.entry.eveningWins || '');
      } else {
        setMorningFocus('');
        setContent('');
        setEveningWins('');
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJournal(selectedDate);
  }, [selectedDate]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const entry: JournalEntry = {
        id: `journal_${selectedDate}`,
        date: selectedDate,
        morningFocus,
        content,
        eveningWins,
        updatedAt: Date.now(),
      };

      const res = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });

      const data = await res.json();
      if (data.ok) {
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 2500);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const changeDay = (delta: number) => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + delta);
    setSelectedDate(current.toISOString().split('T')[0]);
  };

  const formattedDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const isToday = selectedDate === new Date().toISOString().split('T')[0];

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="p-2.5 rounded-xl bg-[#090e1f] border border-blue-900/40 text-gray-400 hover:text-white hover:border-blue-500/50 transition-all"
            title="Return to Mission Control"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-black text-white tracking-tight flex items-center gap-2">
                <BookOpen className="w-6 h-6 text-sky-400" />
                Daily Reflection &amp; Neural Journal
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-950 text-sky-400 border border-blue-800/60 shadow-[0_0_10px_rgba(56,189,248,0.3)]">
                OBSIDIAN VAULT SYNC
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Capture strategic intentions, daily breakthroughs, and retrospective insights with voice dictation.
            </p>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold font-mono transition-all flex items-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.4)] ${
              savedSuccess
                ? 'bg-emerald-600 text-white shadow-[0_0_25px_rgba(16,185,129,0.7)]'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {savedSuccess ? (
              <>
                <Check className="w-4 h-4 text-emerald-200" />
                <span>Saved to Obsidian</span>
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                <span>{saving ? 'Syncing...' : 'Save Reflection'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Date Switcher Bar */}
      <div className="flex items-center justify-between p-3.5 rounded-2xl bg-[#040816] border border-blue-900/50">
        <button
          onClick={() => changeDay(-1)}
          className="p-2 rounded-xl bg-[#080f24] hover:bg-blue-900/40 border border-blue-950 text-gray-400 hover:text-white transition-all flex items-center gap-1 text-xs font-mono"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Previous Day</span>
        </button>

        <div className="flex items-center gap-2.5">
          <Calendar className="w-4 h-4 text-sky-400" />
          <span className="text-sm font-bold text-white font-mono">{formattedDate}</span>
          {isToday && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
              TODAY
            </span>
          )}
        </div>

        <button
          onClick={() => changeDay(1)}
          className="p-2 rounded-xl bg-[#080f24] hover:bg-blue-900/40 border border-blue-950 text-gray-400 hover:text-white transition-all flex items-center gap-1 text-xs font-mono"
        >
          <span className="hidden sm:inline">Next Day</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Main Journal Sections */}
      <div className="space-y-6">
        {/* Morning Focus Card */}
        <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-sky-300">
              <Sun className="w-4 h-4 text-amber-400" />
              <span>Morning Focus &amp; Core Intentions</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-gray-500">Hands-free voice</span>
              <VoiceButton
                onTranscript={(text) => {
                  setMorningFocus(prev => prev ? `${prev} ${text}` : text);
                }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            What is the single highest-leverage mission directive to execute today? What would make today a total victory?
          </p>
          <textarea
            rows={3}
            value={morningFocus}
            onChange={(e) => setMorningFocus(e.target.value)}
            placeholder="Dictate or write your morning priority..."
            className="w-full bg-[#030612] text-white placeholder-gray-600 text-sm rounded-xl p-3.5 border border-blue-950 focus:outline-none focus:border-blue-500 transition-all font-sans resize-none leading-relaxed"
          />
        </div>

        {/* Freeform Notes & Reflections */}
        <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-sky-300">
              <FileText className="w-4 h-4 text-blue-400" />
              <span>Field Notes, Architectures &amp; Epiphanies</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-gray-500">Hands-free voice</span>
              <VoiceButton
                onTranscript={(text) => {
                  setContent(prev => prev ? `${prev}\n${text}` : text);
                }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Scratchpad for prompt engineering thoughts, agent discoveries, system configurations, and strategic observations.
          </p>
          <textarea
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Record technical insights, system logs, or stream-of-consciousness reflections..."
            className="w-full bg-[#030612] text-white placeholder-gray-600 text-sm rounded-xl p-3.5 border border-blue-950 focus:outline-none focus:border-blue-500 transition-all font-sans resize-y leading-relaxed"
          />
        </div>

        {/* Evening Wins Card */}
        <div className="glass-card p-6 rounded-2xl border border-blue-900/40 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-sky-300">
              <Moon className="w-4 h-4 text-indigo-400" />
              <span>Evening Wins &amp; Daily Debrief</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-gray-500">Hands-free voice</span>
              <VoiceButton
                onTranscript={(text) => {
                  setEveningWins(prev => prev ? `${prev} ${text}` : text);
                }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            What was shipped? What breakthroughs were achieved? What was learned from friction?
          </p>
          <textarea
            rows={3}
            value={eveningWins}
            onChange={(e) => setEveningWins(e.target.value)}
            placeholder="Dictate or write your evening debrief..."
            className="w-full bg-[#030612] text-white placeholder-gray-600 text-sm rounded-xl p-3.5 border border-blue-950 focus:outline-none focus:border-blue-500 transition-all font-sans resize-none leading-relaxed"
          />
        </div>
      </div>

      {/* Obsidian Vault Path Footer Note */}
      <div className="p-4 rounded-xl bg-[#02050f] border border-blue-950/60 flex items-center justify-between text-xs font-mono text-gray-400">
        <div className="flex items-center gap-2">
          <FolderSync className="w-4 h-4 text-purple-400" />
          <span>Sync target: Agentic OS/journal/{selectedDate}.md</span>
        </div>
        <button
          onClick={handleSave}
          className="text-sky-400 hover:text-sky-300 underline underline-offset-2"
        >
          Force Manual Save
        </button>
      </div>
    </div>
  );
}
