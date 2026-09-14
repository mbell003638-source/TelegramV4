import { NextResponse } from 'next/server';
import { getVaultPath, setVaultPath, ensureVaultStructure } from '@/lib/obsidian';
import { scanLocalAgents } from '@/lib/agents';

export async function GET() {
  const vaultPath = getVaultPath();
  const root = ensureVaultStructure(vaultPath);
  const agents = scanLocalAgents();
  const liveCount = agents.filter(a => a.status === 'live').length;

  return NextResponse.json({
    ok: true,
    vaultPath,
    vaultAgenticOsDir: root,
    liveAgentsCount: liveCount,
    totalAgentsCount: agents.length,
    bridgePort: 3141,
  });
}

export async function POST(req: Request) {
  try {
    const { vaultPath } = await req.json();
    if (vaultPath) {
      setVaultPath(vaultPath);
    }
    return NextResponse.json({ ok: true, vaultPath: getVaultPath() });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
