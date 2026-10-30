import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const target = new URL("../apps/android/app/src/main/assets/mermaid/", import.meta.url);
await mkdir(target, { recursive: true });
for (const [source, destination] of [["dist/mermaid.min.js", "mermaid.min.js"], ["LICENSE", "LICENSE"]]) {
  await copyFile(new URL("../apps/web/node_modules/mermaid/" + source, import.meta.url), new URL(destination, target));
}
// Include the whole runtime dependency graph conservatively: the single-file
// Mermaid build embeds dependencies and must retain their copyright notices.
const visited = new Set(), notices = [];
async function collect(directory) {
  directory = await realpath(directory);
  if (visited.has(directory)) return;
  visited.add(directory);
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  notices.push("## " + pkg.name + " " + pkg.version + " (" + (pkg.license || "See notices") + ")");
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  notices.push("Source: " + (repository || pkg.homepage || "https://www.npmjs.com/package/" + pkg.name));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name))
      notices.push(await readFile(path.join(directory, entry.name), "utf8"));
  }
  const require = createRequire(path.join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {})) {
    let found = false;
    for (const lookup of require.resolve.paths(name + "/package.json") || []) {
      const candidate = path.join(lookup, name);
      try { await readFile(path.join(candidate, "package.json")); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      await collect(candidate); found = true; break;
    }
    if (!found) throw new Error("Missing Mermaid dependency: " + name);
  }
}
await collect(fileURLToPath(new URL("../apps/web/node_modules/mermaid/", import.meta.url)));
const licenseText = notices.join("\n\n").replace(/[\t ]+$/gm, "");
await writeFile(new URL("THIRD_PARTY_LICENSES.txt", target), licenseText);
const androidLicenses = new URL("../apps/android/THIRD_PARTY_LICENSES.txt", import.meta.url);
const marker = "\n\n=== Bundled Mermaid renderer and dependencies ===\n\n";
const original = (await readFile(androidLicenses, "utf8")).split(marker)[0];
await writeFile(androidLicenses, original + marker + licenseText);
console.log("Android local Mermaid renderer synchronized from the locked web dependency");
