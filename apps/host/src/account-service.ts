import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AccountDatabase } from "./accounts-db.js";
import { HttpError, originAllowed, publicError, requireObject } from "./security.js";
import { adminSecret, requireAdmin } from "./local-admin.js";
import { serviceUrl } from "./account-client.js";

const directory = path.resolve(process.env.CODEXPHONE_ACCOUNTS_HOME || path.join(homedir(), ".codexphone", "accounts"));
await mkdir(directory, { recursive: true });
const database = new AccountDatabase(path.join(directory, "accounts.sqlite"));
const secret = await adminSecret(directory);
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
const attempts = new Map<string, { count: number; start: number }>();
app.addHook("onRequest", async request => {
  if (!originAllowed(request.headers.origin, request.headers.host, new Set())) throw new HttpError(403, "Origin is not allowed");
  if (request.method === "POST" && request.url === "/v1/login") {
    const key = request.ip, now = Date.now();
    const rate = attempts.get(key);
    if (rate && now - rate.start < 60_000) { if (++rate.count > 12) throw new HttpError(429, "登录尝试过多，请一分钟后重试"); }
    else { if (attempts.size > 10000) attempts.clear(); attempts.set(key, { count: 1, start: now }); }
  }
});
function bearer(header: unknown) { if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new HttpError(401, "请登录账号"); return header.slice(7); }
app.get("/health", async () => ({ product: "CodexPhone Accounts", version: "0.3.0", storage: "sqlite" }));
app.post("/v1/register", async request => { requireAdmin(request, secret); const body = requireObject(request.body); await database.createUser(body.username, body.password); return { created: true }; });
app.post("/v1/login", async request => database.login(requireObject(request.body)));
app.post("/v1/logout", async request => { database.logout(bearer(request.headers.authorization)); return { signedOut: true }; });
app.post("/v1/host", async request => {
  const body = requireObject(request.body);
  return database.bind(bearer(request.headers.authorization), body, serviceUrl(body.url));
});
app.post<{ Params: { id: string } }>("/v1/hosts/:id/authorize", async request => database.authorize(request.params.id, bearer(request.headers.authorization), requireObject(request.body)));
app.post<{ Params: { id: string } }>("/v1/hosts/:id/unbind", async request => { database.unbind(request.params.id, bearer(request.headers.authorization)); return { unbound: true }; });
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof HttpError ? error.statusCode : 500).send({ error: error instanceof HttpError ? error.message : publicError(error) }));
await app.listen({ host: process.env.CODEXPHONE_ACCOUNTS_BIND || "0.0.0.0", port: Number(process.env.CODEXPHONE_ACCOUNTS_PORT || 4321) });
console.log(JSON.stringify({ product: "CodexPhone Accounts", address: app.addresses(), storage: "sqlite" }));
export { app };
export async function closeAccounts(): Promise<void> { await app.close(); database.close(); }
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void closeAccounts().then(() => process.exit(0)); });
