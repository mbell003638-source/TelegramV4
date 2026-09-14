import { NextResponse } from 'next/server';
import { scanLocalAgents } from '@/lib/agents';
import { bridgeUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const localAgents = scanLocalAgents();

    // Query local bridge for dynamic runtime models and telemetry
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(bridgeUrl('/api/agents'), {
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const bridgeData = await res.json();
        const bridgeAgents = bridgeData.agents || [];

        const merged = localAgents.map(localAgent => {
          const remote = bridgeAgents.find((a: any) => a.id === localAgent.id);
          if (!remote) return localAgent;

          // Merge available models from bridge if present
          let mergedModels = localAgent.availableModels;
          if (Array.isArray(remote.availableModels) && remote.availableModels.length > 0) {
            // Map remote models to our rich format
            mergedModels = remote.availableModels;
          }

          return {
            ...localAgent,
            status: remote.status === 'live' ? 'live' : localAgent.status,
            model: remote.model && remote.model !== 'default' ? remote.model : localAgent.model,
            availableModels: mergedModels,
            reasoningEfforts: remote.reasoningEfforts || localAgent.reasoningEfforts,
            activeEffort: remote.activeEffort || localAgent.activeEffort,
          };
        });

        return NextResponse.json({ ok: true, agents: merged });
      }
    } catch {
      // Bridge call timed out or failed; return local agents
    }

    return NextResponse.json({ ok: true, agents: localAgents });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
