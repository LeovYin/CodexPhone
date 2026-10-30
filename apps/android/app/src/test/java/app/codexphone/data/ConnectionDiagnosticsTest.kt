package app.codexphone.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

class ConnectionDiagnosticsTest {
    private fun fixedProxy(port: Int) = object : ProxySelector() {
        override fun select(uri: URI) = listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", port)))
        override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) = Unit
    }

    @Test fun privateRequestsBypassAnHttpProxyThatReturns502() = runBlocking {
        MockWebServer().use { computer -> MockWebServer().use { proxy ->
            proxy.enqueue(MockResponse().setResponseCode(502).setBody("<html>proxy cannot route private network</html>"))
            computer.enqueue(MockResponse().setBody("""{"status":"ready"}"""))
            val address = computer.url("/").newBuilder().host("127.0.0.1").build().toString()
            val system = fixedProxy(proxy.port)
            val oldClient = OkHttpClient.Builder().proxySelector(system).build()
            try { CodexPhoneApi(address, client = oldClient).health(); fail("Proxy must reproduce 502") }
            catch (error: ApiException) { assertEquals(502, error.code) }
            assertEquals(1, proxy.requestCount)
            assertEquals(0, computer.requestCount)
            assertEquals("ready", CodexPhoneApi(address, client = CodexPhoneApi.defaultClient(system)).health().status)
            assertEquals(1, computer.requestCount)
            assertEquals(1, proxy.requestCount)
        } }
    }

    @Test fun tailscaleAndLanBypassButPublicSitesKeepSystemProxy() {
        val system = fixedProxy(12345)
        val selector = PrivateNetworkProxySelector(system)
        listOf("100.64.0.1", "100.127.255.255", "192.168.2.1", "10.2.3.4", "172.16.1.1", "pc.tailnet.ts.net", "pc.local", "[fd7a:115c:a1e0::1]", "[::1]").forEach {
            assertEquals(it, listOf(Proxy.NO_PROXY), selector.select(URI("http://$it:4318")))
        }
        listOf("example.org", "100.128.0.1", "172.32.0.1", "100.63.255.255", "pc.ts.net.example.org").forEach {
            assertEquals(it, system.select(URI("https://$it")), selector.select(URI("https://$it")))
        }
    }

    @Test fun gatewayDiagnosticsIdentifyLoginAndComputerStagesWithoutLeakingPayload() = runBlocking {
        MockWebServer().use { server ->
            repeat(2) { server.enqueue(MockResponse().setResponseCode(502).setBody("<html>private-response-marker</html>")) }
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString())
            try { api.login("alice", "private-password-marker", "installation", "phone"); fail() }
            catch (error: ApiException) {
                assertEquals(502, error.code)
                assertTrue(error.message!!.contains("登录账号服务"))
                assertTrue(error.message!!.contains("POST /v1/login"))
                assertTrue(error.message!!.contains("非 JSON"))
                assertTrue(error.message!!.contains("代理"))
                assertFalse(error.message!!.contains("private-password-marker"))
                assertFalse(error.message!!.contains("private-response-marker"))
            }
            try { api.connectAccount("private-token-marker"); fail() }
            catch (error: ApiException) {
                assertTrue(error.message!!.contains("连接账号绑定的电脑"))
                assertTrue(error.message!!.contains("POST /api/account/connect"))
                assertFalse(error.message!!.contains("private-token-marker"))
            }
            assertEquals(2, server.requestCount) // POSTs are not automatically resubmitted.
        }
    }

    @Test fun jsonUpstreamFailureAndWrongPortRemainDistinct() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"账号服务未启动"}"""))
            server.enqueue(MockResponse().setBody("<html>wrong port</html>"))
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString())
            try { api.models(); fail() } catch (error: ApiException) {
                assertTrue(error.message!!.contains("加载 Codex 模型"))
                assertTrue(error.message!!.contains("账号服务未启动"))
                assertTrue(error.message!!.contains("503 · JSON"))
            }
            try { api.health(); fail() } catch (error: IOException) {
                assertTrue(error.message!!.contains("检查电脑连接"))
                assertTrue(error.message!!.contains("数据格式异常"))
            }
        }
    }
}
