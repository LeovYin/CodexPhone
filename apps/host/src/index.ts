import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import type { HostStatus, ModelOption, Project, ThreadDetail, ThreadSummary } from "@codexphone/shared";
import { isRecord } from "@codexphone/shared";
import { AppServerClient, type ServerRequest } from "./app-server.js";
import { ApprovalQueue } from "./approvals.js";
import { OperationStore } from "./operations.js";
import { MessageQueue } from "./queue.js";
import { adminSecret, requireAdmin } from "./local-admin.js";
import { accountRequest, authorizeAccount, binding, serviceUrl, type HostBinding } from "./account-client.js";
import { normalizeThread, normalizeTurn, pageData, stringOrNull } from "./normalize.js";
import { modelSelection, normalizeModel } from "./models.js";
import { readImage } from "./media.js";
import { DeviceStore } from "./store.js";
import { ProjectStore, projectId, validateProjectDirectory } from "./projects.js";
import { HttpError, originAllowed, promptText, publicError, requireObject } from "./security.js";

const host = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });
await host.register(websocket);
const stateDir = path.resolve(process.env.CODEXPHONE_HOME || path.join(homedir(), ".codexphone"));
const store = new DeviceStore(stateDir);
const operations = new OperationStore(stateDir);
const messageQueue = new MessageQueue(stateDir);
const managementSecret = await adminSecret(stateDir);
const accountChecks = new Map<string, number>();
const projectStore = new ProjectStore(stateDir);
const port = Number(process.env.PORT || 4318);
const bindHost = process.env.HOST || "0.0.0.0";
const allowedOrigins = new Set((process.env.CODEXPHONE_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
const sockets = new Set<import("ws").WebSocket>();
const socketDevices = new Map<import("ws").WebSocket, string>();
const wsTickets = new Map<string, { deviceId: string; expiresAt: number }>();
let appServer: AppServerClient | undefined;
let approvals: ApprovalQueue | undefined;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectDelay = 1000;
const ownedThreads = new Set<string>();
const externalThreads = new Set<string>();
const activeTurns = new Map<string, string>();
const selections = new Map<string, { model?: string; effort?: string }>();
const writes = new Map<string, Promise<unknown>>();
let modelCache: { at: number; data: ModelOption[] } | undefined;
const listDefaults = { sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], modelProviders: [], sortKey: "updated_at" };

async function models(): Promise<ModelOption[]> {
  if (modelCache && Date.now() - modelCache.at < 60_000) return modelCache.data;
  const data: ModelOption[] = []; let cursor: unknown = null;
  do {
    const result = requireObject(await server().request("model/list", { limit: 100, cursor, includeHidden: false }));
    data.push(...pageData(result).map(normalizeModel).filter((entry): entry is ModelOption => entry !== null));
    cursor = result.nextCursor;
  } while (typeof cursor === "string" && cursor && data.length < 1000);
  modelCache = { at: Date.now(), data }; return data;
}

async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
  const current = (writes.get(id) || Promise.resolve()).catch(() => {}).then(action);
  writes.set(id, current);
  try { return await current; } finally { if (writes.get(id) === current) writes.delete(id); }
}

async function releaseThread(id: string): Promise<boolean> {
  if (!ownedThreads.has(id) || activeTurns.has(id) || approvals?.list(id).length) return false;
  await server().request("thread/unsubscribe", { threadId: id });
  ownedThreads.delete(id); emit({ type: "refresh-thread", threadId: id }); return true;
}
let hostStatus: HostStatus = { status: "starting", codexVersion: "unknown", model: "unknown", provider: "unknown", authMode: "unknown", lastError: null };

