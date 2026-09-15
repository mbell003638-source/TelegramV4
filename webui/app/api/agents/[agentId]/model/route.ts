import { NextRequest, NextResponse } from 'next/server';
import { BRIDGE_URL, bridgeUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Ceiling for the bridge round trip. */
const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Switching an agent's model is bridge state (core/SessionStore.js holds the
 * active model per agent/chat), so the bridge is the only authority here.
 *
 * This route used to answer `{ ok: true, agentId, model, effort }` whenever the
 * bridge call failed, so the UI showed the new model as applied even though
 * nothing had changed. It now reports the bridge's real outcome.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const body = await req.json().catch(() => null);
    const model: unknown = body?.model;
    const effort: unknown = body?.effort;

    if (typeof model !== 'string' || !model.trim()) {
      return NextResponse.json(
        { ok: false, reason: 'bad_request', error: 'Model identifier required' },
        { status: 400 }
      );
    }

    let bridgeRes: Response;
    try {
      bridgeRes = await fetch(bridgeUrl(`/api/agents/${encodeURIComponent(agentId)}/model`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort }),
        signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const name = (err as { name?: string } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      return NextResponse.json(
        {
          ok: false,
          reason: timedOut ? 'bridge_timeout' : 'bridge_unreachable',
          error: timedOut
            ? `Timed out after ${Math.round(BRIDGE_REQUEST_TIMEOUT_MS / 1000)}s waiting for the bridge at ${BRIDGE_URL} to switch the model for "${agentId}".`
            : `Could not reach the agent bridge at ${BRIDGE_URL} to switch the model for "${agentId}". The model was NOT changed.`,
          agentId,
        },
        { status: timedOut ? 504 : 502 }
      );
    }

    const data = (await bridgeRes.json().catch(() => null)) as
      | { ok?: boolean; success?: boolean; error?: string }
      | null;

    if (!bridgeRes.ok || data?.ok === false || data?.success === false) {
      return NextResponse.json(
        {
          ok: false,
          reason: 'bridge_rejected',
          error:
            (data && typeof data.error === 'string' && data.error) ||
            `Bridge rejected the model switch with HTTP ${bridgeRes.status}. The model was NOT changed.`,
          agentId,
        },
        { status: bridgeRes.ok ? 502 : bridgeRes.status }
      );
    }

    return NextResponse.json({ ok: true, agentId, model, effort, data });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, reason: 'internal_error', error: detail }, { status: 500 });
  }
}
