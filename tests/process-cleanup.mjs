import { execFileSync } from "node:child_process";

export function stopOwnedProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); }
  } else child.kill();
}
