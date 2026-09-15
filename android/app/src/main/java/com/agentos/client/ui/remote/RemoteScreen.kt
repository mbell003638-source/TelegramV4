package com.agentos.client.ui.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentos.client.net.DeviceApp
import com.agentos.client.net.RemoteLayout
import com.agentos.client.net.dataOrNull
import com.agentos.client.ui.components.BannerTone
import com.agentos.client.ui.components.KeyValueRow
import com.agentos.client.ui.components.SectionCard
import com.agentos.client.ui.components.StatusBanner
import com.agentos.client.ui.components.UiStateBox
import com.agentos.client.ui.theme.AccentBlue
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.TextMuted

/**
 * Remote control for a phone or a TV.
 *
 * A TV has no touchscreen, so tap/swipe are useless on one — this screen is
 * built around the named remote keys the gateway advertises at
 * GET /api/devices/remote. A TV is also a NETWORK device with no USB cable, so
 * the connect field dials it with `adb connect <host>:<port>` before any key
 * will reach it.
 */
@Composable
fun RemoteScreen(viewModel: RemoteViewModel) {
    val layout by viewModel.layout.collectAsState()
    val devices by viewModel.devices.collectAsState()
    val action by viewModel.action.collectAsState()
    val host by viewModel.host.collectAsState()
    val port by viewModel.port.collectAsState()
    val serial by viewModel.serial.collectAsState()

    LaunchedEffect(Unit) { viewModel.start() }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // --- Result of the last action -------------------------------------
        item {
            when (val a = action) {
                is com.agentos.client.net.UiState.Error ->
                    StatusBanner(a.message, BannerTone.Bad)
                is com.agentos.client.net.UiState.Success ->
                    StatusBanner("${a.data.label}: ${a.data.output.ifBlank { "ok" }}", BannerTone.Ok)
                else -> Spacer(Modifier.height(0.dp))
            }
        }

        // --- Dial a networked TV -------------------------------------------
        item {
            SectionCard(
                title = "Network device",
                subtitle = "Android TV and Google TV have no USB cable — dial them first",
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = host,
                        onValueChange = viewModel::onHostChange,
                        label = { Text("TV IP address") },
                        placeholder = { Text("192.168.1.50") },
                        singleLine = true,
                        modifier = Modifier.weight(2f),
                    )
                    OutlinedTextField(
                        value = port,
                        onValueChange = viewModel::onPortChange,
                        label = { Text("Port") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = viewModel::connectTv,
                        colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                    ) { Text("Connect") }
                    OutlinedButton(onClick = viewModel::disconnectTv) { Text("Disconnect") }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    "Enable Network debugging on the TV: Settings › Developer options.",
                    color = TextMuted,
                    fontSize = 11.sp,
                )
            }
        }

        // --- Pick which attached device the keys go to ---------------------
        item {
            SectionCard(title = "Target device") {
                UiStateBox(
                    state = devices,
                    idleMessage = "No device scan yet.",
                    loadingMessage = "Looking for devices…",
                    onRetry = viewModel::loadDevices,
                ) { snap ->
                    if (!snap.adbInstalled) {
                        StatusBanner(
                            "adb is not installed on the gateway machine, so no device can be driven.",
                            BannerTone.Warn,
                        )
                    } else if (snap.devices.isEmpty()) {
                        Text("No devices attached or connected.", color = TextMuted, fontSize = 13.sp)
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            snap.devices.forEach { device ->
                                FilterChip(
                                    selected = serial == device.serial,
                                    onClick = { viewModel.selectSerial(device.serial) },
                                    enabled = device.isOnline,
                                    label = {
                                        Text(
                                            listOf(device.model, device.serial)
                                                .filter { it.isNotBlank() }
                                                .joinToString(" · ")
                                                .ifBlank { device.serial },
                                            fontFamily = FontFamily.Monospace,
                                            fontSize = 12.sp,
                                        )
                                    },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    KeyValueRow("Selected", serial.ifBlank { snap.selectedDevice ?: "(gateway default)" }, mono = true)
                }
            }
        }

        // --- The remote itself ---------------------------------------------
        item {
            SectionCard(
                title = "Remote",
                subtitle = "Keys come from the gateway, not hardcoded here",
                trailing = { TextButton(onClick = viewModel::loadLayout) { Text("Reload") } },
            ) {
                UiStateBox(
                    state = layout,
                    idleMessage = "No remote layout loaded.",
                    loadingMessage = "Loading remote…",
                    onRetry = viewModel::loadLayout,
                ) { l ->
                    DPad(l, viewModel::pressKey)
                    Spacer(Modifier.height(14.dp))
                    OtherKeys(l, viewModel::pressKey)
                }
            }
        }

        // --- One-tap apps ---------------------------------------------------
        val loaded: RemoteLayout? = layout.dataOrNull()
        if (loaded != null && (loaded.tvApps.isNotEmpty() || loaded.phoneApps.isNotEmpty())) {
            item {
                SectionCard(title = "Launch an app") {
                    AppGrid(loaded.tvApps, "TV", viewModel::launchApp)
                    if (loaded.phoneApps.isNotEmpty()) {
                        Spacer(Modifier.height(12.dp))
                        AppGrid(loaded.phoneApps, "Phone", viewModel::launchApp)
                    }
                }
            }
        }
    }
}

/** The five keys people reach for most, laid out the way a real remote is. */
@Composable
private fun DPad(layout: RemoteLayout, press: (String) -> Unit) {
    val has = { key: String -> layout.keys.contains(key) }
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (has("up")) KeyButton("▲", "up", press)
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (has("left")) KeyButton("◀", "left", press)
            if (has("ok")) KeyButton("OK", "ok", press, wide = true)
            if (has("right")) KeyButton("▶", "right", press)
        }
        if (has("down")) KeyButton("▼", "down", press)
    }
}

