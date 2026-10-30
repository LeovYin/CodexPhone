import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./security.js";
export interface HostBinding { accountsUrl: string; id: string; secret: string; accountId: string; username: string; name: string; url: string }
export interface AccountIdentity { accountId: string; sessionId: string; installationId: string; name: string; expiresAt: number }
export async function binding(directory: string): Promise<HostBinding | null> {
  try { return JSON.parse(await readFile(path.join(directory, "account-host.json"), "utf8")) as HostBinding; }
  catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new HttpError(503, "电脑账号配置无法读取，请在管理中心检查"); }
}
export function serviceUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "请填写服务地址");
  let url: URL; try { url = new URL(value.includes("://") ? value : "http://" + value); } catch { throw new HttpError(400, "服务地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new HttpError(400, "地址只填写主机和端口");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const bytes = host.split(".").map(Number);
  const privateHost = host === "localhost" || host === "::1" || host.endsWith(".ts.net") || host.startsWith("fd7a:115c:a1e0:") ||
    bytes.length === 4 && bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && (bytes[0] === 127 || bytes[0] === 10 || bytes[0] === 192 && bytes[1] === 168 || bytes[0] === 172 && bytes[1]! >= 16 && bytes[1]! <= 31 || bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127);
  if (url.protocol === "http:" && !privateHost) throw new HttpError(400, "HTTP 账号服务只允许内网或 Tailscale 地址，公网需要 HTTPS");
  return url.origin;
}
export async function accountRequest<T>(base: string, endpoint: string, body: unknown, token?: string): Promise<T> {
  const origin = serviceUrl(base);
  const stage = endpoint === "/v1/login" ? "登录账号服务" : endpoint.endsWith("/authorize") ? "电脑向账号服务核验设备授权" : "访问账号服务";
  let response: Response, text: string;
  try {
    response = await fetch(origin + endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
    text = await response.text();
  } catch { throw new HttpError(503, `${stage}失败：无法连接 ${origin} 或响应超时。请检查电脑上的账号服务、Tailscale 和端口。`); }
  let result: T & { error?: unknown };
  try {
    result = JSON.parse(text) as typeof result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid account response");
  } catch {
    const code = response.ok ? 502 : response.status;
    throw new HttpError(code, `${stage}失败（HTTP ${response.status}）：${origin} 返回非 JSON 数据，可能来自错误端口、代理或反向代理。请检查账号服务地址；网关响应不代表 Codex 任务本身失败。`);
  }
  if (!response.ok) {
    const detail = typeof result.error === "string" && result.error.trim() ? result.error.slice(0, 500) : "账号服务未完成请求";
    throw new HttpError(response.status, `${stage}失败（HTTP ${response.status}，${origin}）：${detail}`);
  }
  return result;
}
export async function authorizeAccount(directory: string, input: { token?: string; sessionId?: string }): Promise<AccountIdentity> {
  const configured = await binding(directory); if (!configured) throw new HttpError(409, "请先在电脑管理中心登录并绑定账号");
  return accountRequest(configured.accountsUrl, "/v1/hosts/" + encodeURIComponent(configured.id) + "/authorize", input, configured.secret);
}
