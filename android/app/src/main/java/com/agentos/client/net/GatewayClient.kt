package com.agentos.client.net

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.NoRouteToHostException
import java.net.PortUnreachableException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException

/**
 * The one and only place this app performs HTTP.
 *
 * Transport is java.net.HttpURLConnection and parsing is org.json - both ship
 * with Android, so the app pulls in no networking or serialization dependency
 * (see app/build.gradle.kts). Every call suspends onto Dispatchers.IO.
 *
 * Contracts come from core/MissionControl.js and core/RouterRoutes.js, and the
 * URL is composed exactly the way webui/lib/config.ts composes it:
 * `<base><path>?token=<DASHBOARD_TOKEN>&...`.
 *
 * SECRET HANDLING: the token is written into the query string and the
 * Authorization header, and nowhere else. It is never logged, and no error
 * message this class produces ever contains a query string - errors name the
 * endpoint via safeEndpointLabel(), which drops the query entirely.
 */
class GatewayClient {

    @Volatile
    private var config: GatewayConfig = GatewayConfig(baseUrl = "", token = "")

    /** Called whenever the persisted settings change. */
    fun updateConfig(newConfig: GatewayConfig) {
        config = newConfig.copy(baseUrl = normalizeBaseUrl(newConfig.baseUrl))
    }

    fun currentConfig(): GatewayConfig = config

    // ---------------------------------------------------------------- calls

    /**
     * GET /api/info - the connection test.
     *
     * @param probe test these settings instead of the saved ones, so the
     *   Connect screen can verify what the user just typed without first
     *   persisting a token that may turn out to be wrong.
     */
    suspend fun fetchInfo(probe: GatewayConfig? = null): GatewayInfo {
        val cfg = resolve(probe)
        val json = getJson(cfg, "/api/info", mapOf("chatId" to cfg.chatId))
        return GatewayInfo(
            status = json.str("status", "unknown"),
            version = json.str("version", "unknown"),
            botName = json.str("botName", "Agent OS"),
            activeAgent = json.str("activeAgent", "unknown"),
            model = json.str("model", "unknown"),
            isProcessing = json.optBoolean("isProcessing", false),
            uptimeSeconds = json.optLong("uptimeSeconds", 0L),
            turns = json.optInt("turns", 0),
            contextPct = json.optInt("contextPct", 0),
        )
    }

    /** GET /api/agents */
    suspend fun fetchAgents(): AgentsSnapshot {
        val cfg = resolve(null)
        val json = getJson(cfg, "/api/agents", mapOf("chatId" to cfg.chatId))
        val agents = (json.optJSONArray("agents") ?: JSONArray()).mapObjects { o ->
            AgentSummary(
                id = o.str("id"),
                name = o.str("name", o.str("id")),
                emoji = o.str("emoji", "🤖"),
                status = o.str("status", "unknown"),
                active = o.optBoolean("active", false),
                running = o.optBoolean("running", false),
                model = o.str("model", "default"),
                todayTurns = o.optInt("todayTurns", 0),
                availableModels = (o.optJSONArray("availableModels") ?: JSONArray()).toModelIds(),
                description = o.str("description"),
            )
        }.filter { it.id.isNotBlank() }
        return AgentsSnapshot(agents = agents, activeAgent = json.str("activeAgent"))
    }

    /**
     * GET /api/agents/override -> `{ overrides: { <agentKey>: {...} } }`.
     *
     * The gateway answers 503 when overrides are not configured at all; the
     * Agents screen catches that and still lists the agents rather than
     * showing nothing at all.
     */
    suspend fun fetchOverrides(): Map<String, AgentOverride> {
        val cfg = resolve(null)
        return parseOverrides(getJson(cfg, "/api/agents/override"))
    }

    /**
     * POST /api/agents/override with `{agentKey, enabled[, model]}`.
     *
     * One agent per call - this is the per-agent switch, not a global one.
     * Returns the full refreshed override map the gateway echoes back.
     */
    suspend fun setOverride(
        agentKey: String,
        enabled: Boolean,
        model: String? = null,
    ): Map<String, AgentOverride> {
        val cfg = resolve(null)
        val body = JSONObject()
            .put("agentKey", agentKey)
            .put("enabled", enabled)
        if (enabled && !model.isNullOrBlank()) body.put("model", model)
        return parseOverrides(sendJson(cfg, "POST", "/api/agents/override", body))
    }

