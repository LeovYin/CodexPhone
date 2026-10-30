import { useEffect, useId, useState } from "react";
import DOMPurify from "dompurify";
import { MessageImage } from "./MessageContent";

let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
function loadRenderer() {
  return renderer ||= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", maxTextSize: 30_000, maxEdges: 300,
      flowchart: { htmlLabels: false }, suppressErrorRendering: true }); return mermaid;
  });
}
export function MermaidDiagram({ source, threadId }: { source: string; threadId: string }) {
  const id = "diagram" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [url, setUrl] = useState(""); const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false; setUrl(""); setError(false);
    void loadRenderer().then(async mermaid => {
      if (source.length > 30_000) throw new Error("Diagram too large");
      const { svg } = await mermaid.render(id, source);
      const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["script", "foreignObject", "image", "use", "a", "animate", "set"], FORBID_ATTR: ["href", "xlink:href"] });
      if (!disposed) setUrl("data:image/svg+xml;charset=utf-8," + encodeURIComponent(clean));
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [source, id]);
  return <div className="mermaid-diagram">
    {url ? <MessageImage src={url} alt="Mermaid 图表" threadId={threadId} /> : <p className="model-note">{error ? "图表语法暂无法渲染，可展开源码查看。" : "正在绘制图表…"}</p>}
    <details><summary>查看 Mermaid 源码</summary><pre><code>{source}</code></pre></details>
  </div>;
}
