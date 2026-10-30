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
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.webkit.WebView
import android.widget.TextView
import android.graphics.Rect
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class PhoneFlowTest {
    @get:Rule val compose = createComposeRule()
    private val server = MockWebServer()
    private lateinit var vm: PhoneViewModel
    private val submissions = CopyOnWriteArrayList<JsonObject>()
    private val queued = CopyOnWriteArrayList<JsonObject>()
    @Volatile private var guided = false
    private val sockets = CopyOnWriteArrayList<WebSocket>()
    @Volatile private var approvalPending = true
    @Volatile private var interrupted = false
    @Volatile private var showRunning = false
    @Volatile private var operationQueries = 0
    @Volatile private var longHistory = false
    @Volatile private var questionMode = false
    @Volatile private var loginGatewayFailure = false
    private val answers = CopyOnWriteArrayList<JsonObject>()
    private val requests = CopyOnWriteArrayList<String>()
    private val questionRequest = """{"id":"approval","threadId":"shared","turnId":"turn","kind":"question","title":"Codex 需要你的回答","detail":"","canAccept":true,"questions":[{"id":"platform","question":"选择客户端","secret":false,"options":[{"label":"原生安卓","description":"Kotlin"},{"label":"网页","description":"浏览器"}]},{"id":"notes","question":"补充要求","secret":false,"options":[]}]}"""
    private val request = """{"id":"approval","threadId":"shared","turnId":"turn","kind":"command","title":"允许执行测试命令？","detail":"echo fixture","canAccept":true,"questions":[]}"""
    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.getSharedPreferences("device-connection", 0).edit().clear().commit()
        File(app.filesDir, "connections").deleteRecursively()
        listOf("conversation-cache.enc", "submission-journal.enc", "last-crash.txt", "previous-crash.txt").forEach { name ->
            android.util.AtomicFile(File(app.filesDir, name)).delete()
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                val path = r.path.orEmpty().substringBefore('?')
                requests.add(r.method + " " + path)
                if (path == "/v1/login" && loginGatewayFailure) return MockResponse().setResponseCode(502)
                    .setHeader("Content-Type", "text/html").setBody("<html>fixture upstream unavailable</html>")
                if (path == "/ws") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                        sockets.add(webSocket); webSocket.send("""{"type":"connected","deviceId":"device"}""")
                    }
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                })
                if (path != "/api/health" && path != "/api/pair" && path != "/v1/login" && path != "/api/account/connect" && r.getHeader("Authorization") != "Bearer fixture-token") return MockResponse().setResponseCode(401).setBody("""{"error":"not paired"}""")
                val body = when {
                    path == "/api/health" -> """{"status":"ready","model":"fixture-model","provider":"local-fixture","codexVersion":"fixture","transport":"websocket"}"""
                    path == "/v1/login" -> """{"token":"account-token","expiresAt":9999999999999,"account":{"id":"fixture-account","username":"fixture-user"},"host":{"id":"host","name":"电脑","url":"${server.url("/").newBuilder().host("127.0.0.1").build()}"}}"""
                    path == "/api/account/connect" -> """{"token":"fixture-token","deviceId":"device"}"""
                    path == "/api/pair" -> """{"token":"fixture-token","deviceId":"device"}"""
                    path == "/api/capabilities" -> """{"hostVersion":"0.2.1","protocolVersion":1,"capabilities":["idempotent-send","global-approvals","message-queue"]}"""
                    path == "/api/projects" -> """{"projects":[{"id":"project","name":"测试项目","canStart":true}]}"""
                    path == "/api/models" -> """{"defaultModel":"fixture-model","models":[{"id":"fixture-model","name":"测试模型","efforts":["low","high"],"defaultEffort":"low"}]}"""
                    path == "/api/ws-ticket" -> """{"ticket":"one-use-ticket"}"""
                    path.startsWith("/api/operations/") -> { operationQueries++; """{"state":"completed","result":{"threadId":"shared","turnId":"turn"}}""" }
                    path.endsWith("/queue/queued/guide") -> { guided = true; queued.clear(); """{"threadId":"shared"}""" }
                    path.endsWith("/queue") && r.method == "POST" -> {
                        val payload = Json.parseToJsonElement(r.body.readUtf8()).jsonObject
                        queued.add(buildJsonObject { put("id", "queued"); put("threadId", "shared"); put("prompt", payload["prompt"]!!); put("state", "queued") })
                        """{"threadId":"shared","queueId":"queued"}"""
                    }
                    path.endsWith("/queue") -> buildJsonObject { put("messages", JsonArray(queued.toList())) }.toString()
                    path == "/api/approvals" -> """{"approvals":[""" + (if (approvalPending) (if (questionMode) questionRequest else request) else "") + "]}"
                    path == "/api/approvals/approval" -> {
                        if (questionMode) answers.add(Json.parseToJsonElement(r.body.readUtf8()).jsonObject)
                        approvalPending = false; showRunning = false
                        """{"threadId":"shared"}"""
                    }
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
        DeviceCredentialStore(app).saveSession(server.url("/").newBuilder().host("127.0.0.1").build().toString(), "fixture-token", "device")
        vm = PhoneViewModel(app)
        compose.setContent { MaterialTheme { CodexPhoneApp(vm) } }
        vm.setForeground(true)
    }
    private fun detail(): String {
        if (longHistory) return buildJsonObject {
            putJsonObject("thread") { put("id", "shared"); put("name", "共享测试任务"); put("canControl", true) }
            putJsonArray("turns") { repeat(30) { index -> add(buildJsonObject {
                put("id", "history-$index")
                putJsonArray("items") { add(buildJsonObject {
                    put("id", "message-$index"); put("type", "userMessage")
                    put("text", if (index == 29) "最新对话标记" else "历史对话第 $index 轮\n" + "用于验证长对话定位。\n".repeat(3))
                }) }
            }) } }
        }.toString()
        val items = buildJsonArray {
            add(buildJsonObject { put("id", "intro"); put("type", "agentMessage"); put("text", "# 原生测试\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```mermaid\nflowchart TD\n A[Phone] --> B[Computer]\n```\n") })
            submissions.forEachIndexed { index, message -> add(buildJsonObject { put("id", "user-" + index); put("type", "userMessage"); put("text", message["prompt"]!!.jsonPrimitive.content) }) }
        }
        return buildJsonObject {
            putJsonObject("thread") { put("id", "shared"); put("name", "共享测试任务"); put("model", "fixture-model"); put("canControl", true); if (showRunning) put("activeTurnId", "turn") }
            put("model", "fixture-model"); put("effort", "low")
            putJsonArray("turns") { add(buildJsonObject { put("id", "turn"); put("items", items) }) }
        }.toString()
    }
    private fun connected() { compose.waitUntil(20000) { vm.state.value.threads.isNotEmpty() || vm.state.value.error != null }; Assert.assertTrue(vm.state.value.error ?: "Fixture did not connect", vm.state.value.threads.isNotEmpty()) }
    @Test fun taskFiltersExplainEmptyStatesAndReturnToAllTasks() {
        connected()
        compose.onNodeWithText("运行中", useUnmergedTree = true).performClick()
        compose.onNodeWithText("当前没有运行中的任务").assertExists()
        compose.onNodeWithText("收藏", useUnmergedTree = true).performClick()
        compose.onNodeWithText("还没有收藏对话").assertExists()
        compose.onNodeWithText("全部", useUnmergedTree = true).performClick()
        compose.onNodeWithText("共享测试任务").assertExists()
    }
    @Test fun loginPageExplainsAccountPort() {
        connected()
        compose.runOnIdle { vm.forgetLocally() }
        compose.waitUntil(5000) { !vm.state.value.paired }
        compose.onNodeWithText("账号服务地址").assertExists()
        screenshot("login-page-test.png")
    }
    @Test fun login502ShowsAccountStageAndDiagnosticsWithoutCrashing() {
        connected()
        compose.runOnIdle {
            vm.forgetLocally()
            vm.editAccounts(server.url("/").newBuilder().host("127.0.0.1").build().toString())
            loginGatewayFailure = true
            vm.login("fixture-account", "fixture-password")
        }
        compose.waitUntil(15000) { vm.state.value.error != null && !vm.state.value.busy }
        Assert.assertFalse(vm.state.value.paired)
        Assert.assertTrue(vm.state.value.error.orEmpty().contains("登录账号服务"))
        Assert.assertTrue(vm.state.value.error.orEmpty().contains("HTTP 502"))
        compose.onNodeWithText("操作未完成").assertIsDisplayed()
        compose.onNodeWithText("查看诊断").performClick()
        compose.onNodeWithText("POST /v1/login", substring = true).assertExists()
        screenshot("login-error-036-test.png")
    }
    @Test fun disconnectAndSwitchAddressKeepsTasksAndRestoresTheSameComputerDraft() {
        connected()
        val origin = server.url("/").newBuilder().host("127.0.0.1").build().toString()
        compose.runOnIdle { vm.disconnectServer(); vm.editAccounts(origin); vm.editComputerUrl(origin); vm.login("fixture-user", "fixture-password") }
        compose.waitUntil(15000) { vm.state.value.paired && !vm.state.value.busy }
        compose.runOnIdle { vm.openThread("shared") }
        compose.waitUntil(10000) { vm.state.value.selectedThread != null }
        compose.runOnIdle { vm.editDraft("局域网切换后继续写"); vm.closeThread() }
        compose.onNodeWithText("设置", useUnmergedTree = true).performClick()
        screenshot("settings-037-test.png")
        compose.onNodeWithText("断开服务器").performScrollTo().performClick()
        compose.waitUntil(5000) { !vm.state.value.paired }
        compose.onNodeWithText("账号服务地址").assertExists()
        compose.onNodeWithText("电脑任务地址（可选）").assertExists()
        screenshot("disconnect-037-test.png")
        val app = ApplicationProvider.getApplicationContext<Application>()
        Assert.assertTrue(DeviceCredentialStore(app).connectionPaused)
        val restored = PhoneViewModel(app)
        Assert.assertFalse("Paused connections must not reconnect after process restart", restored.state.value.paired)
        MockWebServer().use { alternate ->
            // The registered desktop address is deliberately unreachable. The phone's
            // selected entry must control the route, without changing global binding.
            alternate.enqueue(MockResponse().setBody("""{"token":"account-token","expiresAt":9999999999999,"account":{"id":"fixture-account","username":"fixture-user"},"host":{"id":"host","name":"电脑","url":"http://127.0.0.1:1"}}"""))
            alternate.start()
            val alternateOrigin = alternate.url("/").newBuilder().host("127.0.0.1").build().toString()
            compose.runOnIdle {
                restored.editAccounts(alternateOrigin)
                restored.editComputerUrl(origin); restored.login("fixture-user", "fixture-password")
            }
            compose.waitUntil(15000) { restored.state.value.paired && !restored.state.value.busy || restored.state.value.error != null }
            Assert.assertTrue(restored.state.value.error, restored.state.value.paired)
            compose.runOnIdle { restored.openThread("shared") }
            compose.waitUntil(10000) { restored.state.value.selectedThread != null }
            Assert.assertEquals("局域网切换后继续写", restored.state.value.draft)
            Assert.assertEquals(2, restored.state.value.rememberedServers.size)
            Assert.assertEquals(origin, restored.state.value.hostUrl)
            Assert.assertTrue(requests.none { it == "POST /v1/logout" || it.startsWith("DELETE /api/devices/") || it.endsWith("/interrupt") })
            Assert.assertEquals("/v1/login", alternate.takeRequest().path)
            restored.disconnectServer()
        }
    }
    @After fun cleanup() {
        vm.setForeground(false)
        // MockWebServer owns accepted sockets; cancel() expects a client Call.
        sockets.forEach { it.close(1000, "Test complete") }
        server.shutdown()
    }
    @Test fun agentQuestionAppearsOnTaskListAndAnswerUnblocksTask() {
        questionMode = true; showRunning = true
        connected()
        compose.waitUntil(15000) { vm.state.value.approvals.any { it.kind == "question" } || vm.state.value.error != null }
        Assert.assertTrue("Question was not received; error=${vm.state.value.error}, HTTP requests=${server.requestCount}", vm.state.value.approvals.any { it.kind == "question" })
        compose.onNodeWithText("提交回答").assertIsNotEnabled()
        compose.onNodeWithText("原生安卓").performClick()
        compose.onAllNodesWithText("你的回答").onLast().performTextInput("继续执行，不要中断")
        screenshot("agent-question-test.png")
        compose.onNodeWithText("提交回答").performClick()
        compose.waitUntil(15000) { answers.size == 1 && vm.state.value.approvals.isEmpty() }
        Assert.assertEquals("原生安卓", answers[0]["answers"]!!.jsonObject["platform"]!!.jsonPrimitive.content)
        Assert.assertEquals("继续执行，不要中断", answers[0]["answers"]!!.jsonObject["notes"]!!.jsonPrimitive.content)
        Assert.assertTrue(submissions.isEmpty())
        compose.onNodeWithText("共享测试任务").performClick()
        compose.waitUntil(15000) { vm.state.value.selectedThread != null }
        Assert.assertNull(vm.state.value.selectedThread!!.thread.activeTurnId)
    }
    @Test fun pairReadSendSelectApproveInterruptAndRestoreDraft() {
        connected()
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
        compose.onNodeWithText("发送后排队，可点击引导干预…").performTextInput("排队后手动引导")
        compose.onNodeWithContentDescription("排队发送").performClick()
        compose.waitUntil(15000) { vm.state.value.queued.size == 1 && vm.state.value.pending == null }
        Assert.assertEquals(1, submissions.size)
        compose.onNodeWithText("引导", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("排队消息 1 · 展开").performClick()
        screenshot("queue-test.png")
        compose.onNodeWithText("引导", useUnmergedTree = true).performClick()
        compose.waitUntil(15000) { guided && vm.state.value.queued.isEmpty() && vm.state.value.pending == null }
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
    @Test fun bundledMermaidRendersWithoutExternalRequests() {
        connected()
        compose.onNodeWithText("共享测试任务").performClick()
        compose.waitUntil(15000) { vm.state.value.selectedThread != null }
        val rendered = AtomicReference("false")
        fun webViews(view: View): List<WebView> = if (view is WebView) listOf(view) else if (view is ViewGroup) (0 until view.childCount).flatMap { webViews(view.getChildAt(it)) } else emptyList()
        compose.waitUntil(20000) {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                WindowInspector.getGlobalWindowViews().flatMap(::webViews).forEach { web ->
                    web.evaluateJavascript("document.querySelectorAll('#chart svg').length > 0") { rendered.set(it) }
                }
            }
            rendered.get() == "true"
        }
        screenshot("mermaid-test.png")
    }
    @Test fun longConversationOpensAtLatestAndNavigationJumpsBothWays() {
        longHistory = true
        connected()
        compose.onNodeWithText("共享测试任务").performClick()
        compose.waitUntil(15000) { vm.state.value.selectedThread != null }
        screenshot("long-history-test.png")
        waitForNativeText("最新对话标记")
        compose.onNodeWithContentDescription("对话导航").performClick()
        screenshot("navigation-test.png")
        compose.onNodeWithText("第 1 轮", useUnmergedTree = true).performClick()
        waitForNativeText("历史对话第 0 轮")
        compose.onNodeWithContentDescription("对话导航").performClick()
        compose.onNodeWithText("跳到最新消息").performClick()
        waitForNativeText("最新对话标记")
    }
    // Markwon uses native TextViews; Compose semantics bounds do not reliably
    // represent these interop children. Check the actual clipped native bounds.
    private fun waitForNativeText(text: String) {
        fun visible(view: View): Boolean {
            if (view is TextView && view.text.contains(text) && view.isShown) {
                val bounds = Rect()
                if (view.getGlobalVisibleRect(bounds) && bounds.width() > 0 && bounds.height() > 0) return true
            }
            return view is ViewGroup && (0 until view.childCount).any { visible(view.getChildAt(it)) }
        }
        compose.waitUntil(10000) {
            var found = false
            InstrumentationRegistry.getInstrumentation().runOnMainSync { found = WindowInspector.getGlobalWindowViews().any(::visible) }
            found
        }
    }
    private fun screenshot(name: String) {
        compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap().let { bitmap ->
            val app = ApplicationProvider.getApplicationContext<Application>()
            File(app.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
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
