import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./security.js";

export interface QueuedMessage {
  id: string; threadId: string; deviceId: string; prompt: string;
  model?: string; effort?: string; createdAt: number;
  state: "queued" | "dispatching" | "failed" | "unknown" | "completed" | "cancelled" | "guided";
  error?: string;
}
// A dispatch claim is persisted first. Ambiguous results are retained for review,
// never automatically repeated after a connection failure or a host restart.
export class MessageQueue {
  private entries: QueuedMessage[] = [];
  private saves: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const entries: QueuedMessage[] = JSON.parse(await readFile(path.join(this.directory, "message-queue.json"), "utf8"));
      if (!Array.isArray(entries) || entries.some(e => !e || typeof e.id !== "string" || typeof e.threadId !== "string" || typeof e.prompt !== "string")) throw new Error("Invalid queue");
      this.entries = entries.filter(e => !["completed", "cancelled", "guided"].includes(e.state) || e.createdAt > Date.now() - 7 * 86400_000)
        .map(e => e.state === "dispatching" ? { ...e, state: "unknown", error: "电脑曾在提交时退出，请检查对话后处理。" } : e);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read message queue; preserve it before restarting"); }
  }
  list(threadId?: string): QueuedMessage[] { return this.entries.filter(e => (!threadId || e.threadId === threadId) && !["completed", "cancelled", "guided"].includes(e.state)).map(e => ({ ...e })); }
  get(id: string, threadId: string): QueuedMessage {
    const entry = this.entries.find(e => e.id === id && e.threadId === threadId);
    if (!entry) throw new HttpError(404, "排队消息不存在"); return entry;
  }
  async enqueue(input: Omit<QueuedMessage, "id" | "state" | "createdAt">): Promise<QueuedMessage> {
    if (this.list().length >= 200) throw new HttpError(409, "排队消息过多，请先处理已有消息");
    const entry: QueuedMessage = { ...input, id: randomUUID(), state: "queued", createdAt: Date.now() };
    this.entries.push(entry);
    try { await this.save(); } catch (e) { this.entries = this.entries.filter(item => item !== entry); throw e; }
    return { ...entry };
  }
  async claim(id: string, threadId: string): Promise<QueuedMessage> {
    const entry = this.get(id, threadId);
    if (entry.state !== "queued") throw new HttpError(409, "消息已在处理，请刷新查看状态");
    entry.state = "dispatching";
    try { await this.save(); } catch (e) { entry.state = "queued"; throw e; }
    return { ...entry };
  }
  async finish(id: string, threadId: string, state: QueuedMessage["state"], error?: string): Promise<void> {
    const entry = this.get(id, threadId); entry.state = state;
    if (error === undefined) delete entry.error; else entry.error = error;
    await this.save();
  }
  async cancel(id: string, threadId: string): Promise<void> {
    const entry = this.get(id, threadId);
    if (entry.state === "dispatching") throw new HttpError(409, "消息正在提交，不能取消，请检查当前对话");
    await this.finish(id, threadId, "cancelled");
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.entries);
    const next = this.saves.catch(() => {}).then(async () => {
      const tmp = path.join(this.directory, "message-queue.tmp");
      await writeFile(tmp, snapshot, { mode: 0o600 }); await rename(tmp, path.join(this.directory, "message-queue.json"));
    }); this.saves = next; return next;
  }
}
