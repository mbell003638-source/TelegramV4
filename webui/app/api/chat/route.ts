import { NextResponse } from 'next/server';
import { appendChatToObsidian, saveSessionMessage } from '@/lib/obsidian';
import { BRIDGE_URL, bridgeUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Agent execution for the WebUI goes through ONE path: an HTTP POST to the
 * bridge (`core/MissionControl.js` -> `/api/chat/send`). The WebUI must never
 * spawn a CLI agent itself, because the bridge is where every safety mechanism
 * lives: the LLM_SPAWN_ENABLED kill switch (core/KillSwitches.js), outbound DLP
 * (core/ExfiltrationGuard.js), the security approval gate, AgentPool
 * concurrency, LoopGuard, the audit log, and the shared cross-agent
 * conversation context in core/SessionStore.js.
 *
 * The bridge dispatch is asynchronous: `POST /api/chat/send` accepts
 * `{ message, agentId, model, chatId }` and answers immediately with
 * `{ success: true, agent }` (or a non-2xx `{ ok: false, error }` when a kill
 * switch or the auth token blocks it). The agent's real answer is appended to
 * the bridge's own conversation history once the run finishes, so we poll
 * `GET /api/chat/history?chatId=...` for a genuinely NEW assistant turn.
 *
 * If no real reply ever arrives we return `ok: false` with the actual reason.
 * We never invent a reply, and nothing is written to Obsidian as an agent
 * message unless the agent really produced it.
 */

/** Ceiling for any single bridge HTTP round trip. */
const BRIDGE_REQUEST_TIMEOUT_MS = 15_000;

/** Total time we will wait for the agent's real reply to be recorded. */
const REPLY_TIMEOUT_MS = Number(process.env.WEBUI_AGENT_REPLY_TIMEOUT_MS) || 120_000;

/** Delay between conversation-history polls while waiting for the reply. */
const REPLY_POLL_INTERVAL_MS = 1_200;

type FailureReason =
  | 'bad_request'
  | 'bridge_unreachable'
  | 'bridge_timeout'
  | 'bridge_rejected'
  | 'reply_timeout'
  | 'internal_error';

interface BridgeFailure {
  reason: FailureReason;
  error: string;
  status: number;
}

/** A failure we already fully described (e.g. a non-2xx from the bridge). */
class BridgeError extends Error {
  failure: BridgeFailure;
  constructor(failure: BridgeFailure) {
    super(failure.error);
    this.name = 'BridgeError';
    this.failure = failure;
  }
}

/**
 * Turns a thrown fetch error into a reported reason, keeping a timeout
 * distinct from a connection failure -- they mean very different things:
 * a timeout means the bridge is up but slow/stuck, unreachable means it
 * is not running at all.
 */
function toBridgeFailure(err: unknown, whileDoing: string): BridgeFailure {
  if (err instanceof BridgeError) return err.failure;

  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      reason: 'bridge_timeout',
      error:
        `Timed out after ${Math.round(BRIDGE_REQUEST_TIMEOUT_MS / 1000)}s while trying to ` +
        `${whileDoing}. The agent bridge at ${BRIDGE_URL} accepted the connection but did not respond.`,
      status: 504,
    };
  }

  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
  const detail =
    cause?.code || cause?.message || (err as { message?: string } | null)?.message || String(err);
  return {
    reason: 'bridge_unreachable',
    error:
      `Could not connect to the agent bridge at ${BRIDGE_URL} while trying to ${whileDoing} ` +
      `(${detail}). Start the bridge (node index.js) and retry.`,
    status: 502,
  };
}

function failureResponse(failure: BridgeFailure, sessionId: string) {
  console.error(`[AgenticOS] chat dispatch failed (${failure.reason}): ${failure.error}`);
  return NextResponse.json(
    {
      ok: false,
      reason: failure.reason,
      error: failure.error,
      sessionId,
      // The user's own message is still logged, but no agent reply was.
      savedToObsidian: false,
    },
    { status: failure.status }
  );
}

interface BridgeTurn {
  role?: string;
  content?: string;
  source?: string;
  timestamp?: number;
}

