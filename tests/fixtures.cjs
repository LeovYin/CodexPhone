const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" rx="16" fill="#e8eefa"/><text x="28" y="60" font-size="24" fill="#315fca">CodexPhone SVG</text><script>window.hacked=true</script></svg>';
const markdown = `## 移动端验收\n\n**Markdown 已渲染**，支持列表、表格与代码。\n\n- 回车换行\n- 点击箭头发送\n\n| 功能 | 状态 |\n| --- | --- |\n| 模型选择 | 已接入 |\n| SVG 预览 | 已接入 |\n\n\`\`\`ts\nconst message = "hello";\nconsole.log(message);\n\`\`\`\n\n![本地图片](D:/workspace/test.svg)\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n<script>window.hacked=true</script>`;
const summary = (id) => ({ id, name: id === "one" ? "手机界面与内容渲染" : "同步验收", preview: "查看任务进度，继续指导 Codex", cwd: "D:/workspace", model: "a", provider: "custom", updatedAt: new Date().toISOString(), status: { type: "idle" }, turns: 1, isPinned: false, canControl: false, activeTurnId: null, writeState: "unknown" });

async function setupFixture(page) {
  const state = { posts: [], threads: [summary("one"), summary("two")], sockets: [], conflict: false, offline: false, backendOffline: false, running: false, delay: false, approvals: [], mediaHeaders: [], detailReads: 0, more: false, content: markdown, queue: [], queueResponseLost: false, operations: {} };
  await page.addInitScript(() => { localStorage.setItem("codexphone-device-token", "test-token"); });
  await page.routeWebSocket("**/ws?*", (socket) => { state.sockets.push(socket); socket.send(JSON.stringify({ type: "connected" })); });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method();
    if (state.offline && pathname !== "/api/pair") return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (method !== "GET") {
      const body = request.postDataJSON(); state.posts.push({ pathname, body, method });
      if (pathname.endsWith("/queue") && method === "POST") {
        state.queue.push({ id: "queued-" + state.posts.length, threadId: "one", prompt: body.prompt, state: "queued" });
        const result = { threadId: "one", queueId: state.queue.at(-1).id };
        state.operations[body.clientRequestId] = { state: "completed", result };
        if (state.queueResponseLost) { state.queueResponseLost = false; return route.abort(); }
        return json(result);
      }
      if (pathname.includes("/queue/")) { state.queue = []; return json({ threadId: "one" }); }
      if (pathname === "/api/pair") return json({ token: "test-token", deviceId: "device" });
      if (pathname === "/api/threads") return json({ threadId: "one" });
      if (pathname.endsWith("/turns") && state.conflict) return json({ error: "该对话由电脑端 Codex 持有，当前连接无法接管。原消息已保留。" }, 409);
      if (pathname.includes("/favorites/")) state.threads.find((entry) => entry.id === pathname.split("/").at(-1)).isPinned = method === "PUT";
      if (pathname.includes("/approvals/")) state.approvals = [];
      if (pathname.endsWith("/interrupt")) state.running = false;
      return json({ ok: true, threadId: "one" });
    }
    if (pathname === "/api/health") return json({ status: state.backendOffline ? "degraded" : "ready", transport: "websocket", model: "a", provider: "custom", codexVersion: "fixture", authMode: "apiKey", lastError: null });
    if (pathname.endsWith("/queue")) return json({ messages: state.queue });
    if (pathname === "/api/approvals") return json({ approvals: state.approvals });
    if (pathname.startsWith("/api/operations/")) return state.operations[pathname.split("/").at(-1)] ? json(state.operations[pathname.split("/").at(-1)]) : json({ error: "Request not found" }, 404);
    if (state.backendOffline) return json({ error: "Backend unavailable" }, 503);
    if (pathname === "/api/projects") return json({ projects: [{ id: "project", name: "CodexPhone", path: "D:/workspace", canStart: true }] });
    if (pathname === "/api/models") return json({ defaultModel: "a", models: [{ id: "a", name: "Model A", efforts: ["low", "high", "ultra"], defaultEffort: "low" }, { id: "b", name: "Model B", efforts: ["medium", "high"], defaultEffort: "medium" }] });
    if (pathname === "/api/ws-ticket") return json({ ticket: "fixture" });
    if (pathname === "/api/threads") return json({ threads: url.searchParams.has("cursor") ? [summary("three")] : state.threads, nextCursor: state.more && !url.searchParams.has("cursor") ? "next" : null });
    if (pathname === "/api/devices") return json({ devices: [{ id: "device", current: true }] });
    if (pathname === "/api/media") { state.mediaHeaders.push(request.headers()); return route.fulfill({ contentType: "image/svg+xml", body: svg.replace(/<script>[\s\S]*?<\/script>/, "") }); }
    if (pathname.startsWith("/api/threads/")) {
      state.detailReads++;
      const id = decodeURIComponent(pathname.split("/")[3]);
      if (state.delay && id === "one") await new Promise((resolve) => setTimeout(resolve, 600));
      return json({ thread: { ...summary(id), activeTurnId: state.running ? "turn" : null }, model: "a", effort: "low", nextCursor: null, approvals: state.approvals, turns: [{ id: "turn", status: state.running ? "inProgress" : "completed", startedAt: Date.now() - 60000, completedAt: state.running ? null : Date.now(), items: [{ id: "user", type: "userMessage", text: "请优化手机阅读和发送体验。", images: [] }, { id: "agent", type: "agentMessage", text: state.content, images: [] }] }] });
    }
    return json({ error: "Unknown fixture route" }, 404);
  });
  return state;
}
module.exports = { setupFixture };
