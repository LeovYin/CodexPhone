import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
if (process.platform !== "win32") process.exit(0);
const root = await mkdtemp(path.join(tmpdir(), "codexphone-ownership-"));
try {
  const old = path.join(root, "old version 中文");
  await mkdir(path.join(old, "apps/host/dist"), { recursive: true }); await mkdir(path.join(old, "scripts"));
  await writeFile(path.join(old, "apps/host/dist/index.js"), "");
  await writeFile(path.join(old, "apps/host/package.json"), JSON.stringify({ name: "@codexphone/host", dependencies: { "@codexphone/shared": "workspace:*" } }));
  await writeFile(path.join(old, "scripts/shared-cli-proxy.mjs"), "");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-File", path.resolve("tests/bridge-ownership.ps1"), old, process.execPath], { encoding: "utf8", windowsHide: true });
  assert.match(output, /Ownership checks passed/);
  console.log(JSON.stringify({ windowsAndForwardSlashPaths: "passed", unicodePaths: "passed", unrelatedArgvRejected: "passed", unrelatedPackageRejected: "passed" }));
} finally { await rm(root, { recursive: true, force: true }); }
