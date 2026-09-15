package com.agentos.client.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AmoledScheme = darkColorScheme(
    primary = AccentBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF132A5E),
    onPrimaryContainer = Color(0xFFDCE7FF),

    secondary = AccentSky,
    onSecondary = Color(0xFF00121F),
    secondaryContainer = Color(0xFF0B2B3A),
    onSecondaryContainer = Color(0xFFCDEBFA),

    tertiary = AccentSky,
    onTertiary = Color(0xFF00121F),

    // True black everywhere so an AMOLED panel keeps the pixels off.
    background = AmoledBlack,
    onBackground = TextPrimary,
    surface = AmoledBlack,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceVariantDark,
    onSurfaceVariant = TextMuted,
    surfaceContainer = SurfaceRaised,
    surfaceContainerHigh = SurfaceVariantDark,
    outline = OutlineDark,
    outlineVariant = OutlineDark,

    error = DangerRed,
    onError = Color(0xFF1A0000),
    errorContainer = DangerContainer,
    onErrorContainer = DangerOnContainer,
)

/** Dark-only theme. There is no light variant by design. */
@Composable
fun AgentOsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AmoledScheme,
        content = content,
    )
}
