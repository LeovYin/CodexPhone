import { spawn, execFileSync } from "node:child_process";
import { mkdir, open, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";

const require = createRequire(new URL("../apps/host/package.json", import.meta.url));
const WebSocket = require("ws");
const [executable, ...originalArgs] = process.argv.slice(2);
const port = Number(process.env.CODEXPHONE_SHARED_PORT || 4501);
const runtimeFile = process.env.CODEXPHONE_SHARED_RUNTIME_FILE || path.resolve(".codexphone/backend-runtime.json");
let child, socket, closing = false, initializeId, ownsBackend = false;
let ownerLock;
const lockFile = `${runtimeFile}.owner.lock`;
const ownerFingerprint = createHash("sha256").update([process.env.CODEXPHONE_SHARED_SESSION || "", process.env.CODEX_APP_TOOLS_PIPE_PATH || "", path.resolve(process.env.CODEX_HOME || "."), path.resolve(executable || ".")].join("\0")).digest("hex");
let state = { adapterPid: process.pid, backendPid: null, address: `ws://127.0.0.1:${port}`, status: "starting", guiInitialized: false, appToolsEnvironmentPresent: Boolean(process.env.CODEX_APP_TOOLS_PIPE_PATH), startedAt: new Date().toISOString(), failureStage: null, optionNames: originalArgs.filter((value) => value.startsWith("-")).map((value) => value.split("=", 1)[0]), configKeys: originalArgs.flatMap((value,index) => value === "-c" ? [originalArgs[index + 1]?.split("=", 1)[0]] : []) };
let saving = Promise.resolve();
async function replaceStateFile(destination, content) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  // Windows readers (including Get-Content and antivirus) can briefly deny rename.
  // Retain atomic snapshots, but do not let one sharing violation poison the queue.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, destination); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
function save(update) {
  state = { ...state, ...update, revision: (state.revision || 0) + 1 }; const content = JSON.stringify(state, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(path.dirname(runtimeFile), { recursive: true });
    if (ownsBackend) await replaceStateFile(runtimeFile, content);
    await replaceStateFile(`${runtimeFile}.${process.pid}.trace.json`, content);
  });
  void saving.catch((error) => {
    process.stderr.write(`CodexPhone adapter state write failed (${["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(error.code) ? error.code : "IO"}).\n`);
    if (!closing) void finish(1);
  });
  return saving;
}
function stopBackend() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
  else child.kill();
}
async function finish(code) {
  if (closing) return; closing = true;
  socket?.terminate(); stopBackend();
  await save({ status: code ? "failed" : "stopped" }).catch(() => {});
  if (ownerLock) { await ownerLock.close(); await unlink(lockFile).catch(() => {}); }
  process.exit(code);
}
process.on("SIGINT", () => void finish(0)); process.on("SIGTERM", () => void finish(0));
process.stdout.on("error", () => void finish(0));
// Electron can terminate the native adapter without closing its grandchildren.
const nativeParent = process.ppid;
state.nativeParentPid = nativeParent;
setInterval(() => { try { process.kill(nativeParent, 0); } catch { void finish(0); } }, 1000).unref();