    /**
     * POST /api/chat/send with `{message, chatId, agentId}`.
     *
     * The gateway ENQUEUES the turn and answers `{success:true, agent}`
     * immediately - the assistant's actual words arrive later over
     * [streamEvents]. The returned string is the agent key the gateway routed
     * to, never a reply. Nothing here may be presented to the user as an
     * answer.
     */
    suspend fun sendChat(message: String, agentId: String?): String {
        val cfg = resolve(null)
        val body = JSONObject()
            .put("message", message)
            .put("chatId", cfg.chatId)
        if (!agentId.isNullOrBlank()) body.put("agentId", agentId)
        val json = sendJson(cfg, "POST", "/api/chat/send", body)
        if (!json.optBoolean("success", false) && !json.optBoolean("ok", false)) {
            throw GatewayException(
                FailureKind.BadResponse,
                "The gateway did not confirm the message was queued: " +
                    scrubSecrets(json.toString().take(200)),
            )
        }
        return json.str("agent", agentId ?: "")
    }

    /**
     * GET /api/chat/stream - Server-Sent Events.
     *
     * Wire format from MissionControl.broadcast():
     * `event: <name>\ndata: <json>\n\n`, preceded by a `: connected` comment.
     * The flow fails with a [GatewayException] if the stream cannot be opened
     * or later drops, so the UI can say so instead of showing a dead screen.
     */
    fun streamEvents(): Flow<StreamEvent> = callbackFlow {
        val cfg = resolve(null)
        val open = AtomicReference<HttpURLConnection?>(null)
        val label = safeEndpointLabel(cfg.baseUrl, PATH_STREAM)

        val pump = launch(Dispatchers.IO) {
            try {
                val conn = openConnection(cfg, PATH_STREAM, "GET", emptyMap(), stream = true)
                open.set(conn)
                val code = conn.responseCode
                if (code !in 200..299) {
                    throw statusException(code, readAllQuietly(conn.errorStream), label)
                }
                BufferedReader(InputStreamReader(conn.inputStream, Charsets.UTF_8)).use { reader ->
                    var name = "message"
                    val data = StringBuilder()
                    while (isActive) {
                        val line = reader.readLine() ?: break
                        when {
                            // A blank line terminates one event.
                            line.isBlank() -> {
                                if (data.isNotEmpty()) trySend(StreamEvent(name, data.toString()))
                                name = "message"
                                data.setLength(0)
                            }
                            // `: connected` and any other comment line.
                            line.startsWith(":") -> Unit
                            line.startsWith("event:") -> name = line.removePrefix("event:").trim()
                            line.startsWith("data:") -> {
                                if (data.isNotEmpty()) data.append('\n')
                                data.append(line.removePrefix("data:").removePrefix(" "))
                            }
                            else -> Unit
                        }
                    }
                }
                close(
                    GatewayException(
                        FailureKind.Unreachable,
                        "The event stream from $label closed. Tap Reconnect to resume live replies.",
                    )
                )
            } catch (ce: CancellationException) {
                throw ce
            } catch (t: Throwable) {
                close(mapThrowable(t, label))
            }
        }

        awaitClose {
            pump.cancel()
            // A blocking readLine() is not interruptible; closing the socket is
            // what actually unblocks it.
            runCatching { open.get()?.disconnect() }
        }
    }

    /** GET /api/devices/remote - key names plus the TV and phone app lists. */
    suspend fun fetchRemoteLayout(): RemoteLayout {
        val cfg = resolve(null)
        val json = getJson(cfg, "/api/devices/remote")
        return RemoteLayout(
            keys = (json.optJSONArray("keys") ?: JSONArray()).toStringList(),
            tvApps = (json.optJSONArray("tvApps") ?: JSONArray()).mapObjects { it.toDeviceApp() },
            phoneApps = (json.optJSONArray("phoneApps") ?: JSONArray()).mapObjects { it.toDeviceApp() },
        )
    }

