package com.agentos.client.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
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
import com.agentos.client.net.AgentSummary
import com.agentos.client.net.ChatMessage
import com.agentos.client.net.ChatRole
import com.agentos.client.net.UiState
import com.agentos.client.ui.components.BannerTone
import com.agentos.client.ui.components.ErrorCard
import com.agentos.client.ui.components.StatusBanner
import com.agentos.client.ui.theme.DangerRed
import com.agentos.client.ui.theme.OkGreen
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.SurfaceVariantDark
import com.agentos.client.ui.theme.TextMuted
import com.agentos.client.ui.theme.TextPrimary
import com.agentos.client.ui.theme.WarnAmber

/**
 * Chat tab: pick an agent, post a turn, watch the reply arrive.
 *
 * The header is honest about the two halves of this: sending is a POST that
 * only ever confirms the turn was QUEUED, and the reply comes over a separate
 * live stream. When that stream is down, the banner says the reply cannot
 * arrive — the transcript is never left looking merely quiet.
 */
@Composable
fun ChatScreen(viewModel: ChatViewModel, modifier: Modifier = Modifier) {
    val agents by viewModel.agents.collectAsState()
    val selected by viewModel.selectedAgent.collectAsState()
    val messages by viewModel.messages.collectAsState()
    val draft by viewModel.draft.collectAsState()
    val send by viewModel.send.collectAsState()
    val stream by viewModel.stream.collectAsState()
    val processing by viewModel.processing.collectAsState()
    val progress by viewModel.progress.collectAsState()
    val chatId by viewModel.chatId.collectAsState()

    LaunchedEffect(Unit) { viewModel.start() }

    val listState = rememberLazyListState()
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        // ---------------------------------------------------------- header
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SurfaceRaised)
                .padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Chat",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = TextPrimary,
                )
                TextButton(onClick = viewModel::clearTranscript) {
                    Text("Clear view", fontSize = 12.sp)
                }
            }

            if (chatId.isNotBlank()) {
                Text(
                    text = "chatId = $chatId",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = TextMuted,
                )
            }

            Spacer(Modifier.height(8.dp))
            AgentPicker(
                state = agents,
                selected = selected,
                onSelect = viewModel::selectAgent,
                onRetry = viewModel::loadAgents,
            )

            Spacer(Modifier.height(8.dp))
            StreamBanner(
                stream = stream,
                processing = processing,
                progress = progress,
                onReconnect = viewModel::connectStream,
            )
        }

        // ------------------------------------------------------ transcript
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (messages.isEmpty()) {
                Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                    Text(
                        text = "No messages yet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = TextMuted,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = "This transcript starts empty every time the app opens — it " +
                            "shows what happens from now on, and does not load the " +
                            "conversation history the gateway already holds.",
                        style = MaterialTheme.typography.bodySmall,
                        color = TextMuted,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(messages) { message -> MessageBubble(message) }
                }
            }
        }

        // -------------------------------------------------------- composer
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SurfaceRaised)
                .padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            // A send failure is a real failure and stays on screen until the
            // next attempt; it is never swallowed by the optimistic bubble.
            val sendState = send
            if (sendState is UiState.Error) {
                ErrorCard(message = sendState.message, kind = sendState.kind)
                Spacer(Modifier.height(8.dp))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = viewModel::onDraftChange,
                    modifier = Modifier.weight(1f),
                    label = { Text("Message") },
                    placeholder = {
                        Text(
                            if (selected.isBlank()) {
                                "Sent to whichever agent the gateway has active"
                            } else {
                                "Sent to $selected"
                            },
                        )
                    },
                    maxLines = 5,
                )
                Spacer(Modifier.size(10.dp))
                Button(
                    onClick = viewModel::sendMessage,
                    enabled = draft.isNotBlank() && sendState !is UiState.Loading,
                    modifier = Modifier.padding(bottom = 6.dp),
                ) {
                    if (sendState is UiState.Loading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(15.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.size(8.dp))
                    }
                    Text("Send")
                }
            }

            if (sendState is UiState.Success) {
                StatusBanner(
                    text = "Queued on the gateway for \"${sendState.data}\". " +
                        "POST /api/chat/send only confirms the turn was accepted — the " +
                        "reply arrives on the event stream above.",
                    tone = BannerTone.Ok,
                )
            }
        }
    }
}

