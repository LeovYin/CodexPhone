import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Publishing is always explicit. Tokens remain in memory and are never passed in Git URLs.
if (!process.argv.includes("--publish")) throw new Error("Use --publish only after reviewing and testing the release.");
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version, tag = "v" + version;
function git(args, input) {
  const result = spawnSync("git", args, { cwd: root, input, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
  if (result.status !== 0) throw new Error("Git failed: " + args[0] + "\n" + (result.stderr || "").slice(0, 1500));
  return result.stdout.trim();
}
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  const response = git(["credential", "fill"], "protocol=https\nhost=github.com\n\n");
  const entry = response.split(/\r?\n/).find((line) => line.startsWith("password="));
  token = entry?.slice("password=".length);
}
if (!token) throw new Error("GitHub authentication is unavailable. Sign in to GitHub through Git Credential Manager.");
async function api(endpoint, method = "GET", body, allow404 = false) {
  const response = await fetch("https://api.github.com" + endpoint, {
    method, headers: { Authorization: "Bearer " + token, "User-Agent": "CodexPhone-release", "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000)
  });
  if (allow404 && response.status === 404) return null;
  const json = await response.json();
  if (!response.ok) throw new Error("GitHub " + method + " " + endpoint + " failed: " + response.status + " " + json.message);
  return json;
}
const user = await api("/user");
const repo = user.login + "/CodexPhone";
const repoUrl = "https://github.com/" + repo;
console.log("Publishing reviewed source and release to " + repoUrl);
const releaseDir = path.join(root, "releases", version);
const checksums = (await readFile(path.join(releaseDir, "SHA256SUMS.txt"), "utf8")).trim().split(/\r?\n/);
for (const line of checksums) {
  const match = line.match(/^([a-f0-9]{64})  ([^\\/]+)$/);
  if (!match) throw new Error("Invalid checksum entry");
  if (createHash("sha256").update(await readFile(path.join(releaseDir, match[2]))).digest("hex") !== match[1]) throw new Error("Release hash mismatch: " + match[2]);
}
const manifest = JSON.parse(await readFile(path.join(root, "scripts/source-files.json"), "utf8"));
const files = [...manifest.files];
async function collect(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = relative + "/" + entry.name;
    if (entry.isSymbolicLink()) throw new Error("Source contains a link");
    if (entry.isDirectory()) await collect(file); else files.push(file);
  }
}
for (const directory of manifest.directories) await collect(directory);
for (const file of files) {
  const data = await readFile(path.join(root, file), "utf8");
  if (/100\.92\.169\.49|D:[\\/]TOOL[\\/]Github|[A-Z]:[\\/]Users[\\/][^\\/"\s]+/i.test(data)) throw new Error("Private path in public source: " + file);
  if (/\b(sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/.test(data)) throw new Error("Possible credential in public source: " + file);
}
const repoExists = await api("/repos/" + repo, "GET", undefined, true);
const alreadyGit = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true });
if (alreadyGit.status === 0) {
  if (path.resolve(alreadyGit.stdout.trim()) !== root) throw new Error("Refusing to publish a parent repository");
  const remote = git(["remote", "get-url", "origin"]);
  if (remote.replace(/\.git$/, "").toLowerCase() !== repoUrl.toLowerCase()) throw new Error("Origin does not match the authenticated account's repository");
} else {
  if (repoExists) throw new Error("A repository with this name already exists. It was not modified.");
  git(["init", "-b", "main"]);
  git(["config", "user.name", user.login]);
  git(["config", "user.email", String(user.id) + "+" + user.login + "@users.noreply.github.com"]);
  git(["remote", "add", "origin", repoUrl + ".git"]);
}
git(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], files.join("\0") + "\0");
const staged = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
if (staged.some((file) => !files.includes(file))) throw new Error("Unexpected staged file; source publication stopped");
if (staged.length) git(["commit", "-m", "Release CodexPhone " + tag + " with Windows EXE packaging"]);
if (!repoExists) await api("/user/repos", "POST", { name: "CodexPhone", description: "Self-hosted mobile access to your Codex desktop over Tailscale. Windows EXE, shared conversations, MIT.", private: false, auto_init: false, has_issues: true });
git(["push", "-u", "origin", "main"]);
const existingTag = spawnSync("git", ["rev-parse", "--verify", tag], { cwd: root, encoding: "utf8", windowsHide: true });
if (existingTag.status !== 0) git(["tag", "-a", tag, "-m", "CodexPhone " + tag + " Windows preview"]);
git(["push", "origin", tag]);
let release = await api("/repos/" + repo + "/releases/tags/" + tag, "GET", undefined, true);
if (!release) release = await api("/repos/" + repo + "/releases", "POST", {
  tag_name: tag, name: "CodexPhone " + tag + " · Windows x64 Preview", draft: true, prerelease: true,
  body: await readFile(path.join(root, "docs/RELEASE_NOTES.md"), "utf8")
});
const assets = (await readdir(releaseDir)).filter((name) => /\.(exe|zip|txt|json|md)$/i.test(name));
for (const name of assets) {
  const data = await readFile(path.join(releaseDir, name));
  const digest = "sha256:" + createHash("sha256").update(data).digest("hex");
  const existing = release.assets?.find((entry) => entry.name === name);
  if (existing) {
    if (existing.size === data.length && existing.digest === digest) continue;
    throw new Error("Existing release asset differs; it was not overwritten: " + name);
  }
  console.log("Uploading " + name + " (" + (data.length / 1024 / 1024).toFixed(1) + " MiB)");
  const response = await fetch("https://uploads.github.com/repos/" + repo + "/releases/" + release.id + "/assets?name=" + encodeURIComponent(name), {
    method: "POST", headers: { Authorization: "Bearer " + token, "User-Agent": "CodexPhone-release", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
    body: data, signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error("Asset upload failed: " + name + " (" + response.status + ")");
  const uploaded = await response.json();
  if (uploaded.size !== data.length || (uploaded.digest && uploaded.digest !== digest)) throw new Error("Uploaded asset verification failed: " + name);
}
release = await api("/repos/" + repo + "/releases/" + release.id);
if (!assets.every((name) => release.assets.some((entry) => entry.name === name && entry.state === "uploaded"))) throw new Error("Release asset set is incomplete");
release = await api("/repos/" + repo + "/releases/" + release.id, "PATCH", { draft: false, prerelease: true });
const published = await api("/repos/" + repo);
if (published.private || release.draft) throw new Error("Public publication not confirmed");
await mkdir(path.join(root, ".codexphone"), { recursive: true });
await writeFile(path.join(root, ".codexphone/publication.json"), JSON.stringify({ repository: repoUrl, release: release.html_url, tag, assets: release.assets.map((entry) => ({ name: entry.name, size: entry.size, digest: entry.digest })) }, null, 2));
console.log(JSON.stringify({ publicRepository: repoUrl, release: release.html_url, prerelease: release.prerelease, assetCount: release.assets.length, sourceCommit: git(["rev-parse", "HEAD"]) }));
