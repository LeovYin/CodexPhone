import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.argv[2] || ".");
const excluded = new Set(["node_modules", ".git", "releases", ".codexphone", "artifacts", "test-results", "playwright-report", "dist", ".gradle", "build", ".idea", ".kotlin"]);
const denied = new Set(["auth.json", "devices.json", "projects.json", "operations.json", ".env", ".env.local", "launcher-paths.txt", "local.properties", "keystore.properties"]);
let count = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Source contains link: " + entry.name);
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) throw new Error("Generated/private directory in source: " + entry.name);
      await walk(file); continue;
    }
    if (denied.has(entry.name) || /\.(log|sqlite|sqlite-wal|sqlite-shm|exe|zip|tsbuildinfo|apk|aab|p12|jks|keystore)$/i.test(entry.name)) throw new Error("Private/generated file in source: " + entry.name);
    const data = await readFile(file, "utf8");
    if (/100\.92\.169\.49|D:[\\/]TOOL[\\/]Github|[A-Z]:[\\/]Users[\\/][^\\/"\s]+/i.test(data)) throw new Error("Machine-specific content: " + path.relative(root, file));
    if (/\b(sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b/.test(data)) throw new Error("Possible credential: " + path.relative(root, file));
    count++;
  }
}
await walk(root);
console.log(JSON.stringify({ publicSourceFiles: count, privacyScan: "passed", generatedFiles: 0 }));
