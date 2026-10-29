import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function secretEqual(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(digest(a), "hex"), Buffer.from(digest(b), "hex")); }
export function digestEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
export function normalizedPath(value: string): string { const resolved = path.resolve(value); return process.platform === "win32" ? resolved.toLowerCase() : resolved; }

export async function isAllowedDirectory(directory: string, roots: string[]): Promise<boolean> {
  // Check canonical paths so a junction/symlink cannot jump outside an allowed workspace.
  try {
    const target = normalizedPath(await realpath(directory));
    for (const root of roots) {
      const canonical = normalizedPath(await realpath(root));
      const relative = path.relative(canonical, target);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return true;
    }
  } catch { return false; }
  return false;
}

export function originAllowed(origin: string | undefined, requestHost: string | undefined, extra: Set<string>): boolean {
  if (!origin) return true; // CLI clients still require a valid device bearer token.
  if (extra.has(origin)) return true;
  try { const parsed = new URL(origin); return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === requestHost; } catch { return false; }
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

export function promptText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 20_000) throw new HttpError(400, "Prompt must contain 1 to 20000 characters");
  return value.trim();
}

export function publicError(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  // Upstream protocol/provider errors can embed tokens or endpoints. Do not mirror them remotely.
  return "Codex 请求失败或超时，请检查电脑端状态；发送任务失败时请先刷新对话，避免重复提交。";
}