    /** GET /api/devices - adb availability and the attached device list. */
    suspend fun fetchDevices(): DevicesSnapshot {
        val cfg = resolve(null)
        val json = getJson(cfg, "/api/devices")
        return DevicesSnapshot(
            adbInstalled = json.optBoolean("adbInstalled", false),
            devices = (json.optJSONArray("devices") ?: JSONArray()).mapObjects { o ->
                AdbDevice(
                    serial = o.str("serial"),
                    status = o.str("status", "unknown"),
                    model = o.str("model", "Android Device"),
                    product = o.str("product"),
                    isOnline = o.optBoolean("isOnline", o.str("status") == "device"),
                )
            }.filter { it.serial.isNotBlank() },
            selectedDevice = json.strOrNull("selectedDevice"),
        )
    }

    /** POST /api/devices/action `{action:"remote", key:<name>[, serial]}`. */
    suspend fun pressRemoteKey(key: String, serial: String? = null): String =
        deviceAction(JSONObject().put("action", "remote").put("key", key).putSerial(serial))

    /** POST /api/devices/action `{action:"launch", package:<pkg>[, serial]}`. */
    suspend fun launchApp(packageName: String, serial: String? = null): String =
        deviceAction(JSONObject().put("action", "launch").put("package", packageName).putSerial(serial))

    /**
     * POST /api/devices/action `{action:"connect", host, port}`.
     * How a networked Android TV / Google TV is dialled - adb over TCP.
     */
    suspend fun connectDevice(host: String, port: Int = DEFAULT_ADB_PORT): String =
        deviceAction(JSONObject().put("action", "connect").put("host", host).put("port", port))

    /** POST /api/devices/action `{action:"disconnect", host, port}`. */
    suspend fun disconnectDevice(host: String, port: Int = DEFAULT_ADB_PORT): String =
        deviceAction(JSONObject().put("action", "disconnect").put("host", host).put("port", port))

    private suspend fun deviceAction(body: JSONObject): String {
        val cfg = resolve(null)
        val json = sendJson(cfg, "POST", "/api/devices/action", body)
        if (!json.optBoolean("ok", true)) {
            throw GatewayException(
                FailureKind.HttpStatus,
                json.str("error", "The gateway reported the device action as failed."),
            )
        }
        // `result` is whatever DeviceAutomation returned: object, string or null.
        return when (val result = json.opt("result")) {
            null, JSONObject.NULL -> "OK"
            is JSONObject -> result.strOrNull("output")
                ?: result.strOrNull("target")
                ?: if (result.optBoolean("success", false)) "OK" else scrubSecrets(result.toString())
            else -> scrubSecrets(result.toString())
        }
    }

    /** GET /api/memories/search?q=... */
    suspend fun searchMemories(query: String, limit: Int = 20): MemorySearchResult {
        val cfg = resolve(null)
        val json = getJson(
            cfg,
            "/api/memories/search",
            mapOf("q" to query, "limit" to limit.toString()),
        )
        val stats = json.optJSONObject("stats")
        return MemorySearchResult(
            query = json.str("query", query),
            hits = (json.optJSONArray("results") ?: JSONArray()).mapObjects { o ->
                MemoryHit(
                    id = o.optLong("id", 0L),
                    chatId = o.str("chatId"),
                    agentId = o.str("agentId"),
                    source = o.str("source"),
                    text = o.str("text"),
                    summary = o.str("summary"),
                    snippet = o.str("snippet"),
                    importance = o.optDouble("importance", 0.0).orZero(),
                    salience = o.optDouble("salience", 0.0).orZero(),
                    createdAt = o.optLong("createdAt", 0L),
                    score = o.optDouble("score", 0.0).orZero(),
                )
            },
            indexed = stats?.optInt("indexed", 0) ?: 0,
            mode = stats?.str("mode", "unknown") ?: "unknown",
        )
    }

    // ------------------------------------------------------------- plumbing

