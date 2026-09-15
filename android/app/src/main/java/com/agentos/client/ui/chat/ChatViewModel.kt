package com.agentos.client.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentos.client.data.SettingsRepository
import com.agentos.client.net.AgentSummary
import com.agentos.client.net.ChatMessage
import com.agentos.client.net.ChatRole
import com.agentos.client.net.FailureKind
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.StreamEvent
import com.agentos.client.net.UiState
import com.agentos.client.net.asErrorState
import com.agentos.client.net.scrubSecrets
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject

/**
 * Chat tab.
 *
 * The important thing about this screen, and the reason it is not a simple
 * request/response form: **POST /api/chat/send does not return a reply.**
 * MissionControl enqueues the turn on the ActionExecutor and answers
 * `{success:true, agent}` straight away; the assistant's actual words are
 * broadcast later to every SSE client as `assistant_message`.
 *
 * So this ViewModel does two things at once:
 *  - POST /api/chat/send  — hands the turn over, and reports only that.
 *  - GET  /api/chat/stream — the live subscription the reply arrives on.
 *
 * If the stream is not connected, no reply can ever appear, and [stream] says
 * so on the screen rather than leaving an empty transcript that looks like a
 * silent agent.
 */
class ChatViewModel(
    private val gateway: GatewayClient,
    private val settings: SettingsRepository,
) : ViewModel() {

    private val _agents = MutableStateFlow<UiState<List<AgentSummary>>>(UiState.Idle)
    val agents: StateFlow<UiState<List<AgentSummary>>> = _agents.asStateFlow()

    /** Blank means "let the gateway route to whatever its active agent is". */
    private val _selectedAgent = MutableStateFlow("")
    val selectedAgent: StateFlow<String> = _selectedAgent.asStateFlow()

    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val _draft = MutableStateFlow("")
    val draft: StateFlow<String> = _draft.asStateFlow()

    /** Success carries the agent key the gateway said it routed the turn to. */
    private val _send = MutableStateFlow<UiState<String>>(UiState.Idle)
    val send: StateFlow<UiState<String>> = _send.asStateFlow()

    /** Health of the SSE subscription. Success = the socket is open. */
    private val _stream = MutableStateFlow<UiState<Unit>>(UiState.Idle)
    val stream: StateFlow<UiState<Unit>> = _stream.asStateFlow()

    /** From the gateway's own `processing` events, not from our own guesswork. */
    private val _processing = MutableStateFlow(false)
    val processing: StateFlow<Boolean> = _processing.asStateFlow()

    /** Latest `progress` / tool-call line, or null. */
    private val _progress = MutableStateFlow<String?>(null)
    val progress: StateFlow<String?> = _progress.asStateFlow()

    /** Which conversation bucket on the gateway this phone is joined to. */
    private val _chatId = MutableStateFlow("")
    val chatId: StateFlow<String> = _chatId.asStateFlow()

    private var streamJob: Job? = null

    /**
     * Messages we posted and are waiting to see echoed back as `user_message`.
     * MissionControl re-broadcasts every send to all SSE clients including this
     * one, so without this the user's own line would appear twice.
     */
    private val pendingEchoes = ArrayDeque<String>()

    init {
        viewModelScope.launch {
            val stored = settings.current()
            _selectedAgent.value = stored.lastAgentId
            _chatId.value = stored.chatId
        }
    }

    /** Called when the tab first appears. Idempotent. */
    fun start() {
        if (_agents.value is UiState.Idle) loadAgents()
        if (_stream.value is UiState.Idle) connectStream()
    }

    // ------------------------------------------------------------- the list

    fun loadAgents() {
        _agents.value = UiState.Loading
        viewModelScope.launch {
            try {
                val snapshot = gateway.fetchAgents()
                _agents.value = UiState.Success(snapshot.agents)
                // Only adopt the gateway's active agent if the user has never
                // picked one; never silently override a deliberate choice.
                if (_selectedAgent.value.isBlank() && snapshot.activeAgent.isNotBlank()) {
                    _selectedAgent.value = snapshot.activeAgent
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _agents.value = asErrorState(t)
            }
        }
    }

    fun selectAgent(agentId: String) {
        _selectedAgent.value = agentId
        viewModelScope.launch { settings.saveLastAgent(agentId) }
    }

    fun onDraftChange(value: String) {
        _draft.value = value
    }

    fun clearTranscript() {
        // Local only: this does NOT ask the gateway to forget anything.
        _messages.value = emptyList()
        _send.value = UiState.Idle
        _progress.value = null
    }

    // ------------------------------------------------------------- sending

    /**
     * POST /api/chat/send `{message, chatId, agentId}`.
     *
     * A success here means ONLY that the gateway accepted and queued the turn.
     * It is never rendered as an answer — the answer, if one comes, arrives on
     * the stream as `assistant_message`.
     */
    fun sendMessage() {
        val text = _draft.value.trim()
        if (text.isEmpty() || _send.value is UiState.Loading) return
        val agentId = _selectedAgent.value.takeIf { it.isNotBlank() }

        _draft.value = ""
        _send.value = UiState.Loading
        append(ChatMessage(role = ChatRole.User, text = text, source = "you"))
        pendingEchoes.addLast(text)

        viewModelScope.launch {
            try {
                val routedTo = gateway.sendChat(text, agentId)
                _send.value = UiState.Success(routedTo)
                // The gateway's own `processing` event will confirm this, but
                // setting it now avoids a dead-looking gap before it arrives.
                _processing.value = true
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                pendingEchoes.remove(text)
                val state = asErrorState(t)
                _send.value = state
                append(
                    ChatMessage(
                        role = ChatRole.Error,
                        text = state.message,
                        source = "POST /api/chat/send",
                    ),
                )
            }
        }
    }

    // -------------------------------------------------------------- stream

    /** (Re)open GET /api/chat/stream. Cancels any previous subscription. */
    fun connectStream() {
        streamJob?.cancel()
        _stream.value = UiState.Loading
        streamJob = viewModelScope.launch {
            try {
                gateway.streamEvents().collect { event -> handleEvent(event) }
                // A clean completion still means no more replies will arrive.
                _stream.value = UiState.Error(
                    "The gateway closed the event stream. Replies will not appear until " +
                        "you reconnect.",
                    FailureKind.Unreachable,
                )
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _stream.value = asErrorState(t)
            }
        }
    }

    private fun handleEvent(event: StreamEvent) {
        val data = parseJsonOrNull(event.data)
        when (event.name) {
            GatewayClient.EVENT_STREAM_OPEN -> _stream.value = UiState.Success(Unit)

            "assistant_message" -> {
                _stream.value = UiState.Success(Unit)
                val content = data?.textOf("content") ?: return
                append(
                    ChatMessage(
                        role = ChatRole.Assistant,
                        text = content,
                        source = data.textOf("source") ?: _selectedAgent.value,
                    ),
                )
                _processing.value = false
                _progress.value = null
            }

            "user_message" -> {
                _stream.value = UiState.Success(Unit)
                data?.textOf("content")?.let { onUserEcho(it) }
            }

            "processing" -> {
                _stream.value = UiState.Success(Unit)
                _processing.value = data?.optBoolean("processing", false) ?: false
                if (!_processing.value) _progress.value = null
            }

            "progress" -> {
                _stream.value = UiState.Success(Unit)
                _progress.value = data?.textOf("description")
            }

            "chat.status" -> {
                _stream.value = UiState.Success(Unit)
                data?.textOf("message")?.let { _progress.value = it }
            }

            "chat.tool_call" -> {
                _stream.value = UiState.Success(Unit)
                data?.textOf("toolName")?.let { _progress.value = "Using tool: $it" }
            }

            "chat.warning" -> {
                _stream.value = UiState.Success(Unit)
                val message = data?.textOf("message")
                    ?: "The gateway sent a warning with no detail."
                append(
                    ChatMessage(
                        role = ChatRole.System,
                        text = scrubSecrets(message),
                        source = "gateway",
                    ),
                )
            }

            // MissionControl fires `chat.error` AND `error` for the same
            // failure; `error` is the one carrying readable text, so only it is
            // rendered and `chat.error` is ignored to avoid a doubled entry.
            "error" -> {
                _stream.value = UiState.Success(Unit)
                val content = data?.textOf("content")
                    ?: "The gateway reported an error with no message."
                append(
                    ChatMessage(
                        role = ChatRole.Error,
                        text = scrubSecrets(content),
                        source = data?.textOf("source") ?: "agent",
                    ),
                )
                _processing.value = false
                _progress.value = null
            }

            "agent.switched" -> {
                _stream.value = UiState.Success(Unit)
                data?.textOf("agentId")?.let { switched ->
                    append(
                        ChatMessage(
                            role = ChatRole.System,
                            text = "The gateway switched the active agent to $switched.",
                            source = "gateway",
                        ),
                    )
                }
            }

            // Everything else MissionControl broadcasts (mission.*, device.*,
            // settings.*, warroom.*) belongs to other surfaces; seeing one is
            // still proof the stream is alive.
            else -> _stream.value = UiState.Success(Unit)
        }
    }

    /**
     * Our own send, echoed back by the gateway. Usually identical, so it is
     * dropped — but ExfiltrationGuard rewrites a message containing credentials
     * before any agent sees it, and in that case what the gateway stored is the
     * authoritative version and replaces what we optimistically drew.
     */
    private fun onUserEcho(content: String) {
        val expected = pendingEchoes.removeFirstOrNull()
        if (expected == null) {
            // Not ours — another dashboard client posted into the same chat.
            append(ChatMessage(role = ChatRole.User, text = content, source = "another client"))
            return
        }
        if (expected == content) return

        val list = _messages.value.toMutableList()
        val index = list.indexOfLast { it.role == ChatRole.User }
        if (index < 0) {
            list.add(ChatMessage(role = ChatRole.User, text = content, source = "you"))
        } else {
            list[index] = list[index].copy(
                text = content,
                source = "you (rewritten by the gateway before sending)",
            )
        }
        _messages.value = list
    }

    private fun append(message: ChatMessage) {
        _messages.value = _messages.value + message
    }
}

// ------------------------------------------------------------ json helpers
//
// The SSE payloads are whatever MissionControl.broadcast() serialized. They are
// parsed defensively: a missing field, a differently-typed field or an outright
// unparseable body degrades to null and the event is skipped, never thrown.

private fun parseJsonOrNull(raw: String): JSONObject? = try {
    if (raw.isBlank()) null else JSONObject(raw)
} catch (_: JSONException) {
    null
} catch (_: Throwable) {
    null
}

/** A non-blank string for [key], or null. org.json hands back "null" otherwise. */
private fun JSONObject.textOf(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = opt(key) ?: return null
    return value.toString().takeIf { it.isNotBlank() && it != "null" }
}
