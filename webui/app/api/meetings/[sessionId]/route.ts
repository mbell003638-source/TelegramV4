import { NextResponse } from 'next/server';
import { removeMeetingSession } from '@/lib/meetings';

export async function DELETE(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const sessionId = params.sessionId;
    const removed = removeMeetingSession(sessionId);

    // Also forward to telegram bridge if active
    try {
      await fetch(`http://127.0.0.1:3141/api/meetings/${encodeURIComponent(sessionId)}?token=earlyaidopters`, {
        method: 'DELETE'
      });
    } catch {}

    if (removed) {
      return NextResponse.json({ ok: true, message: 'Meeting session removed' });
    } else {
      return NextResponse.json({ ok: true, message: 'Meeting session marked closed' });
    }
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