function emit(event: unknown): void { const payload = JSON.stringify(event); for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(payload); }
function token(request: FastifyRequest): string | undefined { const value = request.headers.authorization; return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : undefined; }
function requireDevice(request: FastifyRequest) { const device = store.authenticate(token(request)); if (!device) throw new HttpError(401, "登录已失效，请重新登录账号"); return device; }
function server(): AppServerClient { if (!appServer) throw new HttpError(503, "Codex App Server is unavailable; check the computer host"); return appServer; }
function isActiveWriterConflict(error: unknown): boolean { return error instanceof Error && error.message.includes("already has an active writer"); }
function explainThreadWriteError(error: unknown, threadId: string): never {
  if (isActiveWriterConflict(error)) { externalThreads.add(threadId); throw new HttpError(409, "该对话由电脑端 Codex 持有，当前连接无法接管。可以查看同步历史，或新建手机任务。原消息已保留。 "); }
  throw error;
}
function configuredProjects(): Project[] {
  return projectStore.list();
}
async function knownProjects(): Promise<Project[]> {
  const map = new Map(configuredProjects().map((project) => [project.id, project]));
  // Use the installed protocol's catalog; cwd hashes remain stable phone-facing IDs.
  let cursor: unknown = null;
  do {
    const result = requireObject(await server().request("project/list", { limit: 100, cursor }));
    for (const entry of pageData(result)) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.roots)) continue;
      for (const root of entry.roots) {
        if (!isRecord(root) || typeof root.path !== "string" || !path.isAbsolute(root.path)) continue;
        const id = projectId(root.path); const existing = map.get(id);
        map.set(id, { id, name: existing?.name || (typeof entry.name === "string" ? entry.name : path.basename(root.path)), path: root.path, canStart: existing?.canStart || false, codexProjectId: entry.id });
      }
    }
    cursor = result.nextCursor;
  } while (typeof cursor === "string" && cursor && map.size < 1000);
  const result = requireObject(await server().request("thread/list", { ...listDefaults, limit: 100 }));
  for (const item of pageData(result)) { const thread = normalizeThread(item); if (thread?.cwd && path.isAbsolute(thread.cwd)) { const id = projectId(thread.cwd); if (!map.has(id)) map.set(id, { id, name: path.basename(thread.cwd), path: thread.cwd, canStart: false }); } }
  return [...map.values()];
}
async function detail(threadId: string, initialCursor?: string): Promise<ThreadDetail> {
  if (server().transport === "websocket" && !ownedThreads.has(threadId)) {
    const resumed = requireObject(await server().request("thread/resume", { threadId, excludeTurns: true }));
    ownedThreads.add(threadId); externalThreads.delete(threadId);
    const thread = isRecord(resumed.thread) ? resumed.thread : {};
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const active = turns.find((turn) => isRecord(turn) && turn.status === "inProgress");
    if (isRecord(active) && typeof active.id === "string") activeTurns.set(threadId, active.id);
    if (typeof resumed.model === "string" && !selections.has(threadId)) selections.set(threadId, { model: resumed.model, ...(typeof resumed.reasoningEffort === "string" ? { effort: resumed.reasoningEffort } : {}) });
  }
  const read = requireObject(await server().request("thread/read", { threadId })); const thread = normalizeThread(read.thread); if (!thread) throw new HttpError(404, "Thread not found"); const turns: ThreadDetail["turns"] = []; let cursor: unknown = initialCursor || null;
  const page = requireObject(await server().request("thread/turns/list", { threadId, limit: 20, itemsView: "full", sortDirection: "desc", cursor }));
  for (const value of pageData(page)) { const turn = requireObject(value); turns.push(normalizeTurn(turn, Array.isArray(turn.items) ? turn.items : [])); }
  cursor = page.nextCursor;
  if (server().transport === "websocket" && !initialCursor) {
    const running = turns.find((turn) => turn.status === "inProgress");
    if (running) activeTurns.set(threadId, running.id);
    else if (!(isRecord(thread.status) && thread.status.type === "active")) activeTurns.delete(threadId);
  }
  const active = activeTurns.get(threadId) || null;
  // The API page is descending; reverse instead of sorting nullable/equal timestamps.
  turns.reverse();
  return { thread: { ...thread, canControl: ownedThreads.has(threadId), activeTurnId: active, writeState: ownedThreads.has(threadId) ? "owned" : externalThreads.has(threadId) ? "external" : "unknown", isPinned: store.favorites.has(thread.id) }, turns, nextCursor: typeof cursor === "string" ? cursor : null, approvals: approvals?.list(threadId) || [], model: selections.get(threadId)?.model || thread.model, effort: selections.get(threadId)?.effort || null };
}
const queueTimers = new Map<string, NodeJS.Timeout>();
function pumpQueue(threadId: string): void {
  if (stopping || !appServer || queueTimers.has(threadId) || !messageQueue.list(threadId).some(e => e.state === "queued")) return;
  queueTimers.set(threadId, setTimeout(() => {
    queueTimers.delete(threadId);
    void serialized(threadId, async () => {
      if (!appServer) return;
      const snapshot = await detail(threadId);
      if (snapshot.thread.activeTurnId || approvals?.list(threadId).length) return;
      if (messageQueue.list(threadId).some(e => e.state === "unknown" || e.state === "dispatching")) return;
      const next = messageQueue.list(threadId).find(e => e.state === "queued");
      if (!next) return;
      if (!store.hasDevice(next.deviceId)) { await messageQueue.cancel(next.id, threadId); emit({ type: "queue-updated", threadId }); return; }
      const device = store.authorizedDevice(next.deviceId)!;
      if (device.sessionId) {
        try { await authorizeAccount(stateDir, { sessionId: device.sessionId }); }
        catch (error) {
          if (error instanceof HttpError && [401, 403, 404, 409].includes(error.statusCode)) {
            await messageQueue.cancel(next.id, threadId); emit({ type: "queue-updated", threadId });
          }
          return; // An unavailable account service leaves the message queued.
        }
      }
      const entry = await messageQueue.claim(next.id, threadId);
      emit({ type: "queue-updated", threadId });
      try {
        await server().request("turn/start", { threadId, ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}), input: [{ type: "text", text: entry.prompt }] }, 60_000);
        await messageQueue.finish(entry.id, threadId, "completed");
        selections.set(threadId, { ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}) });
      } catch (e) { await messageQueue.finish(entry.id, threadId, "unknown", publicError(e)); }
      emit({ type: "queue-updated", threadId }); emit({ type: "refresh-thread", threadId });
    }).catch(() => { /* Keep undispatched entries queued while the backend is unavailable. */ });
  }, 250));
}
function publicNotification(method: string, params: Record<string, unknown>): unknown | null {
  const threadId = stringOrNull(params.threadId); if (method === "item/agentMessage/delta") return { type: "agent-delta", threadId, turnId: stringOrNull(params.turnId), itemId: stringOrNull(params.itemId), delta: typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : "" }; if (method === "turn/started" || method === "turn/completed") return { type: "turn-status", method, threadId, turnId: stringOrNull(isRecord(params.turn) ? params.turn.id : params.turnId), status: isRecord(params.turn) ? params.turn.status ?? null : params.status ?? null }; if (method === "item/completed" || method === "item/started") return { type: "item-status", method, threadId, turnId: stringOrNull(params.turnId), itemId: stringOrNull(params.itemId), itemType: stringOrNull(params.itemType) }; if (method === "serverRequest/resolved") return { type: "approval-resolved", threadId, requestId: params.requestId ?? null }; return null;
}

