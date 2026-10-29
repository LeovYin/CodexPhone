import { AppServerClient } from "../apps/host/dist/app-server.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Only catalogs and history metadata are queried. Never submits prompts or prints config/auth data.
const client = await AppServerClient.start();
try {
  const [projects, threads, models] = await Promise.all([
    client.request("project/list", { limit: 100 }),
    client.request("thread/list", { limit: 100, modelProviders: [], sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], sortKey: "updated_at" }),
    client.request("model/list", { limit: 100, includeHidden: false }),
  ]);
  let sharedDaemon = false;
  try { await promisify(execFile)(process.env.CODEX_BIN || "codex", ["app-server", "daemon", "version"], { windowsHide: true, timeout: 8000 }); sharedDaemon = true; } catch { /* Report a capability, not raw potentially sensitive diagnostics. */ }
  console.log(JSON.stringify({ readable: true, projects: projects.data?.length || 0, threads: threads.data?.length || 0, models: models.data?.map((entry) => entry.model) || [], sharedDaemon, transport: process.env.CODEXPHONE_APP_SERVER || "standalone-stdio", guiLiveControlVerified: false }, null, 2));
} finally { client.close(); }
