package com.agentos.client.ui.connect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentos.client.data.SettingsRepository
import com.agentos.client.data.StoredSettings
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.GatewayConfig
import com.agentos.client.net.GatewayInfo
import com.agentos.client.net.UiState
import com.agentos.client.net.asErrorState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the user has typed. [token] is a secret and is never logged. */
data class ConnectForm(
    val baseUrl: String = "",
    val token: String = "",
    val chatId: String = StoredSettings.DEFAULT_CHAT_ID,
) {
    val canTest: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()

    /** Never print the token, not even by accident. */
    override fun toString(): String = "ConnectForm(baseUrl=$baseUrl, token=***, chatId=$chatId)"
}

/**
 * Connect tab: gateway URL + dashboard token, verified against GET /api/info.
 *
 * The typed token is only persisted once /api/info has actually accepted it
 * (or when the user explicitly taps Save anyway), so a typo never silently
 * becomes the stored credential.
 */
class ConnectViewModel(
    private val gateway: GatewayClient,
    private val settings: SettingsRepository,
) : ViewModel() {

    private val _form = MutableStateFlow(ConnectForm())
    val form: StateFlow<ConnectForm> = _form.asStateFlow()

    private val _test = MutableStateFlow<UiState<GatewayInfo>>(UiState.Idle)
    val test: StateFlow<UiState<GatewayInfo>> = _test.asStateFlow()

    /** Transient confirmation line under the buttons. Contains no secret. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /** "set (48 characters)" / "not set" — the length only, never the value. */
    private val _storedTokenHint = MutableStateFlow("not set")
    val storedTokenHint: StateFlow<String> = _storedTokenHint.asStateFlow()

    init {
        viewModelScope.launch {
            val stored = settings.current()
            _form.value = ConnectForm(
                baseUrl = stored.baseUrl,
                token = stored.token,
                chatId = stored.chatId,
            )
            _storedTokenHint.value = stored.tokenHint
        }
    }

    fun onBaseUrlChange(value: String) {
        _form.value = _form.value.copy(baseUrl = value)
        _notice.value = null
    }

    fun onTokenChange(value: String) {
        _form.value = _form.value.copy(token = value)
        _notice.value = null
    }

    fun onChatIdChange(value: String) {
        _form.value = _form.value.copy(chatId = value)
        _notice.value = null
    }

    /** GET /api/info with the typed values; persists them only on success. */
    fun testConnection() {
        val snapshot = _form.value
        _test.value = UiState.Loading
        _notice.value = null
        viewModelScope.launch {
            try {
                val info = gateway.fetchInfo(
                    probe = GatewayConfig(
                        baseUrl = snapshot.baseUrl,
                        token = snapshot.token,
                        chatId = snapshot.chatId.ifBlank { StoredSettings.DEFAULT_CHAT_ID },
                    ),
                )
                persist(snapshot)
                _test.value = UiState.Success(info)
                _notice.value = "Connected, and these settings are now saved. " +
                    "Every other tab uses them."
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                // Nothing is saved on failure, and the message shown is the real
                // one (already token-free — see Redaction.safeEndpointLabel).
                _test.value = asErrorState(t)
            }
        }
    }

    /** Persist without testing, for when the gateway is not up yet. */
    fun saveWithoutTesting() {
        val snapshot = _form.value
        viewModelScope.launch {
            persist(snapshot)
            _notice.value = "Saved without testing. Nothing has verified the token yet."
        }
    }

    fun clearToken() {
        viewModelScope.launch {
            settings.clearToken()
            _form.value = _form.value.copy(token = "")
            _storedTokenHint.value = "not set"
            _test.value = UiState.Idle
            _notice.value = "Token cleared from this device."
            gateway.updateConfig(settings.current().toConfig())
        }
    }

    private suspend fun persist(snapshot: ConnectForm) {
        settings.saveConnection(
            baseUrl = snapshot.baseUrl,
            token = snapshot.token,
            chatId = snapshot.chatId,
        )
        val stored = settings.current()
        _storedTokenHint.value = stored.tokenHint
        // AppGraph also observes the settings flow; doing it here too means the
        // very next request on any tab cannot race the collector.
        gateway.updateConfig(stored.toConfig())
        _form.value = snapshot.copy(baseUrl = GatewayClient.normalizeBaseUrl(snapshot.baseUrl))
    }
}
