import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { AppServerClient } from "../apps/host/dist/app-server.js";
import { startMockProvider } from "./mock-provider.mjs";
import { stopOwnedProcessTree } from "./process-cleanup.mjs";

if (process.platform !== "win32") { console.log("Native Windows adapter test skipped on this platform"); process.exit(0); }
const root = await mkdtemp(path.join(tmpdir(), "codexphone-adapter-flow-"));
const provider = await startMockProvider();
const reservation = net.createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
execFileSync("powershell.exe", ["-NoProfile", "-File", path.resolve("scripts/Build-SharedLauncher.ps1")], { windowsHide: true, stdio: "ignore" });
const shim = path.resolve(".codexphone/launcher/codexphone-cli.exe");
const runtimeFile = path.join(root, "runtime.json");
await writeFile(path.join(root, "config.toml"), `model = "codexphone-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const env = { ...process.env, CODEX_HOME: root, CODEXPHONE_SHARED_HOME: root, CODEXPHONE_SHARED_SESSION: 'isolated-adapter-session', CODEXPHONE_SHARED_PORT: String(port), CODEXPHONE_SHARED_RUNTIME_FILE: runtimeFile };
const child = spawn(shim, ["app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stderr.on("data", () => {});
const desktop = new AppServerClient(child); let phone;
const events = [];
desktop.on("notification", (event) => events.push(event));
const waitFor = async (predicate, label) => { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}`); };
try {
  await desktop.request("initialize", { clientInfo: { name: "adapter-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  desktop.notify("initialized", {});
  await waitFor(async () => JSON.parse(await readFile(runtimeFile, "utf8")).guiInitialized, "adapter forwards GUI initialize").catch(async (error) => { console.error(await readFile(runtimeFile, "utf8")); throw error; });
  const runtimeBeforePreflight = JSON.parse(await readFile(runtimeFile, "utf8"));
  const preflight = execFileSync(shim, ["app-server", "--print-startup-config", "--startup-client-info", '{"name":"fixture","version":"1"}'], { env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(typeof JSON.parse(preflight), "object");
  assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).adapterPid, runtimeBeforePreflight.adapterPid);
  const secondaryProcess = spawn(shim, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  secondaryProcess.stderr.on("data", () => {});
  const secondary = new AppServerClient(secondaryProcess);
  try {
    await secondary.request("initialize", { clientInfo: { name: "auxiliary-fixture", version: "1" }, capabilities: { experimentalApi: true } });
    assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).adapterPid, runtimeBeforePreflight.adapterPid);
    const rejectedProcess = spawn(shim, ["app-server"], { env: { ...env, CODEXPHONE_SHARED_SESSION: 'unrelated-session' }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    rejectedProcess.stderr.on("data", () => {}); rejectedProcess.stdout.resume();
    assert.equal(await new Promise((resolve) => rejectedProcess.once("exit", resolve)), 1);
    assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).adapterPid, runtimeBeforePreflight.adapterPid);
  } finally { secondary.close(); }
  const concurrent = Array.from({ length: 4 }, () => {
    const process = spawn(shim, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    process.stderr.on("data", () => {});
    return new AppServerClient(process);
  });
  try {
    await Promise.all(concurrent.map((client) => client.request("initialize", { clientInfo: { name: "concurrent-fixture", version: "1" }, capabilities: { experimentalApi: true } })));
    assert.equal(JSON.parse(await readFile(runtimeFile, "utf8")).adapterPid, runtimeBeforePreflight.adapterPid);
  } finally { concurrent.forEach((client) => client.close()); }
  phone = await AppServerClient.connect(`ws://127.0.0.1:${port}`);
  const thread = (await desktop.request("thread/start", { cwd: root })).thread;
  await desktop.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "adapter desktop fixture" }] });
  await waitFor(() => events.filter((entry) => entry.method === "turn/completed").length === 1, "first turn");
  await phone.request("thread/resume", { threadId: thread.id });
  await phone.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "adapter phone fixture" }] });
  await waitFor(() => events.filter((entry) => entry.method === "turn/completed").length === 2, "phone turn delivered through native stdio adapter");
  phone.close(); desktop.close();
  await waitFor(async () => JSON.parse(await readFile(runtimeFile, "utf8")).status === "stopped", "GUI stdin close stops owned backend");
  const version = execFileSync(shim, ["--version"], { encoding: "utf8", windowsHide: true });
  assert.match(version, /codex-cli/);
  console.log(JSON.stringify({ nativeStdioAdapter: "passed", phoneTurnToGuiStdio: "passed", guiCloseCleanup: "passed", cliPassthrough: "passed", guiStartupPreflight: "passed", auxiliaryConnectionReuse: "passed", concurrentConnections: "passed", unrelatedSessionRejected: "passed", ownerStatePreserved: "passed", externalApiCalls: 0 }));
} finally {
  phone?.close(); desktop.close(); stopOwnedProcessTree(child); await provider.close();
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
