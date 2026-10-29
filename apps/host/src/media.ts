import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError, isAllowedDirectory } from "./security.js";

const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif" };

// The caller supplies trusted workspace roots, never roots taken from a URL.
export async function readImage(file: string, cwd: string, roots: string[]): Promise<{ data: Buffer; type: string }> {
  if (!file || file.length > 4096 || file.includes("\0") || /^(?:https?:|data:|\\\\|\/\/)/i.test(file)) throw new HttpError(400, "无效的图片路径");
  let candidate: string;
  try {
    if (file.startsWith("file:")) {
      const url = new URL(file);
      if (url.host) throw new HttpError(400, "不支持网络文件路径");
      file = decodeURIComponent(url.pathname);
    }
    file = file.replace(/^\/([A-Za-z]:[\\/])/, "$1");
    candidate = await realpath(path.resolve(cwd, file));
  } catch { throw new HttpError(404, "图片文件不存在"); }
  const type = types[path.extname(candidate).toLowerCase()];
  if (!type || !await isAllowedDirectory(candidate, roots)) throw new HttpError(403, "图片不在允许的工作区内");
  const handle = await open(candidate, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new HttpError(413, "图片超过 12 MB 或不是文件");
    return { data: await handle.readFile(), type };
  } finally { await handle.close(); }
}
