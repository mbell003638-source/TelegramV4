package com.agentos.client.ui.memory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agentos.client.net.GatewayClient
import com.agentos.client.net.MemorySearchResult
import com.agentos.client.net.UiState
import com.agentos.client.net.asErrorState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Memory tab — search the shared cross-agent memory.
 *
 * Every agent writes into one store, so this searches what ANY agent learned in
 * ANY past session, not just this device's conversations. The backend ranks with
 * SQLite FTS5 (falling back to LIKE where FTS5 is unavailable) and reports which
 * mode it used, which the screen surfaces so the index is never a black box.
 */
class MemoryViewModel(
    private val gateway: GatewayClient,
) : ViewModel() {

    private val _results = MutableStateFlow<UiState<MemorySearchResult>>(UiState.Idle)
    val results: StateFlow<UiState<MemorySearchResult>> = _results.asStateFlow()

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    /** Tracked so a fast second search supersedes the first rather than racing it. */
    private var inFlight: Job? = null

    fun onQueryChange(value: String) {
        _query.value = value
    }

    /**
     * Run the search. A blank query is not sent: the backend would either reject
     * it or return the whole table, and neither is a useful answer to "".
     */
    fun search() {
        val q = _query.value.trim()
        if (q.isEmpty()) {
            inFlight?.cancel()
            _results.value = UiState.Idle
            return
        }

        inFlight?.cancel()
        _results.value = UiState.Loading
        inFlight = viewModelScope.launch {
            try {
                _results.value = UiState.Success(gateway.searchMemories(q))
            } catch (e: CancellationException) {
                // Superseded by a newer search, or the screen went away. Leaving
                // the state on Loading is correct here: the replacement request
                // owns it now.
                throw e
            } catch (e: Throwable) {
                _results.value = asErrorState(e)
            }
        }
    }

    fun clear() {
        inFlight?.cancel()
        _query.value = ""
        _results.value = UiState.Idle
    }
}
