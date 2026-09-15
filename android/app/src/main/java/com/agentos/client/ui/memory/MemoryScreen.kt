package com.agentos.client.ui.memory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentos.client.net.MemoryHit
import com.agentos.client.ui.components.SectionCard
import com.agentos.client.ui.components.UiStateBox
import com.agentos.client.ui.theme.AccentBlue
import com.agentos.client.ui.theme.AccentSky
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.TextMuted
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Search the shared memory every agent reads and writes.
 *
 * A search that legitimately finds nothing says so explicitly — an empty list
 * and a failed request must never look the same on screen.
 */
@Composable
fun MemoryScreen(viewModel: MemoryViewModel) {
    val results by viewModel.results.collectAsState()
    val query by viewModel.query.collectAsState()

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        SectionCard(
            title = "Shared memory",
            subtitle = "What any agent learned, in any past session",
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = viewModel::onQueryChange,
                label = { Text("Search") },
                placeholder = { Text("deploy pipeline, nginx, vps…") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { viewModel.search() }),
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = viewModel::search,
                    enabled = query.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                ) { Text("Search") }
                TextButton(onClick = viewModel::clear) { Text("Clear") }
            }
        }

        Spacer(Modifier.height(12.dp))

        UiStateBox(
            state = results,
            idleMessage = "Type something to search the shared memory.",
            loadingMessage = "Searching memory…",
            onRetry = viewModel::search,
        ) { result ->
            if (result.hits.isEmpty()) {
                // Distinct from an error: the search worked and found nothing.
                SectionCard(title = "No matches") {
                    Text(
                        "Nothing in memory matches “${result.query}”.",
                        color = TextMuted,
                        fontSize = 13.sp,
                    )
                    Spacer(Modifier.height(6.dp))
                    IndexFooter(result.indexed, result.mode)
                }
            } else {
                Column(modifier = Modifier.fillMaxSize()) {
                    Text(
                        "${result.hits.size} match${if (result.hits.size == 1) "" else "es"}",
                        color = TextMuted,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(8.dp))
                    LazyColumn(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(result.hits) { hit -> HitCard(hit) }
                        item {
                            Spacer(Modifier.height(8.dp))
                            IndexFooter(result.indexed, result.mode)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HitCard(hit: MemoryHit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    hit.agentId.ifBlank { "unattributed" },
                    color = AccentSky,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = FontFamily.Monospace,
                )
                Text(formatWhen(hit.createdAt), color = TextMuted, fontSize = 10.sp)
            }
            Spacer(Modifier.height(6.dp))
            // Prefer the server's snippet (it highlights the match); fall back
            // through summary to the raw text so a hit is never blank.
            Text(
                hit.snippet.ifBlank { hit.summary.ifBlank { hit.text } },
                style = MaterialTheme.typography.bodyMedium,
                fontSize = 13.sp,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                buildString {
                    if (hit.source.isNotBlank()) append(hit.source)
                    if (hit.chatId.isNotBlank()) {
                        if (isNotEmpty()) append("  ·  ")
                        append("chat ").append(hit.chatId)
                    }
                    if (isNotEmpty()) append("  ·  ")
                    append("score ").append(String.format(Locale.US, "%.2f", hit.score))
                },
                color = TextMuted,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/** Shows the index is real: how many memories it holds, and in which mode. */
@Composable
private fun IndexFooter(indexed: Int, mode: String) {
    Text(
        "Index: $indexed memor${if (indexed == 1) "y" else "ies"}"
            + (if (mode.isNotBlank()) "  ·  $mode" else ""),
        color = TextMuted,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
    )
}

private fun formatWhen(epochMs: Long): String {
    if (epochMs <= 0L) return ""
    return try {
        SimpleDateFormat("d MMM HH:mm", Locale.getDefault()).format(Date(epochMs))
    } catch (e: Exception) {
        ""
    }
}
