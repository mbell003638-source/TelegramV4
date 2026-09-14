import { NextResponse } from 'next/server';
import { removeMeetingSession } from '@/lib/meetings';
import { bridgeUrl } from '@/lib/config';

export async function DELETE(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const sessionId = params.sessionId;
    const removed = removeMeetingSession(sessionId);

    // Also forward to telegram bridge if active
    try {
      await fetch(bridgeUrl(`/api/meetings/${encodeURIComponent(sessionId)}`), {
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
