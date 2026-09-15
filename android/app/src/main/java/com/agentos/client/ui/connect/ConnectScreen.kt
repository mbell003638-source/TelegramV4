package com.agentos.client.ui.connect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.UiState
import com.agentos.client.ui.components.BannerTone
import com.agentos.client.ui.components.KeyValueRow
import com.agentos.client.ui.components.SectionCard
import com.agentos.client.ui.components.StatusBanner
import com.agentos.client.ui.components.UiStateBox
import com.agentos.client.ui.components.formatUptime
import com.agentos.client.ui.theme.TextMuted

/**
 * Connect tab. Two fields, one button, and the gateway's literal answer.
 *
 * The token field is masked by default and is only ever revealed by an explicit
 * tap; nothing on this screen writes it anywhere but DataStore.
 */
@Composable
fun ConnectScreen(viewModel: ConnectViewModel, modifier: Modifier = Modifier) {
    val form by viewModel.form.collectAsState()
    val test by viewModel.test.collectAsState()
    val notice by viewModel.notice.collectAsState()
    val storedHint by viewModel.storedTokenHint.collectAsState()

    var tokenVisible by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        SectionCard(
            title = "Gateway",
            subtitle = "Where Mission Control is listening",
        ) {
            OutlinedTextField(
                value = form.baseUrl,
                onValueChange = viewModel::onBaseUrlChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Base URL") },
                placeholder = { Text("http://192.168.1.50:${GatewayClient.DEFAULT_GATEWAY_PORT}") },
                supportingText = {
                    Text(
                        "A bare host:port works too — http:// is added for you. " +
                            "Use https:// for anything off your LAN.",
                    )
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )

            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = form.token,
                onValueChange = viewModel::onTokenChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Dashboard token") },
                visualTransformation = if (tokenVisible) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                trailingIcon = {
                    TextButton(onClick = { tokenVisible = !tokenVisible }) {
                        Text(if (tokenVisible) "Hide" else "Show")
                    }
                },
                supportingText = {
                    Text("DASHBOARD_TOKEN from the gateway's .env. Stored on this device: $storedHint")
                },
            )

            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = form.chatId,
                onValueChange = viewModel::onChatIdChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Chat ID") },
                supportingText = {
                    Text("Which conversation on the gateway this phone joins. Leave as-is unless you know otherwise.")
                },
            )

            Spacer(Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = viewModel::testConnection,
                    enabled = form.canTest && test !is UiState.Loading,
                ) {
                    if (test is UiState.Loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.size(10.dp))
                    }
                    Text("Test connection")
                }
                OutlinedButton(
                    onClick = viewModel::saveWithoutTesting,
                    enabled = test !is UiState.Loading,
                ) {
                    Text("Save only")
                }
            }

            if (!form.canTest) {
                Spacer(Modifier.height(8.dp))
                StatusBanner(
                    text = "Both a URL and a token are required before anything can be tested.",
                    tone = BannerTone.Warn,
                )
            }

            val currentNotice = notice
            if (currentNotice != null) {
                Spacer(Modifier.height(8.dp))
                StatusBanner(
                    text = currentNotice,
                    tone = if (test is UiState.Success) BannerTone.Ok else BannerTone.Warn,
                )
            }

            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = viewModel::clearToken) {
                Text("Forget the token on this device")
            }
        }

        SectionCard(
            title = "GET /api/info",
            subtitle = "The gateway's own answer, unmodified",
        ) {
            UiStateBox(
                state = test,
                idleMessage = "Not tested yet. Fill in the URL and token, then tap Test connection.",
                loadingMessage = "Calling /api/info…",
                onRetry = if (form.canTest) ({ viewModel.testConnection() }) else null,
            ) { info ->
                Column {
                    StatusBanner(
                        text = "status = ${info.status}",
                        tone = if (info.status.equals("online", ignoreCase = true)) {
                            BannerTone.Ok
                        } else {
                            BannerTone.Warn
                        },
                    )
                    Spacer(Modifier.height(4.dp))
                    KeyValueRow("Bot", info.botName)
                    KeyValueRow("Version", info.version, mono = true)
                    KeyValueRow("Active agent", info.activeAgent, mono = true)
                    KeyValueRow("Model", info.model, mono = true)
                    KeyValueRow("Processing", if (info.isProcessing) "yes" else "no")
                    KeyValueRow("Uptime", formatUptime(info.uptimeSeconds))
                    KeyValueRow("Turns", info.turns.toString())
                    KeyValueRow("Context", "${info.contextPct}%")
                }
            }
        }

        Text(
            text = "Cleartext http:// only reaches the gateway on a debug build, or on one of " +
                "the hosts allowed by res/xml/network_security_config.xml in a release build. " +
                "See android/README.md.",
            style = MaterialTheme.typography.bodySmall,
            color = TextMuted,
        )
    }
}