/** Everything else the gateway advertised, minus the keys already in the D-pad. */
@Composable
private fun OtherKeys(layout: RemoteLayout, press: (String) -> Unit) {
    val inPad = setOf("up", "down", "left", "right", "ok")
    val rest = layout.keys.filterNot { inPad.contains(it) }
    if (rest.isEmpty()) return

    Text("All keys", color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    Spacer(Modifier.height(6.dp))
    // A fixed height keeps this grid from fighting the outer LazyColumn for
    // vertical space, which would throw an infinite-constraints error.
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 104.dp),
        modifier = Modifier.fillMaxWidth().height(((rest.size / 3 + 1) * 52).dp.coerceAtMost(320.dp)),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(rest) { key ->
            OutlinedButton(onClick = { press(key) }, modifier = Modifier.fillMaxWidth()) {
                Text(key.replace('_', ' '), fontSize = 11.sp, maxLines = 1)
            }
        }
    }
}

@Composable
private fun KeyButton(glyph: String, key: String, press: (String) -> Unit, wide: Boolean = false) {
    Button(
        onClick = { press(key) },
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (wide) AccentBlue else SurfaceRaised,
        ),
        modifier = if (wide) Modifier.width(88.dp).height(56.dp) else Modifier.size(56.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
    ) {
        Text(glyph, fontSize = if (wide) 15.sp else 18.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun AppGrid(apps: List<DeviceApp>, label: String, launch: (String, String) -> Unit) {
    Text(label, color = TextMuted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    Spacer(Modifier.height(6.dp))
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 96.dp),
        modifier = Modifier.fillMaxWidth().height(((apps.size / 3 + 1) * 60).dp.coerceAtMost(260.dp)),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(apps) { app ->
            OutlinedButton(
                onClick = { launch(app.name, app.packageName) },
                modifier = Modifier.fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(6.dp),
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(app.emoji, fontSize = 16.sp)
                    Text(app.name, fontSize = 10.sp, maxLines = 1)
                }
            }
        }
    }
}
