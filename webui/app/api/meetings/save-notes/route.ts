import { NextResponse } from 'next/server';
import { saveMeetingNotesToObsidian } from '@/lib/obsidian';
import { bridgeUrl } from '@/lib/config';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const agentId = body.agentId || 'hermes';
    const provider = body.provider || 'google';
    const meetUrl = body.meetUrl || '';
    const notes = body.notes || [];

    const savedPath = saveMeetingNotesToObsidian(agentId, provider, meetUrl, notes);

    // Also forward to telegram bridge if active
    try {
      await fetch(bridgeUrl('/api/meetings/save-notes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, provider, meetUrl, notes })
      });
    } catch {}

    return NextResponse.json({ ok: true, saved: true, path: savedPath });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
