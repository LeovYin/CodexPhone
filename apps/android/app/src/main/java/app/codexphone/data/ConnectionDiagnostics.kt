package app.codexphone.data

import okhttp3.HttpUrl
import java.io.IOException
import java.net.ConnectException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.util.Locale
import javax.net.ssl.SSLException

internal fun isPrivateHost(value: String): Boolean {
    val host = value.removePrefix("[").removeSuffix("]").lowercase(Locale.ROOT)
    if (host == "localhost" || host == "::1" || host.endsWith(".ts.net") || host.endsWith(".local")) return true
    if (host.startsWith("fd7a:115c:a1e0:")) return true
    val parts = host.split('.')
    val ip = parts.mapNotNull { it.toIntOrNull() }
    if (parts.size != 4 || ip.size != 4 || ip.any { it !in 0..255 }) return false
    return ip[0] == 127 || ip[0] == 10 || (ip[0] == 192 && ip[1] == 168) ||
        (ip[0] == 172 && ip[1] in 16..31) || (ip[0] == 100 && ip[1] in 64..127)
}

/** System HTTP proxies often cannot route a phone's Tailscale/private network. */
internal class PrivateNetworkProxySelector(private val system: ProxySelector?) : ProxySelector() {
    override fun select(uri: URI): List<Proxy> =
        if (isPrivateHost(uri.host.orEmpty())) listOf(Proxy.NO_PROXY)
        else system?.select(uri)?.takeIf { it.isNotEmpty() } ?: listOf(Proxy.NO_PROXY)

    override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {
        if (!isPrivateHost(uri.host.orEmpty())) system?.connectFailed(uri, sa, ioe)
    }
}

/** Never includes query strings, request bodies, credentials, or response HTML. */
internal class RequestContext(private val method: String, path: String, url: HttpUrl) {
    private val segments = path.substringBefore('?').split('/')
    private val route = segments.mapIndexed { index, part ->
        if (index > 0 && segments[index - 1] in listOf("threads", "operations", "approvals", "devices", "favorites", "hosts", "queue")) ":id" else part
    }.joinToString("/")
    private val origin = url.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().trimEnd('/')
    val stage: String = when {
        path == "v1/login" -> "登录账号服务"
        path == "v1/logout" -> "退出账号"
        path == "api/account/connect" -> "连接账号绑定的电脑"
        path == "api/health" -> "检查电脑连接"
        path == "api/models" -> "加载 Codex 模型"
        path == "api/projects" -> "加载项目"
        path == "api/capabilities" -> "检查电脑功能"
        path == "api/ws-ticket" || path == "ws" -> "建立实时连接"
        path.startsWith("api/operations/") -> "查询发送结果"
        path.startsWith("api/approvals") -> "同步或回答 Agent 问题"
        path.startsWith("api/threads") && method != "GET" -> "发送或管理对话"
        path.startsWith("api/threads") -> "加载对话"
        else -> "访问电脑服务"
    }

    private fun diagnostic(status: String) = "诊断：$stage · $status\n地址：$origin\n请求：$method /$route"

    fun http(code: Int, serverMessage: String?, jsonResponse: Boolean): ApiException {
        val title = when (code) {
            401 -> if (route == "v1/login") "账号或密码不正确，或账号登录已失效" else "登录或设备授权已失效"
            403 -> "当前账号或设备没有操作权限"
            404 -> "该服务没有此接口"
            409 -> "当前连接或任务状态存在冲突"
            429 -> "请求过于频繁"
            502 -> "网关无法连接目标服务"
            503 -> "目标服务暂不可用"
            504 -> "网关等待目标服务超时"
            in 300..399 -> "服务要求跳转到其他地址"
            else -> "服务未完成请求"
        }
        val hint = when {
            code in 300..399 -> "请填写最终服务地址，检查 HTTP / HTTPS 配置。"
            code == 401 && route == "v1/login" -> "请核对电脑管理中心创建的账号和密码。"
            code == 401 -> "请退出后重新登录；如仍失败，在电脑管理中心检查设备授权。"
            code == 403 -> "请在电脑管理中心检查设备是否被禁用或仅允许读取。"
            code == 404 && route == "v1/login" -> "账号服务默认端口为 4321，4318 是电脑任务端口。"
            code == 429 -> "请稍后再试。"
            code in 502..504 && !jsonResponse -> "收到非 JSON 的网关响应，可能来自代理、反向代理或错误端口。请检查手机代理/VPN 的 Tailscale 绕过规则，以及电脑管理中心的服务地址。"
            code in 502..504 -> "请在电脑管理中心检查账号服务、共享连接及 Codex 的状态；电脑浏览器正常不代表手机能访问同一地址。"
            else -> "请检查电脑管理中心及服务地址，然后重试。"
        }
        val detail = serverMessage?.trim()?.take(500)?.takeIf { it.isNotBlank() }
        return ApiException(code, "$stage 失败（HTTP $code）：${detail ?: title}。\n$hint\n${diagnostic("HTTP $code · " + if (jsonResponse) "JSON 响应" else "非 JSON 响应")}")
    }

    fun invalidData(cause: Throwable): IOException = IOException(
        "$stage 失败：返回的数据不是兼容的 CodexPhone 数据。请检查端口、反向代理和电脑端版本。\n${diagnostic("数据格式异常")}", cause,
    )

    fun network(cause: IOException): IOException {
        val reason = when (cause) {
            is UnknownHostException -> "无法解析服务器名称。请开启 Tailscale，或改用管理中心显示的 Tailscale IP。"
            is ConnectException -> "无法建立连接。请确认电脑服务已启动，手机能访问该端口，并检查防火墙与 Tailscale。"
            is SocketTimeoutException -> "连接或读取超时。请检查 Tailscale、服务状态和防火墙；发送过的消息请先查询状态。"
            is SSLException -> "HTTPS 证书或协议不匹配。请核对地址和证书；内网 HTTP 服务应填写 http://。"
            else -> "连接中断或响应未完整收到。请检查网络与服务状态；发送过的消息请先查询状态。"
        }
        return IOException("$stage 失败：$reason\n${diagnostic(cause.javaClass.simpleName)}", cause)
    }
}
