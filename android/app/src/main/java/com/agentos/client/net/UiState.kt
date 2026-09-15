package com.agentos.client.net

/**
 * Explicit request state. Every screen renders all four cases; there is no
 * silent failure and no state that pretends success while data is missing.
 */
sealed interface UiState<out T> {
    /** Nothing requested yet (e.g. token not entered). */
    object Idle : UiState<Nothing>

    object Loading : UiState<Nothing>

    data class Success<out T>(val data: T) : UiState<T>

    data class Error(
        val message: String,
        val kind: FailureKind = FailureKind.Unknown,
    ) : UiState<Nothing>
}

/** The payload if this state is Success, else null. */
fun <T> UiState<T>.dataOrNull(): T? = (this as? UiState.Success<T>)?.data

/** Turn a thrown exception into an Error state, keeping the failure kind. */
fun asErrorState(e: Throwable): UiState.Error = when (e) {
    is GatewayException -> UiState.Error(e.message, e.kind)
    else -> UiState.Error(
        e.message?.let { scrubSecrets(it) } ?: e.javaClass.simpleName,
        FailureKind.Unknown,
    )
}
