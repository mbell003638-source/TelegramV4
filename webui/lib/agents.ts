import { AgentInfo } from './types';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export const AGENTS_CATALOG: Omit<AgentInfo, 'status' | 'binaryPath'>[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    emoji: '🟣',
    role: 'Lead Architect & Strategic Planning',
    model: 'claude-opus-5',
    availableModels: [
      { id: 'claude-opus-5', name: 'Claude Opus 5 (Flagship)', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    activeEffort: 'medium',
    description: 'Anthropic Claude Code CLI subprocess with autonomous tool execution, subagent delegation, and 2026 Opus 5 architecture.',
    category: 'core',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    emoji: '🟢',
    role: 'Full-Stack Coding & Test Execution',
    model: 'gpt-6-astra',
    availableModels: [
      { id: 'gpt-6-astra', name: 'GPT-6-Astra (Frontier)', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-5.5', name: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4-Mini' },
      { id: 'o3-mini', name: 'o3-mini' },
    ],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    activeEffort: 'medium',
    description: 'High-speed coding execution engine with full filesystem access, live unit test validation, and GPT-6 frontier models.',
    category: 'coding',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    emoji: '🔵',
    role: 'Swarm Orchestration & Codebase Indexing',
    model: 'gemini-3.7-pro',
    availableModels: [
      { id: 'gemini-3.7-pro', name: 'Gemini 3.7 Pro' },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
      { id: 'gemini-3.6-pro', name: 'Gemini 3.6 Pro' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ],
    description: 'Google Deepmind Advanced Agentic Coding engine with multi-agent coordination, subagents, and skills.',
    category: 'router',
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    emoji: '⚪',
    role: 'Real-Time Telemetry & Analysis',
    model: 'grok-4.6',
    availableModels: [
      { id: 'grok-4.6', name: 'Grok 4.6 (Real-Time)', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'grok-4.5', name: 'Grok 4.5', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'grok-2-latest', name: 'Grok 2 Latest' },
      { id: 'grok-beta', name: 'Grok Beta' },
    ],
    reasoningEfforts: ['low', 'medium', 'high'],
    activeEffort: 'medium',
    description: 'xAI Grok terminal intelligence with real-time web telemetry and uncensored analysis.',
    category: 'core',
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    emoji: '🟠',
    role: 'Tool Reasoning & Scratchpad Planning',
    model: 'hermes-3-llama-3.1-70b',
    availableModels: [
      { id: 'hermes-3-llama-3.1-70b', name: 'Hermes 3 (Llama 3.1 70B)' },
      { id: 'hermes-3-llama-3.1-8b', name: 'Hermes 3 (Llama 3.1 8B)' },
      { id: 'nous-hermes-2-mixtral', name: 'Nous Hermes 2 Mixtral' },
    ],
    description: 'Nous Research Hermes agent with <thought> scratchpad and function call synthesis.',
    category: 'core',
  },
  {
    id: 'opencode',
    name: 'OpenCode CLI',
    emoji: '🟡',
    role: 'Multi-Provider Terminal Assistant',
    model: 'tokenrouter/z-ai/glm-5.3-free',
    availableModels: [
      { id: 'tokenrouter/z-ai/glm-5.3-free', name: 'GLM 5.3 (Free / TokenRouter)' },
      { id: 'nvidia/z-ai/glm-5.2', name: 'GLM 5.2 (Nvidia)' },
      { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Nvidia)' },
      { id: 'nvidia/deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro (Nvidia)' },
      { id: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)' },
    ],
    description: 'OpenCode terminal engine supporting OpenRouter, DeepSeek, and Anthropic.',
    category: 'coding',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw Gateway',
    emoji: '🦞',
    role: 'Local Automation & Hardware Controller',
    model: 'openclaw-v4-universal',
    availableModels: [
      { id: 'openclaw-v4-universal', name: 'OpenClaw v4 Universal' },
      { id: 'openclaw-lite', name: 'OpenClaw Lite' },
    ],
    description: 'Self-hosted agent gateway and daemon connecting local hardware, satellites, and tools.',
    category: 'system',
  },
  {
    id: 'pi',
    name: 'Pi Agent',
    emoji: '🥧',
    role: 'Lightweight Subtask Worker',
    model: 'nvidia/deepseek-ai/deepseek-v4-pro-0813',
    availableModels: [
      { id: 'nvidia/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro (Nvidia)' },
      { id: 'nvidia/google/gemma-3-12b-it', name: 'Gemma 3 12B (Nvidia)' },
      { id: 'nvidia/meta/llama-3.2-90b-vision-instruct', name: 'Llama 3.2 90B Vision (Nvidia)' },
      { id: 'nvidia/moonshotai/kimi-k3', name: 'Kimi K3 (Nvidia)' },
      { id: 'nvidia/nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B (Nvidia)' },
      { id: 'nvidia/openai/gpt-oss-120b', name: 'GPT-OSS 120B (Nvidia)' },
    ],
    description: 'Ultra-fast subtask execution engine for micro-delegation and asynchronous scraping.',
    category: 'system',
  },
];

function checkCommandInPath(cmd: string): string | null {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(checkCmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch {
    // ignore
  }
  return null;
}

export function scanLocalAgents(): AgentInfo[] {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');

  const knownPaths: Record<string, string[]> = {
    claude: [
      path.join(userProfile, '.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
    ],
    codex: [
      path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'bffc5354119c8421', 'codex.exe'),
    ],
    grok: [
      path.join(userProfile, '.grok', 'bin', 'grok.exe'),
    ],
    antigravity: [
      path.join(localAppData, 'agy', 'bin', 'agy.exe'),
    ],
    hermes: [
      path.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
    ],
    opencode: [
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode'),
    ],
    openclaw: [
      path.join(appData, 'npm', 'openclaw.cmd'),
    ],
    pi: [
      path.join(appData, 'npm', 'pi.cmd'),
    ],
  };

  return AGENTS_CATALOG.map((agent) => {
    let binaryPath = checkCommandInPath(agent.id);

    if (!binaryPath && knownPaths[agent.id]) {
      for (const p of knownPaths[agent.id]) {
        if (fs.existsSync(p)) {
          binaryPath = p;
          break;
        }
      }
    }

    let status: 'live' | 'standby' | 'not_installed' = 'not_installed';
    if (binaryPath) {
      status = 'live';
    } else if (agent.id === 'openclaw' || agent.id === 'pi') {
      // Virtual agent adapters in bridge
      status = 'standby';
    }

    return {
      ...agent,
      status,
      binaryPath,
    };
  });
}
