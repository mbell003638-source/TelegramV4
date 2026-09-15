package com.agentos.client.ui.agents

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
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
import com.agentos.client.net.AgentRow
import com.agentos.client.net.dataOrNull
import com.agentos.client.ui.components.BannerTone
import com.agentos.client.ui.components.KeyValueRow
import com.agentos.client.ui.components.SectionCard
import com.agentos.client.ui.components.StatusBanner
import com.agentos.client.ui.components.UiStateBox
import com.agentos.client.ui.theme.OkGreen
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.TextMuted
import com.agentos.client.ui.theme.TextPrimary

/**
 * Agents tab.
 *
 * Every agent gets ITS OWN switch. Flipping one posts
 * `POST /api/agents/override {agentKey:<that agent>, enabled:<new value>}` —
 * one agent per request. There is deliberately no master switch on this screen:
 * nothing here can re-point more than the agent whose row you touched.
 *
 * When an override is on, the model actually in force is shown, and the agent's
 * own `availableModels` become chips that re-post the same toggle with a
 * `model` field.
 */
@Composable
fun AgentsScreen(viewModel: AgentsViewModel, modifier: Modifier = Modifier) {
    val rows by viewModel.rows.collectAsState()
    val activeAgent by viewModel.activeAgent.collectAsState()
    val notice by viewModel.overrideNotice.collectAsState()
    val pending by viewModel.pending.collectAsState()
    val rowErrors by viewModel.rowErrors.collectAsState()

    LaunchedEffect(Unit) { viewModel.refreshIfIdle() }

    LazyColumn(
        modifier = modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard(
                title = "Agents",
                subtitle = "GET /api/agents + GET /api/agents/override",
                trailing = {
                    OutlinedButton(onClick = viewModel::refresh) { Text("Refresh") }
                },
            ) {
                if (activeAgent.isNotBlank()) {
                    StatusBanner(
                        text = "The gateway routes un-addressed chat turns to \"$activeAgent\".",
                        tone = BannerTone.Ok,
                    )
                }
                val currentNotice = notice
                if (currentNotice != null) {
                    StatusBanner(text = currentNotice, tone = BannerTone.Warn)
                }
                Text(
                    text = "Each switch below posts to /api/agents/override for that one " +
                        "agentKey. Switching an agent ON re-points it at the OmniRouter; " +
                        "switching it OFF restores its own defaults.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TextMuted,
                )
            }
        }

        item {
            UiStateBox(
                state = rows,
                idleMessage = "Not loaded yet.",
                loadingMessage = "Calling /api/agents…",
                onRetry = viewModel::refresh,
            ) { list ->
                if (list.isEmpty()) {
                    StatusBanner(
                        text = "The gateway returned an empty agent list. Nothing to show — " +
                            "this is the gateway's real answer, not a loading state.",
                        tone = BannerTone.Warn,
                    )
                }
            }
        }

        val loaded = rows.dataOrNull().orEmpty()
        items(loaded, key = { it.agent.id }) { row ->
            AgentCard(
                row = row,
                isPending = row.agent.id in pending,
                rowError = rowErrors[row.agent.id],
                onToggle = { enabled -> viewModel.setOverride(row.agent.id, enabled) },
                onPickModel = { model -> viewModel.selectModel(row.agent.id, model) },
                onDismissError = { viewModel.dismissRowError(row.agent.id) },
            )
        }
    }
}

@Composable
private fun AgentCard(
    row: AgentRow,
    isPending: Boolean,
    rowError: String?,
    onToggle: (Boolean) -> Unit,
    onPickModel: (String) -> Unit,
    onDismissError: () -> Unit,
) {
    val agent = row.agent
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = agent.emoji, fontSize = 22.sp)
                Spacer(Modifier.size(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = agent.name,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = TextPrimary,
                        )
                        if (agent.active) {
                            Spacer(Modifier.size(8.dp))
                            Text(
                                text = "ACTIVE",
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = OkGreen,
                            )
                        }
                    }
                    Text(
                        text = agent.id,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = TextMuted,
                    )
                }

                if (isPending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.size(12.dp))
                }

                // THE per-agent switch. One agentKey, one request.
                Switch(
                    checked = row.overrideOn,
                    onCheckedChange = onToggle,
                    enabled = row.toggleable && !isPending,
                )
            }

            Spacer(Modifier.height(10.dp))
            HorizontalDivider()
            Spacer(Modifier.height(10.dp))

            KeyValueRow("Status", agent.status)
            KeyValueRow("Turns today", agent.todayTurns.toString())
            KeyValueRow(
                label = if (row.overrideOn) "Model in force (override)" else "Model in force",
                value = row.effectiveModel,
                mono = true,
            )

            val override = row.override
            if (row.overrideOn && override != null) {
                KeyValueRow("Provider", override.providerId ?: "omnirouter", mono = true)
                if (override.baseUrl != null) {
                    KeyValueRow("Router base URL", override.baseUrl, mono = true)
                }
                KeyValueRow(
                    label = "API key",
                    // Already masked server-side by AgentOverrides.maskKey().
                    value = override.maskedApiKey ?: if (override.hasApiKey) "set" else "not set",
                    mono = true,
                )
            }

            if (!row.toggleable) {
                Spacer(Modifier.height(8.dp))
                StatusBanner(
                    text = "This agent has no environment mapping on the gateway " +
                        "(AGENT_ENV_MAP in core/AgentOverrides.js), so it cannot be " +
                        "re-pointed from here. Its switch is disabled.",
                    tone = BannerTone.Warn,
                )
            }

            // Model choice only makes sense while the override is on: that is
            // the only state in which the gateway records a `model`.
            if (row.overrideOn && agent.availableModels.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "Pin a model (re-posts this agent's override)",
                    style = MaterialTheme.typography.labelMedium,
                    color = TextMuted,
                )
                Spacer(Modifier.height(6.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (model in agent.availableModels) {
                        FilterChip(
                            selected = override?.model == model,
                            onClick = { onPickModel(model) },
                            enabled = !isPending,
                            label = { Text(model, fontSize = 12.sp) },
                        )
                    }
                }
            }

            if (rowError != null) {
                Spacer(Modifier.height(10.dp))
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            text = rowError,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        TextButton(onClick = onDismissError) { Text("Dismiss") }
                    }
                }
            }
        }
    }
}
