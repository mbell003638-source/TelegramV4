package com.agentos.client.net

/**
 * Secret scrubbing for anything that could reach a log, a Toast or a UI error
 * string.
 *
 * The dashboard token travels as `?token=...` (and occasionally as an
 * `Authorization: Bearer ...` header), which means it can easily end up inside
 * an exception message produced deep inside java.net — for example
 * `java.io.FileNotFoundException: http://host:3141/api/info?token=hunter2`.
 * Every message that this app displays or logs is passed through here first.
 *
 * Referenced by UiState.asErrorState() and by GatewayClient.
 */

private val SECRET_QUERY_PARAM = Regex(
    "(?i)\b(token|apikey|api_key|access_token|auth|secret|password|key)=([^&\s\"'<>]+)"
)

private val BEARER_HEADER = Regex("(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")

/** Replace anything that looks like a credential with `***`. Never throws. */
fun scrubSecrets(text: String): String = try {
    text
        .replace(SECRET_QUERY_PARAM) { m -> "${m.groupValues[1]}=***" }
        .replace(BEARER_HEADER, "Bearer ***")
} catch (_: Throwable) {
    // A scrub that fails must not turn into a leak: drop the text entirely.
    "(redacted)"
}

/**
 * A URL safe to show or log: scheme://host:port/path, with the entire query
 * string dropped rather than scrubbed. Used for every error message so that a
 * token can never ride along in one.
 */
fun safeEndpointLabel(baseUrl: String, path: String): String {
    val base = baseUrl.trim().trimEnd('/')
    val cleanPath = path.substringBefore('?')
    return scrubSecrets(base + cleanPath)
}
