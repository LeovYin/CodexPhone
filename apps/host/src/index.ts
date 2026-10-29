import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { HostStatus, ModelOption, Project, ThreadDetail, ThreadSummary } from "@codexphone/shared";
import { isRecord } from "@codexphone/shared";
import { AppServerClient, type ServerRequest } from "./app-server.js";
import { ApprovalQueue } from "./approvals.js";
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
const projectStore = new ProjectStore(stateDir);
const port = Number(process.env.PORT || 4318);
const bindHost = process.env.HOST || "0.0.0.0";
const allowedOrigins = new Set((process.env.CODEXPHONE_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
const sockets = new Set<import("ws").WebSocket>();
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
function requireDevice(request: FastifyRequest): { id: string } { const device = store.authenticate(token(request)); if (!device) throw new HttpError(401, "Device is not paired"); return { id: device.id }; }
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
    const resumed = requireObject(await server().request("thread/resume", { threadId, excludeTurns: false }));
    ownedThreads.add(threadId); externalThreads.delete(threadId);
    const thread = isRecord(resumed.thread) ? resumed.thread : {};
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const active = turns.find((turn) => isRecord(turn) && turn.status === "inProgress");
    if (isRecord(active) && typeof active.id === "string") activeTurns.set(threadId, active.id);
    if (typeof resumed.model === "string" && !selections.has(threadId)) selections.set(threadId, { model: resumed.model, ...(typeof resumed.reasoningEffort === "string" ? { effort: resumed.reasoningEffort } : {}) });
  }
  const read = requireObject(await server().request("thread/read", { threadId })); const thread = normalizeThread(read.thread); if (!thread) throw new HttpError(404, "Thread not found"); const turns: ThreadDetail["turns"] = []; let cursor: unknown = initialCursor || null;
  do { const page = requireObject(await server().request("thread/turns/list", { threadId, limit: 40, itemsView: "full", cursor })); for (const value of pageData(page)) { const turn = requireObject(value); turns.push(normalizeTurn(turn, Array.isArray(turn.items) ? turn.items : [])); } cursor = page.nextCursor; } while (typeof cursor === "string" && cursor.length > 0 && turns.length < 200);
  if (server().transport === "websocket") {
    const running = turns.find((turn) => turn.status === "inProgress");
    if (running) activeTurns.set(threadId, running.id);
    else if (!(isRecord(thread.status) && thread.status.type === "active")) activeTurns.delete(threadId);
  }
  const active = activeTurns.get(threadId) || null;
  turns.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return { thread: { ...thread, canControl: ownedThreads.has(threadId), activeTurnId: active, writeState: ownedThreads.has(threadId) ? "owned" : externalThreads.has(threadId) ? "external" : "unknown", isPinned: store.favorites.has(thread.id) }, turns, nextCursor: typeof cursor === "string" ? cursor : null, approvals: approvals?.list(threadId) || [], model: selections.get(threadId)?.model || thread.model, effort: selections.get(threadId)?.effort || null };
}
function publicNotification(method: string, params: Record<string, unknown>): unknown | null {
  const threadId = stringOrNull(params.threadId); if (method === "item/agentMessage/delta") return { type: "agent-delta", threadId, turnId: stringOrNull(params.turnId), itemId: stringOrNull(params.itemId), delta: typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : "" }; if (method === "turn/started" || method === "turn/completed") return { type: "turn-status", method, threadId, turnId: stringOrNull(isRecord(params.turn) ? params.turn.id : params.turnId), status: isRecord(params.turn) ? params.turn.status ?? null : params.status ?? null }; if (method === "item/completed" || method === "item/started") return { type: "item-status", method, threadId, turnId: stringOrNull(params.turnId), itemId: stringOrNull(params.itemId), itemType: stringOrNull(params.itemType) }; if (method === "serverRequest/resolved") return { type: "approval-resolved", threadId, requestId: params.requestId ?? null }; return null;
}

