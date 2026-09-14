import { NextResponse } from 'next/server';
import { getSafetyState, saveSafetyState, SafetySwitchesState } from '@/lib/obsidian';

export async function GET(request: Request) {
  try {
    const safety = getSafetyState();
    return NextResponse.json({ ok: true, safety });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const current = getSafetyState();

    if (body.action === 'emergency_kill') {
      const updated: SafetySwitchesState = {
        llm_spawn: false,
        warroom_text: false,
        voice_standup: false,
        mutations: false,
        auto_assign: false,
        scheduler: false,
        master_kill: true,
      };
      saveSafetyState(updated);
      return NextResponse.json({ ok: true, safety: updated, message: 'EMERGENCY KILL SWITCH ENGAGED' });
    }

    if (body.action === 'restore_all') {
      const updated: SafetySwitchesState = {
        llm_spawn: true,
        warroom_text: true,
        voice_standup: true,
        mutations: true,
        auto_assign: true,
        scheduler: true,
        master_kill: false,
      };
      saveSafetyState(updated);
      return NextResponse.json({ ok: true, safety: updated, message: 'Safety switches restored to nominal' });
    }

    if (body.switchKey) {
      const key = body.switchKey as keyof SafetySwitchesState;
      const updated = {
        ...current,
        [key]: typeof body.value === 'boolean' ? body.value : !current[key],
      };
      // If any switch turned back on, disable master_kill
      if (updated[key] === true && updated.master_kill) {
        updated.master_kill = false;
      }
      saveSafetyState(updated);
      return NextResponse.json({ ok: true, safety: updated });
    }

    return NextResponse.json({ ok: false, error: 'Invalid safety action' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
