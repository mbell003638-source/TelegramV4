package com.agentos.client.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.agentos.client.net.FailureKind
import com.agentos.client.net.UiState
import com.agentos.client.ui.theme.DangerRed
import com.agentos.client.ui.theme.OkGreen
import com.agentos.client.ui.theme.SurfaceRaised
import com.agentos.client.ui.theme.TextMuted
import com.agentos.client.ui.theme.TextPrimary
import com.agentos.client.ui.theme.WarnAmber

/**
 * The four request states, rendered identically on every screen.
 *
 * There is no fifth "probably fine" state: [UiState.Error] always shows the
 * gateway's own message verbatim (GatewayClient has already dropped the query
 * string, and therefore the token, out of it), and [UiState.Success] is only
 * ever reached with real data in hand.
 */
@Composable
fun <T> UiStateBox(
    state: UiState<T>,
    idleMessage: String,
    loadingMessage: String = "Loading…",
    onRetry: (() -> Unit)? = null,
    content: @Composable (T) -> Unit,
) {
    when (state) {
        is UiState.Idle -> IdleCard(idleMessage)
        is UiState.Loading -> LoadingCard(loadingMessage)
        is UiState.Error -> ErrorCard(state.message, state.kind, onRetry)
        is UiState.Success -> content(state.data)
    }
}

@Composable
fun IdleCard(message: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = TextMuted,
            modifier = Modifier.padding(16.dp),
        )
    }
}

@Composable
fun LoadingCard(message: String = "Loading…") {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.size(12.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = TextMuted,
            )
        }
    }
}

/**
 * The real failure, spelled out. [FailureKind] only chooses the heading — the
 * body is whatever the gateway or the transport actually said.
 */
@Composable
fun ErrorCard(
    message: String,
    kind: FailureKind = FailureKind.Unknown,
    onRetry: (() -> Unit)? = null,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = headingFor(kind),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            if (onRetry != null) {
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onRetry) { Text("Try again") }
            }
        }
    }
}

private fun headingFor(kind: FailureKind): String = when (kind) {
    FailureKind.Unreachable -> "Could not reach the gateway"
    FailureKind.Timeout -> "The gateway did not answer in time"
    FailureKind.Unauthorized -> "Token rejected (HTTP 401)"
    FailureKind.HttpStatus -> "The gateway returned an error"
    FailureKind.BadResponse -> "Unexpected response from the gateway"
    FailureKind.NotConfigured -> "Not configured yet"
    FailureKind.Unknown -> "Request failed"
}

/** A titled panel. Every screen is built out of these. */
@Composable
fun SectionCard(
    title: String,
    subtitle: String? = null,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = TextPrimary,
                    )
                    if (subtitle != null) {
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = TextMuted,
                        )
                    }
                }
                if (trailing != null) {
                    Spacer(Modifier.size(8.dp))
                    trailing()
                }
            }
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

/** A one-line status strip: green ok, amber caveat, red failure. */
@Composable
fun StatusBanner(text: String, tone: BannerTone) {
    val dotColor = when (tone) {
        BannerTone.Ok -> OkGreen
        BannerTone.Warn -> WarnAmber
        BannerTone.Bad -> DangerRed
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 5.dp)
                .size(8.dp)
                .background(dotColor, CircleShape),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = if (tone == BannerTone.Bad) DangerRed else TextMuted,
        )
    }
}

enum class BannerTone { Ok, Warn, Bad }

/** Label / value line used all over the detail panels. */
@Composable
fun KeyValueRow(label: String, value: String, mono: Boolean = false) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = TextMuted,
        )
        Spacer(Modifier.size(12.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            color = TextPrimary,
        )
    }
}

/** `93825` -> `1d 2h 3m`. Never throws on a nonsense value. */
fun formatUptime(seconds: Long): String {
    if (seconds <= 0L) return "unknown"
    val days = seconds / 86_400
    val hours = (seconds % 86_400) / 3_600
    val minutes = (seconds % 3_600) / 60
    return buildString {
        if (days > 0) append("${days}d ")
        if (days > 0 || hours > 0) append("${hours}h ")
        append("${minutes}m")
    }.trim()
}