host.addHook("onRequest", async (request) => {
  if (!originAllowed(request.headers.origin, request.headers.host, allowedOrigins)) throw new HttpError(403, "Origin is not allowed");
  const route = request.url.split("?")[0]!;
  if (route.startsWith("/api/admin/")) { requireAdmin(request, managementSecret); return; }
  if (route.startsWith("/api/") && !["/api/health", "/api/pair", "/api/account/connect", "/api/account/login", "/api/auth/info"].includes(route)) {
    const device = requireDevice(request);
    if (device.sessionId && (accountChecks.get(device.sessionId) || 0) < Date.now()) {
      await authorizeAccount(stateDir, { sessionId: device.sessionId }); accountChecks.set(device.sessionId, Date.now() + 10000);
    }
    if (device.permission === "read" && !["GET", "HEAD"].includes(request.method) && route !== "/api/ws-ticket" && !(request.method === "DELETE" && route === "/api/devices/" + device.id)) throw new HttpError(403, "此手机只有查看权限，请在电脑管理中心调整");
  }
});
host.get("/api/health", async () => ({ ...hostStatus, activeTasks: activeTurns.size, pairedDevices: store.list().length }));
host.get("/api/capabilities", async () => ({ hostVersion: "0.3.2", protocolVersion: 1, capabilities: ["idempotent-send", "operation-status", "global-approvals", "websocket-ticket", "media", "message-queue", "latest-history", "account-login", "device-permissions"], requestRetentionDays: 7 }));
host.get<{ Params: { requestId: string } }>("/api/operations/:requestId", async (request) => {
  const entry = operations.get(requireDevice(request).id, request.params.requestId);
  if (!entry) throw new HttpError(404, "Request not found");
  return { requestId: entry.requestId, state: entry.state, result: entry.result, error: entry.error };
});
host.post("/api/pair", async (request) => { if (await binding(stateDir)) throw new HttpError(410, "此电脑已启用账号登录，请使用账号连接"); const body = requireObject(request.body); return store.pair(body.code, body.name); });
host.get("/api/auth/info", async () => ({ mode: await binding(stateDir) ? "account" : "legacy", hostVersion: "0.3.2" }));
host.post("/api/account/connect", async request => {
  const body = requireObject(request.body); if (typeof body.token !== "string") throw new HttpError(400, "请先登录账号");
  const identity = await authorizeAccount(stateDir, { token: body.token });
  return store.accountSession(identity);
});
host.post("/api/account/login", async request => {
  const body = requireObject(request.body); const configured = await binding(stateDir);
  if (!configured) throw new HttpError(409, "请先在电脑管理中心绑定账号");
  const loggedIn = await accountRequest<{ token: string; account: { username: string } }>(configured.accountsUrl, "/v1/login", { username: body.username, password: body.password, installationId: body.installationId, name: body.name, kind: "web" });
  const identity = await authorizeAccount(stateDir, { token: loggedIn.token });
  return { ...await store.accountSession(identity), username: loggedIn.account.username };
});
host.get("/api/admin/status", async () => {
  const configured = await binding(stateDir);
  return { ...hostStatus, hostVersion: "0.3.2", activeTasks: activeTurns.size, devices: store.list(),
    account: configured ? { username: configured.username, name: configured.name, url: configured.url, accountsUrl: configured.accountsUrl } : null };
});
host.post("/api/admin/account", async request => {
  const body = requireObject(request.body), accountsUrl = serviceUrl(body.accountsUrl), url = serviceUrl(body.url);
  let installation: string;
  try { installation = await readFile(path.join(stateDir, "installation-id"), "utf8"); }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; installation = randomUUID(); await writeFile(path.join(stateDir, "installation-id"), installation, { mode: 0o600 }); }
  if (body.register === true) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(accountsUrl).hostname)) throw new HttpError(400, "请在账号服务所在电脑创建账号，再到本机登录");
    const accountsDirectory = path.resolve(process.env.CODEXPHONE_ACCOUNTS_HOME || path.join(homedir(), ".codexphone", "accounts"));
    await accountRequest(accountsUrl, "/v1/register", { username: body.username, password: body.password }, await adminSecret(accountsDirectory));
  }
  const login = await accountRequest<{ token: string }>(accountsUrl, "/v1/login", { username: body.username, password: body.password, installationId: installation, name: body.name, kind: "desktop" });
  try {
    const previous = await binding(stateDir);
    if (previous && previous.accountsUrl !== accountsUrl) throw new HttpError(409, "请先解除当前账号绑定再更换账号服务");
    if (previous && previous.username !== String(body.username).trim().toLowerCase()) throw new HttpError(409, "请先解除当前账号绑定再更换账号");
    const registered = await accountRequest<Omit<HostBinding, "accountsUrl">>(accountsUrl, "/v1/host", { installationId: installation, name: body.name, url, previousHostSecret: previous?.secret }, login.token);
    const temporary = path.join(stateDir, "account-host.tmp");
    await writeFile(temporary, JSON.stringify({ ...registered, accountsUrl }), { mode: 0o600 }); await rename(temporary, path.join(stateDir, "account-host.json"));
    accountChecks.clear();
    for (const device of store.list()) if (!device.accountId) await store.updatePermission(device.id, "blocked");
    for (const socket of sockets) socket.close(1008, "Account binding updated");
    return { bound: true, username: registered.username };
  } finally { await accountRequest(accountsUrl, "/v1/logout", {}, login.token).catch(() => {}); }
});
host.post<{ Params: { id: string } }>("/api/admin/devices/:id/permission", async request => {
  await store.updatePermission(request.params.id, requireObject(request.body).permission);
  for (const [socket, id] of socketDevices) if (id === request.params.id) socket.close(1008, "Device permissions changed");
  for (const message of messageQueue.list()) if (message.deviceId === request.params.id && message.state === "queued" && !store.hasDevice(message.deviceId)) await messageQueue.cancel(message.id, message.threadId);
  emit({ type: "queue-updated" }); return { updated: true };
});
host.delete("/api/admin/account", async () => {
  const configured = await binding(stateDir); if (!configured) return { unbound: true };
  await accountRequest(configured.accountsUrl, "/v1/hosts/" + encodeURIComponent(configured.id) + "/unbind", {}, configured.secret);
  await unlink(path.join(stateDir, "account-host.json")); accountChecks.clear();
  for (const device of store.list()) if (device.accountId) await store.updatePermission(device.id, "blocked");
  for (const socket of sockets) socket.close(1008, "Computer unbound"); return { unbound: true };
});
host.delete<{ Params: { id: string } }>("/api/admin/devices/:id", async request => {
  await store.updatePermission(request.params.id, "blocked");
  for (const [socket, id] of socketDevices) if (id === request.params.id) socket.close(1008, "Device revoked");
  return { revoked: true };
});
host.get("/api/ws-ticket", async (request) => { const device = requireDevice(request); const ticket = randomBytes(36).toString("base64url"); wsTickets.set(ticket, { deviceId: device.id, expiresAt: Date.now() + 30_000 }); return { ticket }; });
host.get("/ws", { websocket: true }, (socket, request) => {
  const query = request.query as { ticket?: string };
  const entry = typeof query?.ticket === "string" ? wsTickets.get(query.ticket) : undefined;
  if (typeof query?.ticket === "string") wsTickets.delete(query.ticket);
  const device = entry && store.authorizedDevice(entry.deviceId);
  if (!entry || entry.expiresAt < Date.now() || !device) { socket.close(1008, "Invalid WebSocket ticket"); return; }
  // Install handlers synchronously, before awaiting authorization.
  let closed = false, checking = false;
  const cleanup = () => { closed = true; clearInterval(timer); sockets.delete(socket); socketDevices.delete(socket); };
  socket.on("close", cleanup); socket.on("error", cleanup);
  const validate = async () => {
    if (closed || checking) return; checking = true;
    try {
      const current = store.authorizedDevice(entry.deviceId);
      if (!current || current.sessionId !== device.sessionId) throw new Error("Session expired");
      if (current.sessionId) await authorizeAccount(stateDir, { sessionId: current.sessionId });
      if (closed) return;
      if (!sockets.has(socket)) { sockets.add(socket); socketDevices.set(socket, entry.deviceId); socket.send(JSON.stringify({ type: "connected", deviceId: entry.deviceId })); }
    } catch { sockets.delete(socket); socketDevices.delete(socket); socket.close(1008, "Session expired or unavailable"); }
    finally { checking = false; }
  };
  const timer = setInterval(() => void validate(), 10000); timer.unref(); void validate();
});
host.get("/api/projects", async () => ({ projects: await knownProjects() }));
host.post("/api/projects", async (request) => {
  const project = await projectStore.upsert(requireObject(request.body));
  emit({ type: "projects-changed" });
  return { project };
});
host.put<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) => {
  const project = await projectStore.upsert(requireObject(request.body), request.params.projectId);
  emit({ type: "projects-changed" });
  return { project };
});
host.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) => {
  await projectStore.remove(request.params.projectId);
  emit({ type: "projects-changed" });
  return { removed: true };
});
host.get("/api/models", async () => ({ models: await models(), defaultModel: server().metadata.model }));
host.get("/api/threads", async (request) => { const query = request.query as { cursor?: string; limit?: string; projectId?: string; search?: string }; const project = (await knownProjects()).find((item) => item.id === query.projectId); const params: Record<string, unknown> = { ...listDefaults, limit: Math.min(50, Math.max(1, Number(query.limit) || 30)), cursor: query.cursor || null, searchTerm: query.search?.slice(0, 120) || null }; if (project?.path) params.cwd = project.path; const result = requireObject(await server().request("thread/list", params)); const threads = pageData(result).map(normalizeThread).filter((item): item is ThreadSummary => item !== null).map((item) => ({ ...item, isPinned: store.favorites.has(item.id), canControl: ownedThreads.has(item.id), activeTurnId: activeTurns.get(item.id) || null, writeState: ownedThreads.has(item.id) ? "owned" as const : externalThreads.has(item.id) ? "external" as const : "unknown" as const })); return { threads, nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null }; });
host.get<{ Params: { threadId: string }; Querystring: { cursor?: string } }>("/api/threads/:threadId", async (request) => detail(request.params.threadId, request.query.cursor));
host.get<{ Params: { threadId: string } }>("/api/threads/:threadId/queue", async request => ({ messages: messageQueue.list(request.params.threadId) }));
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/queue", async request => {
  const body = requireObject(request.body), threadId = request.params.threadId;
  const prompt = promptText(body.prompt), selection = modelSelection(body, await models());
  return operations.run(requireDevice(request).id, body.clientRequestId, request.url, body, async () => {
    const entry = await messageQueue.enqueue({ threadId, deviceId: requireDevice(request).id, prompt, ...selection });
    emit({ type: "queue-updated", threadId }); pumpQueue(threadId);
    return { threadId, queueId: entry.id };
  });
});
host.delete<{ Params: { threadId: string; queueId: string } }>("/api/threads/:threadId/queue/:queueId", async request => {
  const { threadId, queueId } = request.params;
  await serialized(threadId, () => messageQueue.cancel(queueId, threadId)); emit({ type: "queue-updated", threadId }); pumpQueue(threadId);
  return { cancelled: true };
});
host.post<{ Params: { threadId: string; queueId: string } }>("/api/threads/:threadId/queue/:queueId/guide", async request => {
  const { threadId, queueId } = request.params; const body = requireObject(request.body);
  return operations.run(requireDevice(request).id, body.clientRequestId, request.url, body, () => serialized(threadId, async () => {
    await detail(threadId);
    const expectedTurnId = activeTurns.get(threadId);
    if (!expectedTurnId) throw new HttpError(409, "本轮已结束，消息将按队列顺序发送，请刷新");
    const entry = await messageQueue.claim(queueId, threadId);
    try {
      await server().request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text: entry.prompt }] });
      await messageQueue.finish(queueId, threadId, "guided");
    } catch (e) { await messageQueue.finish(queueId, threadId, "unknown", publicError(e)); throw e; }
    finally { emit({ type: "queue-updated", threadId }); }
    return { threadId, queueId };
  }));
});
host.put<{ Params: { threadId: string } }>("/api/favorites/:threadId", async (request) => { await store.favorite(request.params.threadId, true); return { threadId: request.params.threadId, isPinned: true }; });
host.delete<{ Params: { threadId: string } }>("/api/favorites/:threadId", async (request) => { await store.favorite(request.params.threadId, false); return { threadId: request.params.threadId, isPinned: false }; });
host.get<{ Querystring: { threadId: string; file: string } }>("/api/media", async (request, reply) => {
  const { threadId, file } = request.query;
  if (typeof threadId !== "string" || typeof file !== "string") throw new HttpError(400, "缺少图片路径");
  const read = requireObject(await server().request("thread/read", { threadId }));
  const thread = normalizeThread(read.thread);
  if (!thread?.cwd) throw new HttpError(404, "找不到图片所属对话");
  const roots = configuredProjects().flatMap((entry) => entry.path ? [entry.path] : []);
  roots.push(path.join(homedir(), ".codex", "visualizations"), path.join(homedir(), ".codex", "attachments"));
  const image = await readImage(file, thread.cwd, roots);
  return reply.header("Content-Type", image.type).header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'").send(image.data);
});
host.post("/api/threads", async (request) => {
  const body = requireObject(request.body); const prompt = promptText(body.prompt);
  const project = (await knownProjects()).find((item) => item.id === body.projectId && item.canStart);
  if (!project?.path) throw new HttpError(400, "Choose a configured project");
  await validateProjectDirectory(project.path);
  const selection = modelSelection(body, await models());
  return operations.run(requireDevice(request).id, body.clientRequestId, "/api/threads", body, async () => {
  const started = requireObject(await server().request("thread/start", { cwd: project.path, ...(project.codexProjectId ? { projectId: project.codexProjectId } : {}), ...(selection.model ? { model: selection.model } : {}), serviceName: "codexphone" }));
  const thread = isRecord(started.thread) ? started.thread : started;
  if (typeof thread.id !== "string") throw new HttpError(502, "Codex did not return a thread id");
  const threadId = thread.id; ownedThreads.add(threadId); selections.set(threadId, selection);
  return serialized(threadId, async () => {
    try {
      const turn = await server().request("turn/start", { threadId, ...selection, input: [{ type: "text", text: prompt }] }, 60_000);
      emit({ type: "refresh-thread", threadId }); return { threadId, turnId: isRecord(turn) && typeof turn.id === "string" ? turn.id : null };
    } catch (error) { await releaseThread(threadId).catch(() => {}); throw error; }
  });
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/turns", async (request) => {
  const body = requireObject(request.body); const prompt = promptText(body.prompt); const threadId = request.params.threadId;
  const selection = modelSelection(body, await models());
  return operations.run(requireDevice(request).id, body.clientRequestId, request.url, body, async () => {
  return serialized(threadId, async () => {
    try {
      if (server().transport === "websocket") await detail(threadId);
      if (activeTurns.has(threadId)) throw new HttpError(409, "任务仍在运行，请先等待完成或中断，再发送新消息");
      await server().request("thread/resume", { threadId, excludeTurns: true });
      ownedThreads.add(threadId); externalThreads.delete(threadId);
      const turn = await server().request("turn/start", { threadId, ...selection, input: [{ type: "text", text: prompt }] }, 60_000);
      selections.set(threadId, selection); emit({ type: "refresh-thread", threadId }); return { threadId, turnId: isRecord(turn) && typeof turn.id === "string" ? turn.id : null };
    } catch (error) { return explainThreadWriteError(error, threadId); }
  });
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/steer", async (request) => {
  const body = requireObject(request.body); const threadId = request.params.threadId;
  return operations.run(requireDevice(request).id, body.clientRequestId, request.url, body, async () => {
  return serialized(threadId, async () => {
    const expectedTurnId = activeTurns.get(threadId);
    if (!ownedThreads.has(threadId) || !expectedTurnId) throw new HttpError(409, "当前连接没有可指导的运行任务");
    return server().request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text: promptText(body.prompt) }] });
  });
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/interrupt", async (request) => {
  const body = requireObject(request.body); const threadId = request.params.threadId;
  return serialized(threadId, async () => {
    if (!ownedThreads.has(threadId) || !activeTurns.has(threadId) || activeTurns.get(threadId) !== body.turnId) throw new HttpError(409, "当前任务已变化，请刷新对话");
    return server().request("turn/interrupt", { threadId, turnId: body.turnId });
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/release", async (request) => serialized(request.params.threadId, async () => ({ released: await releaseThread(request.params.threadId) })));
host.get<{ Querystring: { threadId?: string } }>("/api/approvals", async (request) => ({ approvals: approvals?.list(request.query.threadId) || [] }));
host.post<{ Params: { approvalId: string } }>("/api/approvals/:approvalId", async (request) => ({ threadId: approvals!.answer(request.params.approvalId, requireObject(request.body)) }));
host.get("/api/devices", async (request) => { const device = requireDevice(request); return { devices: store.list().map((item) => ({ ...item, current: item.id === device.id })) }; });
host.delete<{ Params: { deviceId: string } }>("/api/devices/:deviceId", async (request) => { const device = requireDevice(request); if (device.id !== request.params.deviceId) throw new HttpError(403, "A device can only revoke its own session"); await store.revoke(device.id); for (const [socket, id] of socketDevices) if (id === device.id) socket.close(1008, "Device revoked"); return { revoked: true }; });
host.setErrorHandler((error, _request, reply) => { reply.code(error instanceof HttpError ? error.statusCode : 500).send({ error: publicError(error) }); });

await mkdir(stateDir, { recursive: true }); await store.load(); await projectStore.load(); await operations.load(); await messageQueue.load();
async function connectServer(): Promise<void> {
  try {
    const client = await AppServerClient.start();
    if (stopping) { client.close(); return; }
    appServer = client; approvals = new ApprovalQueue(client);
    ownedThreads.clear(); activeTurns.clear(); externalThreads.clear(); modelCache = undefined;
    reconnectDelay = 1000;
    hostStatus = { status: "ready", codexVersion: client.metadata.version, model: client.metadata.model, provider: client.metadata.provider, authMode: client.metadata.authMode, lastError: null, transport: client.transport };
    emit({ type: "host-status", status: hostStatus });
    client.on("serverRequest", (request: ServerRequest) => {
      const approval = approvals!.add(request); if (approval) emit({ type: "approval-requested", approval });
    });
    // Initialization can replay an already-blocking question before listeners
    // are attached. Preserve it so reconnecting phones can answer it as well.
    for (const request of client.outstandingRequests()) approvals.add(request);
    client.on("notification", (notification: { method: string; params: Record<string, unknown> }) => {
      if (notification.method === "serverRequest/resolved") approvals!.remove(notification.params.requestId);
      const threadId = stringOrNull(notification.params.threadId);
      const turn = isRecord(notification.params.turn) ? notification.params.turn : null;
      if (threadId && notification.method === "turn/started" && typeof turn?.id === "string") activeTurns.set(threadId, turn.id);
      if (threadId && notification.method === "turn/completed") {
        if (!turn || activeTurns.get(threadId) === turn.id) activeTurns.delete(threadId);
        pumpQueue(threadId);
        // Shared clients stay subscribed so later desktop turns reach the phone immediately.
        if (client.transport === "stdio") void serialized(threadId, () => releaseThread(threadId)).catch(() => {});
      }
      const event = publicNotification(notification.method, notification.params); if (event) emit(event);
      if (["thread/started", "thread/name/updated", "thread/metadata/updated", "thread/archived", "thread/unarchived"].includes(notification.method)) emit({ type: "refresh-thread", threadId });
    });
    client.on("closed", () => {
      if (appServer !== client) return;
      appServer = undefined; approvals = undefined; ownedThreads.clear(); activeTurns.clear();
      hostStatus = { ...hostStatus, status: "degraded", lastError: "电脑端连接已断开，正在重新连接。发送前请等待恢复。" };
      emit({ type: "host-status", status: hostStatus }); scheduleReconnect();
    });
    for (const entry of messageQueue.list()) pumpQueue(entry.threadId);
  } catch (error) {
    hostStatus = { ...hostStatus, status: "degraded", lastError: publicError(error) };
    emit({ type: "host-status", status: hostStatus }); scheduleReconnect();
  }
}
function scheduleReconnect(): void {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connectServer(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}
await connectServer();
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"); await host.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: true }); await host.listen({ host: bindHost, port }); host.log.info({ address: `http://${bindHost}:${port}`, model: hostStatus.model, provider: hostStatus.provider, pairing: store.pairingInfo });
export { host };
export async function closeHost(): Promise<void> { stopping = true; clearInterval(queueSweep); clearTimeout(reconnectTimer); for (const timer of queueTimers.values()) clearTimeout(timer); queueTimers.clear(); appServer?.close(); await host.close(); }
const shutdown = async () => { await closeHost(); process.exit(0); }; process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
const queueSweep = setInterval(() => { for (const entry of messageQueue.list()) pumpQueue(entry.threadId); }, 5000);
queueSweep.unref();
