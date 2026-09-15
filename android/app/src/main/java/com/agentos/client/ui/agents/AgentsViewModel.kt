package com.agentos.client.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentos.client.net.AgentOverride
import com.agentos.client.net.AgentRow
import com.agentos.client.net.AgentSummary
import com.agentos.client.net.FailureKind
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.UiState
import com.agentos.client.net.asErrorState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Agents tab.
 *
 * Two independent requests are joined here:
 *  - GET /api/agents           — the agent list (MissionControl)
 *  - GET /api/agents/override  — the per-agent override map (RouterRoutes)
 *
 * The override map is treated as OPTIONAL: RouterRoutes answers 503 when
 * `agentOverrides` is not configured, and in that case the agent list is still
 * shown, with the switches disabled and a banner explaining exactly why. The
 * alternative — failing the whole screen — would hide working information.
 *
 * Every switch is its own request: POST /api/agents/override carries one
 * `agentKey`. There is no global toggle anywhere in this file.
 */
class AgentsViewModel(private val gateway: GatewayClient) : ViewModel() {

    private val _rows = MutableStateFlow<UiState<List<AgentRow>>>(UiState.Idle)
    val rows: StateFlow<UiState<List<AgentRow>>> = _rows.asStateFlow()

    /** Which agent the gateway currently routes un-addressed chat turns to. */
    private val _activeAgent = MutableStateFlow("")
    val activeAgent: StateFlow<String> = _activeAgent.asStateFlow()

    /** Set when the override endpoint is unavailable but the list loaded anyway. */
    private val _overrideNotice = MutableStateFlow<String?>(null)
    val overrideNotice: StateFlow<String?> = _overrideNotice.asStateFlow()

    /** agentKeys with a toggle request in flight. Drives the per-row spinner. */
    private val _pending = MutableStateFlow<Set<String>>(emptySet())
    val pending: StateFlow<Set<String>> = _pending.asStateFlow()

    /** agentKey -> the error its own last toggle produced. Shown on that row. */
    private val _rowErrors = MutableStateFlow<Map<String, String>>(emptyMap())
    val rowErrors: StateFlow<Map<String, String>> = _rowErrors.asStateFlow()

    private var agents: List<AgentSummary> = emptyList()
    private var overrides: Map<String, AgentOverride> = emptyMap()

    fun refresh() {
        _rows.value = UiState.Loading
        _rowErrors.value = emptyMap()
        viewModelScope.launch {
            try {
                val snapshot = gateway.fetchAgents()
                agents = snapshot.agents
                _activeAgent.value = snapshot.activeAgent

                // Optional second call. A failure here is a caveat, not a crash.
                overrides = try {
                    val fetched = gateway.fetchOverrides()
                    _overrideNotice.value = if (fetched.isEmpty()) {
                        "The gateway returned no override entries, so no agent can be " +
                            "re-pointed from here yet."
                    } else {
                        null
                    }
                    fetched
                } catch (ce: CancellationException) {
                    throw ce
                } catch (t: Throwable) {
                    val detail = asErrorState(t).message
                    _overrideNotice.value = "Per-agent overrides are unavailable: $detail " +
                        "The switches below are disabled; the agent list itself is live."
                    emptyMap()
                }

                _rows.value = UiState.Success(joinRows())
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _rows.value = asErrorState(t)
            }
        }
    }

    fun refreshIfIdle() {
        if (_rows.value is UiState.Idle) refresh()
    }

    /**
     * POST /api/agents/override with `{agentKey, enabled}` — exactly one agent.
     *
     * @param model sent as `model` only when switching ON and non-blank; the
     *   gateway then pins that model, otherwise it routes to the OmniRouter's
     *   own default.
     */
    fun setOverride(agentKey: String, enabled: Boolean, model: String? = null) {
        if (agentKey.isBlank() || agentKey in _pending.value) return
        _pending.value = _pending.value + agentKey
        _rowErrors.value = _rowErrors.value - agentKey
        viewModelScope.launch {
            try {
                // The gateway echoes the whole refreshed map back.
                overrides = gateway.setOverride(agentKey, enabled, model)
                _overrideNotice.value = null
                _rows.value = UiState.Success(joinRows())
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                val state = asErrorState(t)
                val prefix = if (state.kind == FailureKind.Unauthorized) "" else "Toggle failed — "
                _rowErrors.value = _rowErrors.value + (agentKey to prefix + state.message)
            } finally {
                _pending.value = _pending.value - agentKey
            }
        }
    }

    /** Re-post with the same enabled=true and a different model. */
    fun selectModel(agentKey: String, model: String) {
        setOverride(agentKey, enabled = true, model = model)
    }

    fun dismissRowError(agentKey: String) {
        _rowErrors.value = _rowErrors.value - agentKey
    }

    private fun joinRows(): List<AgentRow> =
        agents.map { agent -> AgentRow(agent = agent, override = overrides[agent.id]) }
}
