import fs from 'fs';
import path from 'path';
import { GoalItem, JournalEntry } from './types';

const CONFIG_FILE = path.join(process.cwd(), 'obsidian-config.json');

export function getVaultPath(): string {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.vaultPath) return data.vaultPath;
    }
  } catch {}
  return path.join(process.env.USERPROFILE || 'C:\\Users\\just2', 'Documents', 'ObsidianVault');
}

export function setVaultPath(newPath: string): boolean {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ vaultPath: newPath }, null, 2), 'utf8');
    ensureVaultStructure(newPath);
    return true;
  } catch {
    return false;
  }
}

export function ensureVaultStructure(vaultPath: string = getVaultPath()): string {
  const root = path.join(vaultPath, 'Agentic OS');
  const dirs = [
    root,
    path.join(root, 'chats'),
    path.join(root, 'goals'),
    path.join(root, 'journal'),
  ];
  dirs.forEach(d => {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  });
  return root;
}

function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function appendChatToObsidian(agentName: string, role: 'user' | 'agent', text: string) {
  try {
    const root = ensureVaultStructure();
    const today = getTodayString();
    const filePath = path.join(root, 'chats', `${today}.md`);
    const timeStr = new Date().toLocaleTimeString();

    let header = '';
    if (!fs.existsSync(filePath)) {
      header = `# Agentic OS — Chat Log (${today})\n\n`;
    }

    const speaker = role === 'user' ? '👤 **You**' : `🤖 **${agentName}**`;
    const entry = `${header}### [${timeStr}] ${speaker}\n${text}\n\n---\n\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
  } catch (err) {
    console.warn('[Obsidian] Could not append chat:', err);
  }
}

export function readGoalsFromObsidian(): GoalItem[] {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'goals', 'goals.md');
    if (!fs.existsSync(filePath)) {
      // Seed default goals
      const defaults: GoalItem[] = [
        { id: '1', title: 'Initialize Agentic OS Mission Control WebUI', category: 'Strategic', completed: true, priority: 'High', createdAt: Date.now() - 3600000, completedAt: Date.now() },
        { id: '2', title: 'Scan and verify all local AI CLI engines', category: 'Coding', completed: true, priority: 'High', createdAt: Date.now() - 1800000, completedAt: Date.now() },
        { id: '3', title: 'Test voice input on per-agent chat pages', category: 'Operations', completed: false, priority: 'Medium', createdAt: Date.now() },
        { id: '4', title: 'Review morning priorities in Daily Journal', category: 'Personal', completed: false, priority: 'Medium', createdAt: Date.now() },
      ];
      writeGoalsToObsidian(defaults);
      return defaults;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const items: GoalItem[] = [];

    lines.forEach((line, index) => {
      const match = line.match(/^-\s*\[([ xX])\]\s*(.+)$/);
      if (match) {
        const completed = match[1].toLowerCase() === 'x';
        let title = match[2].trim();
        let category: GoalItem['category'] = 'Strategic';
        let priority: GoalItem['priority'] = 'Medium';

        if (title.includes('[Coding]')) { category = 'Coding'; title = title.replace('[Coding]', '').trim(); }
        else if (title.includes('[Operations]')) { category = 'Operations'; title = title.replace('[Operations]', '').trim(); }
        else if (title.includes('[Personal]')) { category = 'Personal'; title = title.replace('[Personal]', '').trim(); }

        if (title.includes('🔥 High')) { priority = 'High'; title = title.replace('🔥 High', '').trim(); }
        else if (title.includes('⚡ Low')) { priority = 'Low'; title = title.replace('⚡ Low', '').trim(); }

        items.push({
          id: `goal_${index}`,
          title,
          category,
          completed,
          priority,
          createdAt: Date.now(),
        });
      }
    });

    return items;
  } catch {
    return [];
  }
}

export function writeGoalsToObsidian(goals: GoalItem[]): boolean {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'goals', 'goals.md');
    let md = `# 🎯 Agentic OS — Goals Tracker\n\n`;
    md += `*Updated: ${new Date().toLocaleString()}*\n\n`;

    goals.forEach(g => {
      const check = g.completed ? 'x' : ' ';
      const tag = `[${g.category}]`;
      const pri = g.priority === 'High' ? '🔥 High' : (g.priority === 'Low' ? '⚡ Low' : '');
      md += `- [${check}] ${tag} ${g.title} ${pri}\n`;
    });

    fs.writeFileSync(filePath, md, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readJournalFromObsidian(date: string = getTodayString()): JournalEntry {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'journal', `${date}.md`);
    if (!fs.existsSync(filePath)) {
      return {
        id: `journal_${date}`,
        date,
        content: '',
        morningFocus: 'Define key priority for the AI swarm today.',
        eveningWins: '',
        updatedAt: Date.now(),
      };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return {
      id: `journal_${date}`,
      date,
      content,
      updatedAt: Date.now(),
    };
  } catch {
    return {
      id: `journal_${date}`,
      date,
      content: '',
      updatedAt: Date.now(),
    };
  }
}

export function writeJournalToObsidian(entry: JournalEntry): boolean {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'journal', `${entry.date}.md`);
    let md = `# 📓 Daily Journal — ${entry.date}\n\n`;
    md += `*Logged at: ${new Date().toLocaleTimeString()}*\n\n`;
    if (entry.morningFocus) {
      md += `## 🌅 Morning Focus\n${entry.morningFocus}\n\n`;
    }
    if (entry.content) {
      md += `## ✍️ Notes & Reflections\n${entry.content}\n\n`;
    }
    if (entry.eveningWins) {
      md += `## 🏆 Evening Wins\n${entry.eveningWins}\n\n`;
    }

    fs.writeFileSync(filePath, md, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface SessionSummary {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  lastMessage: string;
}

export function saveSessionMessage(agentId: string, sessionId: string, role: 'user' | 'agent', text: string, speakerName?: string) {
  try {
    const root = ensureVaultStructure();
    const sessionsDir = path.join(root, 'chats', 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    const filePath = path.join(sessionsDir, `${agentId}_${sessionId}.json`);
    let sessionData: { id: string; agentId: string; title: string; updatedAt: number; messages: any[] } = {
      id: sessionId,
      agentId,
      title: text.slice(0, 45),
      updatedAt: Date.now(),
      messages: []
    };

    if (fs.existsSync(filePath)) {
      try {
        sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {}
    }

    sessionData.updatedAt = Date.now();
    sessionData.messages.push({
      id: `${role}-${Date.now()}`,
      role,
      speaker: speakerName || (role === 'user' ? 'You' : agentId),
      text,
      timestamp: Date.now()
    });

    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Obsidian] saveSessionMessage error:', e);
  }
}

export function listAgentSessions(agentId: string): SessionSummary[] {
  try {
    const root = ensureVaultStructure();
    const sessionsDir = path.join(root, 'chats', 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];

    const files = fs.readdirSync(sessionsDir);
    const summaries: SessionSummary[] = [];

    files.forEach(f => {
      if (f.startsWith(`${agentId}_`) && f.endsWith('.json')) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
          const msgs = content.messages || [];
          summaries.push({
            id: content.id || f.replace(`${agentId}_`, '').replace('.json', ''),
            agentId,
            title: content.title || (msgs[0]?.text?.slice(0, 40) ?? 'New Conversation'),
            updatedAt: content.updatedAt || Date.now(),
            messageCount: msgs.length,
            lastMessage: msgs[msgs.length - 1]?.text?.slice(0, 60) || ''
          });
        } catch {}
      }
    });

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function getSessionMessages(agentId: string, sessionId: string) {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'chats', 'sessions', `${agentId}_${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data.messages || [];
    }
  } catch {}
  return [];
}

export function deleteSession(agentId: string, sessionId: string): boolean {
  try {
    const root = ensureVaultStructure();
    const filePath = path.join(root, 'chats', 'sessions', `${agentId}_${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: 'inbox' | 'inprogress' | 'review' | 'completed';
  assignedAgent: string;
  priority: 'critical' | 'high' | 'normal';
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_TASKS: KanbanTask[] = [
  {
    id: 'task-1',
    title: 'Verify Three.js WebGL 3D Globe & Ultron Core',
    description: 'Hardware accelerated 3D rotating particle sphere and holographic wireframe core.',
    column: 'completed',
    assignedAgent: 'antigravity',
    priority: 'critical',
    createdAt: Date.now() - 3600000 * 4,
    updatedAt: Date.now() - 3600000 * 2,
  },
  {
    id: 'task-2',
    title: 'War Room Text & Voice Standup Protocol',
    description: 'Direct multi-agent consensus broadcasting with individual browser speech synthesis voices.',
    column: 'inprogress',
    assignedAgent: 'hermes',
    priority: 'high',
    createdAt: Date.now() - 3600000 * 3,
    updatedAt: Date.now() - 3600000 * 1,
  },
  {
    id: 'task-3',
    title: 'Audit Local Memory Vault for High Salience Insights',
    description: 'Classify unpinned notes, calculate salience decay, and consolidate recurring learnings.',
    column: 'inbox',
    assignedAgent: 'claude',
    priority: 'normal',
    createdAt: Date.now() - 3600000 * 2,
    updatedAt: Date.now() - 3600000 * 2,
  },
  {
    id: 'task-4',
    title: 'Real-time Telemetry & Model Key Verification',
    description: 'Ensure OpenRouter, Anthropic, and Groq local environment variables are valid.',
    column: 'review',
    assignedAgent: 'grok',
    priority: 'high',
    createdAt: Date.now() - 3600000 * 1,
    updatedAt: Date.now() - 1800000,
  }
];

export function getKanbanTasks(): KanbanTask[] {
  try {
    const root = ensureVaultStructure();
    const tasksFile = path.join(root, 'tasks.json');
    if (fs.existsSync(tasksFile)) {
      return JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    }
    // Write defaults
    fs.writeFileSync(tasksFile, JSON.stringify(DEFAULT_TASKS, null, 2), 'utf8');
    return DEFAULT_TASKS;
  } catch {
    return DEFAULT_TASKS;
  }
}

export function saveKanbanTasks(tasks: KanbanTask[]): boolean {
  try {
    const root = ensureVaultStructure();
    const tasksFile = path.join(root, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface SafetySwitchesState {
  llm_spawn: boolean;
  warroom_text: boolean;
  voice_standup: boolean;
  mutations: boolean;
  auto_assign: boolean;
  scheduler: boolean;
  master_kill: boolean;
}

const DEFAULT_SAFETY: SafetySwitchesState = {
  llm_spawn: true,
  warroom_text: true,
  voice_standup: true,
  mutations: true,
  auto_assign: true,
  scheduler: true,
  master_kill: false,
};

export function getSafetyState(): SafetySwitchesState {
  try {
    const root = ensureVaultStructure();
    const safetyFile = path.join(root, 'safety.json');
    if (fs.existsSync(safetyFile)) {
      return JSON.parse(fs.readFileSync(safetyFile, 'utf8'));
    }
    fs.writeFileSync(safetyFile, JSON.stringify(DEFAULT_SAFETY, null, 2), 'utf8');
    return DEFAULT_SAFETY;
  } catch {
    return DEFAULT_SAFETY;
  }
}

export function saveSafetyState(state: SafetySwitchesState): boolean {
  try {
    const root = ensureVaultStructure();
    const safetyFile = path.join(root, 'safety.json');
    fs.writeFileSync(safetyFile, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function saveMeetingNotesToObsidian(
  agentId: string,
  provider: string,
  meetUrl: string,
  notes: Array<{ speaker: string; text: string; timestamp?: string }>
): string {
  const root = ensureVaultStructure();
  const today = getTodayString();
  const timeFormatted = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
  const filename = `Meeting-${agentId.toLowerCase()}-${today}-${timeFormatted}.md`;
  const filePath = path.join(root, 'chats', filename);

  let md = `# 🎥 Live Meeting Copilot Log\n\n`;
  md += `- **Agent Copilot**: \`${agentId.toUpperCase()}\`\n`;
  md += `- **Meeting Provider**: \`${provider.toUpperCase()}\`\n`;
  md += `- **Date**: \`${new Date().toLocaleString()}\`\n`;
  if (meetUrl) md += `- **Meeting Room**: [${meetUrl}](${meetUrl})\n`;
  md += `\n---\n\n## Transcript & Live Discussion Notes\n\n`;

  if (!notes || notes.length === 0) {
    md += `*No notes recorded during this session.*\n`;
  } else {
    notes.forEach((n, idx) => {
      const timeTag = n.timestamp ? `\`${n.timestamp}\` ` : '';
      const icon = n.speaker.toLowerCase().includes('you') ? '👤' : '🤖';
      md += `### ${idx + 1}. ${timeTag}${icon} **${n.speaker}**\n\n${n.text}\n\n`;
    });
  }

  md += `\n---\n*Auto-saved by Agentic OS Live Copilot*\n`;
  fs.writeFileSync(filePath, md, 'utf8');
  return filePath;
}


