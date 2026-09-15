package com.agentos.client.net

/**
 * Data shapes for the Agent OS gateway, derived from core/MissionControl.js and
 * core/RouterRoutes.js. Every field is optional-tolerant: the gateway is under
 * active development, so a missing or differently-typed field must degrade to a
 * default rather than crash the app.
 */

/** Base URL + dashboard token. Held by the ViewModel, read by GatewayClient. */
data class GatewayConfig(
    val baseUrl: String,
    val token: String,
    val chatId: String = "dashboard_chat",
) {
    val isConfigured: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
}

/** How a request failed. Drives the wording the user sees. */
enum class FailureKind {
    /** TCP refused / no route / DNS failure — nothing is listening there. */
    Unreachable,

    /** Connected, but no answer inside the timeout. */
    Timeout,

    /** HTTP 401 — the dashboard token was rejected. */
    Unauthorized,

    /** Any other non-2xx status. */
    HttpStatus,

    /** 2xx, but the body was not the JSON this client expects. */
    BadResponse,

    /** Base URL or token not set yet. */
    NotConfigured,

    Unknown,
}

/**
 * The single error type every GatewayClient call throws.
 * `message` is already safe to display: it never contains the token.
 */
class GatewayException(
    val kind: FailureKind,
    override val message: String,
) : Exception(message)

/** GET /api/info */
data class GatewayInfo(
    val status: String,
    val version: String,
    val botName: String,
    val activeAgent: String,
    val model: String,
    val isProcessing: Boolean,
    val uptimeSeconds: Long,
    val turns: Int,
    val contextPct: Int,
)

/** One entry of the `agents` array from GET /api/agents. */
data class AgentSummary(
    val id: String,
    val name: String,
    val emoji: String,
    val status: String,
    val active: Boolean,
    val running: Boolean,
    val model: String,
    val todayTurns: Int,
    val availableModels: List<String>,
    val description: String,
)

/** GET /api/agents */
data class AgentsSnapshot(
    val agents: List<AgentSummary>,
    val activeAgent: String,
)

/** One value of the `overrides` map from GET /api/agents/override. */
data class AgentOverride(
    val agentKey: String,
    val supported: Boolean,
    val enabled: Boolean,
    val providerId: String?,
    val model: String?,
    val baseUrl: String?,
    /** Already masked by the server (first 7 + "..." + last 4). */
    val maskedApiKey: String?,
    val hasApiKey: Boolean,
    val updatedAt: Long?,
)

/** An agent row joined with its override state — what the Agents screen shows. */
data class AgentRow(
    val agent: AgentSummary,
    val override: AgentOverride?,
) {
    /** An agent absent from AGENT_ENV_MAP server-side cannot be toggled. */
    val toggleable: Boolean get() = override?.supported ?: false
    val overrideOn: Boolean get() = override?.enabled ?: false

    /**
     * The model actually in force: the override's model when the toggle is on,
     * otherwise the agent's own session model.
     */
    val effectiveModel: String
        get() = if (overrideOn) {
            override?.model?.takeIf { it.isNotBlank() } ?: "router default"
        } else {
            agent.model
        }
}

enum class ChatRole { User, Assistant, System, Error }

data class ChatMessage(
    val role: ChatRole,
    val text: String,
    val source: String = "",
    val timestampMs: Long = System.currentTimeMillis(),
)

/** One decoded Server-Sent Event from GET /api/chat/stream. */
data class StreamEvent(
    /** The SSE `event:` name, e.g. "assistant_message". */
    val name: String,
    /** The raw `data:` payload, still JSON text. */
    val data: String,
)

/** GET /api/devices/remote */
data class RemoteLayout(
    val keys: List<String>,
    val tvApps: List<DeviceApp>,
    val phoneApps: List<DeviceApp>,
)

data class DeviceApp(
    val id: String,
    val name: String,
    val packageName: String,
    val emoji: String,
)

/** GET /api/devices */
data class DevicesSnapshot(
    val adbInstalled: Boolean,
    val devices: List<AdbDevice>,
    val selectedDevice: String?,
)

data class AdbDevice(
    val serial: String,
    val status: String,
    val model: String,
    val product: String,
    val isOnline: Boolean,
)

/** One hit from GET /api/memories/search. */
data class MemoryHit(
    val id: Long,
    val chatId: String,
    val agentId: String,
    val source: String,
    val text: String,
    val summary: String,
    val snippet: String,
    val importance: Double,
    val salience: Double,
    val createdAt: Long,
    val score: Double,
)

data class MemorySearchResult(
    val query: String,
    val hits: List<MemoryHit>,
    /** `stats.indexed` — how many memories the index holds. */
    val indexed: Int,
    /** `stats.mode` — "fts" or the LIKE fallback. */
    val mode: String,
)
