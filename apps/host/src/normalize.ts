import type { ThreadItem, ThreadSummary, ThreadTurn } from "@codexphone/shared";
import { isRecord } from "@codexphone/shared";

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function timestampMs(value: unknown): number | null {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

export function normalizeThread(value: unknown): ThreadSummary | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const timestamp = timestampMs(value.updatedAt);
  return {
    id: value.id, name: stringOrNull(value.name), preview: stringOrNull(value.preview),
    cwd: stringOrNull(value.cwd), model: stringOrNull(value.model), provider: stringOrNull(value.modelProvider),
    updatedAt: timestamp === null ? null : new Date(timestamp).toISOString(),
    status: isRecord(value.status) ? { type: value.status.type, activeFlags: value.status.activeFlags } : null,
    turns: Array.isArray(value.turns) ? value.turns.length : 0,
    isPinned: false, canControl: false, activeTurnId: null, writeState: "unknown",
  };
}

export function normalizeItem(value: unknown): ThreadItem | null {
  if (!isRecord(value)) return null;
  const item = isRecord(value.item) ? value.item : value;
  // Only explicit user-visible messages cross the bridge. Raw events and reasoning stay local.
  if (item.type !== "userMessage" && item.type !== "agentMessage") return null;
  const content = Array.isArray(item.content) ? item.content : [];
  const pieces = content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []);
  const text = typeof item.text === "string" ? item.text : pieces.join("\n");
  const images = content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "image" && typeof part.url === "string") return [part.url];
    if (part.type === "localImage" && typeof part.path === "string") return [part.path];
    return [];
  });
  if (!text.trim() && !images.length) return null;
  return { id: typeof item.id === "string" ? item.id : "", type: item.type, text, images, status: stringOrNull(item.status) };
}

export function normalizeTurn(value: unknown, items: unknown[]): ThreadTurn {
  const turn = isRecord(value) ? value : {};
  return {
    id: typeof turn.id === "string" ? turn.id : "", status: stringOrNull(turn.status),
    startedAt: timestampMs(turn.startedAt), completedAt: timestampMs(turn.completedAt),
    items: items.map(normalizeItem).filter((item): item is ThreadItem => item !== null),
  };
}

export function pageData(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.data) ? value.data : [];
}