    private fun resolve(probe: GatewayConfig?): GatewayConfig {
        val cfg = probe?.copy(baseUrl = normalizeBaseUrl(probe.baseUrl)) ?: config
        if (cfg.baseUrl.isBlank()) {
            throw GatewayException(
                FailureKind.NotConfigured,
                "No gateway URL yet. Set one on the Connect tab, e.g. http://192.168.1.50:$DEFAULT_GATEWAY_PORT",
            )
        }
        if (cfg.token.isBlank()) {
            throw GatewayException(
                FailureKind.NotConfigured,
                "No dashboard token yet. Paste DASHBOARD_TOKEN on the Connect tab.",
            )
        }
        return cfg
    }

    private suspend fun getJson(
        cfg: GatewayConfig,
        path: String,
        params: Map<String, String?> = emptyMap(),
    ): JSONObject = parseObject(request(cfg, "GET", path, params, null), cfg, path)

    private suspend fun sendJson(
        cfg: GatewayConfig,
        method: String,
        path: String,
        body: JSONObject,
    ): JSONObject = parseObject(request(cfg, method, path, emptyMap(), body), cfg, path)

    private fun parseObject(text: String, cfg: GatewayConfig, path: String): JSONObject {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            throw GatewayException(
                FailureKind.BadResponse,
                "${safeEndpointLabel(cfg.baseUrl, path)} returned an empty body where JSON was expected.",
            )
        }
        return try {
            JSONObject(trimmed)
        } catch (_: JSONException) {
            throw GatewayException(
                FailureKind.BadResponse,
                "${safeEndpointLabel(cfg.baseUrl, path)} did not return JSON. " +
                    "First bytes: ${scrubSecrets(trimmed.take(120))}",
            )
        }
    }

    /** The single request primitive. Always on Dispatchers.IO. */
    private suspend fun request(
        cfg: GatewayConfig,
        method: String,
        path: String,
        params: Map<String, String?>,
        body: JSONObject?,
    ): String = withContext(Dispatchers.IO) {
        val label = safeEndpointLabel(cfg.baseUrl, path)
        var conn: HttpURLConnection? = null
        try {
            conn = openConnection(cfg, path, method, params, stream = false)
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            val code = conn.responseCode
            if (code in 200..299) {
                readAll(conn.inputStream)
            } else {
                throw statusException(code, readAllQuietly(conn.errorStream), label)
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (t: Throwable) {
            throw mapThrowable(t, label)
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun openConnection(
        cfg: GatewayConfig,
        path: String,
        method: String,
        params: Map<String, String?>,
        stream: Boolean,
    ): HttpURLConnection {
        val url = URL(buildUrl(cfg, path, params))
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        // An SSE stream must never time out on idleness; a normal call must.
        conn.readTimeout = if (stream) 0 else READ_TIMEOUT_MS
        conn.useCaches = false
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("Accept", if (stream) "text/event-stream" else "application/json")
        conn.setRequestProperty("User-Agent", USER_AGENT)
        // MissionControl accepts the token either as ?token= or as a bearer
        // header; sending both survives a proxy that strips the query string.
        conn.setRequestProperty("Authorization", "Bearer ${cfg.token}")
        return conn
    }

    /**
     * Mirrors webui/lib/config.ts bridgeUrl(): base + path + `?token=...`,
     * preserving any query already present in `path`.
     *
     * Callers pass parameters through `params` (raw, unencoded); nothing
     * pre-encoded is ever put into `path`, so nothing gets double-encoded.
     */
    private fun buildUrl(cfg: GatewayConfig, path: String, params: Map<String, String?>): String {
        val base = cfg.baseUrl.trim().trimEnd('/')
        val normalized = if (path.startsWith("/")) path else "/$path"
        val q = normalized.indexOf('?')
        val pathname = if (q == -1) normalized else normalized.substring(0, q)
        val existing = if (q == -1) "" else normalized.substring(q + 1)

        val merged = LinkedHashMap<String, String>()
        if (existing.isNotEmpty()) {
            for (pair in existing.split('&')) {
                if (pair.isEmpty()) continue
                val eq = pair.indexOf('=')
                if (eq == -1) merged[pair] = "" else merged[pair.substring(0, eq)] = pair.substring(eq + 1)
            }
        }
        merged["token"] = cfg.token
        for ((key, value) in params) if (!value.isNullOrBlank()) merged[key] = value

        val query = merged.entries.joinToString("&") { "${encode(it.key)}=${encode(it.value)}" }
        return "$base$pathname?$query"
    }

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun statusException(code: Int, detail: String, label: String): GatewayException {
        val serverMessage = serverErrorOf(detail)
        return when (code) {
            HttpURLConnection.HTTP_UNAUTHORIZED -> GatewayException(
                FailureKind.Unauthorized,
                "The gateway rejected the dashboard token (HTTP 401). Check the token on the " +
                    "Connect tab - it has to match DASHBOARD_TOKEN in the gateway's .env.",
            )
            HttpURLConnection.HTTP_NOT_FOUND -> GatewayException(
                FailureKind.HttpStatus,
                "$label does not exist on this gateway (HTTP 404). " +
                    (serverMessage ?: "It may be older than this app expects."),
            )
            HttpURLConnection.HTTP_UNAVAILABLE -> GatewayException(
                FailureKind.HttpStatus,
                "$label is not enabled on this gateway (HTTP 503). " +
                    (serverMessage ?: "That feature is switched off server-side."),
            )
            else -> GatewayException(
                FailureKind.HttpStatus,
                "$label returned HTTP $code" + (serverMessage?.let { ": $it" } ?: "."),
            )
        }
    }

    /** Pull `error` / `message` out of the gateway's JSON error body, scrubbed. */
    private fun serverErrorOf(body: String): String? {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return null
        val fromJson = try {
            val o = JSONObject(trimmed)
            o.strOrNull("error") ?: o.strOrNull("message")
        } catch (_: JSONException) {
            null
        }
        return scrubSecrets(fromJson ?: trimmed.take(160)).takeIf { it.isNotBlank() }
    }

    /**
     * Turn a transport failure into a [GatewayException] the user can act on.
     * There is deliberately no catch-all "request failed" wording here.
     */
    private fun mapThrowable(t: Throwable, label: String): GatewayException = when (t) {
        is GatewayException -> t

        is SocketTimeoutException -> GatewayException(
            FailureKind.Timeout,
            "$label accepted the connection but sent nothing back within " +
                "${READ_TIMEOUT_MS / 1000}s. The gateway is reachable but busy or stuck.",
        )

        is UnknownHostException -> GatewayException(
            FailureKind.Unreachable,
            "The host in $label could not be resolved. Check the address, and prefer the LAN " +
                "IP (e.g. 192.168.1.50) over a hostname if this phone has no local DNS.",
        )

        is ConnectException -> GatewayException(
            FailureKind.Unreachable,
            "Nothing accepted a connection at $label. Is the gateway running, is the port " +
                "right, and is this phone on the same network?",
        )

        is NoRouteToHostException, is PortUnreachableException -> GatewayException(
            FailureKind.Unreachable,
            "No network route to $label from this device.",
        )

        is SSLException -> GatewayException(
            FailureKind.Unknown,
            "The TLS handshake with $label failed: " +
                "${scrubSecrets(t.message ?: t.javaClass.simpleName)}. " +
                "A self-signed certificate will not be trusted by this app.",
        )

        is MalformedURLException -> GatewayException(
            FailureKind.NotConfigured,
            "The gateway URL is not usable: ${scrubSecrets(t.message ?: "malformed URL")}. " +
                "Expected something like http://192.168.1.50:$DEFAULT_GATEWAY_PORT",
        )

        is JSONException -> GatewayException(
            FailureKind.BadResponse,
            "$label answered with something this app could not parse as JSON.",
        )

        is IOException -> {
            val raw = t.message ?: ""
            if (raw.contains("Cleartext", ignoreCase = true)) {
                GatewayException(
                    FailureKind.Unreachable,
                    "Android blocked plain HTTP to $label. Sideload the DEBUG build for a LAN " +
                        "gateway, or put the gateway behind https:// (see android/README.md).",
                )
            } else {
                GatewayException(
                    FailureKind.Unreachable,
                    "The connection to $label failed: " +
                        scrubSecrets(raw.ifBlank { t.javaClass.simpleName }),
                )
            }
        }

        else -> GatewayException(
            FailureKind.Unknown,
            "Unexpected ${t.javaClass.simpleName} talking to $label: " +
                scrubSecrets(t.message ?: "no detail"),
        )
    }

    private fun readAll(stream: InputStream?): String {
        if (stream == null) return ""
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    private fun readAllQuietly(stream: InputStream?): String =
        runCatching { readAll(stream) }.getOrDefault("")

    private fun parseOverrides(json: JSONObject): Map<String, AgentOverride> {
        val map = json.optJSONObject("overrides") ?: return emptyMap()
        val out = LinkedHashMap<String, AgentOverride>()
        val keys = map.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val o = map.optJSONObject(key) ?: continue
            out[key] = AgentOverride(
                agentKey = o.str("agentKey", key),
                supported = o.optBoolean("supported", true),
                enabled = o.optBoolean("enabled", false),
                providerId = o.strOrNull("providerId"),
                model = o.strOrNull("model"),
                baseUrl = o.strOrNull("baseUrl"),
                // The gateway masks this server-side and names the field `apiKey`.
                maskedApiKey = o.strOrNull("apiKey"),
                hasApiKey = o.optBoolean("hasApiKey", false),
                updatedAt = if (o.isNull("updatedAt")) null else o.optLong("updatedAt", 0L),
            )
        }
        return out
    }

    companion object {
        const val DEFAULT_ADB_PORT = 5555
        const val DEFAULT_GATEWAY_PORT = 3141
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val READ_TIMEOUT_MS = 25_000
        private const val USER_AGENT = "AgentOSClient/1.0 (Android)"
        private const val PATH_STREAM = "/api/chat/stream"

        /**
         * Accept what a human actually types: `192.168.1.50:3141`,
         * `http://box.lan:3141/`, `https://gw.example.com`. A missing scheme
         * becomes http:// and a trailing slash is dropped.
         */
        fun normalizeBaseUrl(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return ""
            val withScheme = if (trimmed.contains("://")) trimmed else "http://$trimmed"
            return withScheme.trimEnd('/')
        }
    }
}

// ------------------------------------------------------- org.json extensions
//
// org.json is forgiving in the wrong direction: optString() on an explicit JSON
// null hands back the literal string "null". These helpers give back a real
// Kotlin null instead, which matters because several override fields (model,
// providerId, baseUrl, apiKey) are null far more often than they are set.

private fun JSONObject.strOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = opt(key) ?: return null
    return value.toString().takeIf { it.isNotEmpty() && it != "null" }
}

private fun JSONObject.str(key: String, fallback: String = ""): String =
    strOrNull(key) ?: fallback

private fun JSONObject.putSerial(serial: String?): JSONObject =
    if (serial.isNullOrBlank()) this else put("serial", serial)

private fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> {
    val out = ArrayList<T>(length())
    for (i in 0 until length()) {
        optJSONObject(i)?.let { out.add(transform(it)) }
    }
    return out
}

private fun JSONArray.toStringList(): List<String> {
    val out = ArrayList<String>(length())
    for (i in 0 until length()) {
        if (isNull(i)) continue
        opt(i)?.toString()?.takeIf { it.isNotBlank() && it != "null" }?.let { out.add(it) }
    }
    return out
}

/**
 * `availableModels` is an array of `{id, name, ...}` objects (SessionStore
 * .getAvailableModels), but older gateways sent bare strings. Handle both.
 */
private fun JSONArray.toModelIds(): List<String> {
    val out = ArrayList<String>(length())
    for (i in 0 until length()) {
        if (isNull(i)) continue
        val id = when (val item = opt(i)) {
            is JSONObject -> item.strOrNull("id")
                ?: item.strOrNull("model")
                ?: item.strOrNull("name")
            else -> item?.toString()?.takeIf { it.isNotBlank() && it != "null" }
        }
        if (id != null) out.add(id)
    }
    return out
}

private fun JSONObject.toDeviceApp(): DeviceApp = DeviceApp(
    id = str("id"),
    name = str("name", str("id")),
    // The gateway's field is `package`; the model calls it packageName.
    packageName = str("package", str("packageName")),
    emoji = str("emoji", "📱"),
)

/** NaN / Infinity out of optDouble must never reach a formatter. */
private fun Double.orZero(): Double = if (isNaN() || isInfinite()) 0.0 else this
