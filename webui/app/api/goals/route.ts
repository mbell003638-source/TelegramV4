import { NextResponse } from 'next/server';
import { readGoalsFromObsidian, writeGoalsToObsidian } from '@/lib/obsidian';

export async function GET() {
  const goals = readGoalsFromObsidian();
  return NextResponse.json({ ok: true, goals });
}

export async function POST(req: Request) {
  try {
    const { goals } = await req.json();
    const success = writeGoalsToObsidian(goals);
    return NextResponse.json({ ok: success });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
