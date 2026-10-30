import { test, expect } from "@playwright/test";
// Fixture API never calls a real model or modifies the paired host.
// @ts-expect-error The reusable fixture is CJS for the interactive browser REPL.
import { setupFixture } from "../fixtures.cjs";

test("Enter inserts newline and model/effort reach the clicked send action", async ({ page }) => {
  const state = await setupFixture(page); await page.goto("/");
  await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
  await page.getByLabel("选择模型").selectOption("b");
  await expect(page.getByLabel("选择思考强度")).toHaveValue("medium");
  await page.getByLabel("选择思考强度").selectOption("high");
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("第一行"); await input.press("Enter"); await input.pressSequentially("第二行");
  await expect(input).toHaveValue("第一行\n第二行");
  expect(state.posts.filter((entry: { pathname: string }) => entry.pathname === "/api/threads")).toHaveLength(0);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => state.posts.find((entry: { pathname: string }) => entry.pathname === "/api/threads")).toBeTruthy();
  expect(state.posts.find((entry: { pathname: string }) => entry.pathname === "/api/threads").body).toEqual({ projectId: "project", prompt: "第一行\n第二行", model: "b", effort: "high" });
});

test("Mermaid renders locally and conversation navigation jumps to latest", async ({ page }) => {
  const state = await setupFixture(page);
  state.content = "```mermaid\nflowchart TD\n A[手机] --> B[电脑]\n```\n\n" + "内容段落\n\n".repeat(60);
  await page.goto("/"); await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.getByAltText("Mermaid 图表")).toBeAttached();
  await expect.poll(() => page.getByAltText("Mermaid 图表").evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator(".conversation-content").evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(30);
  await page.getByRole("button", { name: "对话导航", exact: true }).click();
  await page.getByRole("button", { name: /第 1 轮/ }).click();
  await page.getByRole("button", { name: "对话导航", exact: true }).click();
  await page.getByRole("button", { name: "跳到最新消息", exact: true }).click();
  await expect.poll(() => page.locator(".conversation-content").evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(30);
});

test("Markdown, tables and sanitized SVG render with authenticated local images", async ({ page }) => {
  const state = await setupFixture(page); await page.goto("/");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.getByRole("heading", { name: "移动端验收" })).toBeAttached();
  await expect(page.locator("strong").filter({ hasText: "Markdown 已渲染" })).toBeAttached();
  await expect(page.locator("table")).toHaveCount(1);
  await expect.poll(() => page.locator(".message-agent img").evaluateAll((elements) => elements.every((entry) => (entry as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect((await page.locator(".message-agent img").first().boundingBox())!.width).toBeGreaterThan(100);
  expect((await page.locator(".message-agent img").nth(1).boundingBox())!.width).toBeGreaterThan(100);
  expect(state.mediaHeaders[0].authorization).toBe("Bearer test-token");
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked)).toBeUndefined();
  await page.getByRole("button", { name: "放大本地图片", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 680 });
  const bounds = await page.locator(".composer").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(680);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("writer conflicts retain drafts and switching threads never mixes drafts", async ({ page }) => {
  const state = await setupFixture(page); state.conflict = true; await page.goto("/");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  const input = page.getByRole("textbox", { name: "消息", exact: true }); await input.fill("保留这段指导");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText(/该对话由电脑端 Codex 持有/)).toBeVisible(); await expect(input).toHaveValue("保留这段指导");
  await page.getByRole("button", { name: "返回对话列表", exact: true }).click();
  await page.getByRole("button", { name: /同步验收/ }).click(); await expect(input).toHaveValue(""); await input.fill("第二个草稿");
  await page.getByRole("button", { name: "返回对话列表", exact: true }).click();
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click(); await expect(input).toHaveValue("保留这段指导");
  await page.reload(); await page.getByRole("button", { name: /手机界面与内容渲染/ }).click(); await expect(input).toHaveValue("保留这段指导");
});

test("background updates preserve detail and stale responses cannot replace a new thread", async ({ page }) => {
  const state = await setupFixture(page); state.delay = true; await page.goto("/");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await page.getByRole("button", { name: "返回对话列表", exact: true }).click();
  await page.getByRole("button", { name: /同步验收/ }).click();
  await expect(page.locator(".breadcrumbs")).toContainText("同步验收");
  await expect(page.getByRole("heading", { name: "移动端验收" })).toBeAttached();
  state.content = "## 后台同步成功";
  for (const socket of state.sockets) socket.send(JSON.stringify({ type: "refresh-thread", threadId: "two" }));
  await expect(page.getByRole("heading", { name: "后台同步成功" })).toBeAttached();
  await expect(page.locator(".detail-loading")).toHaveCount(0);
  await expect(page.locator(".breadcrumbs")).toContainText("同步验收");
});

test("running tasks queue by default, guide explicitly and interrupt", async ({ page }) => {
  const state = await setupFixture(page); state.running = true; await page.goto("/");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.getByLabel("选择模型")).toBeDisabled();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("继续指导");
  await page.getByRole("button", { name: "排队发送", exact: true }).click();
  await expect(page.getByLabel("排队消息")).toContainText("继续指导");
  expect(state.posts.some((entry: { pathname: string }) => entry.pathname.endsWith("/steer"))).toBe(false);
  await page.getByRole("button", { name: "引导", exact: true }).click();
  await expect.poll(() => state.posts.some((entry: { pathname: string }) => entry.pathname.endsWith("/guide"))).toBe(true);
  await page.getByRole("button", { name: "中断当前任务", exact: true }).click();
  await expect(page.getByLabel("选择模型")).toBeEnabled();
});

test("lost queue response is reconciled after reload without a duplicate submission", async ({ page }) => {
  const state = await setupFixture(page); state.running = true; state.queueResponseLost = true;
  await page.goto("/"); await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("只排队一次");
  await page.getByRole("button", { name: "排队发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "已检查，清除提交记录" })).toBeVisible();
  state.running = false;
  await page.reload(); await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("只排队一次");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
  expect(state.posts.filter((entry: { pathname: string }) => entry.pathname.endsWith("/queue"))).toHaveLength(1);
  expect(state.posts.filter((entry: { pathname: string }) => entry.pathname.endsWith("/turns"))).toHaveLength(0);
});

test("project filters, favorites, pagination, approvals and unpair controls", async ({ page }) => {
  const state = await setupFixture(page); state.more = true;
  state.approvals = [{ id: "approval", threadId: "one", turnId: "turn", kind: "command", title: "允许执行命令", detail: "echo test", canAccept: true, questions: [] }];
  await page.goto("/"); await page.getByLabel("选择项目").selectOption("project");
  await page.getByRole("button", { name: "加载更多对话", exact: true }).click(); await expect(page.locator(".thread-row")).toHaveCount(3);
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await page.getByRole("button", { name: "允许", exact: true }).click(); await expect(page.locator(".approval-card")).toHaveCount(0);
  await page.getByRole("button", { name: "标记重点", exact: true }).last().click();
  await page.getByRole("button", { name: "返回对话列表", exact: true }).click();
  await page.getByRole("button", { name: "重点", exact: true }).click(); await expect(page.locator(".thread-row")).toHaveCount(1);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "解除本机配对", exact: true }).click(); await expect(page.getByRole("button", { name: "配对设备", exact: true })).toBeVisible();
});

test("streamed fragments survive a persisted-history refresh", async ({ page }) => {
  const state = await setupFixture(page); state.running = true; state.content = "开始";
  await page.goto("/"); await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.locator(".message-agent")).toContainText("开始");
  const send = (delta: string) => state.sockets.at(-1).send(JSON.stringify({ type: "agent-delta", threadId: "one", turnId: "turn", itemId: "agent", delta }));
  send("第一段"); await expect(page.locator(".message-agent")).toContainText("开始第一段");
  state.content = "开始第一段";
  const reads = state.detailReads;
  await expect.poll(() => state.detailReads).toBeGreaterThan(reads);
  send("第二段"); await expect(page.locator(".message-agent")).toContainText("开始第一段第二段");
  state.content = "开始第一段第二段"; state.running = false;
  state.sockets.at(-1).send(JSON.stringify({ type: "turn-status", threadId: "one" }));
  await expect(page.getByLabel("选择模型")).toBeEnabled();
  await expect(page.locator(".message-agent")).toHaveCount(1);
});

test("disconnected websocket reconnects and refreshes visible history", async ({ page }) => {
  const state = await setupFixture(page); await page.goto("/");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  await expect(page.getByRole("heading", { name: "移动端验收" })).toBeAttached();
  state.content = "## 重连后新内容";
  const initial = state.sockets.length;
  state.sockets.at(-1).close();
  await expect.poll(() => state.sockets.length).toBeGreaterThan(initial);
  await expect(page.getByRole("heading", { name: "重连后新内容" })).toBeAttached();
});

test("backend outage updates phone status even while project APIs fail and recovers", async ({ page }) => {
  const state = await setupFixture(page); await page.goto("/");
  await expect(page.locator(".host-status-text")).toContainText("电脑与手机已同步");
  await page.getByRole("button", { name: /手机界面与内容渲染/ }).click();
  state.backendOffline = true;
  state.sockets.at(-1).send(JSON.stringify({ type: "host-status" }));
  await expect(page.locator(".offline-banner")).toBeVisible();
  await expect(page.locator(".host-status-text")).toContainText("正在连接电脑");
  state.backendOffline = false;
  state.sockets.at(-1).send(JSON.stringify({ type: "host-status" }));
  await expect(page.locator(".offline-banner")).toHaveCount(0);
  await expect(page.locator(".host-status-text")).toContainText("电脑与手机已同步");
});
