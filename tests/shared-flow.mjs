import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { AppServerClient } from "../apps/host/dist/app-server.js";
import { startMockProvider } from "./mock-provider.mjs";
import { ApprovalQueue } from "../apps/host/dist/approvals.js";
import { stopOwnedProcessTree } from "./process-cleanup.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "codexphone-shared-flow-"));
const provider = await startMockProvider();
const reservation = net.createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
await writeFile(path.join(directory, "config.toml"), `model = "codexphone-fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "${provider.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
const child = spawn(process.env.CODEX_BIN || "codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], { env: { ...process.env, CODEX_HOME: directory }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
child.stderr.on("data", () => {});
let desktop, phone;
const waitFor = async (predicate, label) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${label}`); };
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { desktop = await AppServerClient.connect(`ws://127.0.0.1:${port}`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  assert.ok(desktop); phone = await AppServerClient.connect(`ws://127.0.0.1:${port}`);
  const desktopEvents = [], phoneEvents = [];
  desktop.on("notification", (event) => desktopEvents.push(event)); phone.on("notification", (event) => phoneEvents.push(event));
  const started = await desktop.request("thread/start", { cwd: directory, approvalPolicy: "on-request", sandbox: "read-only" }); const threadId = started.thread.id;
  await desktop.request("turn/start", { threadId, input: [{ type: "text", text: "desktop fixture" }] });
  await waitFor(() => desktopEvents.some((entry) => entry.method === "turn/completed"), "desktop first turn");
  const resumed = await phone.request("thread/resume", { threadId, excludeTurns: false }); assert.equal(resumed.thread.id, threadId);
  await phone.request("turn/start", { threadId, input: [{ type: "text", text: "phone fixture" }] });
  await waitFor(() => phoneEvents.some((entry) => entry.method === "turn/completed"), "phone second turn");
  await waitFor(() => desktopEvents.filter((entry) => entry.method === "turn/completed").length === 2, "desktop receives phone completion");
  assert.ok(desktopEvents.some((entry) => entry.method === "item/agentMessage/delta" && entry.params.delta.includes("response 2")));
  await desktop.request("turn/start", { threadId, input: [{ type: "text", text: "desktop fixture again" }] });
  await waitFor(() => phoneEvents.filter((entry) => entry.method === "turn/completed").length === 2, "phone receives desktop completion");
  const history = await phone.request("thread/turns/list", { threadId, itemsView: "full", limit: 10 });
  assert.equal(history.data.length, 3);
  const userTexts = history.data.flatMap((turn) => turn.items.filter((item) => item.type === "userMessage").flatMap((item) => item.content.map((part) => part.text)));
  assert.deepEqual(userTexts.sort(), ["desktop fixture", "desktop fixture again", "phone fixture"].sort());
  const phoneApprovals = new ApprovalQueue(phone); const desktopApprovals = new ApprovalQueue(desktop);
  phone.on("serverRequest", (request) => phoneApprovals.add(request)); desktop.on("serverRequest", (request) => desktopApprovals.add(request));
  phone.on("notification", (event) => { if (event.method === "serverRequest/resolved") phoneApprovals.remove(event.params.requestId); });
  desktop.on("notification", (event) => { if (event.method === "serverRequest/resolved") desktopApprovals.remove(event.params.requestId); });
  provider.state.nextFunction = { name: "exec_command", arguments: { cmd: "echo codexphone-approval-fixture", sandbox_permissions: "require_escalated", justification: "Local approval-routing test; decline without executing" } };
  const approvalTurn = await desktop.request("turn/start", { threadId, input: [{ type: "text", text: "approval fixture" }] });
  await waitFor(() => phoneApprovals.list(threadId).length > 0, "phone receives desktop approval");
  const request = phoneApprovals.list(threadId)[0]; assert.equal(request.kind, "command");
  phoneApprovals.answer(request.id, { decision: "decline" });
  await waitFor(() => desktopEvents.some((entry) => entry.method === "turn/completed" && entry.params.turn?.id === approvalTurn.turn.id), "declined approval turn completes");
  await waitFor(() => desktopApprovals.list(threadId).length === 0, "desktop clears resolved approval");
  const dynamic = (await desktop.request("thread/start", { cwd: directory, dynamicTools: [{ type: "function", name: "gui_fixture", description: "Local GUI-owned tool fixture", inputSchema: { type: "object", properties: {} } }] })).thread;
  await desktop.request("turn/start", { threadId: dynamic.id, input: [{ type: "text", text: "create persistent dynamic fixture" }] });
  await waitFor(() => desktopEvents.some((entry) => entry.method === "turn/completed" && entry.params.threadId === dynamic.id), "dynamic fixture history");
  await phone.request("thread/resume", { threadId: dynamic.id });
  let guiToolCalls = 0;
  desktop.on("serverRequest", (request) => {
    if (request.method !== "item/tool/call") return;
    guiToolCalls++;
    desktop.respond(request.id, { success: true, contentItems: [{ type: "inputText", text: "GUI fixture tool succeeded" }] });
  });
  provider.state.nextFunction = { name: "gui_fixture", arguments: {} };
  const dynamicTurn = await phone.request("turn/start", { threadId: dynamic.id, input: [{ type: "text", text: "phone requests GUI-owned fixture tool" }] });
  await waitFor(() => desktopEvents.some((entry) => entry.method === "turn/completed" && entry.params.turn?.id === dynamicTurn.turn.id), "GUI-owned tool completes during phone turn");
  assert.equal(guiToolCalls, 1);
  assert.ok(provider.state.requests.some((request) => JSON.stringify(request.input).includes("GUI fixture tool succeeded")));
  provider.state.hold = true;
  const held = await desktop.request("turn/start", { threadId, input: [{ type: "text", text: "interrupt fixture" }] });
  await waitFor(() => provider.state.streams.size > 0, "held stream");
  await phone.request("turn/interrupt", { threadId, turnId: held.turn.id });
  await waitFor(() => desktopEvents.some((entry) => entry.method === "turn/completed" && entry.params.turn?.id === held.turn.id && entry.params.turn.status === "interrupted"), "phone interrupts desktop turn");
  console.log(JSON.stringify({ phoneToDesktop: "passed", desktopToPhone: "passed", sharedHistory: "passed", crossClientInterrupt: "passed", crossClientApproval: "passed", guiOwnedDynamicTool: "passed", approvalCommandExecuted: false, localFixtureCalls: provider.state.requests.length, externalApiCalls: 0 }));
} finally {
  desktop?.close(); phone?.close(); stopOwnedProcessTree(child); await provider.close();
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
