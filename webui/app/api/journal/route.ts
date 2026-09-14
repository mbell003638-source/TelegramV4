import { NextResponse } from 'next/server';
import { readJournalFromObsidian, writeJournalToObsidian } from '@/lib/obsidian';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const entry = readJournalFromObsidian(date);
  return NextResponse.json({ ok: true, entry });
}

export async function POST(req: Request) {
  try {
    const entry = await req.json();
    const success = writeJournalToObsidian(entry);
    return NextResponse.json({ ok: success });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
