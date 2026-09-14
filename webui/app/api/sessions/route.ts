import { NextResponse } from 'next/server';
import { listAgentSessions, getSessionMessages, deleteSession } from '@/lib/obsidian';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');
    const sessionId = searchParams.get('sessionId');

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'agentId is required' }, { status: 400 });
    }

    if (sessionId) {
      const messages = getSessionMessages(agentId, sessionId);
      return NextResponse.json({ ok: true, sessionId, messages });
    }

    const sessions = listAgentSessions(agentId);
    return NextResponse.json({ ok: true, sessions });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const agentId = searchParams.get('agentId');
    const sessionId = searchParams.get('sessionId');

    if (!agentId || !sessionId) {
      return NextResponse.json({ ok: false, error: 'agentId and sessionId are required' }, { status: 400 });
    }

    const deleted = deleteSession(agentId, sessionId);
    return NextResponse.json({ ok: true, deleted });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