/** Reads the bridge's conversation history for one chat id. */
async function fetchAssistantTurns(chatId: string): Promise<BridgeTurn[]> {
  const res = await fetch(bridgeUrl('/api/chat/history', { chatId }), {
    cache: 'no-store',
    signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new BridgeError({
      reason: 'bridge_rejected',
      error:
        (body && typeof body.error === 'string' && body.error) ||
        `Bridge returned HTTP ${res.status} for /api/chat/history.`,
      status: res.status === 401 || res.status === 403 ? res.status : 502,
    });
  }

  const data = (await res.json()) as { turns?: BridgeTurn[] };
  const turns = Array.isArray(data?.turns) ? data.turns : [];
  return turns.filter(
    (t) => t?.role === 'assistant' && typeof t.content === 'string' && t.content.trim().length > 0
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request) {
  let currentSessionId = '';

  try {
    const body = await req.json().catch(() => null);
    const message: unknown = body?.message;
    const agentId: unknown = body?.agentId;
    const agentName: unknown = body?.agentName;
    const sessionId: unknown = body?.sessionId;
    const model: unknown = body?.model;

    if (typeof message !== 'string' || !message.trim()) {
      return NextResponse.json(
        { ok: false, reason: 'bad_request' satisfies FailureReason, error: 'Message is required' },
        { status: 400 }
      );
    }

    currentSessionId = typeof sessionId === 'string' && sessionId ? sessionId : `session_${Date.now()}`;
    const agentKey = typeof agentId === 'string' && agentId ? agentId : 'agent';
    const displayName = typeof agentName === 'string' && agentName ? agentName : agentKey;

    // 1. Log the user's own message. This is real, user-authored content.
    appendChatToObsidian(displayName, 'user', message);
    saveSessionMessage(agentKey, currentSessionId, 'user', message, 'You');

    // 2. Snapshot the bridge's history BEFORE dispatching so a genuinely new
    //    assistant turn can be told apart from an older one in this session.
    //    This also proves the bridge is reachable before we claim anything.
    let baselineReplyCount: number;
    try {
      baselineReplyCount = (await fetchAssistantTurns(currentSessionId)).length;
    } catch (err) {
      return failureResponse(toBridgeFailure(err, 'read the conversation history'), currentSessionId);
    }

    // 3. Dispatch through the bridge -- the only way an agent is ever run.
    let dispatchedAgent = agentKey;
    try {
      const res = await fetch(bridgeUrl('/api/chat/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          agentId: typeof agentId === 'string' ? agentId : undefined,
          model: typeof model === 'string' ? model : undefined,
          chatId: currentSessionId,
        }),
        signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
      });

      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; ok?: boolean; agent?: string; error?: string }
        | null;

      // The bridge refuses with a non-2xx when the LLM_SPAWN_ENABLED kill
      // switch is active, when the token is wrong, etc. Report its reason.
      if (!res.ok || data?.ok === false || data?.success === false) {
        return failureResponse(
          {
            reason: 'bridge_rejected',
            error:
              (data && typeof data.error === 'string' && data.error) ||
              `Bridge rejected the dispatch with HTTP ${res.status}.`,
            status: res.ok ? 502 : res.status,
          },
          currentSessionId
        );
      }

      if (typeof data?.agent === 'string' && data.agent) dispatchedAgent = data.agent;
    } catch (err) {
      return failureResponse(toBridgeFailure(err, 'dispatch the message'), currentSessionId);
    }

    // 4. Wait for the agent's REAL reply to appear in the bridge history.
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    let reply = '';
    let replyAgent = dispatchedAgent;

    while (Date.now() < deadline) {
      await sleep(REPLY_POLL_INTERVAL_MS);

      let turns: BridgeTurn[];
      try {
        turns = await fetchAssistantTurns(currentSessionId);
      } catch (err) {
        return failureResponse(toBridgeFailure(err, 'read the agent reply'), currentSessionId);
      }

      if (turns.length > baselineReplyCount) {
        const latest = turns[turns.length - 1];
        reply = String(latest.content).trim();
        if (typeof latest.source === 'string' && latest.source) replyAgent = latest.source;
        break;
      }
    }

    if (!reply) {
      return failureResponse(
        {
          reason: 'reply_timeout',
          error:
            `The message was dispatched to "${dispatchedAgent}" through the bridge, but no reply was ` +
            `recorded within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s. The agent may still be working -- ` +
            `check the bridge. No agent reply was written to Obsidian.`,
          status: 504,
        },
        currentSessionId
      );
    }

    // 5. Log the REAL agent reply to Obsidian.
    const replyDisplayName =
      typeof agentName === 'string' && agentName ? agentName : replyAgent;
    appendChatToObsidian(replyDisplayName, 'agent', reply);
    saveSessionMessage(agentKey, currentSessionId, 'agent', reply, replyDisplayName);

    return NextResponse.json({
      ok: true,
      reply,
      sessionId: currentSessionId,
      agent: replyAgent,
      source: 'bridge',
      timestamp: Date.now(),
      savedToObsidian: true,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[AgenticOS] chat route internal error:', detail);
    return NextResponse.json(
      {
        ok: false,
        reason: 'internal_error' satisfies FailureReason,
        error: detail,
        sessionId: currentSessionId,
        savedToObsidian: false,
      },
      { status: 500 }
    );
  }
}
