import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError, secretEqual } from "./security.js";
import type { FastifyRequest } from "fastify";
export async function adminSecret(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "admin-token");
  try { const value = await readFile(file, "utf8"); if (/^[A-Za-z0-9_-]{48}$/.test(value)) return value; throw new Error("Invalid local admin token"); }
  catch(e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const value = randomBytes(36).toString("base64url");
    try { await writeFile(file, value, { flag: "wx", mode: 0o600 }); return value; }
    catch(e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return adminSecret(directory); throw e; }
  }
}
export function requireAdmin(request: FastifyRequest, secret: string) {
  const ip = request.socket.remoteAddress;
  const header = request.headers.authorization;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip || "") ||
      typeof header !== "string" || !secretEqual(header, "Bearer " + secret)) throw new HttpError(403, "管理操作只允许本机管理中心执行");
}
