import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { isRecord } from "@codexphone/shared";

interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export interface ServerRequest { id: number | string; method: string; params: Record<string, unknown> }

export class AppServerClient extends EventEmitter {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private closed = false;
  private serverRequests = new Map<number | string, ServerRequest>();
  outstandingRequests(): ServerRequest[] { return [...this.serverRequests.values()]; }
  metadata = { model: "unknown", provider: "unknown", authMode: "unknown", version: "unknown" };

  readonly transport: "stdio" | "websocket";

  constructor(private child?: ChildProcessWithoutNullStreams, private socket?: WebSocket) {
    super();
    this.transport = socket ? "websocket" : "stdio";
    if (socket) {
      socket.on("message", (frame) => this.read(`${frame.toString()}\n`));
      socket.on("error", () => this.failAll(new Error("Shared Codex App Server connection failed")));
      socket.on("close", () => this.failAll(new Error("Shared Codex App Server disconnected. Restart CodexPhone.")));
      return;
    }
    if (!child) throw new Error("An App Server transport is required");
    child.stdout.on("data", (chunk: Buffer) => this.read(this.decoder.write(chunk)));
    // Raw diagnostics can contain credentials; keep them off HTTP and structured logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.failAll(new Error("Codex App Server input closed")));
    child.on("error", () => this.failAll(new Error("Could not start Codex App Server. Check CODEX_BIN.")));
    child.on("close", (code) => this.failAll(new Error(`Codex App Server exited (${code}). Restart CodexPhone.`)));
  }

  static async start(): Promise<AppServerClient> {
    const executable = process.env.CODEX_BIN || "codex";
    if (process.env.CODEXPHONE_APP_SERVER_URL) return AppServerClient.connect(process.env.CODEXPHONE_APP_SERVER_URL);
    // Opt-in shared daemon transport. This does not connect to an unrelated GUI stdio server.
    const args = process.env.CODEXPHONE_APP_SERVER === "proxy"
      ? ["app-server", "proxy", ...(process.env.CODEXPHONE_CONTROL_SOCKET ? ["--sock", process.env.CODEXPHONE_CONTROL_SOCKET] : [])]
      : ["app-server", "--listen", "stdio://"];
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env,
    });
    const client = new AppServerClient(child);
    return AppServerClient.initialize(client, executable);
  }

  static async connect(address: string): Promise<AppServerClient> {
    const url = new URL(address);
    // The GUI's local override has no configurable bearer handshake. Keep this endpoint local.
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Shared App Server URL must be a loopback ws:// endpoint");
    const socket = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
    const client = new AppServerClient(undefined, socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const opened = () => { socket.off("error", failed); resolve(); };
        const failed = () => { socket.off("open", opened); reject(new Error("Could not connect to shared App Server")); };
        socket.once("open", opened); socket.once("error", failed);
      });
      return await AppServerClient.initialize(client, process.env.CODEX_BIN || "codex");
    } catch (error) { client.close(); throw error; }
  }

  private static async initialize(client: AppServerClient, executable: string): Promise<AppServerClient> {
    try {
      await client.request("initialize", { clientInfo: { name: "codexphone", title: "CodexPhone", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      client.notify("initialized", {});
      const configResult = await client.request("config/read", { includeLayers: false });
      if (isRecord(configResult) && isRecord(configResult.config)) {
        const config = configResult.config;
        client.metadata.model = typeof config.model === "string" ? config.model : "unknown";
        client.metadata.provider = typeof config.model_provider === "string" ? config.model_provider : "unknown";
      }
      try {
        const accountResult = await client.request("account/read", { refreshToken: false });
        if (isRecord(accountResult) && isRecord(accountResult.account) && typeof accountResult.account.type === "string") client.metadata.authMode = accountResult.account.type;
      } catch { /* Custom providers may not expose account metadata. */ }
      const version = spawn(executable, ["--version"], { windowsHide: true });
      version.stdout.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/codex-cli ([a-zA-Z0-9.+-]+)/);
        if (match?.[1]) client.metadata.version = match[1];
      });
      version.on("error", () => {});
      return client;
    } catch (error) { client.close(); throw error; }
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) throw new Error("Codex App Server is not running. Restart CodexPhone.");
    const id = ++this.requestId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`App Server timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params }, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("App Server input failed")); }
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void { this.write({ method, params }); }
  respond(id: number | string, result: unknown): void { this.serverRequests.delete(id); this.write({ id, result }); }
  reject(id: number | string, message: string): void { this.serverRequests.delete(id); this.write({ id, error: { code: -32601, message } }); }

  close(): void {
    if (this.closed) return;
    this.failAll(new Error("Codex App Server stopped"));
    if (this.socket) { this.socket.close(); setTimeout(() => { if (this.socket?.readyState !== WebSocket.CLOSED) this.socket?.terminate(); }, 1500).unref(); }
    this.child?.stdin.end();
    setTimeout(() => { if (this.child?.exitCode === null) this.child.kill(); }, 1500).unref();
  }

  private send(message: unknown, callback?: (error?: Error | null) => void): void {
    if (this.socket) this.socket.send(JSON.stringify(message), callback);
    else this.child?.stdin.write(`${JSON.stringify(message)}\n`, callback);
  }
  private write(message: unknown): void { if (!this.closed) this.send(message); }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) { this.child?.kill(); this.socket?.terminate(); this.failAll(new Error("App Server frame limit exceeded")); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      if (!isRecord(message)) continue;
      // Server requests have IDs too: dispatch by method before matching our request IDs.
      if (typeof message.method === "string") {
        const params = isRecord(message.params) ? message.params : {};
        if (typeof message.id === "number" || typeof message.id === "string") {
          const request = { id: message.id, method: message.method, params };
          this.serverRequests.set(message.id, request); this.emit("serverRequest", request);
        } else {
          if (message.method === "serverRequest/resolved" && (typeof params.requestId === "string" || typeof params.requestId === "number")) this.serverRequests.delete(params.requestId);
          this.emit("notification", { method: message.method, params });
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (isRecord(message.error)) pending.reject(new Error(`App Server request rejected (${message.error.code ?? "unknown"}): ${typeof message.error.message === "string" ? message.error.message : "unknown error"}`));
        else pending.resolve(message.result);
      }
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit("closed", error);
  }
}
