package app.codexphone.ui

import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Link
import org.commonmark.node.Text
import org.commonmark.parser.Parser
import org.junit.Assert.*
import org.junit.Test

class MessageLinksTest {
    @Test fun distinguishesWebFileAndUnsupportedSchemes() {
        listOf("https://example.org/path?q=a", "HTTP://example.org", "https://example.org/#section").forEach {
            assertEquals(it, MessageLinkKind.WEB, messageLinkKind(it))
        }
        listOf("/workspace/src/main.kt:12", "D:/project/main.kt:12", "D:\\project\\main.kt", "file:///tmp/test.txt", "sandbox:/tmp/report.pdf", "src/main.kt", "README.md").forEach {
            assertEquals(it, MessageLinkKind.FILE, messageLinkKind(it))
        }
        listOf("javascript:alert(1)", "intent://app", "content://private", "#section", "https://", "//example.org").forEach {
            assertEquals(it, MessageLinkKind.UNSUPPORTED, messageLinkKind(it))
        }
    }

    @Test fun marksFilesAndAutolinksProseWithoutChangingCodeOrExistingLabels() {
        val document = prepareMessageLinks(Parser.builder().build().parse("""
            [网站](https://example.org) [源码](/workspace/app.kt:12) [不可执行](javascript:alert)

            访问 https://example.org/a_(b)。另见 https://example.org/test).

            `https://inline-code.example.org`

            ```text
            https://fenced-code.example.org
            [源码](/workspace/code.kt)
            ```
        """.trimIndent()))
        val links = mutableListOf<Link>()
        val text = StringBuilder()
        document.accept(object : AbstractVisitor() {
            override fun visit(link: Link) { links.add(link); visitChildren(link) }
            override fun visit(node: Text) { text.append(node.literal) }
        })
        assertEquals(5, links.size)
        assertEquals("网站", (links[0].firstChild as Text).literal)
        assertTrue(text.contains("源码 〔文件 · 暂不支持打开〕"))
        assertTrue(text.contains("不可执行 〔暂不支持此链接〕"))
        assertEquals("https://example.org/a_(b)", links[3].destination)
        assertEquals("https://example.org/test", links[4].destination)
        assertFalse(links.any { it.destination.contains("code.example") })
    }
}
