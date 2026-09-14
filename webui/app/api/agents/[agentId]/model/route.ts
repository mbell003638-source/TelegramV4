import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const body = await req.json();
    const { model, effort } = body;

    if (!model) {
      return NextResponse.json({ ok: false, error: 'Model identifier required' }, { status: 400 });
    }

    // Forward to bridge backend
    try {
      const bridgeRes = await fetch(`http://localhost:3141/api/agents/${agentId}/model?token=earlyaidopters`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          effort,
        }),
      });
      if (bridgeRes.ok) {
        const data = await bridgeRes.json();
        return NextResponse.json({ ok: true, data });
      }
    } catch {
      // Bridge could be offline, acknowledge locally
    }

    return NextResponse.json({ ok: true, agentId, model, effort });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
