import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeviceStore } from "../apps/host/dist/store.js";

// A separate, ephemeral host and device store. Only read-only Codex requests are made.
const stateDir = await mkdtemp(path.join(tmpdir(), "codexphone-smoke-"));
let runtime;
try {
  const store = new DeviceStore(stateDir); await store.load();
  const paired = await store.pair(store.pairingInfo.code, "Temporary smoke test");
  Object.assign(process.env, { CODEXPHONE_HOME: stateDir, HOST: "127.0.0.1", PORT: "0", LOG_LEVEL: "silent", CODEXPHONE_PROJECTS: `CodexPhone=${process.cwd()}` });
  runtime = await import("../apps/host/dist/index.js");
  const address = runtime.host.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${paired.token}` };
  const get = async (endpoint) => {
    const response = await fetch(`${base}${endpoint}`, { headers });
    assert.equal(response.status, 200, `${endpoint} status`); return response.json();
  };
  const status = await get("/api/health"); assert.equal(status.status, "ready");
  assert.equal((await fetch(`${base}/api/models`)).status, 401);
  assert.equal((await fetch(`${base}/api/media?threadId=x&file=x.svg`)).status, 401);
  const catalog = await get("/api/models"); assert.ok(catalog.models.length > 0);
  const projects = await get("/api/projects"); const project = projects.projects.find((entry) => entry.canStart);
  assert.ok(project?.codexProjectId);
  const threads = await get(`/api/threads?projectId=${project.id}`); assert.ok(threads.threads.length > 0);
  const threadId = threads.threads[0].id;
  const detail = await get(`/api/threads/${threadId}`); assert.ok(Array.isArray(detail.turns));
  const media = await fetch(`${base}/api/media?${new URLSearchParams({ threadId, file: "docs/mobile-conversation.png" })}`, { headers });
  assert.equal(media.status, 200); assert.equal(media.headers.get("content-type"), "image/png");
  const escaped = await fetch(`${base}/api/media?${new URLSearchParams({ threadId, file: "../../outside.svg" })}`, { headers });
  assert.ok([403, 404].includes(escaped.status));
  const invalidModel = await fetch(`${base}/api/threads`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, prompt: "Validation only; must not be sent", model: "invalid-model-for-validation", effort: "wrong" }) });
  assert.equal(invalidModel.status, 400);
  console.log(JSON.stringify({ realHost: "passed", authenticatedModels: catalog.models.length, threadsVisible: threads.threads.length, projectIdentity: "present", mediaAuth: "passed", modelRequestsSent: 0 }));
} finally {
  if (runtime) await runtime.closeHost();
  await rm(stateDir, { recursive: true, force: true });
}
