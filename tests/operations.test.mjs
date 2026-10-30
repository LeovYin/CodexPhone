import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationStore } from "../apps/host/dist/operations.js";

test("durable requests execute once across retries, concurrency, restart and devices", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codexphone-operation-"));
  try {
    const store = new OperationStore(root); await store.load();
    let calls = 0, release;
    const gate = new Promise(resolve => release = resolve);
    const first = store.run("device-a", "request-1234567890", "/turns", { prompt: "test" }, async () => { calls++; await gate; return { threadId: "shared" }; });
    await assert.rejects(store.run("device-a", "request-1234567890", "/turns", { prompt: "test" }, async () => { calls++; }), /already submitted/);
    release(); assert.deepEqual(await first, { threadId: "shared" });
    assert.deepEqual(await store.run("device-a", "request-1234567890", "/turns", { prompt: "test" }, async () => { calls++; }), { threadId: "shared" });
    assert.equal(calls, 1);
    await assert.rejects(store.run("device-a", "request-1234567890", "/turns", { prompt: "other" }, async () => {}), /different content/);
    const restarted = new OperationStore(root); await restarted.load();
    assert.deepEqual(await restarted.run("device-a", "request-1234567890", "/turns", { prompt: "test" }, async () => { calls++; }), { threadId: "shared" });
    assert.equal(restarted.get("device-b", "request-1234567890"), undefined);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous upstream failures are never dispatched a second time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codexphone-operation-"));
  try {
    const store = new OperationStore(root); await store.load(); let calls = 0;
    await assert.rejects(store.run("device", "unknown-1234567890", "/turns", {}, async () => { calls++; throw new Error("secret upstream error"); }));
    assert.equal(store.get("device", "unknown-1234567890").state, "unknown");
    assert.ok(!store.get("device", "unknown-1234567890").error.includes("secret"));
    const restart = new OperationStore(root); await restart.load();
    await assert.rejects(restart.run("device", "unknown-1234567890", "/turns", {}, async () => { calls++; }));
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
