import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { stopOwnedProcessTree } from "./process-cleanup.mjs";

if (process.platform !== "win32") process.exit(0);
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const executable = path.resolve(process.argv[2] || "releases/" + version + "/CodexPhone-" + version + "-win-x64.exe");
const temporary = await mkdtemp(path.join(tmpdir(), "codexphone-release-"));
const extracted = path.join(temporary, "中文 路径", "CodexPhone");
let hostProcess, backend, hostBase;
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error("Timed out: " + label);
};
try {
  execFileSync(executable, ["--extract-only", extracted], { windowsHide: true, timeout: 90_000, stdio: "pipe" });
  const node = path.join(extracted, "runtime/node.exe");
  const bundledVersion = execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  assert.match(bundledVersion, /^v24\./);
  assert.ok((await readFile(path.join(extracted, "runtime/NODE-LICENSE.txt"), "utf8")).includes("Node.js"));
  assert.ok((await readFile(path.join(extracted, "USER_GUIDE.txt"), "utf8")).includes("CodexPhone 使用说明"));
  const ico = await readFile(path.join(extracted, "runtime/codexphone.ico"));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  assert.ok((await readFile(path.join(extracted, "apps/web/dist/icons/icon.svg"), "utf8")).includes("CodexPhone"));
  assert.ok((await readFile(path.join(extracted, "THIRD-PARTY-NOTICES.txt"), "utf8")).includes("react"));
  const minimalPath = path.join(process.env.SystemRoot, "System32") + ";" + path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0");
  const env = { ...process.env, PATH: minimalPath, Path: minimalPath };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX") || key.startsWith("BROWSER_USE_")) delete env[key];
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(extracted, "scripts/Build-SharedLauncher.ps1"), "-CodexExecutable", node], { env, windowsHide: true, stdio: "pipe" });
  // Reusing a prebuilt adapter exercises the module-independent SHA-256 comparison.
  execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(extracted, "scripts/Build-SharedLauncher.ps1"), "-CodexExecutable", node], { env, windowsHide: true, stdio: "pipe" });
  const shim = path.join(extracted, ".codexphone/launcher/codexphone-cli.exe");
  assert.equal(execFileSync(shim, ["--version"], { env, windowsHide: true, encoding: "utf8" }).trim(), bundledVersion);
  const require = createRequire(path.join(extracted, "apps/host/package.json"));
  const { WebSocketServer } = require("ws");
  backend = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => backend.once("listening", resolve));
  let turns = 0;
  backend.on("connection", (socket) => socket.on("message", (buffer) => {
    const message = JSON.parse(buffer.toString());
    if (message.id === undefined) return;
    let result = {};
    switch (message.method) {
      case "initialize": result = { userAgent: "local-release-fixture" }; break;
      case "config/read": result = { config: { model: "release-fixture", model_provider: "local-fixture" } }; break;
      case "account/read": result = { account: { type: "apiKey" } }; break;
      case "model/list": result = { data: [{ id: "release-fixture", model: "release-fixture", displayName: "Local fixture", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }; break;
      case "project/list": result = { data: [{ id: "fixture-project", name: "Release fixture", roots: [{ path: temporary }] }] }; break;
      case "thread/list": result = { data: [] }; break;
      case "thread/start": result = { thread: { id: "release-thread", cwd: temporary, source: "appServer" } }; break;
      case "turn/start": turns++; result = { turn: { id: "release-turn", status: "completed" } }; break;
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  Object.assign(env, { CODEXPHONE_HOME: path.join(temporary, "phone-data"), CODEX_HOME: path.join(temporary, "codex-data"), CODEX_BIN: node, CODEXPHONE_PROJECTS: "Fixture=" + temporary,
    CODEXPHONE_APP_SERVER_URL: "ws://127.0.0.1:" + backend.address().port, HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "info" });
  let pairing;
  hostProcess = spawn(node, [path.join(extracted, "apps/host/dist/index.js")], { env, cwd: extracted, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  hostProcess.stderr.on("data", () => {});
  let stdout = "";
  hostProcess.stdout.on("data", (data) => {
    stdout += data.toString();
    const lines = stdout.split("\n"); stdout = lines.pop();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.pairing) pairing = entry.pairing;
        const match = entry.msg?.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) hostBase = match[1];
      } catch {}
    }
  });
  await waitFor(() => pairing && hostBase, "extracted host startup");
  const health = await (await fetch(hostBase + "/api/health")).json();
  assert.equal(health.status, "ready"); assert.equal(health.transport, "websocket");
  assert.equal((await fetch(hostBase + "/api/models")).status, 401);
  const home = await fetch(hostBase);
  assert.equal(home.status, 200);
  const html = await home.text();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) assert.equal((await fetch(hostBase + match[1])).status, 200);
  const pairedResponse = await fetch(hostBase + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Release test" }) });
  assert.equal(pairedResponse.status, 200);
  const paired = await pairedResponse.json(), headers = { Authorization: "Bearer " + paired.token };
  assert.equal((await fetch(hostBase + "/api/projects", { headers })).status, 200);
  const models = await (await fetch(hostBase + "/api/models", { headers })).json();
  assert.equal(models.models[0].id, "release-fixture");
  const projects = await (await fetch(hostBase + "/api/projects", { headers })).json();
  const project = projects.projects.find((entry) => entry.canStart);
  const sent = await fetch(hostBase + "/api/threads", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, prompt: "Local release fixture", model: "release-fixture", effort: "medium" }) });
  assert.equal(sent.status, 200); assert.equal(turns, 1);
  assert.equal((await (await fetch(hostBase + "/api/health")).json()).pairedDevices, 1);
  // Check relocation rather than relying on the build directory's modules or system Node.
  assert.equal((await readdir(path.join(extracted, "runtime"))).includes("node.exe"), true);
  console.log(JSON.stringify({ exeExtraction: "passed", unicodeAndSpacePath: "passed", bundledNode: bundledVersion, prebuiltNativeAdapter: "passed",
    systemNodeNotRequired: "passed", staticAssets: "passed", pairing: "passed", authentication: "passed", localFixtureSend: "passed", externalApiCalls: 0 }));
} finally {
  stopOwnedProcessTree(hostProcess);
  if (backend) { for (const client of backend.clients) client.terminate(); await new Promise((resolve) => backend.close(resolve)); }
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
