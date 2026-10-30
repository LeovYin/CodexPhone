import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError, publicError } from "./security.js";

export interface Operation {
  requestId: string; deviceId: string; fingerprint: string; createdAt: number;
  state: "running" | "completed" | "failed" | "unknown";
  result?: unknown; error?: string; statusCode?: number;
}
// A durable reservation is saved BEFORE dispatch. After a crash an ambiguous
// request stays unknown; it must never be submitted automatically a second time.
export class OperationStore {
  private entries = new Map<string, Operation>();
  private saves: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const entries: Operation[] = JSON.parse(await readFile(path.join(this.directory, "operations.json"), "utf8"));
      if (!Array.isArray(entries)) throw new Error("Invalid operations store");
      for (const entry of entries) {
        if (!entry || typeof entry.requestId !== "string" || typeof entry.deviceId !== "string" || typeof entry.fingerprint !== "string") throw new Error("Invalid operation");
        if (entry.createdAt > Date.now() - 7 * 86400_000) {
          if (entry.state === "running") entry.state = "unknown";
          this.entries.set(this.key(entry.deviceId, entry.requestId), entry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read operations store; preserve it before restarting");
    }
  }
  get(deviceId: string, requestId: string): Operation | undefined {
    return this.entries.get(this.key(deviceId, requestId));
  }
  async run<T>(deviceId: string, requestId: unknown, route: string, body: unknown, action: () => Promise<T>): Promise<T> {
    if (requestId === undefined) return action(); // Existing web clients remain compatible.
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, "Invalid clientRequestId");
    const fingerprint = createHash("sha256").update(JSON.stringify([route, body])).digest("hex");
    const key = this.key(deviceId, requestId), existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError(409, "Request ID already used for different content");
      if (existing.state === "completed") return existing.result as T;
      if (existing.state === "failed") throw new HttpError(existing.statusCode || 500, existing.error || "Request failed");
      throw new HttpError(409, "Request already submitted; refresh or query its status before sending again");
    }
    if (this.entries.size >= 10_000) throw new HttpError(503, "Request journal is full; check the computer host");
    const entry: Operation = { requestId, deviceId, fingerprint, createdAt: Date.now(), state: "running" };
    this.entries.set(key, entry);
    // Do not dispatch if the reservation could not be written durably.
    try { await this.save(); } catch (error) { this.entries.delete(key); throw error; }
    try {
      const result = await action();
      entry.state = "completed"; entry.result = result; await this.save(); return result;
    } catch (error) {
      entry.state = error instanceof HttpError ? "failed" : "unknown"; entry.error = publicError(error);
      entry.statusCode = error instanceof HttpError ? error.statusCode : 500;
      await this.save(); throw error;
    }
  }
  private key(deviceId: string, requestId: string): string { return deviceId + ":" + requestId; }
  private save(): Promise<void> {
    const snapshot = JSON.stringify([...this.entries.values()]);
    const next = this.saves.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, "operations.tmp");
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, path.join(this.directory, "operations.json"));
    });
    this.saves = next; return next;
  }
}
