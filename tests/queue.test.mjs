import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MessageQueue } from "../apps/host/dist/queue.js";

test("queue survives restart, claims once and preserves ambiguous dispatches", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codexphone-queue-"));
  try {
    const store = new MessageQueue(directory); await store.load();
    const input = { threadId: "thread", deviceId: "device", prompt: "next instruction", model: "test" };
    const first = await store.enqueue(input), second = await store.enqueue({ ...input, prompt: "second" });
    assert.deepEqual(store.list("thread").map(e => e.id), [first.id, second.id]);
    await store.claim(first.id, "thread");
    await assert.rejects(() => store.claim(first.id, "thread"), /already|正在|处理/);
    await assert.rejects(() => store.cancel(first.id, "thread"), /正在/);
    const restored = new MessageQueue(directory); await restored.load();
    assert.equal(restored.list("thread")[0].state, "unknown");
    await assert.rejects(() => restored.claim(first.id, "thread"));
    await restored.cancel(first.id, "thread");
    await restored.claim(second.id, "thread"); await restored.finish(second.id, "thread", "guided");
    assert.deepEqual(restored.list(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
