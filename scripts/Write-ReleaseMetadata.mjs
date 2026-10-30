import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, rm, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const [root, nodeVersion, version] = process.argv.slice(2);
if (!root || !version || !nodeVersion) throw new Error("Release metadata arguments are missing");
const hostModules = path.join(root, "apps/host/node_modules");
const notices = [], packages = [];
async function dependencyGraph(directory, seen = new Set(), graph = new Set()) {
  directory = await realpath(directory);
  if (seen.has(directory)) return graph;
  seen.add(directory);
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  graph.add(pkg.name + "@" + pkg.version);
  const require = createRequire(path.join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    let found = false;
    for (const lookup of require.resolve.paths(name + "/package.json") || []) {
      const candidate = path.join(lookup, name);
      try { await readFile(path.join(candidate, "package.json")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      await dependencyGraph(candidate, seen, graph); found = true; break;
    }
    if (!found) throw new Error("Missing deployed dependency: " + name);
  }
  return graph;
}
const sourceGraph = await dependencyGraph(path.resolve("apps/host"));
const deployedGraph = await dependencyGraph(path.join(root, "apps/host"));
if ([...sourceGraph].some((entry) => !deployedGraph.has(entry)) || [...deployedGraph].some((entry) => !sourceGraph.has(entry)))
  throw new Error("Deployment dependencies differ from the installed, tested source dependency graph");
// Prune non-runtime material and retain every bundled package's copyright/license.
async function visitModules(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) { await visitModules(full); continue; }
    await visitPackage(full);
  }
}
async function visitPackage(directory) {
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  packages.push({ name: pkg.name, version: pkg.version, license: pkg.license || "See bundled license" });
  const files = await readdir(directory, { withFileTypes: true });
  for (const entry of files) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name))
      notices.push("## " + pkg.name + " " + pkg.version + " / " + entry.name + "\n\n" + await readFile(path.join(directory, entry.name), "utf8"));
    if (entry.isDirectory() && ["test", "tests", "__tests__", "docs", "examples", "example", "benchmark", "benchmarks", "integration", ".github", ".git"].includes(entry.name))
      await rm(path.join(directory, entry.name), { recursive: true, force: true });
  }
  try { await visitModules(path.join(directory, "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
await visitModules(hostModules);
const frontendVisited = new Set();
async function frontendLicenses(directory) {
  directory = await realpath(directory);
  if (frontendVisited.has(directory)) return;
  frontendVisited.add(directory);
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (pkg.name !== "@codexphone/web" && !pkg.name.startsWith("@codexphone/")) {
    packages.push({ name: pkg.name, version: pkg.version, license: pkg.license || "See bundled license", usage: "frontend bundle" });
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name))
        notices.push("## " + pkg.name + " " + pkg.version + " / " + entry.name + "\n\n" + await readFile(path.join(directory, entry.name), "utf8"));
  }
  const require = createRequire(path.join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    let found = false;
    for (const lookup of require.resolve.paths(name + "/package.json") || []) {
      const candidate = path.join(lookup, name);
      try { await readFile(path.join(candidate, "package.json")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      await frontendLicenses(candidate); found = true; break;
    }
    if (!found) throw new Error("Cannot locate frontend dependency: " + name);
  }
}
await frontendLicenses(path.resolve("apps/web"));
await rm(path.join(hostModules, ".bin"), { recursive: true, force: true });
await rm(path.join(hostModules, ".pnpm"), { recursive: true, force: true });
await rm(path.join(hostModules, ".modules.yaml"), { force: true });
await writeFile(path.join(root, "THIRD-PARTY-NOTICES.txt"),
  "CodexPhone third-party notices\n\nNode.js: runtime/NODE-LICENSE.txt\nCodexPhone: LICENSE (MIT)\nCodex desktop and Tailscale are not included.\n\n" + notices.join("\n\n"));
await writeFile(path.join(root, "release.json"), JSON.stringify({
  product: "CodexPhone", version, platform: "win32", arch: "x64", nodeVersion,
  license: "MIT", sourceRepository: "See the release page that supplied this file",
  testedCodexDesktop: ["26.1023.6123.0"], testedCodexCli: ["0.165.0-alpha.1.2"],
  packages: packages.sort((a, b) => a.name.localeCompare(b.name))
}, null, 2));
const privatePatterns = [/100\.92\.169\.49/, /D:[\\/]TOOL[\\/]Github/i, /[A-Z]:[\\/]Users[\\/][^\\/"\s]+/i];
const privateNames = new Set(["account-host.json", "account-host.tmp", "admin-token", "installation-id", "accounts.sqlite", "accounts.sqlite-wal", "accounts.sqlite-shm", "conversation-cache.enc", "submission-journal.enc", "auth.json", "devices.json", "projects.json", "launcher-paths.txt", "backend-runtime.json", "shared-runtime.json", ".env", ".npmrc"]);
const textTypes = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".ps1", ".cmd", ".cs", ".html", ".css", ".yaml", ".yml", ".map"]);
const files = {};
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error("Release contains a link: " + relative);
    if (entry.isDirectory()) { if (entry.name === ".codexphone" || entry.name === ".git") throw new Error("Runtime data in release"); await walk(absolute); continue; }
    if (privateNames.has(entry.name)) throw new Error("Private state in release: " + relative);
    const data = await readFile(absolute);
    if (textTypes.has(path.extname(entry.name))) {
      const text = data.toString("utf8");
      if (privatePatterns.some((pattern) => pattern.test(text))) throw new Error("Machine-specific content in release: " + relative);
    }
    files[relative] = createHash("sha256").update(data).digest("hex");
  }
}
await walk(root);
await writeFile(path.join(root, "integrity.json"), JSON.stringify({ algorithm: "SHA-256", files }, null, 2));
console.log(JSON.stringify({ releaseFileCount: Object.keys(files).length, productionPackages: packages.length, privacyScan: "passed", links: 0 }));
