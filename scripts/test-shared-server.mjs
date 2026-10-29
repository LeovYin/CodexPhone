import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { AppServerClient } from "../apps/host/dist/app-server.js";

// No turn/start, queue/start, or model request: two clients share a temporary history fork.
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const address = `ws://127.0.0.1:${port}`;
const child = spawn(process.env.CODEX_BIN || "codex", ["app-server", "--listen", address], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
child.stderr.on("data", () => {});
let a, b, threadId;
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { a = await AppServerClient.connect(address); break; }
    catch { if (child.exitCode !== null) throw new Error("Shared App Server exited"); await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  assert.ok(a, "shared App Server starts"); b = await AppServerClient.connect(address);
  const listed = await a.request("thread/list", { limit: 30, modelProviders: [], sourceKinds: ["vscode", "cli", "appServer"], sortKey: "updated_at" });
  const source = listed.data.find((entry) => entry.preview?.trim());
  assert.ok(source, "one existing history is available for a diagnostic fork");
  const started = await a.request("thread/fork", { threadId: source.id, cwd: process.cwd(), ephemeral: false, deferGoalContinuation: true });
  threadId = started.thread.id;
  const resumed = await b.request("thread/resume", { threadId, excludeTurns: true });
  assert.equal(resumed.thread.id, threadId, "second client can resume while first owns the same thread");
  await b.request("thread/unsubscribe", { threadId });
  const reread = await a.request("thread/read", { threadId });
  assert.equal(reread.thread.id, threadId, "unsubscribing phone does not detach desktop client");
  b.close(); b = undefined;
  const config = await a.request("config/read", { includeLayers: false });
  assert.ok(config.config, "closing a client does not stop the shared server");
  console.log(JSON.stringify({ sharedTransport: "passed", concurrentResume: "passed", independentUnsubscribe: "passed", independentDisconnect: "passed", modelRequestsSent: 0 }));
} finally {
  if (a && threadId) await a.request("thread/archive", { threadId }).catch(() => {});
  a?.close(); b?.close(); child.kill();
}
