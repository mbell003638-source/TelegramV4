'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  CheckCircle2, 
  Circle, 
  Plus, 
  Trash2, 
  Flame, 
  Sparkles, 
  FolderSync, 
  Filter, 
  ArrowLeft,
  Award,
  Zap,
  Tag
} from 'lucide-react';
import VoiceButton from '@/components/VoiceButton';
import { GoalItem } from '@/lib/types';

// Web Audio API dopamine chime (zero external audio files required)
function playDopamineChime() {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 major chord
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.08);

      gain.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + idx * 0.08 + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + idx * 0.08);
      osc.stop(ctx.currentTime + idx * 0.08 + 0.45);
    });
  } catch {
    // AudioContext blocked or not supported
  }
}

export default function GoalsPage() {
  const [goals, setGoals] = useState<GoalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>('All');
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<GoalItem['category']>('Strategic');
  const [newPriority, setNewPriority] = useState<GoalItem['priority']>('High');
  const [saving, setSaving] = useState(false);
  const [lastDopamineId, setLastDopamineId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/goals')
      .then(res => res.json())
      .then(data => {
        if (data.ok && Array.isArray(data.goals)) {
          setGoals(data.goals);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const saveGoalsToBackend = async (updated: GoalItem[]) => {
    setSaving(true);
    try {
      await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals: updated }),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const toggleGoal = (id: string) => {
    const updated = goals.map(g => {
      if (g.id === id) {
        const nextCompleted = !g.completed;
        if (nextCompleted) {
          playDopamineChime();
          setLastDopamineId(id);
          setTimeout(() => setLastDopamineId(null), 1500);
        }
        return { ...g, completed: nextCompleted, completedAt: nextCompleted ? Date.now() : undefined };
      }
      return g;
    });
    setGoals(updated);
    saveGoalsToBackend(updated);
  };

  const deleteGoal = (id: string) => {
    const updated = goals.filter(g => g.id !== id);
    setGoals(updated);
    saveGoalsToBackend(updated);
  };

  const addGoal = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newTitle.trim()) return;

    const newGoal: GoalItem = {
      id: 'goal_' + Date.now(),
      title: newTitle.trim(),
      category: newCategory,
      priority: newPriority,
      completed: false,
      createdAt: Date.now(),
    };

    const updated = [newGoal, ...goals];
    setGoals(updated);
    setNewTitle('');
    saveGoalsToBackend(updated);
  };

  const categories = ['All', 'Strategic', 'Coding', 'Operations', 'Personal'];

  const filteredGoals = goals.filter(g => {
    if (filterCategory === 'All') return true;
    return g.category === filterCategory;
  });

  const totalCount = goals.length;
  const completedCount = goals.filter(g => g.completed).length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      {/* Header */}
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
                <Award className="w-6 h-6 text-sky-400" />
                Goals &amp; Dopamine Matrix
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-blue-950 text-sky-400 border border-blue-800/60 shadow-[0_0_10px_rgba(56,189,248,0.3)]">
                OBSIDIAN TWO-WAY SYNC
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              High-velocity execution radar. Every completed milestone syncs to your Obsidian Second Brain.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#070d1e] border border-blue-950 text-xs font-mono text-gray-400">
            <FolderSync className={`w-3.5 h-3.5 ${saving ? 'animate-spin text-sky-400' : 'text-purple-400'}`} />
            <span>{saving ? 'Syncing...' : 'goals/goals.md'}</span>
          </div>
        </div>
      </div>

      {/* Dopamine Progress Hero Banner */}
      <div className="relative rounded-2xl p-6 bg-gradient-to-r from-[#030717] via-[#081230] to-[#020510] border border-blue-500/30 shadow-[0_0_40px_rgba(37,99,235,0.25)] overflow-hidden">
        <div className="absolute -top-10 -right-10 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400 uppercase tracking-wider">
              <Flame className="w-4 h-4 text-amber-400 animate-pulse" />
              <span>Dopamine Momentum Velocity</span>
            </div>
            <div className="text-4xl font-black text-white font-mono flex items-baseline gap-3">
              {progressPercent}%
              <span className="text-xs font-sans font-medium text-gray-400">
                ({completedCount} of {totalCount} objectives achieved)
              </span>
            </div>
            <p className="text-xs text-gray-400 max-w-md">
              {progressPercent === 100 
                ? '🏆 Supercharged! All mission directives completed. Ready for next strategic campaign.'
                : progressPercent > 50 
                ? '⚡ Phenomenal momentum! Over halfway to complete mission velocity.'
                : '🎯 Select or speak an objective to initiate execution flow.'}
            </p>
          </div>

          {/* Glowing Neon Progress Bar */}
          <div className="w-full md:w-80 space-y-2">
            <div className="h-3 w-full bg-[#02040a] rounded-full overflow-hidden border border-blue-900/60 p-0.5">
              <div 
                className="h-full bg-gradient-to-r from-blue-600 via-sky-400 to-emerald-400 rounded-full transition-all duration-700 ease-out shadow-[0_0_15px_rgba(56,189,248,0.8)]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono text-gray-400">
              <span>0% INITIALIZED</span>
              <span className="text-emerald-400">{completedCount} COMPLETED</span>
              <span>100% ASCENT</span>
            </div>
          </div>
        </div>
      </div>

      {/* Add New Goal Card with Voice Dictation */}
      <div className="glass-card p-5 rounded-2xl border border-blue-900/40">
        <form onSubmit={addGoal} className="space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
            <Plus className="w-4 h-4 text-sky-400" />
            <span>Create New Directive</span>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative flex items-center">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Type objective or click the microphone to speak hands-free..."
                className="w-full bg-[#050916] text-white placeholder-gray-500 text-sm rounded-xl px-4 py-2.5 pr-12 border border-blue-900/50 focus:outline-none focus:border-blue-500 focus:shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all font-sans"
              />
              <div className="absolute right-2">
                <VoiceButton
                  onTranscript={(text) => {
                    setNewTitle(prev => prev ? `${prev} ${text}` : text);
                  }}
                />
              </div>
            </div>

            {/* Category Select */}
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as any)}
              className="bg-[#050916] text-gray-300 text-xs font-mono rounded-xl px-3 py-2.5 border border-blue-900/50 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="Strategic">Strategic</option>
              <option value="Coding">Coding</option>
              <option value="Operations">Operations</option>
              <option value="Personal">Personal</option>
            </select>

            {/* Priority Select */}
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as any)}
              className="bg-[#050916] text-gray-300 text-xs font-mono rounded-xl px-3 py-2.5 border border-blue-900/50 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="High">🔥 High Priority</option>
              <option value="Medium">⚡ Medium Priority</option>
              <option value="Low">🌱 Low Priority</option>
            </select>

            {/* Add Button */}
            <button
              type="submit"
              disabled={!newTitle.trim()}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold font-mono transition-all shadow-[0_0_15px_rgba(37,99,235,0.4)] disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Add Directive</span>
            </button>
          </div>
        </form>
      </div>

      {/* Category Filter Pills */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
          <Filter className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={`px-3 py-1.5 rounded-xl text-xs font-mono font-medium transition-all ${
                filterCategory === cat
                  ? 'bg-blue-600 text-white shadow-[0_0_12px_rgba(37,99,235,0.5)] border border-blue-400'
                  : 'bg-[#050916] text-gray-400 hover:text-gray-200 border border-blue-950 hover:border-blue-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="text-xs font-mono text-gray-500">
          Showing {filteredGoals.length} items
        </div>
      </div>

      {/* Goals List */}
      <div className="space-y-2.5">
        {loading ? (
          <div className="p-8 text-center text-xs font-mono text-gray-400">Loading objectives matrix...</div>
        ) : filteredGoals.length === 0 ? (
          <div className="p-12 text-center glass-card rounded-2xl border border-blue-950 space-y-2">
            <Sparkles className="w-8 h-8 text-sky-400/40 mx-auto" />
            <p className="text-sm font-semibold text-gray-300">No directives found in this category</p>
            <p className="text-xs text-gray-500">Use the input above to create a new task or speak hands-free.</p>
          </div>
        ) : (
          filteredGoals.map((goal) => {
            const isJustCelebrated = lastDopamineId === goal.id;
            return (
              <div
                key={goal.id}
                className={`group relative rounded-xl p-4 transition-all flex items-center justify-between gap-4 border ${
                  goal.completed
                    ? 'bg-[#02050f]/60 border-blue-950/40 opacity-70'
                    : 'bg-[#040817] hover:bg-[#060d24] border-blue-900/40 hover:border-blue-600/60 shadow-[0_0_15px_rgba(0,0,0,0.5)]'
                } ${isJustCelebrated ? 'ring-2 ring-emerald-400 shadow-[0_0_30px_rgba(52,211,153,0.6)] scale-[1.01]' : ''}`}
              >
                <div className="flex items-center gap-3.5 flex-1 min-w-0">
                  {/* Custom Checkbox Button */}
                  <button
                    onClick={() => toggleGoal(goal.id)}
                    className={`w-6 h-6 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${
                      goal.completed
                        ? 'bg-emerald-500 text-black shadow-[0_0_10px_rgba(16,185,129,0.7)]'
                        : 'border border-blue-700/60 hover:border-blue-400 text-transparent hover:text-blue-400/40'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                  </button>

                  <div className="flex-1 min-w-0">
                    <span 
                      className={`text-sm block truncate ${
                        goal.completed ? 'line-through text-gray-500' : 'text-gray-100 font-medium'
                      }`}
                    >
                      {goal.title}
                    </span>
                  </div>
                </div>

                {/* Badges & Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Category Tag */}
                  <span className="hidden sm:inline-block px-2 py-0.5 rounded-md text-[10px] font-mono bg-blue-950/80 text-sky-400 border border-blue-800/40">
                    {goal.category}
                  </span>

                  {/* Priority Tag */}
                  <span 
                    className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${
                      goal.priority === 'High'
                        ? 'bg-red-950/60 text-red-400 border-red-800/40'
                        : goal.priority === 'Medium'
                        ? 'bg-amber-950/60 text-amber-400 border-amber-800/40'
                        : 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40'
                    }`}
                  >
                    {goal.priority}
                  </span>

                  {/* Delete Button */}
                  <button
                    onClick={() => deleteGoal(goal.id)}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete directive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
