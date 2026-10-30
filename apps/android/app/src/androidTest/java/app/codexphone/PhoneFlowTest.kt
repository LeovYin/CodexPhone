package app.codexphone

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.graphics.asAndroidBitmap
import android.graphics.Bitmap
import app.codexphone.data.DeviceCredentialStore
import app.codexphone.data.ConversationStore
import app.codexphone.data.PendingSubmission
import app.codexphone.ui.CodexPhoneApp
import app.codexphone.ui.PhoneViewModel
import kotlinx.serialization.json.*
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.io.File

@RunWith(AndroidJUnit4::class)
class PhoneFlowTest {
    @get:Rule val compose = createComposeRule()
    private val server = MockWebServer()
    private lateinit var vm: PhoneViewModel
    private val submissions = CopyOnWriteArrayList<JsonObject>()
    private val sockets = CopyOnWriteArrayList<WebSocket>()
    @Volatile private var approvalPending = true
    @Volatile private var interrupted = false
    @Volatile private var showRunning = false
    @Volatile private var operationQueries = 0
    private val request = """{"id":"approval","threadId":"shared","turnId":"turn","kind":"command","title":"允许执行测试命令？","detail":"echo fixture","canAccept":true,"questions":[]}"""
    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("device-connection", 0).edit().clear().commit()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.path.orEmpty().substringBefore('?')
                if (path == "/ws") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                        sockets.add(webSocket); webSocket.send("""{"type":"connected","deviceId":"device"}""")
                    }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                })
                if (path != "/api/health" && path != "/api/pair" && r.getHeader("Authorization") != "Bearer fixture-token") return MockResponse().setResponseCode(401).setBody("""{"error":"not paired"}""")
                val body = when {
                    path == "/api/health" -> """{"status":"ready","model":"fixture-model","provider":"local-fixture","codexVersion":"fixture","transport":"websocket"}"""
                    path == "/api/pair" -> """{"token":"fixture-token","deviceId":"device"}"""
                    path == "/api/capabilities" -> """{"hostVersion":"0.2.0","protocolVersion":1,"capabilities":["idempotent-send","global-approvals"]}"""
                    path == "/api/projects" -> """{"projects":[{"id":"project","name":"测试项目","canStart":true}]}"""
                    path == "/api/models" -> """{"defaultModel":"fixture-model","models":[{"id":"fixture-model","name":"测试模型","efforts":["low","high"],"defaultEffort":"low"}]}"""
                    path == "/api/ws-ticket" -> """{"ticket":"one-use-ticket"}"""
                    path.startsWith("/api/operations/") -> { operationQueries++; """{"state":"completed","result":{"threadId":"shared","turnId":"turn"}}""" }
                    path == "/api/approvals" -> """{"approvals":[""" + (if (approvalPending) request else "") + "]}"
                    path == "/api/approvals/approval" -> { approvalPending = false; """{"threadId":"shared"}""" }
                    path.endsWith("/interrupt") -> { interrupted = true; showRunning = false; "{}" }
                    r.method == "POST" && (path == "/api/threads" || path.endsWith("/turns") || path.endsWith("/steer")) -> {
                        val payload = Json.parseToJsonElement(r.body.readUtf8()).jsonObject; submissions.add(payload)
                        showRunning = true
                        sockets.forEach { it.send("""{"type":"refresh-thread","threadId":"shared"}""") }
                        """{"threadId":"shared","turnId":"turn"}"""
                    }
                    path == "/api/threads" -> """{"threads":[{"id":"shared","name":"共享测试任务","preview":"电脑上创建的任务","model":"fixture-model"}],"nextCursor":null}"""
                    path == "/api/threads/shared" -> detail()
                    else -> "{}"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
        vm = PhoneViewModel(app)
        compose.setContent { MaterialTheme { CodexPhoneApp(vm) } }
        vm.setForeground(true)
    }
    private fun detail(): String {
        val items = buildJsonArray {
            add(buildJsonObject { put("id", "intro"); put("type", "agentMessage"); put("text", "# 原生测试\n\n| A | B |\n|---|---|\n| 1 | 2 |") })
            submissions.forEachIndexed { index, message -> add(buildJsonObject { put("id", "user-" + index); put("type", "userMessage"); put("text", message["prompt"]!!.jsonPrimitive.content) }) }
        }
        return buildJsonObject {
            putJsonObject("thread") { put("id", "shared"); put("name", "共享测试任务"); put("model", "fixture-model"); put("canControl", true); if (showRunning) put("activeTurnId", "turn") }
            put("model", "fixture-model"); put("effort", "low")
            putJsonArray("turns") { add(buildJsonObject { put("id", "turn"); put("items", items) }) }
        }.toString()
    }
    @After fun cleanup() {
        vm.setForeground(false)
        // MockWebServer owns accepted sockets; cancel() expects a client Call.
        sockets.forEach { it.close(1000, "Test complete") }
        server.shutdown()
    }
    @Test fun pairReadSendSelectApproveInterruptAndRestoreDraft() {
        compose.onNodeWithText("电脑地址").performTextInput(server.url("/").newBuilder().host("127.0.0.1").build().toString())
        compose.onNodeWithText("一次性配对码").performTextInput("fixture-code")
        compose.onNodeWithText("配对并连接").performClick()
        compose.waitUntil(20000) { vm.state.value.threads.isNotEmpty() }
        compose.onNodeWithText("共享测试任务").performClick()
        compose.waitUntil(10000) { vm.state.value.selectedThread != null }
        compose.onNodeWithText("fixture-model").performClick()
        compose.onNodeWithText("high").performClick()
        compose.onNodeWithText("完成").performClick()
        compose.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            val app = ApplicationProvider.getApplicationContext<Application>()
            File(app.filesDir, "conversation-test.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        compose.onNodeWithText("输入消息，回车换行…").performTextInput("手机测试\n第二行")
        compose.onNodeWithContentDescription("发送消息").performClick()
        compose.waitUntil(15000) { submissions.size == 1 && vm.state.value.pending == null && vm.state.value.selectedThread?.thread?.activeTurnId != null }
        Assert.assertEquals("手机测试\n第二行", submissions[0]["prompt"]!!.jsonPrimitive.content)
        Assert.assertEquals("high", submissions[0]["effort"]!!.jsonPrimitive.content)
        Assert.assertTrue(submissions[0]["clientRequestId"]!!.jsonPrimitive.content.length >= 16)
        compose.onNodeWithContentDescription("中断任务").performClick()
        compose.onNodeWithText("中断", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { interrupted && vm.state.value.selectedThread?.thread?.activeTurnId == null }
        compose.onNodeWithText("输入消息，回车换行…").performTextInput("保存草稿")
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("待处理").performClick()
        compose.onNodeWithText("允许本次").performClick()
        compose.waitUntil(10000) { vm.state.value.approvals.isEmpty() }
        compose.onNodeWithText("任务", useUnmergedTree = true).performClick()
        compose.onNodeWithText("共享测试任务").performClick()
        compose.waitUntil(10000) { vm.state.value.draft == "保存草稿" }
        compose.onNodeWithText("保存草稿").assertExists()
    }
    @Test fun durablePendingReconcilesAfterClientRecreationWithoutResending() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val credentials = DeviceCredentialStore(app)
        credentials.saveSession(server.url("/").newBuilder().host("127.0.0.1").build().toString(), "fixture-token", "device")
        val store = ConversationStore(credentials)
        store.draft("shared", "已送达但手机未收到响应")
        store.pending(PendingSubmission("fixture-persisted-request-0001", "shared", null, "已送达但手机未收到响应", "fixture-model", "high"))
        val restored = PhoneViewModel(app)
        Assert.assertNotNull(restored.state.value.pending)
        restored.setForeground(true)
        compose.waitUntil(15000) { operationQueries > 0 && restored.state.value.pending == null }
        Assert.assertTrue(submissions.isEmpty())
        Assert.assertNull(ConversationStore(credentials).data.pending)
        Assert.assertEquals("", ConversationStore(credentials).draft("shared"))
        restored.setForeground(false)
    }
}
