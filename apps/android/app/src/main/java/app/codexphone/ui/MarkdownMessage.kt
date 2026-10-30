package app.codexphone.ui

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.text.method.LinkMovementMethod
import android.widget.TextView
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.codexphone.data.CodexPhoneApi
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class MessageAssets(val markdown: String, val images: List<String>)

fun splitMessageAssets(markdown: String, attachments: List<String>): MessageAssets {
    val paths = attachments.toMutableList()
    val pattern = Regex("""!\[[^\]]*]\((?:<([^>]+)>|([^\n)]+))\)""")
    val clean = pattern.replace(markdown) { match ->
        val path = (match.groups[1]?.value ?: match.groups[2]?.value.orEmpty())
            .trim().replace(Regex("""\s+["'].*$"""), "")
        if (path.isNotBlank()) paths.add(path)
        ""
    }
    return MessageAssets(clean.trim(), paths.distinct())
}

@Composable fun MarkdownMessage(markdown: String, attachments: List<String>, threadId: String, api: CodexPhoneApi?) {
    val blocks = remember(markdown) { splitMermaidBlocks(markdown) }
    if (blocks.any { it.diagram }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            blocks.forEach { block -> if (block.diagram) MermaidDiagram(block.text) else MarkdownMessage(block.text, emptyList(), threadId, api) }
            if (attachments.isNotEmpty()) MarkdownMessage("", attachments, threadId, api)
        }
        return
    }
    val context = LocalContext.current
    val assets = remember(markdown, attachments) { splitMessageAssets(markdown, attachments) }
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TablePlugin.create(context))
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
                    builder.linkResolver { view, link ->
                        when (messageLinkKind(link)) {
                            MessageLinkKind.WEB -> runCatching {
                                view.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.trim().toHttpUrlOrNull().toString())))
                            }.onFailure { Toast.makeText(view.context, "未找到可打开网页的浏览器", Toast.LENGTH_SHORT).show() }
                            MessageLinkKind.FILE -> Toast.makeText(view.context, "这是电脑上的文件链接，暂不支持在手机打开", Toast.LENGTH_SHORT).show()
                            MessageLinkKind.UNSUPPORTED -> Toast.makeText(view.context, "暂不支持打开此类型的链接", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }).build()
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (assets.markdown.isNotBlank()) AndroidView(
            modifier = Modifier.fillMaxWidth(),
            factory = { ctx -> TextView(ctx).apply {
                textSize = 15f; setTextColor(Color.rgb(23, 34, 59))
                setLinkTextColor(Color.rgb(49, 95, 202)); linksClickable = true
                setTextIsSelectable(true); setLineSpacing(3f, 1.1f)
                setOnTouchListener(MessageLinkTouchListener())
                setPadding(0, 0, 0, 0)
            } },
            update = { view ->
                if (view.tag != assets.markdown) {
                    markwon.setParsedMarkdown(view, markwon.render(prepareMessageLinks(markwon.parse(assets.markdown))))
                    view.movementMethod = LinkMovementMethod.getInstance()
                    view.tag = assets.markdown
                }
            },
        )
        if (api != null) assets.images.forEach { path ->
            // Remote images never receive the device bearer token. File paths use
            // the authenticated host media endpoint and its workspace validation.
            val url = if (path.startsWith("https://", ignoreCase = true)) path
                else if (path.startsWith("http://", ignoreCase = true) || path.startsWith("data:", ignoreCase = true)) null
                else api.mediaUrl(threadId, path)
            if (url != null) MediaPreview(url, api)
        }
    }
}
