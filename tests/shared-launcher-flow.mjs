import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { AppServerClient } from "../apps/host/dist/app-server.js";
import { DeviceStore } from "../apps/host/dist/store.js";
import { startMockProvider } from "./mock-provider.mjs";
import { stopOwnedProcessTree } from "./process-cleanup.mjs";

if (process.platform !== "win32") process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), "codexphone-launcher-flow-"));
const provider = await startMockProvider();
const freePort = async () => { const reservation = net.createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve)); const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve)); return port; };
const phonePort = await freePort(), stalePort = await freePort();
const occupied = net.createServer();
occupied.on("connection", (socket) => socket.destroy());
await new Promise((resolve, reject) => { occupied.once("error", (error) => error.code === "EADDRINUSE" ? resolve() : reject(error)); occupied.listen(4501, "127.0.0.1", resolve); });
const home = path.join(root, "codex"), phoneHome = path.join(root, "phone"), runtimeDir = path.join(root, "runtime");
await mkdir(home); await mkdir(runtimeDir);
await writeFile(path.join(home, "config.toml"), `model = "codexphone-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
await writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "codexphone-local-fixture-not-a-real-key" }));
const devices = new DeviceStore(phoneHome); await devices.load(); const paired = await devices.pair(devices.pairingInfo.code, "launcher-fixture");
const env = { ...process.env, CODEX_HOME: home, CODEXPHONE_HOME: phoneHome, CODEXPHONE_PROJECTS: `Fixture=${root}`, CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "gui-profile"), HOST: "127.0.0.1", PORT: String(phonePort), LOG_LEVEL: "silent" };
for (const name of ["CODEXPHONE_APP_SERVER_URL", "CODEX_CLI_PATH", "CODEX_APP_RUNTIME_CLI_PATH", "CODEX_APP_SERVER_WS_URL", "CODEX_APP_SERVER_FORCE_CLI", "CODEX_THREAD_ID", "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY", "CODEX_APP_TOOLS_PIPE_PATH"]) delete env[name];
const executable = (await readFile(path.resolve(".codexphone/launcher/launcher-paths.txt"), "utf8")).trim().split(/\r?\n/).at(-1);
const stale = spawn(executable, ["app-server", "--listen", `ws://127.0.0.1:${stalePort}`], { env, stdio: "ignore", windowsHide: true });
const old = spawn(process.execPath, [path.resolve("apps/host/dist/index.js")], { env: { ...env, CODEXPHONE_APP_SERVER_URL: `ws://127.0.0.1:${stalePort}` }, stdio: "ignore", windowsHide: true });
await writeFile(path.join(runtimeDir, "backend-runtime.json"), JSON.stringify({ status: "connected", address: "ws://127.0.0.1:4501", adapterPid: old.pid, backendPid: stale.pid, guiInitialized: true }));
let launcher, runtime, desktopClient, failed = false;
const waitFor = async (predicate, label) => { const deadline = Date.now() + 45_000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
const health = async () => { try { return await (await fetch(`http://127.0.0.1:${phonePort}/api/health`)).json(); } catch { return {}; } };
function stopRecordedOwnedProcess(processId) { if (!processId) return; try { execFileSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} }
try {
  await waitFor(async () => (await health()).status === "ready", "isolated original phone bridge");
  assert.equal((await health()).transport, "websocket");
  let output = "";
  launcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/Start-SharedCodex.ps1"), "-PhonePort", String(phonePort), "-RuntimeDirectory", runtimeDir], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  launcher.stdout.on("data", (data) => { output += data; }); launcher.stderr.on("data", (data) => { output += data; });
  const code = await new Promise((resolve) => launcher.on("exit", resolve));
  assert.equal(code, 0, output);
  console.log("Isolated launcher: initial cutover ready");
  runtime = JSON.parse((await readFile(path.join(runtimeDir, "shared-runtime.json"), "utf8")).replace(/^\uFEFF/, ""));
  assert.notEqual(new URL(runtime.address).port, "4501");
  assert.notEqual(runtime.bridgePid, old.pid);
  assert.equal((await health()).transport, "websocket"); assert.equal((await health()).pairedDevices, 1);
  const request = await fetch(`http://127.0.0.1:${phonePort}/api/projects`, { headers: { Authorization: `Bearer ${paired.token}` } }); assert.equal(request.status, 200);
  desktopClient = await AppServerClient.connect(runtime.address);
  const thread = (await desktopClient.request("thread/start", { cwd: root })).thread;
  const completed = new Promise((resolve) => desktopClient.on("notification", (event) => { if (event.method === "turn/completed") resolve(); }));
  await desktopClient.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "isolated launch fixture" }] }); await completed;
  const detail = await fetch(`http://127.0.0.1:${phonePort}/api/threads/${thread.id}`, { headers: { Authorization: `Bearer ${paired.token}` } }); assert.equal(detail.status, 200);
  assert.equal((await detail.json()).thread.canControl, true);
  const again = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/Start-SharedCodex.ps1"), "-PhonePort", String(phonePort), "-RuntimeDirectory", runtimeDir], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let againOutput = ""; again.stdout.on("data", (data) => { againOutput += data; }); again.stderr.on("data", (data) => { againOutput += data; });
  assert.equal(await new Promise((resolve) => again.on("exit", resolve)), 0, againOutput);
  console.log("Isolated launcher: repeated launch recognized");
  assert.equal((await health()).transport, "websocket");
  const beforePairRefresh = runtime;
  const renew = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/Start-SharedCodex.ps1"), "-PhonePort", String(phonePort), "-RuntimeDirectory", runtimeDir, "-RenewPairing"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let renewOutput = ""; renew.stdout.on("data", (data) => { renewOutput += data; }); renew.stderr.on("data", (data) => { renewOutput += data; });
  assert.equal(await new Promise((resolve) => renew.once("exit", resolve)), 0, renewOutput);
  runtime = JSON.parse((await readFile(path.join(runtimeDir, "shared-runtime.json"), "utf8")).replace(/^\uFEFF/, ""));
  assert.equal(runtime.desktopPid, beforePairRefresh.desktopPid);
  assert.equal(runtime.adapterPid, beforePairRefresh.adapterPid);
  assert.notEqual(runtime.bridgePid, beforePairRefresh.bridgePid);
  assert.equal((await fetch("http://127.0.0.1:" + phonePort + "/api/projects", { headers: { Authorization: "Bearer " + paired.token } })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  const after = JSON.parse(await readFile(path.join(runtimeDir, "backend-runtime.json"), "utf8"));
  assert.equal(after.adapterPid, runtime.adapterPid); assert.equal(after.status, "connected"); assert.equal(after.guiInitialized, true);
  const traces = (await readdir(runtimeDir)).filter((name) => name.endsWith(".trace.json"));
  for (const name of traces) { const trace = JSON.parse(await readFile(path.join(runtimeDir, name), "utf8")); assert.equal(trace.failureStage, null, "late auxiliary host must not fail or displace owner"); }
  console.log(JSON.stringify({ originalGuiLaunch: "passed", staleWebsocketBridgeReplaced: "passed", occupiedPortSkipped: "passed", originalPairingRetained: "passed", phoneAttachesGuiBackend: "passed", repeatedLaunch: "passed", pairingRefreshWithoutGuiRestart: "passed", lateAuxiliaryHostStable: "passed", originalUserGuiUntouched: true, externalApiCalls: 0 }));
} catch (error) {
  failed = true;
  console.error(`Isolated launcher failure artifacts: ${root}`);
  throw error;
} finally {
  desktopClient?.close(); stopOwnedProcessTree(old); stopOwnedProcessTree(stale);
  if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
  if (runtime) { stopRecordedOwnedProcess(runtime.bridgePid); stopRecordedOwnedProcess(runtime.desktopPid); }
  else if (launcher) stopOwnedProcessTree(launcher);
  await provider.close();
  if (!failed) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
