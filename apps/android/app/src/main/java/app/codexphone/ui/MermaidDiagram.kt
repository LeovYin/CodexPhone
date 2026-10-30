package app.codexphone.ui

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.RenderProcessGoneDetail
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.json.JSONObject
import java.io.ByteArrayInputStream

data class MarkdownBlock(val text: String, val diagram: Boolean = false)
fun splitMermaidBlocks(text: String): List<MarkdownBlock> {
    val pattern = Regex("(?m)^```mermaid[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)^```[^\\S\\r\\n]*(?:\\r?\\n|$)", RegexOption.IGNORE_CASE)
    val result = mutableListOf<MarkdownBlock>(); var position = 0
    pattern.findAll(text).forEach {
        if (it.range.first > position) result.add(MarkdownBlock(text.substring(position, it.range.first)))
        result.add(MarkdownBlock(it.groupValues[1].trim(), true)); position = it.range.last + 1
    }
    if (position < text.length) result.add(MarkdownBlock(text.substring(position)))
    return result
}

@Composable fun MermaidDiagram(source: String) {
    var expanded by remember { mutableStateOf(false) }
    var showSource by remember { mutableStateOf(false) }
    Column {
        MermaidCanvas(source, Modifier.fillMaxWidth().height(280.dp))
        Row { TextButton({ expanded = true }) { Text("放大图表") }; TextButton({ showSource = !showSource }) { Text("查看 Mermaid 源码") } }
        if (showSource) SelectionContainerCompatDiagram(source)
    }
    if (expanded) Dialog({ expanded = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface { Column(Modifier.fillMaxSize().systemBarsPadding()) {
            TextButton({ expanded = false }) { Text("关闭图表") }
            MermaidCanvas(source, Modifier.fillMaxWidth().weight(1f))
        } }
    }
}
@Composable private fun SelectionContainerCompatDiagram(source: String) {
    androidx.compose.foundation.text.selection.SelectionContainer { Text(source, style = MaterialTheme.typography.bodySmall) }
}

// JavaScript is confined to this bundled diagram renderer. It has no native bridge,
// file/content access, device credentials, external requests or navigable links.
@SuppressLint("SetJavaScriptEnabled")
@Composable private fun MermaidCanvas(source: String, modifier: Modifier) {
    val quoted = remember(source) { JSONObject.quote(source.take(30_001)).replace("<", "\\u003c") }
    val html = remember(quoted) { """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://codexphone.invalid; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'">
        <style>body{margin:0;padding:12px;background:#fff;color:#17223b;font:14px sans-serif}#chart{width:100%;text-align:center}svg{max-width:100%;height:auto}#status{color:#65718a}pre{white-space:pre-wrap}</style>
        <script src="https://codexphone.invalid/mermaid.js"></script></head><body><div id="status">正在绘制图表…</div><div id="chart"></div><script>
        (async()=>{try{const source=$quoted;if(source.length>30000)throw Error('large');mermaid.initialize({startOnLoad:false,securityLevel:'strict',maxTextSize:30000,maxEdges:300,flowchart:{htmlLabels:false},suppressErrorRendering:true});const result=await mermaid.render('diagram',source);document.getElementById('chart').innerHTML=result.svg;document.getElementById('status').textContent='';}catch(e){document.getElementById('status').textContent='图表语法暂无法渲染，可查看源码。';}})();
        </script></body></html>""".trimIndent() }
    AndroidView(modifier = modifier, factory = { context ->
        WebView(context).apply {
            settings.javaScriptEnabled = true; settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.domStorageEnabled = false; settings.blockNetworkLoads = true
            settings.setSupportZoom(true); settings.builtInZoomControls = true; settings.displayZoomControls = false
            webViewClient = object : WebViewClient() {
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    (view.parent as? android.view.ViewGroup)?.removeView(view)
                    view.destroy()
                    // A failed isolated renderer must not terminate the chat process.
                    return true
                }
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    if (request.url.toString() == "https://codexphone.invalid/mermaid.js")
                        WebResourceResponse("application/javascript", "UTF-8", context.assets.open("mermaid/mermaid.min.js"))
                    else WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
            }
        }
    }, update = { view -> if (view.tag != html) { view.tag = html; view.loadDataWithBaseURL("https://codexphone.invalid/", html, "text/html", "UTF-8", null) } },
        onRelease = { it.stopLoading(); it.destroy() })
}
