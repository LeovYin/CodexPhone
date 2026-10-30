package app.codexphone.ui

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Link
import org.commonmark.node.Image
import org.commonmark.node.Node
import org.commonmark.node.Text

internal enum class MessageLinkKind { WEB, FILE, UNSUPPORTED }

internal fun messageLinkKind(destination: String): MessageLinkKind {
    val value = destination.trim()
    if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(value)) {
        return if (value.toHttpUrlOrNull() != null) MessageLinkKind.WEB else MessageLinkKind.UNSUPPORTED
    }
    if (value.isBlank() || value.startsWith('#') || value.startsWith("//")) return MessageLinkKind.UNSUPPORTED
    if (Regex("^[a-z]:[/\\\\]", RegexOption.IGNORE_CASE).containsMatchIn(value) ||
        value.startsWith("file:", true) || value.startsWith("sandbox:", true) ||
        !Regex("^[a-z][a-z0-9+.-]*:", RegexOption.IGNORE_CASE).containsMatchIn(value)) return MessageLinkKind.FILE
    return MessageLinkKind.UNSUPPORTED
}

/** Transform parsed prose only: code blocks, inline code, and existing labels stay intact. */
internal fun prepareMessageLinks(document: Node): Node {
    document.accept(object : AbstractVisitor() {
        override fun visit(image: Image) = Unit
        override fun visit(link: Link) {
            when (messageLinkKind(link.destination)) {
                MessageLinkKind.FILE -> link.appendChild(Text(" 〔文件 · 暂不支持打开〕"))
                MessageLinkKind.UNSUPPORTED -> link.appendChild(Text(" 〔暂不支持此链接〕"))
                MessageLinkKind.WEB -> Unit
            }
            // Do not autolink inside an existing link.
        }

        override fun visit(text: Text) {
            val content = text.literal
            val matches = Regex("https?://[^\\s<>。，；！？、（）【】《》“”‘’]+", RegexOption.IGNORE_CASE).findAll(content).toList()
            if (matches.isEmpty()) return
            var offset = 0
            for (match in matches) {
                var address = match.value.trimEnd('.', ',', ';', '!', '?', ':', '。', '，', '；', '！', '？', '、', '）', '】', '》', '”', '’')
                while (address.endsWith(')') && address.count { it == ')' } > address.count { it == '(' }) address = address.dropLast(1)
                while (address.endsWith(']') && address.count { it == ']' } > address.count { it == '[' }) address = address.dropLast(1)
                if (messageLinkKind(address) != MessageLinkKind.WEB) continue
                if (match.range.first > offset) text.insertBefore(Text(content.substring(offset, match.range.first)))
                text.insertBefore(Link(address, null).apply { appendChild(Text(address)) })
                offset = match.range.first + address.length
            }
            if (offset == 0) return
            if (offset < content.length) text.insertBefore(Text(content.substring(offset)))
            text.unlink()
        }
    })
    return document
}
