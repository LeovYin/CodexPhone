package app.codexphone

import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.TextView
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.codexphone.ui.ConnectionErrorCard
import app.codexphone.ui.MarkdownMessage
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class LinksAndErrorsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun webLinksOpenBrowserWhileFilesAndUnsupportedLinksStayOnPhone() {
        val opened = AtomicReference<Intent>()
        compose.setContent {
            val context = LocalContext.current
            val intercepted = remember(context) { object : ContextWrapper(context) {
                override fun startActivity(intent: Intent) { opened.set(intent) }
            } }
            MaterialTheme { CompositionLocalProvider(LocalContext provides intercepted) {
                Column(Modifier.padding(20.dp)) { MarkdownMessage(
                    "[项目主页](https://example.org/project)\n\nhttps://example.org/docs\n\n[Main.kt](/workspace/Main.kt:12)\n\n[其他链接](intent://disabled)",
                    emptyList(), "fixture", null,
                ) }
            } }
        }
        compose.waitForIdle()
        tapNativeLink("项目主页")
        assertEquals(Intent.ACTION_VIEW, opened.get()?.action)
        assertEquals("https://example.org/project", opened.get()?.dataString)
        opened.set(null)
        tapNativeLink("https://example.org/docs")
        assertEquals("https://example.org/docs", opened.get()?.dataString)
        opened.set(null)
        tapNativeLink("文件 · 暂不支持打开")
        assertNull("File opening must remain unimplemented", opened.get())
        tapNativeLink("暂不支持此链接")
        assertNull(opened.get())
        screenshot("links-036-test.png")
    }

    @Test fun errorsExposeStageAndCopyableDiagnostics() {
        val error = "登录账号服务 失败（HTTP 502）：网关无法连接目标服务。\n收到非 JSON 网关响应，请检查代理与服务地址。\n诊断：登录账号服务 · HTTP 502 · 非 JSON 响应\n地址：http://100.64.0.1:4321\n请求：POST /v1/login"
        compose.setContent { MaterialTheme { Column(Modifier.padding(20.dp)) { ConnectionErrorCard(error) } } }
        compose.onNodeWithText("操作未完成").assertIsDisplayed()
        compose.onNodeWithText("登录账号服务 失败", substring = true).assertIsDisplayed()
        compose.onNodeWithText("查看诊断").performClick()
        compose.onNodeWithText("请求：POST /v1/login", substring = true).assertIsDisplayed()
        compose.onNodeWithText("复制错误信息").performClick()
        compose.onNodeWithText("已复制").assertExists()
        val clipboard = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(android.content.ClipboardManager::class.java)
        assertEquals(error, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        screenshot("error-036-test.png")
    }

    private fun tapNativeLink(label: String) {
        var clicked = false
        fun find(view: View): TextView? {
            if (view is TextView && view.text.contains(label)) return view
            return if (view is ViewGroup) (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) } else null
        }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val view = WindowInspector.getGlobalWindowViews().firstNotNullOfOrNull(::find) ?: error("Missing link: $label")
            assertTrue(view.linksClickable)
            assertTrue(view.movementMethod is LinkMovementMethod)
            val text = view.text as Spanned
            val span = text.getSpans(0, text.length, ClickableSpan::class.java).first { span ->
                text.subSequence(text.getSpanStart(span), text.getSpanEnd(span)).contains(label)
            }
            val offset = text.getSpanStart(span) + 1
            val line = view.layout.getLineForOffset(offset)
            val x = view.layout.getPrimaryHorizontal(offset) + view.totalPaddingLeft + 1
            val y = (view.layout.getLineTop(line) + view.layout.getLineBottom(line)) / 2f + view.totalPaddingTop
            val now = android.os.SystemClock.uptimeMillis()
            for ((index, action) in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).withIndex()) {
                val event = MotionEvent.obtain(now, now + index * 10L, action, x, y, 0)
                clicked = view.dispatchTouchEvent(event) || clicked
                event.recycle()
            }
        }
        assertTrue("Link touch was not handled: $label", clicked)
    }

    private fun screenshot(name: String) {
        compose.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            File(context.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