try {
  if (!executable || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid adapter configuration");
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  const lockDeadline = Date.now() + 15_000;
  let existing;
  while (!ownerLock) {
    try {
      ownerLock = await open(lockFile, "wx");
      await ownerLock.writeFile(JSON.stringify({ adapterPid: process.pid, ownerFingerprint }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let lock;
      try { lock = JSON.parse(await readFile(lockFile, "utf8")); } catch {}
      if (lock?.adapterPid) {
        let alive = true; try { process.kill(lock.adapterPid, 0); } catch (failure) { if (failure.code === "ESRCH") alive = false; }
        if (!alive) { await unlink(lockFile).catch(() => {}); continue; }
        if (!process.env.CODEXPHONE_SHARED_SESSION || lock.ownerFingerprint !== ownerFingerprint) throw new Error("Shared backend belongs to a different GUI launch");
        try {
          const candidate = JSON.parse(await readFile(runtimeFile, "utf8"));
          if (candidate.adapterPid === lock.adapterPid && candidate.ownerFingerprint === ownerFingerprint && candidate.status === "connected" && candidate.address === state.address) { existing = candidate; break; }
        } catch {}
      }
      if (Date.now() >= lockDeadline) throw new Error("Shared backend owner did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  // Do not silently attach the desktop to an unrelated server occupying the port.
  if (!existing) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(port, "127.0.0.1", resolve); });
    await new Promise((resolve) => reservation.close(resolve));
    ownsBackend = true;
  } else {
    process.kill(existing.backendPid, 0);
    await save({ reusedBackend: true, ownerAdapterPid: existing.adapterPid });
  }
  const args = [];
  for (let index = 0; index < originalArgs.length; index++) {
    if (originalArgs[index] === "--stdio") continue;
    if (originalArgs[index] === "--listen") { index++; continue; }
    if (originalArgs[index].startsWith("--listen=")) continue;
    args.push(originalArgs[index]);
  }
  args.push("--listen", state.address);
  // These are the real GUI-created values, including its fresh native tool pipe.
  // Do not substitute a prior chat's identity or tool pipe.
  const env = { ...process.env, CODEX_CLI_PATH: executable, CODEX_APP_RUNTIME_CLI_PATH: executable };
  // Routing belongs to the GUI entry point, never to tools or app-servers started by its backend.
  for (const name of Object.keys(env)) if (name.startsWith("CODEXPHONE_SHARED_") || name === "CODEX_APP_SERVER_FORCE_CLI" || name === "CODEX_APP_SERVER_WS_URL") delete env[name];
  if (ownsBackend) {
  child = spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  child.stderr.on("data", (data) => {
    // Save only the name of an unrecognized switch, never raw provider diagnostics.
    const match = data.toString().match(/unexpected argument '(--?[a-zA-Z0-9-]+)'/);
    if (match) void save({ unsupportedOption: match[1] });
  });
  child.once("error", () => { void save({ failureStage: "backend-spawn" }); void finish(1); });
  child.once("exit", (code) => { if (!closing) { void save({ failureStage: "backend-exit", backendExitCode: code }); void finish(1); } });
  await save({ backendPid: child.pid, ownerFingerprint });
  }
  let connected = false;
  for (let attempt = 0; attempt < 80 && !closing; attempt++) {
    try {
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) });
      if (ready.ok) { connected = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  if (!connected) throw new Error("Shared backend did not become ready");
  socket = new WebSocket(state.address, { maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
  socket.on("error", () => void finish(1)); socket.on("close", () => { if (!closing) void finish(1); });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", (data) => {
    try { const message = JSON.parse(data.toString()); if (initializeId !== undefined && message.id === initializeId && Object.hasOwn(message, "result")) void save({ guiInitialized: true }); } catch {}
    if (!process.stdout.write(`${data.toString()}\n`)) socket.pause();
  });
  process.stdout.on("drain", () => socket.resume());
  await save({ status: "connected" });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > 32 * 1024 * 1024 || socket.bufferedAmount > 32 * 1024 * 1024) { void finish(1); return; }
    try { const message = JSON.parse(line); if (message.method === "initialize") { initializeId = message.id; void save({ initializeRequestSeen: true }); } if (message.method === "initialized") void save({ guiInitialized: true }); } catch { void finish(1); return; }
    socket.send(line, (error) => { if (error) void finish(1); });
  });
  lines.on("close", () => void finish(0));
} catch (error) {
  await save({ failureStage: error?.code === "EADDRINUSE" ? "port-in-use" : error?.message === "Shared backend did not become ready" ? "backend-not-ready" : "adapter-startup" });
  process.stderr.write("CodexPhone shared backend could not start. Check the shared launcher status and port.\n");
  await finish(1);
}
