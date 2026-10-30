import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
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
const timedFetch = (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(5_000) });
const freePort = async () => {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
};
const waitForStopped = (url, label) => waitFor(async () => {
  try { await timedFetch(url, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}, label);
try {
  execFileSync(executable, ["--extract-only", extracted], { windowsHide: true, timeout: 90_000, stdio: "pipe" });
  console.log("release test: EXE extracted");
  const preview = path.join(temporary, "desktop-preview.png");
  execFileSync(executable, ["--render-preview", preview], { windowsHide: true, timeout: 30_000, stdio: "pipe" });
  assert.equal((await readFile(preview)).subarray(1, 4).toString(), "PNG");
  console.log("release test: desktop XAML rendered");
  const node = path.join(extracted, "runtime/node.exe");
  const bundledVersion = execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  assert.match(bundledVersion, /^v24\./);
  assert.ok((await readFile(path.join(extracted, "runtime/NODE-LICENSE.txt"), "utf8")).includes("Node.js"));
  assert.ok((await readFile(path.join(extracted, "USER_GUIDE.txt"), "utf8")).includes("CodexPhone 使用说明"));
  const ico = await readFile(path.join(extracted, "runtime/codexphone.ico"));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  assert.ok((await readFile(path.join(extracted, "apps/web/dist/icons/icon.svg"), "utf8")).includes("CodexPhone"));
  assert.ok((await readFile(path.join(extracted, "THIRD-PARTY-NOTICES.txt"), "utf8")).includes("react"));
  assert.ok((await readFile(path.join(extracted, "apps/host/dist/account-service.js"), "utf8")).includes("CodexPhone Accounts"));
  const minimalPath = path.join(process.env.SystemRoot, "System32") + ";" + path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0");
  const env = { ...process.env, PATH: minimalPath, Path: minimalPath };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX") || key.startsWith("BROWSER_USE_")) delete env[key];
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(extracted, "scripts/Build-SharedLauncher.ps1"), "-CodexExecutable", node], { env, windowsHide: true, stdio: "pipe" });
  // Reusing a prebuilt adapter exercises the module-independent SHA-256 comparison.
  execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(extracted, "scripts/Build-SharedLauncher.ps1"), "-CodexExecutable", node], { env, windowsHide: true, stdio: "pipe" });
  const shim = path.join(extracted, ".codexphone/launcher/codexphone-cli.exe");
  assert.equal(execFileSync(shim, ["--version"], { env, windowsHide: true, encoding: "utf8" }).trim(), bundledVersion);
  const accountsHome = path.join(temporary, "account-service-data");
  const accountsEnv = { ...env, CODEXPHONE_ACCOUNTS_HOME: accountsHome, CODEXPHONE_ACCOUNTS_BIND: "127.0.0.1", CODEXPHONE_ACCOUNTS_PORT: "0" };
  const accounts = spawn(node, [path.join(extracted, "apps/host/dist/account-service.js")], { env: accountsEnv, cwd: extracted, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let accountsLog = ""; accounts.stdout.on("data", chunk => { accountsLog += chunk.toString(); }); accounts.stderr.on("data", () => {});
  let accountsUrl;
  try {
    await waitFor(() => { const match = accountsLog.match(/"address":\[\{"address":"127\.0\.0\.1","family":"IPv4","port":(\d+)\}\]/); if (match) { accountsUrl = "http://127.0.0.1:" + match[1]; return true; } return false; }, "packaged SQLite account service");
    console.log("release test: packaged account service ready");
    const health = await (await timedFetch(accountsUrl + "/health")).json(); assert.equal(health.storage, "sqlite"); assert.equal(health.version, version);
    const secret = (await readFile(path.join(accountsHome, "admin-token"), "utf8")).trim();
    const register = await timedFetch(accountsUrl + "/v1/register", { method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" }, body: JSON.stringify({ username: "张三", password: "abc123" }) }); assert.equal(register.status, 200);
    const login = await timedFetch(accountsUrl + "/v1/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "张三", password: "abc123", installationId: "release-phone-installation-001" }) }); assert.equal(login.status, 200);
    const db = await readFile(path.join(accountsHome, "accounts.sqlite"));
    const wal = await readFile(path.join(accountsHome, "accounts.sqlite-wal")).catch(() => Buffer.alloc(0));
    const stored = Buffer.concat([db, wal]); assert.equal(stored.includes(Buffer.from("abc123")), false); assert.equal(stored.includes(Buffer.from("张三")), true);
    const shutdown = await timedFetch(accountsUrl + "/admin/shutdown", { method: "POST", headers: { Authorization: "Bearer " + secret } }); assert.equal(shutdown.status, 200);
    await waitForStopped(accountsUrl + "/health", "graceful account service upgrade shutdown");
  } finally { stopOwnedProcessTree(accounts); }
  const upgradePort = await freePort();
  const upgradeHome = path.join(temporary, "upgrade-account-home");
  const upgradeEnv = { ...accountsEnv, CODEXPHONE_ACCOUNTS_HOME: upgradeHome, CODEXPHONE_ACCOUNTS_PORT: String(upgradePort) };
  let seededService, staleService;
  try {
    seededService = spawn(node, [path.join(extracted, "apps/host/dist/account-service.js")], { env: upgradeEnv, cwd: extracted, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    seededService.stdout.on("data", () => {}); seededService.stderr.on("data", () => {});
    const upgradeUrl = "http://127.0.0.1:" + upgradePort;
    await waitFor(async () => { try { return (await (await timedFetch(upgradeUrl + "/health")).json()).version === version; } catch { return false; } }, "initial account service for upgrade fixture");
    const upgradeSecret = (await readFile(path.join(upgradeHome, "admin-token"), "utf8")).trim();
    const seeded = await timedFetch(upgradeUrl + "/v1/register", { method: "POST", headers: { Authorization: "Bearer " + upgradeSecret, "Content-Type": "application/json" }, body: JSON.stringify({ username: "survivor", password: "keep123" }) }); assert.equal(seeded.status, 200);
    await timedFetch(upgradeUrl + "/admin/shutdown", { method: "POST", headers: { Authorization: "Bearer " + upgradeSecret } });
    await waitForStopped(upgradeUrl + "/health", "seed account service shutdown");

    const staleRoot = path.join(temporary, "stale-account-install");
    const staleEntry = path.join(staleRoot, "apps", "host", "dist", "account-service.js");
    await mkdir(path.dirname(staleEntry), { recursive: true });
    await writeFile(path.join(staleRoot, "apps", "host", "package.json"), JSON.stringify({ name: "@codexphone/host", version: "0.3.3" }));
    await writeFile(staleEntry, "import http from 'node:http'; const server=http.createServer((req,res)=>{if(req.url!=='/health'){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({product:'CodexPhone Accounts',version:'0.3.3'}));}); server.listen(Number(process.env.CODEXPHONE_ACCOUNTS_PORT),'127.0.0.1');");
    staleService = spawn(node, [staleEntry], { env: upgradeEnv, cwd: staleRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); staleService.stderr.on("data", () => {});
    await waitFor(async () => { try { return (await (await timedFetch(upgradeUrl + "/health")).json()).version === "0.3.3"; } catch { return false; } }, "stale account service fixture");
    console.log("release test: stale account service fixture ready");
    execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(extracted, "scripts/Start-AccountService.ps1"), "-Port", String(upgradePort), "-AccountsHome", upgradeHome], { env: upgradeEnv, windowsHide: true, stdio: "ignore", timeout: 90_000 });
    console.log("release test: account service launch script returned");
    await waitFor(async () => { try { return (await (await timedFetch(upgradeUrl + "/health")).json()).version === version; } catch { return false; } }, "upgraded account service");
    console.log("release test: upgraded service is healthy");
    const relogin = await timedFetch(upgradeUrl + "/v1/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "survivor", password: "keep123", installationId: "upgrade-survival-phone-001" }) }); assert.equal(relogin.status, 200);
    console.log("release test: old account login passed");
    await timedFetch(upgradeUrl + "/admin/shutdown", { method: "POST", headers: { Authorization: "Bearer " + upgradeSecret } });
    await waitForStopped(upgradeUrl + "/health", "upgraded account service shutdown");
  } finally { if (seededService) stopOwnedProcessTree(seededService); if (staleService) stopOwnedProcessTree(staleService); }
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