@Composable
private fun AgentPicker(
    state: UiState<List<AgentSummary>>,
    selected: String,
    onSelect: (String) -> Unit,
    onRetry: () -> Unit,
) {
    when (state) {
        is UiState.Idle -> Text(
            text = "Agent list not loaded yet.",
            style = MaterialTheme.typography.bodySmall,
            color = TextMuted,
        )

        is UiState.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.size(8.dp))
            Text(
                text = "Loading agents from /api/agents…",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
            )
        }

        is UiState.Error -> Column {
            Text(
                text = "Could not load the agent list: ${state.message}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = DangerRed,
            )
            Text(
                text = "You can still send — the gateway will route to its own active agent.",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted,
            )
            TextButton(onClick = onRetry) { Text("Retry", fontSize = 12.sp) }
        }

        is UiState.Success -> Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = selected.isBlank(),
                onClick = { onSelect("") },
                label = { Text("Gateway default", fontSize = 12.sp) },
            )
            for (agent in state.data) {
                FilterChip(
                    selected = agent.id == selected,
                    onClick = { onSelect(agent.id) },
                    label = { Text("${agent.emoji} ${agent.name}", fontSize = 12.sp) },
                )
            }
        }
    }
}

/** Live-stream health. This is the only thing that makes a reply possible. */
@Composable
private fun StreamBanner(
    stream: UiState<Unit>,
    processing: Boolean,
    progress: String?,
    onReconnect: () -> Unit,
) {
    when (stream) {
        is UiState.Idle -> StatusBanner(
            text = "Not subscribed to /api/chat/stream yet.",
            tone = BannerTone.Warn,
        )

        is UiState.Loading -> StatusBanner(
            text = "Opening the live reply stream (GET /api/chat/stream)…",
            tone = BannerTone.Warn,
        )

        is UiState.Error -> Column {
            StatusBanner(
                text = "Live replies are OFF: ${stream.message} Anything you send will still " +
                    "be queued on the gateway, but its answer cannot reach this screen.",
                tone = BannerTone.Bad,
            )
            TextButton(onClick = onReconnect) { Text("Reconnect", fontSize = 12.sp) }
        }

        is UiState.Success -> Column {
            StatusBanner(
                text = if (processing) {
                    "Live. The gateway says it is working on a reply."
                } else {
                    "Live on /api/chat/stream. Replies will appear here as they are sent."
                },
                tone = BannerTone.Ok,
            )
            if (progress != null) {
                Text(
                    text = progress,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = WarnAmber,
                    modifier = Modifier.padding(start = 18.dp),
                )
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.role == ChatRole.User
    val background = when (message.role) {
        ChatRole.User -> MaterialTheme.colorScheme.primaryContainer
        ChatRole.Assistant -> SurfaceVariantDark
        ChatRole.System -> SurfaceRaised
        ChatRole.Error -> MaterialTheme.colorScheme.errorContainer
    }
    val foreground = when (message.role) {
        ChatRole.User -> MaterialTheme.colorScheme.onPrimaryContainer
        ChatRole.Assistant -> TextPrimary
        ChatRole.System -> TextMuted
        ChatRole.Error -> MaterialTheme.colorScheme.onErrorContainer
    }
    val label = when (message.role) {
        ChatRole.User -> message.source.ifBlank { "you" }
        ChatRole.Assistant -> message.source.ifBlank { "assistant" }
        ChatRole.System -> "system · ${message.source.ifBlank { "gateway" }}"
        ChatRole.Error -> "error · ${message.source.ifBlank { "gateway" }}"
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .background(background, RoundedCornerShape(14.dp))
                .padding(12.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = when (message.role) {
                    ChatRole.Error -> DangerRed
                    ChatRole.Assistant -> OkGreen
                    else -> TextMuted
                },
            )
            Spacer(Modifier.height(4.dp))
            // Selectable so a stack trace or a command in a reply can be copied.
            SelectionContainer {
                Text(
                    text = message.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = foreground,
                    fontFamily = if (message.role == ChatRole.Error) {
                        FontFamily.Monospace
                    } else {
                        FontFamily.Default
                    },
                )
            }
        }
    }
}
