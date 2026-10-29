import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { AppServerClient } from "../apps/host/dist/app-server.js";
import { stopOwnedProcessTree } from "./process-cleanup.mjs";

if (process.platform !== "win32") process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), "codexphone-lifecycle-"));
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
const runtimeFile = path.join(root, "runtime.json");
const shim = path.resolve(".codexphone/launcher/codexphone-cli.exe");
execFileSync("powershell.exe", ["-NoProfile", "-File", path.resolve("scripts/Build-SharedLauncher.ps1")], { windowsHide: true, stdio: "ignore" });
const env = { ...process.env, CODEX_HOME: root, CODEXPHONE_SHARED_HOME: root, CODEXPHONE_SHARED_SESSION: "concurrent-first-start", CODEXPHONE_SHARED_PORT: String(port), CODEXPHONE_SHARED_RUNTIME_FILE: runtimeFile };
const children = [], clients = []; let locker;
const readState = async () => JSON.parse(await readFile(runtimeFile, "utf8"));
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}`); };
try {
  for (let index = 0; index < 4; index++) {
    const child = spawn(shim, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    children.push(child); clients.push(new AppServerClient(child));
  }
  await Promise.all(clients.map((client) => client.request("initialize", { clientInfo: { name: "lifecycle-fixture", version: "1" } })));
  clients.forEach((client) => client.notify("initialized", {}));
  await waitFor(async () => (await readState()).guiInitialized, "concurrent owner initialization");
  const owner = await readState();
  const ownerIndex = children.findIndex((child) => child.pid === owner.nativeParentPid);
  assert.notEqual(ownerIndex, -1);
  const marker = path.join(root, "locked"), release = path.join(root, "release"), lockScript = path.join(root, "hold-reader.ps1");
  await writeFile(lockScript, [
    "param($Target,$Marker,$Release)",
    "$handle = [IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    `try { [IO.File]::WriteAllText($Marker,"locked"); $deadline = [DateTime]::UtcNow.AddSeconds(5); while (-not [IO.File]::Exists($Release) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 } } finally { $handle.Dispose() }`,
  ].join("\n"));
  locker = spawn("powershell.exe", ["-NoProfile", "-File", lockScript, runtimeFile, marker, release], { windowsHide: true, stdio: "ignore" });
  await waitFor(() => exists(marker), "Windows reader lock");
  const before = await readState();
  clients[ownerIndex].notify("initialized", {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await readState()).revision, before.revision);
  await writeFile(release, "release");
  await waitFor(async () => (await readState()).revision > before.revision, "state recovers after sharing violation");
  assert.equal((await readState()).status, "connected");
  // Terminate only the native parent, deliberately leaving its children to the watchdog.
  execFileSync("taskkill.exe", ["/PID", String(children[ownerIndex].pid), "/F"], { windowsHide: true, stdio: "ignore" });
  await waitFor(async () => (await readState()).status === "stopped", "abrupt parent exit cleans backend");
  await waitFor(async () => !(await exists(`${runtimeFile}.owner.lock`)), "owner lock released");
  assert.throws(() => process.kill(owner.backendPid, 0), { code: "ESRCH" });
  console.log(JSON.stringify({ concurrentFirstStartup: "passed", windowsReaderLockRecovery: "passed", abruptNativeParentCleanup: "passed", ownerLockReleased: "passed", externalApiCalls: 0 }));
} finally {
  clients.forEach((client) => client.close()); children.forEach(stopOwnedProcessTree); stopOwnedProcessTree(locker);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
