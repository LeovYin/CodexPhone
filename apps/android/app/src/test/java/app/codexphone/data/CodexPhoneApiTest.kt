package app.codexphone.data

import app.codexphone.ui.applyDelta
import app.codexphone.ui.mergeHistory
import app.codexphone.ui.splitMermaidBlocks
import app.codexphone.ui.splitMessageAssets
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class CodexPhoneApiTest {
    @Test fun mermaidBlocksSeparateFromTextAndIncompleteStreamingFencesStayText() {
        val blocks = splitMermaidBlocks("hello\n```mermaid\nflowchart TD\n A-->B\n```\nend")
        assertEquals(listOf(false, true, false), blocks.map { it.diagram })
        assertTrue(blocks[1].text.startsWith("flowchart"))
        assertFalse(splitMermaidBlocks("```mermaid\nflowchart TD\n A").any { it.diagram })
    }
    @Test fun refreshPreservesLoadedEarlierPagesAndUpdatesLatestTurn() {
        val current = ThreadDetail(ThreadSummary("a"), listOf(ThreadTurn("old"), ThreadTurn("latest", "inProgress")), nextCursor = "older-page")
        val fresh = ThreadDetail(ThreadSummary("a"), listOf(ThreadTurn("latest", "completed"), ThreadTurn("new")), nextCursor = "first-page")
        val merged = mergeHistory(current, fresh, true)
        assertEquals(listOf("old", "latest", "new"), merged.turns.map { it.id })
        assertEquals("completed", merged.turns[1].status)
        assertEquals("older-page", merged.nextCursor)
        assertEquals(fresh, mergeHistory(current, fresh, false))
    }
    @Test fun pairingUsesConcreteJsonAndNoBearer() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"token":"fixture-token","deviceId":"fixture-device"}"""))
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString(), "old-token")
            val response = api.pair("one-use-code", "Test Android")
            assertEquals("fixture-device", response.deviceId)
            val request = server.takeRequest()
            assertEquals("/api/pair", request.path)
            assertNull(request.getHeader("Authorization"))
            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("one-use-code", body["code"]?.jsonPrimitive?.content)
        }
    }
    @Test fun loginExplainsWhenThePhoneBridgePortIsUsedForAccountLogin() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}"""))
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString())
            try {
                api.login("alice", "secret", "fixture-installation", "Test phone")
                fail("A bridge port does not expose the account login endpoint")
            } catch (error: IOException) {
                assertTrue(error.message.orEmpty().contains("4321"))
                assertTrue(error.message.orEmpty().contains("4318"))
            }
            assertEquals("/v1/login", server.takeRequest().path)
        }
    }
    @Test fun submissionRetainsRequestIdentityAndSelection() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"threadId":"shared-thread"}"""))
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString(), "fixture-token")
            val pending = PendingSubmission("12345678-request-id", "shared-thread", null, "你好\n继续", "custom-model", "high")
            api.submit(pending)
            val request = server.takeRequest()
            assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
            assertEquals("/api/threads/shared-thread/turns", request.path)
            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals(pending.requestId, body["clientRequestId"]?.jsonPrimitive?.content)
            assertEquals("high", body["effort"]?.jsonPrimitive?.content)
            assertEquals(pending.prompt, body["prompt"]?.jsonPrimitive?.content)
        }
    }
    @Test fun noRedirectAndNoCredentialLeakToImages() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "http://localhost:1/steal"))
            val api = CodexPhoneApi(server.url("/").newBuilder().host("127.0.0.1").build().toString(), "fixture-token")
            try { api.health(); fail("Redirect must not be followed") } catch (e: ApiException) { assertEquals(302, e.code) }
            assertNull(api.authorizedImageRequest("https://example.org/api/media"))
            assertNull(api.authorizedImageRequest(server.url("/other").newBuilder().host("127.0.0.1").build().toString()))
            assertNotNull(api.authorizedImageRequest(api.mediaUrl("thread", "assets/a.svg")))
        }
    }
    @Test fun validatesHostAndEncodesThreadKeys() {
        assertThrows(IOException::class.java) { CodexPhoneApi.normalizeBaseUrl("http://example.org") }
        assertThrows(IOException::class.java) { CodexPhoneApi.normalizeBaseUrl("https://user:password@example.org") }
        assertThrows(IOException::class.java) { CodexPhoneApi.normalizeBaseUrl("http://100.64.0.1:4318/path") }
        assertEquals("100.64.0.1", CodexPhoneApi.normalizeBaseUrl("100.64.0.1:4318").host)
        assertEquals("a%2Fb%20c", CodexPhoneApi.encode("a/b c"))
    }
    @Test fun liveMessagesRemainIsolatedAndAccumulate() {
        val detail = ThreadDetail(ThreadSummary("a"), listOf(ThreadTurn("turn")))
        assertSame(detail, applyDelta(detail, "b", "turn", "item", "wrong"))
        val first = applyDelta(detail, "a", "turn", "item", "hello")
        val second = applyDelta(first, "a", "turn", "item", " world")
        assertEquals("hello world", second?.turns?.first()?.items?.first()?.text)
    }
    @Test fun extractsSvgAndPreservesCodeAndTables() {
        val assets = splitMessageAssets("# 标题\n![图](assets/chart.svg)\n| A | B |\n|---|---|\n| 1 | 2 |", listOf("assets/chart.svg"))
        assertEquals(listOf("assets/chart.svg"), assets.images)
        assertTrue(assets.markdown.contains("| A | B |"))
        assertFalse(assets.markdown.contains("![图]"))
    }
}