host.addHook("onRequest", async (request) => { if (!originAllowed(request.headers.origin, request.headers.host, allowedOrigins)) throw new HttpError(403, "Origin is not allowed"); if (request.url.startsWith("/api/") && !request.url.startsWith("/api/health") && !request.url.startsWith("/api/pair")) requireDevice(request); });
host.get("/api/health", async () => ({ ...hostStatus, activeTasks: activeTurns.size, pairedDevices: store.list().length }));
host.post("/api/pair", async (request) => { const body = requireObject(request.body); return store.pair(body.code, body.name); });
host.get("/api/ws-ticket", async (request) => { const device = requireDevice(request); const ticket = randomBytes(36).toString("base64url"); wsTickets.set(ticket, { deviceId: device.id, expiresAt: Date.now() + 30_000 }); return { ticket }; });
host.get("/ws", { websocket: true }, (socket, request) => { const query = request.query as { ticket?: string }; const entry = typeof query?.ticket === "string" ? wsTickets.get(query.ticket) : undefined; if (typeof query?.ticket === "string") wsTickets.delete(query.ticket); if (!entry || entry.expiresAt < Date.now() || !store.hasDevice(entry.deviceId)) { socket.close(1008, "Invalid WebSocket ticket"); return; } sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => sockets.delete(socket)); socket.send(JSON.stringify({ type: "connected", deviceId: entry.deviceId })); });
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
  const started = requireObject(await server().request("thread/start", { cwd: project.path, ...(project.codexProjectId ? { projectId: project.codexProjectId } : {}), ...(selection.model ? { model: selection.model } : {}), serviceName: "codexphone" }));
  const thread = isRecord(started.thread) ? started.thread : started;
  if (typeof thread.id !== "string") throw new HttpError(502, "Codex did not return a thread id");
  const threadId = thread.id; ownedThreads.add(threadId); selections.set(threadId, selection);
  return serialized(threadId, async () => {
    try {
      const turn = await server().request("turn/start", { threadId, ...selection, input: [{ type: "text", text: prompt }] }, 60_000);
      emit({ type: "refresh-thread", threadId }); return { threadId, turn };
    } catch (error) { await releaseThread(threadId).catch(() => {}); throw error; }
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/turns", async (request) => {
  const body = requireObject(request.body); const prompt = promptText(body.prompt); const threadId = request.params.threadId;
  const selection = modelSelection(body, await models());
  return serialized(threadId, async () => {
    try {
      if (server().transport === "websocket") await detail(threadId);
      if (activeTurns.has(threadId)) throw new HttpError(409, "任务仍在运行，请先等待完成或中断，再发送新消息");
      await server().request("thread/resume", { threadId, excludeTurns: true });
      ownedThreads.add(threadId); externalThreads.delete(threadId);
      const turn = await server().request("turn/start", { threadId, ...selection, input: [{ type: "text", text: prompt }] }, 60_000);
      selections.set(threadId, selection); emit({ type: "refresh-thread", threadId }); return { threadId, turn };
    } catch (error) { return explainThreadWriteError(error, threadId); }
  });
});
host.post<{ Params: { threadId: string } }>("/api/threads/:threadId/steer", async (request) => {
  const body = requireObject(request.body); const threadId = request.params.threadId;
  return serialized(threadId, async () => {
    const expectedTurnId = activeTurns.get(threadId);
    if (!ownedThreads.has(threadId) || !expectedTurnId) throw new HttpError(409, "当前连接没有可指导的运行任务");
    return server().request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text: promptText(body.prompt) }] });
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
host.get<{ Querystring: { threadId?: string } }>("/api/approvals", async (request) => ({ approvals: approvals?.list(request.query.threadId || "") || [] }));
host.post<{ Params: { approvalId: string } }>("/api/approvals/:approvalId", async (request) => ({ threadId: approvals!.answer(request.params.approvalId, requireObject(request.body)) }));
host.get("/api/devices", async (request) => { const device = requireDevice(request); return { devices: store.list().map((item) => ({ ...item, current: item.id === device.id })) }; });
host.delete<{ Params: { deviceId: string } }>("/api/devices/:deviceId", async (request) => { const device = requireDevice(request); if (device.id !== request.params.deviceId) throw new HttpError(403, "A device can only revoke its own session"); await store.revoke(device.id); return { revoked: true }; });
host.setErrorHandler((error, _request, reply) => { reply.code(error instanceof HttpError ? error.statusCode : 500).send({ error: publicError(error) }); });

await mkdir(stateDir, { recursive: true }); await store.load(); await projectStore.load();
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
    client.on("notification", (notification: { method: string; params: Record<string, unknown> }) => {
      if (notification.method === "serverRequest/resolved") approvals!.remove(notification.params.requestId);
      const threadId = stringOrNull(notification.params.threadId);
      const turn = isRecord(notification.params.turn) ? notification.params.turn : null;
      if (threadId && notification.method === "turn/started" && typeof turn?.id === "string") activeTurns.set(threadId, turn.id);
      if (threadId && notification.method === "turn/completed") {
        if (!turn || activeTurns.get(threadId) === turn.id) activeTurns.delete(threadId);
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
export async function closeHost(): Promise<void> { stopping = true; clearTimeout(reconnectTimer); appServer?.close(); await host.close(); }
const shutdown = async () => { await closeHost(); process.exit(0); }; process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
