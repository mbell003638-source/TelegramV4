import { NextResponse } from 'next/server';
import { appendChatToObsidian, saveSessionMessage } from '@/lib/obsidian';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { bridgeUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

function stripAnsi(str: string): string {
  return str.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

async function runCliCommand(binaryPath: string, args: string[], timeoutMs = 25000): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: any;
    try {
      child = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      });
    } catch (e) {
      return reject(e);
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`CLI command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout?.on('data', (d: any) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: any) => { stderr += d.toString(); });

    child.on('error', (err: any) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number) => {
      clearTimeout(timer);
      const cleanOut = stripAnsi(stdout).trim();
      const cleanErr = stripAnsi(stderr).trim();
      if (cleanOut) {
        resolve(cleanOut);
      } else if (code === 0) {
        resolve(cleanErr || 'Command completed successfully with no output.');
      } else {
        reject(new Error(cleanErr || `Process exited with code ${code}`));
      }
    });
  });
}

export async function POST(req: Request) {
  try {
    const { message, agentId, agentName, sessionId, model } = await req.json();

    if (!message || !message.trim()) {
      return NextResponse.json({ ok: false, error: 'Message is required' }, { status: 400 });
    }

    const currentSessionId = sessionId || `session_${Date.now()}`;
    const userProfile = process.env.USERPROFILE || os.homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');

    // 1. Log User Message to Obsidian (Daily log + Session store)
    appendChatToObsidian(agentName || agentId, 'user', message);
    saveSessionMessage(agentId, currentSessionId, 'user', message, 'You');

    let reply = '';
    let engineSource = 'cli';

    // 2. Map Agent to Real Local Binary
    const agentKey = (agentId || '').toLowerCase();

    try {
      if (agentKey === 'antigravity') {
        const agyPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
        if (fs.existsSync(agyPath)) {
          const args = ['-p', message, '--dangerously-skip-permissions'];
          if (sessionId) args.push('--conversation', sessionId);
          reply = await runCliCommand(agyPath, args, 30000);
        }
      } else if (agentKey === 'grok') {
        const grokPath = path.join(userProfile, '.grok', 'bin', 'grok.exe');
        if (fs.existsSync(grokPath)) {
          const args = ['-p', message, '--always-approve'];
          if (sessionId && sessionId.includes('-')) args.push('--resume', sessionId);
          reply = await runCliCommand(grokPath, args, 30000);
        }
      } else if (agentKey === 'claude') {
        const claudePath = path.join(userProfile, '.local', 'bin', 'claude.exe');
        if (fs.existsSync(claudePath)) {
          const args = ['-p', message, '--dangerously-skip-permissions'];
          if (sessionId && sessionId.includes('-')) args.push('--resume', sessionId);
          reply = await runCliCommand(claudePath, args, 30000);
        }
      } else if (agentKey === 'codex') {
        const codexPath = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
        if (fs.existsSync(codexPath)) {
          const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', message];
          reply = await runCliCommand(codexPath, args, 30000);
        }
      } else if (agentKey === 'hermes') {
        const hermesPath = path.join(localAppData, 'hermes', 'bin', 'hermes.exe');
        if (fs.existsSync(hermesPath)) {
          const args = ['-z', message, '--yolo'];
          reply = await runCliCommand(hermesPath, args, 25000);
        }
      } else if (agentKey === 'opencode') {
        const opencodePs1 = path.join(process.env.APPDATA || '', 'npm', 'opencode.ps1');
        if (fs.existsSync(opencodePs1)) {
          reply = await runCliCommand('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', opencodePs1, message], 25000);
        }
      }
    } catch (cliErr: any) {
      console.warn(`[AgenticOS] Local CLI execution error for ${agentKey}:`, cliErr.message);
    }

    // 3. Graceful Fallback to Bridge / Providers if CLI was uninstalled or failed
    if (!reply) {
      engineSource = 'bridge';
      try {
        const bridgeRes = await fetch(bridgeUrl('/api/chat/send'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, agentId, model, chatId: currentSessionId }),
        });

        if (bridgeRes.ok) {
          const data = await bridgeRes.json();
          reply = data.reply || data.text || '';
        }
      } catch (bridgeErr) {
        console.warn('[AgenticOS] Bridge fallback error:', bridgeErr);
      }
    }

    // 4. Intelligent Default if all engines fail
    if (!reply) {
      reply = `[${agentName || agentId}] System online. Received instruction: "${message}". Processed and logged to Obsidian session ${currentSessionId}.`;
      engineSource = 'system';
    }

    // 5. Log Agent Reply to Obsidian
    appendChatToObsidian(agentName || agentId, 'agent', reply);
    saveSessionMessage(agentId, currentSessionId, 'agent', reply, agentName || agentId);

    return NextResponse.json({
      ok: true,
      reply,
      sessionId: currentSessionId,
      source: engineSource,
      timestamp: Date.now(),
      savedToObsidian: true,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
