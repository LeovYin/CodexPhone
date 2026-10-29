import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeItem } from "../apps/host/dist/normalize.js";
import { modelSelection } from "../apps/host/dist/models.js";
import { readImage } from "../apps/host/dist/media.js";
import { AppServerClient } from "../apps/host/dist/app-server.js";
import { ApprovalQueue } from "../apps/host/dist/approvals.js";
import { appendDelta } from "../apps/web/src/live.ts";

test("image-only user messages survive normalization; internal items stay local", () => {
  const item = normalizeItem({ type: "userMessage", content: [{ type: "localImage", path: "C:/project/a.svg" }] });
  assert.deepEqual(item.images, ["C:/project/a.svg"]);
  assert.equal(item.text, "");
  assert.equal(normalizeItem({ type: "reasoning", text: "internal" }), null);
});

test("efforts are validated against the selected model before starting a turn", () => {
  const catalog = [{ id: "a", efforts: ["low", "high"], defaultEffort: "low", name: "A" }, { id: "b", efforts: ["medium"], defaultEffort: "medium", name: "B" }];
  assert.deepEqual(modelSelection({ model: "a", effort: "high" }, catalog), { model: "a", effort: "high" });
  assert.throws(() => modelSelection({ model: "b", effort: "high" }, catalog), /不支持/);
  assert.throws(() => modelSelection({ model: "other" }, catalog), /列表/);
  assert.deepEqual(modelSelection({}, catalog), {});
});

test("media rejects traversal, non-images, network paths and junction escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codexphone-media-"));
  try {
    const workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
    await mkdir(workspace); await mkdir(outside);
    await writeFile(path.join(workspace, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(workspace, "auth.json"), "secret");
    await writeFile(path.join(outside, "private.svg"), "secret");
    const image = await readImage("diagram.svg", workspace, [workspace]);
    assert.equal(image.type, "image/svg+xml");
    await assert.rejects(readImage("../outside/private.svg", workspace, [workspace]), /允许/);
    await assert.rejects(readImage("auth.json", workspace, [workspace]), /允许/);
    await assert.rejects(readImage("https://example.com/a.svg", workspace, [workspace]), /无效/);
    await symlink(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readImage("linked/private.svg", workspace, [workspace]), /允许/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("streaming deltas remain isolated across threads and items", () => {
  const delta = (threadId, itemId, text) => ({ type: "agent-delta", threadId, turnId: "turn", itemId, delta: text });
  let state = appendDelta([], delta("one", "a", "Hello"));
  state = appendDelta(state, delta("two", "a", "Other"));
  state = appendDelta(state, delta("one", "a", " world"));
  assert.equal(state[0].text, "Hello world"); assert.equal(state[1].text, "Other");
  assert.strictEqual(appendDelta(state, { type: "agent-delta" }), state);
});

test("shared approval handling does not reject GUI-owned tool calls", () => {
  const rejected = [];
  const shared = new ApprovalQueue({ transport: "websocket", reject: (...args) => rejected.push(args) });
  assert.equal(shared.add({ id: 1, method: "item/tool/call", params: { threadId: "thread", turnId: "turn" } }), null);
  assert.equal(rejected.length, 0);
  const standalone = new ApprovalQueue({ transport: "stdio", reject: (...args) => rejected.push(args) });
  standalone.add({ id: 2, method: "item/tool/call", params: { threadId: "thread", turnId: "turn" } });
  assert.equal(rejected.length, 1);
});

test("RPC server requests with colliding IDs do not consume pending client replies", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);
      if(!request.method)return;
      process.stdout.write(JSON.stringify({id:request.id,method:'approval',params:{}})+'\\n');
      process.stdout.write(JSON.stringify({id:request.id,result:{ok:true}})+'\\n');
    });`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const client = new AppServerClient(child); let approvals = 0;
  client.on("serverRequest", () => approvals++);
  try { assert.deepEqual(await client.request("test", {}, 2000), { ok: true }); assert.equal(approvals, 1); }
  finally { client.close(); }
});
