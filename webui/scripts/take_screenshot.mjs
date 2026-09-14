import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const url = process.argv[2] || 'http://localhost:3000/agents/grok?session=grok_session_load_analysis';
const outputPath = process.argv[3] || 'C:\\Users\\just2\\.gemini\\antigravity\\brain\\1150b87d-49a5-4f9e-ba31-b9837aeb35bd\\.tempmediaStorage\\mc_grok_tabs_verified.png';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const edge = spawn(edgePath, [
  '--headless',
  '--disable-gpu',
  '--remote-debugging-port=9222',
  '--window-size=1440,900',
  'about:blank'
]);

// Wait for debug port to open
await new Promise(r => setTimeout(r, 1000));

try {
  const versionRes = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await versionRes.json();
  const wsUrl = tabs[0]?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('No debugger URL found');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = id++;
    const handler = (e) => {
      const data = JSON.parse(e.data);
      if (data.id === msgId) {
        ws.removeEventListener('message', handler);
        resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send('Page.enable');
  await send('Page.navigate', { url });
  
  // Wait 2.5 seconds for all client fetches (agents, sessions, vault) to resolve
  await new Promise(r => setTimeout(r, 2500));

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  if (screenshot?.data) {
    fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
    console.log(`Saved screenshot to ${outputPath}`);
  }

  ws.close();
} catch (e) {
  console.error('Screenshot error:', e);
} finally {
  try { edge.kill('SIGKILL'); } catch {}
  process.exit(0);
}
