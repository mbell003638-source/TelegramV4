import { NextResponse } from 'next/server';
import { getMeetingSessions, clearMeetingSessions } from '@/lib/meetings';
import { bridgeUrl } from '@/lib/config';

export async function GET() {
  try {
    const sessions = getMeetingSessions();
    return NextResponse.json({ ok: true, sessions });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearMeetingSessions();
    // Also try to clear in telegram bridge if running
    try {
      await fetch(bridgeUrl('/api/meetings'), {
        method: 'DELETE'
      });
    } catch {}
    return NextResponse.json({ ok: true, message: 'All meeting sessions cleared' });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
