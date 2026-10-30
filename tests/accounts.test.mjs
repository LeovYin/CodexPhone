import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { AccountDatabase } from "../apps/host/dist/accounts-db.js";
import { DeviceStore } from "../apps/host/dist/store.js";

test("SQLite accounts isolate hosts, persist login and never store plaintext passwords or tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "phone-accounts-")); let db;
  try {
    const file = path.join(dir, "accounts.sqlite"); db = new AccountDatabase(file);
    await db.createUser("owner", "fixture-password-1234"); await db.createUser("other", "different-password-1234");
    await assert.rejects(db.login({ username: "owner", password: "wrong", installationId: "fixture-desktop-0001" }), /账号或密码/);
    const desktop = await db.login({ username: "owner", password: "fixture-password-1234", installationId: "fixture-desktop-0001", kind: "desktop" });
    const host = db.bind(desktop.token, { installationId: "fixture-desktop-0001", name: "Workstation" }, "http://100.64.0.1:4318");
    const phone = await db.login({ username: "owner", password: "fixture-password-1234", installationId: "fixture-phone-0001", name: "Phone" });
    assert.equal(phone.host.id, host.id);
    const identity = db.authorize(host.id, host.secret, { token: phone.token });
    const other = await db.login({ username: "other", password: "different-password-1234", installationId: "fixture-phone-0002" });
    assert.throws(() => db.authorize(host.id, host.secret, { token: other.token }), /无权/);
    assert.throws(() => db.bind(desktop.token, { installationId: "fixture-desktop-0002" }, "http://100.64.0.2:4318"), /另一台/);
    db.close(); db = new AccountDatabase(file);
    assert.equal(db.authorize(host.id, host.secret, { sessionId: identity.sessionId }).installationId, "fixture-phone-0001");
    const devices = new DeviceStore(dir); await devices.load();
    const first = await devices.accountSession(identity); assert.ok(devices.authenticate(first.token));
    await devices.updatePermission(first.deviceId, "read"); assert.equal(devices.hasDevice(first.deviceId), false);
    const relogin = await devices.accountSession(identity); assert.equal(devices.authenticate(relogin.token).permission, "read");
    await devices.updatePermission(first.deviceId, "blocked"); assert.equal(devices.authenticate(relogin.token), undefined);
    await assert.rejects(devices.accountSession(identity), /禁用/);
    db.logout(phone.token); assert.throws(() => db.authorize(host.id, host.secret, { sessionId: identity.sessionId }), /无权/);
    db.close(); db = undefined;
    const bytes = await readFile(file); assert.equal(bytes.includes(Buffer.from("fixture-password-1234")), false); assert.equal(bytes.includes(Buffer.from(phone.token)), false);
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("question answers preserve question IDs and replayed requests do not duplicate", async () => {
  const { ApprovalQueue } = await import("../apps/host/dist/approvals.js"); const sent = [];
  const queue = new ApprovalQueue({ transport: "websocket", respond: (...args) => sent.push(args) });
  const original = { id: "q-1", method: "item/tool/requestUserInput", params: { threadId: "thread", turnId: "turn", isBlocking: true,
    questions: [{ id: "choice", question: "选哪个？", options: [{ label: "原生", description: "Kotlin" }] }, { id: "notes", question: "补充说明" }] } };
  const request = queue.add(original); assert.equal(queue.add(original).id, request.id); assert.equal(queue.list().length, 1);
  assert.throws(() => queue.answer(request.id, { answers: { choice: "原生" } }), /every question/);
  queue.answer(request.id, { answers: { choice: "原生", notes: "继续" } });
  assert.deepEqual(sent, [["q-1", { answers: { choice: { answers: ["原生"] }, notes: { answers: ["继续"] } } }]]);
  assert.equal(queue.list().length, 0);
});
