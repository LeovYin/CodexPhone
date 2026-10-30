package app.codexphone.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String) : IOException(message)

class CodexPhoneApi(
    rawBaseUrl: String, private val token: String? = null,
    private val client: OkHttpClient = defaultClient(),
) {
    val baseUrl: HttpUrl = normalizeBaseUrl(rawBaseUrl)
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun health(): HostStatus = get("api/health")
    suspend fun capabilities(): Capabilities = get("api/capabilities")
    suspend fun pair(code: String, name: String): PairResponse = post("api/pair", buildJsonObject {
        put("code", code.trim()); put("name", name)
    }, false)
    suspend fun projects(): List<Project> = get<ProjectsResponse>("api/projects").projects
    suspend fun models(): ModelsResponse = get("api/models")
    suspend fun approvals(): List<ApprovalRequest> = get<ApprovalsResponse>("api/approvals").approvals
    suspend fun threads(projectId: String? = null, cursor: String? = null, search: String? = null): ThreadsResponse =
        get("api/threads", mapOf("limit" to "30", "projectId" to projectId, "cursor" to cursor, "search" to search))
    suspend fun thread(id: String, cursor: String? = null): ThreadDetail = get("api/threads/" + encode(id), mapOf("cursor" to cursor))
    suspend fun submit(pending: PendingSubmission): JsonObject {
        val path = when {
            pending.threadId == null -> "api/threads"
            pending.kind == "steer" -> "api/threads/" + encode(pending.threadId) + "/steer"
            else -> "api/threads/" + encode(pending.threadId) + "/turns"
        }
        return post(path, buildJsonObject {
            put("clientRequestId", pending.requestId); put("prompt", pending.prompt)
            pending.projectId?.let { put("projectId", it) }
            pending.model?.let { put("model", it) }; pending.effort?.let { put("effort", it) }
        })
    }
    suspend fun operation(id: String): JsonObject = get("api/operations/" + encode(id))
    suspend fun interrupt(threadId: String, turnId: String): JsonObject = post("api/threads/" + encode(threadId) + "/interrupt",
        buildJsonObject { put("turnId", turnId) })
    suspend fun approve(id: String, decision: String? = null, answers: Map<String, String> = emptyMap()): JsonObject =
        post("api/approvals/" + encode(id), buildJsonObject {
            decision?.let { put("decision", it) }
            if (answers.isNotEmpty()) putJsonObject("answers") { answers.forEach { (key, value) -> put(key, value) } }
        })
    suspend fun favorite(id: String, pinned: Boolean): JsonObject =
        execute(if (pinned) "PUT" else "DELETE", "api/favorites/" + encode(id))
    suspend fun revoke(deviceId: String): JsonObject = execute("DELETE", "api/devices/" + encode(deviceId))

    fun mediaUrl(threadId: String, file: String): String = url("api/media", mapOf("threadId" to threadId, "file" to file)).toString()
    fun authorizedImageRequest(url: String): Request? {
        val parsed = url.toHttpUrlOrNull() ?: return null
        if (parsed.scheme != baseUrl.scheme || parsed.host != baseUrl.host || parsed.port != baseUrl.port || parsed.encodedPath != "/api/media") return null
        return Request.Builder().url(parsed).apply { token?.let { header("Authorization", "Bearer " + it) } }.build()
    }
    fun events(): Flow<JsonObject> = callbackFlow {
        val ticket = get<JsonObject>("api/ws-ticket")["ticket"]?.jsonPrimitive?.content ?: throw IOException("无法取得实时连接票据")
        val address = url("ws", mapOf("ticket" to ticket))
        val socket = client.newWebSocket(Request.Builder().url(address).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()?.let { trySend(it) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                close(IOException("实时连接中断，请检查 Tailscale 与电脑状态"))
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close(if (code == 1008) ApiException(401, "设备连接已失效，请重新配对") else null)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
        })
        awaitClose { socket.cancel() }
    }
    fun imageClient(): OkHttpClient = client

    private suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap()): T = execute("GET", path, query = query)
    private suspend inline fun <reified T> post(path: String, body: JsonObject, authenticated: Boolean = true): T =
        execute("POST", path, json.encodeToString(body), authenticated)
    private suspend inline fun <reified T> execute(
        method: String, path: String, body: String? = null, authenticated: Boolean = true,
        query: Map<String, String?> = emptyMap(),
    ): T = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url(path, query))
            .method(method, body?.toRequestBody(JSON) ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null)
            .apply { if (authenticated && token != null) header("Authorization", "Bearer " + token) }.build()
        client.newCall(request).execute().use { response ->
            val payload = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching { json.decodeFromString<ApiError>(payload).error }.getOrNull()
                throw ApiException(response.code, message ?: "电脑返回错误 (" + response.code + ")")
            }
            runCatching { json.decodeFromString<T>(payload) }.getOrElse { throw IOException("电脑返回的数据格式不正确", it) }
        }
    }
    private fun url(path: String, query: Map<String, String?> = emptyMap()): HttpUrl =
        (baseUrl.resolve(path) ?: throw IOException("电脑地址无效")).newBuilder().apply {
            query.forEach { (name, value) -> if (!value.isNullOrBlank()) addQueryParameter(name, value) }
        }.build()
    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS).readTimeout(70, TimeUnit.SECONDS)
            .callTimeout(80, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build()
        fun normalizeBaseUrl(input: String): HttpUrl {
            val value = input.trim().let { if ("://" in it) it else "http://" + it }.trimEnd('/') + "/"
            val url = value.toHttpUrlOrNull() ?: throw IOException("请输入有效的电脑地址，例如 http://100.x.x.x:4318")
            if (url.encodedUsername.isNotEmpty() || url.encodedPassword.isNotEmpty() ||
                url.encodedPath != "/" || url.query != null || url.fragment != null) throw IOException("电脑地址只填写主机和端口")
            if (url.scheme == "http" && !privateHost(url.host)) throw IOException("HTTP 只允许 Tailscale 或内网电脑地址；公网请使用 HTTPS")
            return url
        }
        private fun privateHost(host: String): Boolean {
            if (host == "localhost" || host == "::1" || host.endsWith(".ts.net") || host.endsWith(".local")) return true
            val ip = host.split('.').mapNotNull { it.toIntOrNull() }
            if (ip.size != 4 || ip.any { it !in 0..255 }) return host.startsWith("fd7a:115c:a1e0:", ignoreCase = true)
            return ip[0] == 127 || ip[0] == 10 || (ip[0] == 192 && ip[1] == 168) ||
                (ip[0] == 172 && ip[1] in 16..31) || (ip[0] == 100 && ip[1] in 64..127)
        }
        fun encode(value: String): String = HttpUrl.Builder().scheme("http").host("localhost").addPathSegment(value).build().encodedPath.drop(1)
    }
}
