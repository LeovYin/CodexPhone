import { useEffect, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import DOMPurify from "dompurify";
import { X, ZoomIn } from "lucide-react";
import { getToken } from "./api";
import { MermaidDiagram } from "./MermaidDiagram";

const isRemote = (src: string) => /^https?:\/\//i.test(src);
const isDataImage = (src: string) => /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml|avif);/i.test(src) && src.length < 16 * 1024 * 1024;

export function MessageImage({ src, alt = "对话图片", threadId }: { src: string; alt?: string; threadId: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setUrl(""); setFailed(false);
    if (isRemote(src) || isDataImage(src)) { setUrl(src); return; }
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(?:file:|[A-Za-z]:[\\/])/.test(src)) { setFailed(true); return; }
    const controller = new AbortController(); let objectUrl = "";
    const params = new URLSearchParams({ threadId, file: src });
    void fetch(`/api/media?${params}`, { headers: { Authorization: `Bearer ${getToken() || ""}` }, signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("image unavailable"); return response.blob(); })
      .then((blob) => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, threadId]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [expanded]);
  if (failed) return <span className="image-fallback">{alt}：图片暂不可用</span>;
  if (!url) return <span className="image-fallback">正在读取图片…</span>;
  return <span className="image-frame">
    <button type="button" className="image-button" aria-label={`放大${alt}`} onClick={() => setExpanded(true)}><img src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /><span><ZoomIn size={16} /></span></button>
    {expanded && <span role="dialog" aria-modal="true" aria-label={alt} className="image-overlay" onClick={() => setExpanded(false)}><button type="button" className="icon-button" aria-label="关闭图片" autoFocus onClick={() => setExpanded(false)}><X /></button><img src={url} alt={alt} referrerPolicy="no-referrer" /></span>}
  </span>;
}

function SvgPreview({ source, threadId }: { source: string; threadId: string }) {
  const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["script", "foreignObject", "image", "use", "style", "animate", "animateMotion", "animateTransform", "set"], FORBID_ATTR: ["style", "href", "xlink:href"] });
  return <div className="svg-preview"><MessageImage src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`} alt="SVG 预览" threadId={threadId} /><details><summary>查看 SVG 源码</summary><pre><code>{source}</code></pre></details></div>;
}

export function MessageContent({ text, images = [], threadId }: { text: string; images?: string[]; threadId: string }) {
  // Raw HTML remains disabled. Only complete SVG fragments receive an isolated, sanitized image preview.
  const pieces = text.split(/(```(?:mermaid|svg|xml)\s*\n[\s\S]*?```|<svg\b[^>]*>[\s\S]*?<\/svg>)/gi);
  return <div className="message-body markdown">
    {pieces.map((part, index) => {
      if (!part) return null;
      if (/^```mermaid\s*\n/i.test(part)) return <MermaidDiagram key={index} source={part.replace(/^```mermaid\s*\n/i, "").replace(/```$/, "").trim()} threadId={threadId} />;
      const source = part.replace(/^```(?:svg|xml)\s*\n/i, "").replace(/```$/, "").trim();
      if (/^<svg\b/i.test(source) && /<\/svg>$/.test(source)) return <SvgPreview key={index} source={source} threadId={threadId} />;
      return <Markdown key={index} skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === "src" || /\.(?:svg|png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url) ? url : defaultUrlTransform(url)} components={{
        img: ({ src, alt }) => <MessageImage src={typeof src === "string" ? src : ""} alt={alt} threadId={threadId} />,
        a: ({ href, children }) => {
          if (href && !isRemote(href) && /\.(?:svg|png|jpe?g|webp|gif|avif)$/i.test(href)) return <MessageImage src={href} alt={typeof children === "string" ? children : "对话图片"} threadId={threadId} />;
          if (href && /^(?:https?:|mailto:)/i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          return <span className="local-reference" title={href}>{children}</span>;
        },
        table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
      }}>{part}</Markdown>;
    })}
    {images.map((src, index) => <MessageImage key={`${index}:${src}`} src={src} threadId={threadId} />)}
  </div>;
}
