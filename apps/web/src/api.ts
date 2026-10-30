import type { ApiError, HostStatus, ModelOption, ModelSelection, Project, ThreadDetail, ThreadSummary } from "@codexphone/shared";

const TOKEN_KEY = "codexphone-device-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

class ResponseError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json() as T | ApiError;
  if (!response.ok) throw new ResponseError(payload && typeof payload === "object" && "error" in payload ? String(payload.error) : `Request failed (${response.status})`, response.status);
  return payload as T;
}

export const api = {
  authInfo: () => request<{ mode: string }>("/api/auth/info"),
  login: (username: string, password: string, name: string) => {
    let installationId = localStorage.getItem("codexphone-installation");
    if (!installationId) { installationId = requestId(); localStorage.setItem("codexphone-installation", installationId); }
    return request<{ token: string; deviceId: string }>("/api/account/login", { method: "POST", body: JSON.stringify({ username, password, name, installationId }) });
  },
  hasPendingEnqueue: (threadId: string) => !!localStorage.getItem("codexphone-queue-request:/api/threads/" + encodeURIComponent(threadId) + "/queue"),
  hasPendingQueueRequest: (threadId: string) => queueRequestKeys(threadId).length > 0,
  discardQueueRequests: (threadId: string) => queueRequestKeys(threadId).forEach(key => localStorage.removeItem(key)),
  queue: (threadId: string) => request<{ messages: QueuedMessage[] }>(`/api/threads/${encodeURIComponent(threadId)}/queue`),
  enqueue: (threadId: string, prompt: string, selection: ModelSelection) => durableQueueRequest(`/api/threads/${encodeURIComponent(threadId)}/queue`, { prompt, ...selection }),
  guideQueued: (threadId: string, id: string) => durableQueueRequest(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(id)}/guide`, {}),
  cancelQueued: (threadId: string, id: string) => request(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(id)}`, { method: "DELETE" }),
  health: () => request<HostStatus & { pairedDevices: number }>("/api/health"),
  approvals: async () => (await request<{ approvals: import("@codexphone/shared").ApprovalRequest[] }>("/api/approvals")).approvals,
  pair: (code: string, name: string) => request<{ token: string; deviceId: string }>("/api/pair", { method: "POST", body: JSON.stringify({ code, name }) }),
  projects: async () => (await request<{ projects: Project[] }>("/api/projects")).projects,
  saveProject: (project: { name: string; path: string }, id?: string) => request<{ project: Project }>(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects", { method: id ? "PUT" : "POST", body: JSON.stringify(project) }),
  removeProject: (id: string) => request<{ removed: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  models: () => request<{ models: ModelOption[]; defaultModel: string }>("/api/models"),
  threads: async (projectId?: string, cursor?: string) => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (cursor) params.set("cursor", cursor);
    return request<{ threads: ThreadSummary[]; nextCursor: string | null }>(`/api/threads?${params}`);
  },
  thread: (threadId: string, cursor?: string) => request<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  favorite: (threadId: string, value: boolean) => request(`/api/favorites/${encodeURIComponent(threadId)}`, { method: value ? "PUT" : "DELETE" }),
  start: (projectId: string, prompt: string, selection: ModelSelection) => request<{ threadId: string }>("/api/threads", { method: "POST", body: JSON.stringify({ projectId, prompt, ...selection }) }),
  send: (threadId: string, prompt: string, selection: ModelSelection) => request(`/api/threads/${encodeURIComponent(threadId)}/turns`, { method: "POST", body: JSON.stringify({ prompt, ...selection }) }),
  release: (threadId: string) => request<{ released: boolean }>(`/api/threads/${encodeURIComponent(threadId)}/release`, { method: "POST" }),
  steer: (threadId: string, prompt: string) => request(`/api/threads/${encodeURIComponent(threadId)}/steer`, { method: "POST", body: JSON.stringify({ prompt }) }),
  interrupt: (threadId: string, turnId: string) => request(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, { method: "POST", body: JSON.stringify({ turnId }) }),
  wsTicket: () => request<{ ticket: string }>("/api/ws-ticket"),
  revokeCurrentDevice: async () => {
    const { devices } = await request<{ devices: Array<{ id: string; current: boolean }> }>("/api/devices");
    const current = devices.find((device) => device.current);
    if (current) await request(`/api/devices/${encodeURIComponent(current.id)}`, { method: "DELETE" });
  },
  approve: (approvalId: string, body: Record<string, unknown>) => request<{ threadId: string }>(`/api/approvals/${encodeURIComponent(approvalId)}`, { method: "POST", body: JSON.stringify(body) }),
};
export interface QueuedMessage { id: string; threadId: string; prompt: string; state: string; error?: string }
// HTTP over Tailscale may not expose crypto.randomUUID in browsers.
function requestId(): string { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
function queueRequestKeys(threadId: string): string[] {
  const prefix = "codexphone-queue-request:/api/threads/" + encodeURIComponent(threadId) + "/queue";
  return Object.keys(localStorage).filter(key => key === prefix || key.startsWith(prefix + "/"));
}
async function durableQueueRequest(path: string, body: object): Promise<unknown> {
  const key = "codexphone-queue-request:" + path, payload = JSON.stringify(body);
  const previous = JSON.parse(localStorage.getItem(key) || "null") as { payload: string; id: string; at: number } | null;
  if (previous && Date.now() - previous.at <= 6 * 86400_000) {
    const operation = await request<{ state: string; result?: unknown; error?: string }>("/api/operations/" + encodeURIComponent(previous.id))
      .catch(error => { if (error instanceof ResponseError && error.status === 404) return null; throw error; });
    if (operation?.state === "completed") {
      localStorage.removeItem(key);
      if (previous.payload === payload) return operation.result;
      throw new Error("上次提交已送达，请查看对话和排队条，再发送新内容。");
    }
    if (operation?.state === "failed") { localStorage.removeItem(key); throw new Error(operation.error || "上次提交失败，可以重新发送。"); }
    if (operation) throw new Error("上次提交仍在处理或结果待确认，请先检查电脑对话。");
  }
  if (previous && (previous.payload !== payload || Date.now() - previous.at > 6 * 86400_000))
    throw new Error("上次排队提交尚未确认，请先检查对话和排队条。保留原内容重试可查询去重结果。");
  const intent = previous || { payload, id: requestId(), at: Date.now() };
  localStorage.setItem(key, JSON.stringify(intent));
  const result = await request(path, { method: "POST", body: JSON.stringify({ ...body, clientRequestId: intent.id }) });
  localStorage.removeItem(key); return result;
}

export async function connectEvents(onEvent: (event: Record<string, unknown>) => void, onClose: () => void): Promise<() => void> {
  const { ticket } = await api.wsTicket();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
  socket.addEventListener("message", (message) => {
    try { onEvent(JSON.parse(message.data) as Record<string, unknown>); } catch { /* Ignore malformed frames. */ }
  });
  socket.addEventListener("close", onClose, { once: true });
  return () => socket.close();
}
