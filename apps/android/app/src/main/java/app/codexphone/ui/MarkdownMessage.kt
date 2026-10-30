package app.codexphone.ui

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.widget.TextView
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
                        val uri = Uri.parse(link)
                        if (uri.scheme == "https" || uri.scheme == "http") {
                            runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
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
                setTextIsSelectable(true); setLineSpacing(3f, 1.1f)
                setPadding(0, 0, 0, 0)
            } },
            update = { view ->
                if (view.tag != assets.markdown) {
                    markwon.setMarkdown(view, assets.markdown); view.tag = assets.markdown
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
