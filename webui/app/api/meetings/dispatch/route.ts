import { NextResponse } from 'next/server';
import { addMeetingSession, MeetingSession } from '@/lib/meetings';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const provider = body.provider || 'google';
    const agentId = body.agentId || 'hermes';
    const mode = body.mode || 'direct';
    const autoBrief = body.autoBrief !== false;
    let meetUrl = (body.meetUrl || body.url || '').trim();

    // 1. Sanitize & Normalize URL
    if (meetUrl) {
      if (!meetUrl.startsWith('http://') && !meetUrl.startsWith('https://')) {
        meetUrl = `https://${meetUrl}`;
      }
    } else {
      // Automatic Instant Room Generation
      if (provider === 'google') {
        meetUrl = 'https://meet.google.com/new';
      } else if (provider === 'daily') {
        // High-reliability WebRTC zero-configuration live room
        const roomCode = `ClaudeClaw-${agentId}-${Date.now().toString(36)}`;
        meetUrl = `https://p2p.mirotalk.com/join/${roomCode}`;
      } else {
        // Fallback for Pika and Recall
        meetUrl = 'https://meet.google.com/new';
      }
    }

    const sessionId = `meet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const session: MeetingSession = {
      id: sessionId,
      provider,
      agentId,
      meetUrl,
      mode,
      autoBrief,
      status: 'live',
      createdAt: Date.now()
    };

    // 2. Persist in local WebUI store
    addMeetingSession(session);

    // 3. Forward to backend bridge on port 3141 if available
    try {
      await fetch('http://127.0.0.1:3141/api/meetings/dispatch?token=earlyaidopters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          agentId,
          meetUrl,
          mode,
          autoBrief
        })
      });
    } catch {}

    return NextResponse.json({ ok: true, session });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
