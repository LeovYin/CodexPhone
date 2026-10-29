export interface LiveMessage { threadId: string; turnId: string; itemId: string; text: string }

export function appendDelta(current: LiveMessage[], event: Record<string, unknown>): LiveMessage[] {
  if (event.type !== "agent-delta" || typeof event.threadId !== "string" || typeof event.turnId !== "string" || typeof event.itemId !== "string" || typeof event.delta !== "string") return current;
  const index = current.findIndex((entry) => entry.threadId === event.threadId && entry.turnId === event.turnId && entry.itemId === event.itemId);
  if (index < 0) return [...current, { threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, text: event.delta }];
  return current.map((entry, i) => i === index ? { ...entry, text: entry.text + event.delta } : entry);
}
