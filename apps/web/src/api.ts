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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json() as T | ApiError;
  if (!response.ok) throw new Error(payload && typeof payload === "object" && "error" in payload ? String(payload.error) : `Request failed (${response.status})`);
  return payload as T;
}

export const api = {
  health: () => request<HostStatus & { pairedDevices: number }>("/api/health"),
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
