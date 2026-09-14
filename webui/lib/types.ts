export interface ModelDescriptor {
  id: string;
  name: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  autoReasoningEffort?: string;
}

export type AgentModelItem = string | ModelDescriptor;

export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  role: string;
  status: 'live' | 'standby' | 'not_installed';
  binaryPath: string | null;
  model: string;
  availableModels: AgentModelItem[];
  reasoningEfforts?: string[];
  activeEffort?: string;
  description: string;
  category: 'core' | 'coding' | 'system' | 'router';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  speaker?: string;
  text: string;
  timestamp: number;
  agentId: string;
  voiceName?: string;
}

export interface GoalItem {
  id: string;
  title: string;
  category: 'Strategic' | 'Coding' | 'Operations' | 'Personal';
  completed: boolean;
  priority: 'High' | 'Medium' | 'Low';
  createdAt: number;
  completedAt?: number;
}

export interface JournalEntry {
  id: string;
  date: string; // YYYY-MM-DD
  content: string;
  morningFocus?: string;
  eveningWins?: string;
  updatedAt: number;
}

export interface SystemStatus {
  online: boolean;
  bridgeConnected: boolean;
  bridgePort: number;
  vaultPath: string;
  installedAgentsCount: number;
  totalAgentsCount: number;
  uptimeSeconds: number;
}
