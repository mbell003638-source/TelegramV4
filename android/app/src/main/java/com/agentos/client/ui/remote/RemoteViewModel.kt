package com.agentos.client.ui.remote

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentos.client.data.SettingsRepository
import com.agentos.client.net.DevicesSnapshot
import com.agentos.client.net.FailureKind
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.RemoteLayout
import com.agentos.client.net.UiState
import com.agentos.client.net.asErrorState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the last POST /api/devices/action actually did, and what adb said back. */
data class RemoteActionResult(
    /** e.g. `remote key "ok"` — what was pressed, in words. */
    val label: String,
    /** The gateway's `result`, verbatim. Never a made-up confirmation. */
    val output: String,
)

/**
 * Remote tab.
 *
 * The pad is NOT hard-coded. `GET /api/devices/remote` returns the key names
 * the gateway's DeviceAutomation actually supports (plus its TV and phone app
 * lists), and every button on the screen is built from that response — so a
 * gateway that gains or loses a key changes this screen with no app update.
 *
 * Presses are `POST /api/devices/action {action:"remote", key:"<name>"}`.
 * A networked Android TV is dialled first with
 * `POST /api/devices/action {action:"connect", host, port}` — adb over TCP —
 * because a TV is not plugged into the gateway by USB.
 */
class RemoteViewModel(
    private val gateway: GatewayClient,
    private val settings: SettingsRepository,
) : ViewModel() {

    private val _layout = MutableStateFlow<UiState<RemoteLayout>>(UiState.Idle)
    val layout: StateFlow<UiState<RemoteLayout>> = _layout.asStateFlow()

    private val _devices = MutableStateFlow<UiState<DevicesSnapshot>>(UiState.Idle)
    val devices: StateFlow<UiState<DevicesSnapshot>> = _devices.asStateFlow()

    /** adb-over-TCP target for a TV. Persisted so it survives a restart. */
    private val _host = MutableStateFlow("")
    val host: StateFlow<String> = _host.asStateFlow()

    private val _port = MutableStateFlow(GatewayClient.DEFAULT_ADB_PORT.toString())
    val port: StateFlow<String> = _port.asStateFlow()

    /** `adb -s <serial>`. Blank = let the gateway use whatever it selected. */
    private val _serial = MutableStateFlow("")
    val serial: StateFlow<String> = _serial.asStateFlow()

    private val _action = MutableStateFlow<UiState<RemoteActionResult>>(UiState.Idle)
    val action: StateFlow<UiState<RemoteActionResult>> = _action.asStateFlow()

    init {
        viewModelScope.launch {
            val stored = settings.current()
            _host.value = stored.tvHost
            _port.value = stored.tvPort.toString()
            _serial.value = stored.deviceSerial
        }
    }

    /** Called when the tab first appears. Idempotent. */
    fun start() {
        if (_layout.value is UiState.Idle) loadLayout()
        if (_devices.value is UiState.Idle) loadDevices()
    }

    fun refresh() {
        loadLayout()
        loadDevices()
    }

    /** GET /api/devices/remote */
    fun loadLayout() {
        _layout.value = UiState.Loading
        viewModelScope.launch {
            _layout.value = try {
                UiState.Success(gateway.fetchRemoteLayout())
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                asErrorState(t)
            }
        }
    }

    /** GET /api/devices */
    fun loadDevices() {
        _devices.value = UiState.Loading
        viewModelScope.launch {
            try {
                val snapshot = gateway.fetchDevices()
                _devices.value = UiState.Success(snapshot)
                // Adopt the gateway's own selection only if we have none.
                if (_serial.value.isBlank() && !snapshot.selectedDevice.isNullOrBlank()) {
                    _serial.value = snapshot.selectedDevice
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                _devices.value = asErrorState(t)
            }
        }
    }

    fun onHostChange(value: String) {
        _host.value = value
    }

    fun onPortChange(value: String) {
        // Digits only; an empty field is allowed while typing.
        _port.value = value.filter { it.isDigit() }.take(5)
    }

    fun selectSerial(value: String) {
        _serial.value = value
        viewModelScope.launch { settings.saveDeviceSerial(value) }
    }

    // --------------------------------------------------------- the actions

    /** POST /api/devices/action `{action:"connect", host, port}`. */
    fun connectTv() {
        val hostValue = _host.value.trim()
        if (hostValue.isEmpty()) {
            _action.value = UiState.Error(
                "Enter the TV's IP address first, e.g. 192.168.1.42.",
                FailureKind.NotConfigured,
            )
            return
        }
        val portValue = parsedPort() ?: return
        run("connect to $hostValue:$portValue") {
            val result = gateway.connectDevice(hostValue, portValue)
            settings.saveRemoteTarget(hostValue, portValue)
            // A new device only appears in the list after adb re-scans.
            loadDevices()
            result
        }
    }

    /** POST /api/devices/action `{action:"disconnect", host, port}`. */
    fun disconnectTv() {
        val hostValue = _host.value.trim()
        if (hostValue.isEmpty()) {
            _action.value = UiState.Error(
                "Enter the TV's IP address first.",
                FailureKind.NotConfigured,
            )
            return
        }
        val portValue = parsedPort() ?: return
        run("disconnect $hostValue:$portValue") {
            val result = gateway.disconnectDevice(hostValue, portValue)
            loadDevices()
            result
        }
    }

    /** POST /api/devices/action `{action:"remote", key:"<name>"[, serial]}`. */
    fun pressKey(key: String) {
        run("remote key \"$key\"") {
            gateway.pressRemoteKey(key, _serial.value.takeIf { it.isNotBlank() })
        }
    }

    /** POST /api/devices/action `{action:"launch", package:"<pkg>"[, serial]}`. */
    fun launchApp(appName: String, packageName: String) {
        if (packageName.isBlank()) {
            _action.value = UiState.Error(
                "The gateway listed \"$appName\" without a package name, so it cannot be launched.",
                FailureKind.BadResponse,
            )
            return
        }
        run("launch $appName ($packageName)") {
            gateway.launchApp(packageName, _serial.value.takeIf { it.isNotBlank() })
        }
    }

    fun dismissAction() {
        _action.value = UiState.Idle
    }

    private fun parsedPort(): Int? {
        val value = _port.value.trim().toIntOrNull()
        if (value == null || value !in 1..65535) {
            _action.value = UiState.Error(
                "\"${_port.value}\" is not a usable TCP port. adb over TCP is normally " +
                    "${GatewayClient.DEFAULT_ADB_PORT}.",
                FailureKind.NotConfigured,
            )
            return null
        }
        return value
    }

    /** One place where every device action gets its Loading / Success / Error. */
    private fun run(label: String, block: suspend () -> String) {
        _action.value = UiState.Loading
        viewModelScope.launch {
            _action.value = try {
                UiState.Success(RemoteActionResult(label = label, output = block()))
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                val state = asErrorState(t)
                UiState.Error("$label failed — ${state.message}", state.kind)
            }
        }
    }
}
