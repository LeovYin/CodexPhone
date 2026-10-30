import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowLeft, ArrowUp, CircleAlert, Code2, FolderGit2, LoaderCircle, LogOut, MessageSquareText, Pin, Plus, RefreshCw, Smartphone, Square, Wifi, WifiOff, X } from "lucide-react";
import type { ApprovalRequest, HostStatus, ModelOption, Project, ThreadDetail, ThreadSummary } from "@codexphone/shared";
import { api, clearToken, connectEvents, getToken, setToken, type QueuedMessage } from "./api";
import { MessageContent } from "./MessageContent";
import { ProjectManager } from "./ProjectManager";
import { appendDelta, type LiveMessage } from "./live";
import "./style.css";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "连接失败，请重试";
}

function threadLabel(thread: ThreadSummary): string {
  return thread.name || thread.preview?.split("\n")[0]?.slice(0, 64) || "新对话";
}

function relativeTime(value: string | null): string {
  if (!value) return "最近";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "最近";
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

function readSaved<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
}

function App() {
  const [token, updateToken] = useState<string | null>(getToken());
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [managingProjects, setManagingProjects] = useState(false);
  const [projectId, setProjectId] = useState<string>("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [pairName, setPairName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readSaved("codexphone-drafts", {}));
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const listProject = useRef(projectId);
  const selectedRef = useRef<string | null>(null);
  const detailRef = useRef<ThreadDetail | null>(null);
  detailRef.current = detail;
  const threadRequest = useRef(0);
  const refreshRequest = useRef(0);
  const sending = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const extendedHistory = useRef(false);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [navigation, setNavigation] = useState(false);
  const draftKey = selectedId || "new";
  const composer = typeof drafts[draftKey] === "string" ? drafts[draftKey] : "";
  const setComposer = (value: string) => setDrafts((current) => ({ ...current, [draftKey]: value }));
  const selectedModel = modelOptions.find((entry) => entry.id === model);
  useEffect(() => { try { localStorage.setItem("codexphone-drafts", JSON.stringify(drafts)); } catch { /* Storage may be full or disabled. */ } }, [drafts]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty("--app-height", `${viewport?.height || window.innerHeight}px`);
    resize(); viewport?.addEventListener("resize", resize); window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  const [newTask, setNewTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "pinned">("all");
  const [approvalAnswers, setApprovalAnswers] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!token) return;
    const request = ++refreshRequest.current;
    if (listProject.current !== projectId) { listProject.current = projectId; setThreads([]); setNextCursor(null); }
    setLoading(true);
    try {
      const status = await api.health();
      if (request !== refreshRequest.current) return;
      setHostStatus(status);
      if (status.status !== "ready") return;
      const [projectList, threadPage] = await Promise.all([api.projects(), api.threads(projectId || undefined)]);
      if (request !== refreshRequest.current) return;
      setProjects(projectList);
      setThreads((current) => [...threadPage.threads, ...current.filter((old) => !threadPage.threads.some((entry) => entry.id === old.id))]);
      setNextCursor(threadPage.nextCursor);
    } catch (caught) {
      if (request !== refreshRequest.current) return;
      setHostStatus((current) => current ? { ...current, status: "degraded" } : current);
      if (errorMessage(caught).includes("not paired")) {
        clearToken();
        updateToken(null);
      } else setError(errorMessage(caught));
    } finally {
      if (request === refreshRequest.current) setLoading(false);
    }
  }, [projectId, token]);

  const loadThread = useCallback(async (id: string, background = false) => {
    if (!background) {
      selectedRef.current = id; setSelectedId(id); setDetail(null); setQueued([]); setNavigation(false); setError(null); followBottom.current = true; extendedHistory.current = false;
    }
    const request = ++threadRequest.current;
    try {
      const result = await api.thread(id);
      if (selectedRef.current === id && request === threadRequest.current) {
        setDetail((current) => current?.thread.id === id && extendedHistory.current ? {
          ...result, nextCursor: current.nextCursor,
          turns: [...current.turns.filter((turn) => !result.turns.some((entry) => entry.id === turn.id)), ...result.turns],
        } : result);
        setLiveMessages((current) => current.filter((message) => {
          if (message.threadId !== id) return false;
          const turn = result.turns.find((entry) => entry.id === message.turnId);
          return !turn || turn.status === "inProgress";
        }));
        // Older hosts can still display conversations; never fall back to implicit steer.
        void api.queue(id).then(result => { if (selectedRef.current === id) setQueued(result.messages); }).catch(() => {});
      }
    } catch (caught) { if (selectedRef.current === id && request === threadRequest.current) setError(errorMessage(caught)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void api.models().then((result) => { if (!cancelled) { setModelOptions(result.models); setModelError(null); } })
      .catch((caught) => { if (!cancelled) setModelError(errorMessage(caught)); });
    return () => { cancelled = true; };
  }, [token, hostStatus?.status]);

  useEffect(() => {
    const saved = readSaved<{ model?: string; effort?: string }>(`codexphone-selection:${draftKey}`, {});
    const option = modelOptions.find((entry) => entry.id === saved.model)
      || modelOptions.find((entry) => entry.id === detail?.model)
      || modelOptions.find((entry) => entry.id === hostStatus?.model) || modelOptions[0];
    setModel(option?.id || "");
    const preferredEffort = saved.effort || detail?.effort || "";
    setEffort(option?.efforts.includes(preferredEffort) ? preferredEffort : option?.defaultEffort || "");
    // The active selection is a per-thread draft; background refreshes must not reset it.
  }, [draftKey, modelOptions, detail?.thread.id]);

  const chooseModel = (value: string) => {
    const option = modelOptions.find((entry) => entry.id === value);
    setModel(value); setEffort(option?.defaultEffort || "");
    localStorage.setItem(`codexphone-selection:${draftKey}`, JSON.stringify({ model: value, effort: option?.defaultEffort }));
  };
  const chooseEffort = (value: string) => {
    setEffort(value); localStorage.setItem(`codexphone-selection:${draftKey}`, JSON.stringify({ model, effort: value }));
  };

  useLayoutEffect(() => {
    if (followBottom.current && contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [detail, selectedId, busy, liveMessages]);
  useEffect(() => {
    const element = contentRef.current, stack = element?.firstElementChild;
    if (!element || !stack) return;
    const observer = new ResizeObserver(() => { if (followBottom.current) element.scrollTop = element.scrollHeight; });
    observer.observe(stack); return () => observer.disconnect();
  }, [selectedId, !!detail]);

  useEffect(() => {
    if (!token) return;
    let disconnect: (() => void) | undefined; let closed = false;
    let reconnectTimer: number | undefined; let updateTimer: number | undefined; let retryDelay = 1000;
    const scheduleUpdate = () => {
      if (updateTimer) return;
      updateTimer = window.setTimeout(() => {
        updateTimer = undefined; if (closed) return;
        void refresh(); if (selectedRef.current) void loadThread(selectedRef.current, true);
      }, 450);
    };
    const connect = async () => {
      try {
        const stop = await connectEvents((event) => {
          if (closed) return;
          if (event.type === "agent-delta" && event.threadId === selectedRef.current) setLiveMessages((current) => {
            const existing = current.some((entry) => entry.threadId === event.threadId && entry.turnId === event.turnId && entry.itemId === event.itemId);
            const persisted = detailRef.current?.turns.find((turn) => turn.id === event.turnId)?.items.find((item) => item.id === event.itemId)?.text || "";
            return appendDelta(current, !existing && persisted ? { ...event, delta: persisted + String(event.delta || "") } : event);
          });
          if (event.type === "connected") { setConnected(true); scheduleUpdate(); }
          if (event.type === "host-status") void api.health().then(setHostStatus).catch(() => {});
          if (event.type === "queue-updated" || event.type === "agent-delta" || event.type === "item-status" || event.type === "turn-status" || event.type === "refresh-thread" || event.type === "approval-requested" || event.type === "approval-resolved" || event.type === "host-status") scheduleUpdate();
        }, () => {
          setConnected(false);
          if (!closed) { reconnectTimer = window.setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 15_000); }
        });
        if (closed) stop(); else disconnect = stop;
        retryDelay = 1000;
      } catch { if (!closed) { setConnected(false); reconnectTimer = window.setTimeout(connect, 4000); } }
    };
    void connect();
    const interval = window.setInterval(() => { if (!document.hidden) scheduleUpdate(); }, 5000);
    const resume = () => { if (!document.hidden) scheduleUpdate(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { closed = true; disconnect?.(); window.clearTimeout(reconnectTimer); window.clearTimeout(updateTimer); window.clearInterval(interval); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [loadThread, refresh, token]);

  const loadMoreThreads = async () => {
    if (!nextCursor || loading) return;
    const request = refreshRequest.current; setLoading(true);
    try {
      const page = await api.threads(projectId || undefined, nextCursor);
      if (request !== refreshRequest.current) return;
      setThreads((current) => [...current, ...page.threads.filter((entry) => !current.some((old) => old.id === entry.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) { setError(errorMessage(caught)); } finally { setLoading(false); }
  };

  const loadOlderMessages = async () => {
    if (!selectedId || !detail?.nextCursor || loadingOlder) return;
    const id = selectedId; const element = contentRef.current;
    const distanceFromBottom = element ? element.scrollHeight - element.scrollTop : 0;
    followBottom.current = false; setLoadingOlder(true);
    try {
      const page = await api.thread(id, detail.nextCursor);
      if (selectedRef.current !== id) return;
      extendedHistory.current = true;
        setDetail((current) => current?.thread.id === id ? { ...current, nextCursor: page.nextCursor, turns: [...page.turns.filter((turn) => !current.turns.some((entry) => entry.id === turn.id)), ...current.turns] } : current);
      requestAnimationFrame(() => { if (element && selectedRef.current === id) element.scrollTop = element.scrollHeight - distanceFromBottom; });
    } catch (caught) { setError(errorMessage(caught)); } finally { setLoadingOlder(false); }
  };

  const visibleThreads = useMemo(() => filter === "pinned" ? threads.filter((thread) => thread.isPinned) : threads, [filter, threads]);

  const pair = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.pair(pairCode.trim(), pairName.trim() || "Phone");
      setToken(result.token);
      updateToken(result.token);
      setPairCode("");
    } catch (caught) { setError(errorMessage(caught)); }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = composer.trim();
    if (!prompt || sending.current) return;
    sending.current = true;
    const submittedKey = draftKey;
    const selection = model && effort ? { model, effort } : {};
    const clearSubmitted = () => setDrafts((current) => current[submittedKey]?.trim() === prompt ? { ...current, [submittedKey]: "" } : current);
    setBusy(true);
    setError(null);
    try {
      if (newTask) {
        if (!projects.find((project) => project.id === projectId)?.canStart) throw new Error("请先在电脑端登记允许启动任务的项目目录");
        const result = await api.start(projectId, prompt, selection);
        setNewTask(false);
        clearSubmitted();
        await refresh();
        await loadThread(result.threadId);
      } else if (selectedId) {
        if (detail?.thread.activeTurnId || api.hasPendingEnqueue(selectedId)) await api.enqueue(selectedId, prompt, selection);
        else await api.send(selectedId, prompt, selection);
        clearSubmitted();
        await loadThread(selectedId, true);
      }
    } catch (caught) { setError(errorMessage(caught)); }
    finally { sending.current = false; setBusy(false); }
  };

  const toggleFavorite = async (thread: ThreadSummary) => {
    try {
      await api.favorite(thread.id, !thread.isPinned);
      await refresh();
    } catch (caught) { setError(errorMessage(caught)); }
  };

  const answerApproval = async (approval: ApprovalRequest, decision: "accept" | "decline") => {
    if (!selectedId) return;
    try {
      const answer = approval.kind === "question"
        ? { answers: Object.fromEntries(approval.questions.map((question) => [question.id, approvalAnswers[`${approval.id}:${question.id}`] || ""])) }
        : { decision };
      await api.approve(approval.id, answer);
      setApprovalAnswers((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${approval.id}:`))));
      await loadThread(selectedId, true);
    } catch (caught) { setError(errorMessage(caught)); }
  };

  const signOut = async () => {
    try {
      await api.revokeCurrentDevice();
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    clearToken();
    updateToken(null);
  };

  if (!token) return <main className="pair-screen">
    <section className="pair-panel">
      <div className="brand-mark"><Code2 size={22} /></div>
      
      <h1>CodexPhone</h1>
      <p className="pair-copy">输入电脑端 CodexPhone 服务显示的一次性配对码，连接你的工作区。</p>
      <form onSubmit={pair} className="pair-form">
        <label>设备名称<input value={pairName} onChange={(event) => setPairName(event.target.value)} placeholder="我的手机" autoComplete="off" /></label>
        <label>配对码<input value={pairCode} onChange={(event) => setPairCode(event.target.value)} placeholder="粘贴电脑端配对码" autoComplete="one-time-code" required /></label>
        {error && <p className="error-note"><CircleAlert size={16} />{error}</p>}
        <button className="primary-button" type="submit"><Smartphone size={17} />配对设备</button>
      </form>
      <div className="secure-note"><Wifi size={15} />仅通过你的 Tailscale 网络连接</div>
    </section>
  </main>;

  const activeThread = threads.find((thread) => thread.id === selectedId) ?? detail?.thread ?? null;
  const selectedProject = projects.find((project) => project.id === projectId);
  const projectsSaved = async (project?: Project) => {
    const entries = await api.projects();
    setProjects(entries);
    if (project) setProjectId(project.id);
    else if (!entries.some((entry) => entry.id === projectId && entry.canStart)) setProjectId(entries.find((entry) => entry.canStart)?.id || "");
  };
  const isOnline = hostStatus?.status === "ready";
  const goBack = () => { selectedRef.current = null; threadRequest.current++; setSelectedId(null); setDetail(null); setNewTask(false); };
  const createTask = () => { goBack(); if (!projectId) setProjectId(projects.find((project) => project.canStart)?.id || ""); setNewTask(true); };
  const running = Boolean(detail?.thread.activeTurnId);

  return <main className="app-shell">
    {managingProjects && <ProjectManager projects={projects} onSaved={projectsSaved} onClose={() => setManagingProjects(false)} />}
    <aside className={`sidebar ${selectedId || newTask ? "sidebar-hidden-mobile" : ""}`}>
      <header className="sidebar-header">
        <div className="brand-mark small"><Code2 size={19} /></div>
        <div><strong>CodexPhone</strong><span className="host-label">{connected ? "已连接电脑" : "正在重新连接"}</span></div>
        <span className={`connection-dot ${isOnline ? "online" : "offline"}`} title={isOnline ? "电脑在线" : "电脑连接异常"} />
      </header>
      <div className="project-select-wrap">
        <FolderGit2 size={16} />
        <select aria-label="选择项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">所有项目</option>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}{project.canStart ? " · 可启动任务" : " · 只读"}</option>)}
        </select>
      </div>
      <div className="thread-actions">
        <button className="new-task-button" onClick={createTask}><Plus size={17} />新建任务</button>
        <button className="icon-button" aria-label="管理项目" title="管理项目" onClick={() => setManagingProjects(true)}><FolderGit2 size={18} /></button>
        <button className="icon-button refresh-button" aria-label="刷新对话" title="刷新对话" onClick={() => void refresh()}><RefreshCw size={16} /></button>
      </div>
      <nav className="thread-filter" aria-label="对话筛选">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}><MessageSquareText size={15} />全部</button>
        <button className={filter === "pinned" ? "active" : ""} onClick={() => setFilter("pinned")}><Pin size={15} />重点</button>
      </nav>
      <div className="thread-list" aria-label="对话列表">
        {loading && !threads.length ? <div className="empty-state"><LoaderCircle className="spin" size={19} />加载对话</div> : null}
        {!loading && !visibleThreads.length ? <div className="empty-state">{filter === "pinned" ? "还没有重点对话" : "当前项目暂无对话"}</div> : null}
        {visibleThreads.map((thread) => <button key={thread.id} className={`thread-row ${thread.id === selectedId ? "selected" : ""}`} onClick={() => { setNewTask(false); void loadThread(thread.id); }}>
          <span className="thread-row-top"><span className="thread-title">{threadLabel(thread)}</span><span className="thread-time">{relativeTime(thread.updatedAt)}</span></span>
          <span className="thread-preview">{thread.preview || thread.cwd || "Codex 对话"}</span>
          <span className="thread-row-meta"><span>{typeof thread.status === "object" && thread.status && "type" in thread.status ? ({ active: "运行中", idle: "待命", notLoaded: "历史对话", systemError: "执行异常" } as Record<string, string>)[String((thread.status as {type: unknown}).type)] || "对话" : "对话"}</span><span onClick={(event) => { event.stopPropagation(); void toggleFavorite(thread); }} className={`pin-control ${thread.isPinned ? "pinned" : ""}`} role="button" aria-label={thread.isPinned ? "取消重点" : "标记重点"}><Pin size={13} /></span></span>
        </button>)}
        {nextCursor && <button className="load-more" disabled={loading} onClick={() => void loadMoreThreads()}>{loading ? "正在加载…" : "加载更多对话"}</button>}
      </div>
      <footer className="sidebar-footer">
        <div className="host-status-text" title={hostStatus?.model}>{isOnline ? <><span className="mini-dot" />{hostStatus?.transport === "websocket" ? "电脑与手机已同步" : "电脑在线 · 独立连接"}</> : <><span className="mini-dot offline" />正在连接电脑</>}</div>
        <button className="icon-button" aria-label="解除本机配对" title="解除本机配对" onClick={() => void signOut()}><LogOut size={16} /></button>
      </footer>
    </aside>

    <section className={`conversation ${selectedId || newTask ? "conversation-open-mobile" : ""}`}>
      <header className="conversation-header">
        <button className="icon-button mobile-back" aria-label="返回对话列表" onClick={goBack}><ArrowLeft size={19} /></button>
        <div className="conversation-heading">
          <div className="breadcrumbs"><span>{selectedProject?.name || "项目"}</span><span className="crumb-divider">/</span><span>{newTask ? "新建任务" : activeThread ? threadLabel(activeThread) : "对话"}</span></div>
          <div className="conversation-subtitle">{activeThread?.cwd || selectedProject?.path || "选择一个项目"}</div>
        </div>
        {activeThread && <button className={`icon-button header-pin ${activeThread.isPinned ? "pinned" : ""}`} aria-label={activeThread.isPinned ? "取消重点" : "标记重点"} title={activeThread.isPinned ? "取消重点" : "标记重点"} onClick={() => void toggleFavorite(activeThread)}><Pin size={17} /></button>}
      </header>
      <div ref={contentRef} className="conversation-content" key={selectedId || (newTask ? "new" : "empty")} onScroll={(event) => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {!selectedId && !newTask && <div className="welcome-state"><div className="welcome-icon"><Activity size={22} /></div><h2>选择一个对话</h2><p>从列表打开现有任务，或在电脑项目中启动新任务。</p><button className="primary-button" onClick={createTask}><Plus size={17} />新建任务</button></div>}
        {newTask && <div className="new-task-state"><div className="new-task-icon"><Plus size={20} /></div><p className="eyebrow">{selectedProject?.name || "选择项目"}</p><h2>开始一个 Codex 任务</h2><label className="task-project-picker">启动项目<select aria-label="任务项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.canStart ? "" : " · 需先启用"}</option>)}</select></label><p>{selectedProject?.canStart ? selectedProject.path : "选择可启动项目，或在管理项目中登记和启用目录。"}</p><button type="button" className="project-add" onClick={() => setManagingProjects(true)}><FolderGit2 size={17} />管理项目</button></div>}
        {selectedId && !detail && <div className="empty-state detail-loading"><LoaderCircle className="spin" size={20} />正在读取对话</div>}
        {detail && <div className="message-stack">
          {detail.nextCursor && <button className="load-more" disabled={loadingOlder} onClick={() => void loadOlderMessages()}>{loadingOlder ? "正在加载…" : "加载更早消息"}</button>}
          {detail.approvals.map((approval) => <article className="approval-card" key={approval.id}>
            <div className="approval-heading"><span className="approval-icon"><CircleAlert size={15} /></span><div><strong>{approval.title}</strong><span>Codex 正在等待你的决定</span></div></div>
            {approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
            {approval.questions.map((question) => <label className="approval-question" key={question.id}>{question.question}<input type={question.secret ? "password" : "text"} value={approvalAnswers[`${approval.id}:${question.id}`] || ""} onChange={(event) => setApprovalAnswers((current) => ({ ...current, [`${approval.id}:${question.id}`]: event.target.value }))} /></label>)}
            <div className="approval-actions">{approval.kind !== "question" && <button className="approval-decline" onClick={() => void answerApproval(approval, "decline")}><X size={15} />拒绝</button>}{approval.canAccept && <button className="approval-accept" onClick={() => void answerApproval(approval, "accept")}><Plus size={15} />{approval.kind === "question" ? "提交回答" : "允许"}</button>}</div>
          </article>)}
          {detail.turns.flatMap((turn) => turn.items.filter((item) => item.type === "userMessage" || item.type === "agentMessage").map((item, index) => {
            const isUser = item.type === "userMessage";
            const live = liveMessages.find((entry) => entry.threadId === selectedId && entry.turnId === turn.id && entry.itemId === item.id);
            const text = (live && live.text.length > item.text.length ? live.text : item.text).trim();
            if (!text && !item.images?.length) return null;
            return <article data-turn-id={turn.id} className={`message ${isUser ? "message-user" : "message-agent"}`} key={`${turn.id}-${item.id || index}`}>
              <div className="message-label">{isUser ? "你" : "Codex"}<span>{turn.startedAt ? relativeTime(new Date(turn.startedAt).toISOString()) : ""}</span></div>
              {isUser ? <div className="message-body user-text">{text}<MessageContent text="" images={item.images} threadId={selectedId!} /></div> : <MessageContent text={text} images={item.images} threadId={selectedId!} />}
            </article>;
          }))}
          {liveMessages.filter((entry) => entry.threadId === selectedId && !detail.turns.some((turn) => turn.id === entry.turnId && turn.items.some((item) => item.id === entry.itemId))).map((entry) => <article className="message message-agent" key={`live:${entry.turnId}:${entry.itemId}`}><div className="message-label">Codex</div><MessageContent text={entry.text} threadId={selectedId!} /></article>)}
          {detail.thread.writeState === "external" && <p className="sync-note">此对话正由电脑端持有，手机可同步查看历史，暂不能接管发送。</p>}
          {running && <p className="running-note"><LoaderCircle size={16} className="spin" />Codex 正在执行任务…</p>}
          {detail.turns.length === 0 && <div className="empty-state">暂无对话内容</div>}
        </div>}
        {error && <div className="inline-error"><CircleAlert size={15} />{error}<button className="icon-button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button></div>}
      </div>
      {selectedId && detail && <div className="conversation-nav"><button type="button" onClick={() => setNavigation(!navigation)}>对话导航</button>{navigation && <div role="dialog" aria-label="对话导航" className="navigation-panel"><button onClick={() => { followBottom.current = true; if (contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight; setNavigation(false); }}>跳到最新消息</button>{detail.nextCursor && <button disabled={loadingOlder} onClick={() => void loadOlderMessages()}>加载更早消息</button>}{detail.turns.map((turn, index) => <button key={turn.id} onClick={() => { followBottom.current = false; contentRef.current?.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`)?.scrollIntoView({ block: "start" }); setNavigation(false); }}><strong>第 {index + 1} 轮</strong><span>{(turn.items.find(i => i.type === "userMessage")?.text || turn.items[0]?.text || "任务消息").slice(0, 80)}</span></button>)}</div>}</div>}
      {(selectedId || newTask) && <form className="composer" onSubmit={submit}>
          {selectedId && api.hasPendingQueueRequest(selectedId) && !busy && <p className="model-note">有排队或引导提交待确认。保留原内容重试会先查询状态。<button type="button" onClick={() => { if (confirm("请先核对电脑对话及排队条。清除后再次发送可能重复执行；此操作不会取消电脑任务。确认已检查？")) { api.discardQueueRequests(selectedId); setError(null); void loadThread(selectedId, true); } }}>已检查，清除提交记录</button></p>}
        {queued.length > 0 && <div className="queued-messages" aria-label="排队消息">{queued.map(message => <div className="queued-message" key={message.id}><div><small>{message.state === "queued" ? "排队中 · 本轮结束后发送" : message.state === "dispatching" ? "正在提交" : "结果待确认 · 请先检查对话"}</small><p>{message.prompt}</p>{message.error && <small>{message.error}</small>}</div><div className="queue-actions"><button type="button" disabled={busy || !running || message.state !== "queued"} onClick={() => { if (selectedId) { setBusy(true); void api.guideQueued(selectedId, message.id).then(() => loadThread(selectedId, true)).catch(e => setError(errorMessage(e))).finally(() => setBusy(false)); } }}>引导</button><button type="button" disabled={busy || message.state === "dispatching"} onClick={() => { if (selectedId && (message.state !== "unknown" || confirm("请确认已检查对话。移除记录不会取消已执行的任务。"))) void api.cancelQueued(selectedId, message.id).then(() => loadThread(selectedId, true)).catch(e => setError(errorMessage(e))); }}>{message.state === "unknown" ? "已检查，移除" : "移除"}</button></div></div>)}</div>}
        <div className="model-controls">
          <label>模型<select aria-label="选择模型" value={model} onChange={(event) => chooseModel(event.target.value)} disabled={busy || running || !modelOptions.length}>{!modelOptions.length && <option value="">使用电脑配置</option>}{modelOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
          <label>思考强度<select aria-label="选择思考强度" value={effort} onChange={(event) => chooseEffort(event.target.value)} disabled={busy || running || !selectedModel?.efforts.length}>{!selectedModel && <option value="">默认</option>}{selectedModel?.efforts.map((value) => <option key={value} value={value}>{({ low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高", ultra: "极高", minimal: "最小", none: "无" } as Record<string, string>)[value] || value} ({value})</option>)}</select></label>
        </div>
        {modelError && <p className="model-note">模型列表暂不可用，将使用电脑配置。</p>}
        {running && <p className="model-note">发送后默认排队；点击排队条右侧“引导”可干预当前任务。</p>}
        <textarea aria-label="消息" value={composer} onChange={(event) => { setComposer(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; }} placeholder={newTask ? "想让 Codex 做什么？" : "继续对话…"} rows={2} maxLength={20_000} enterKeyHint="enter" />
        <div className="composer-footer"><span>回车换行，点击箭头发送</span><span className="composer-actions">{selectedId && running && <button className="stop-button" type="button" aria-label="中断当前任务" title="中断当前任务" onClick={() => { if (!selectedId || !detail?.thread.activeTurnId) return; void api.interrupt(selectedId, detail.thread.activeTurnId).then(() => loadThread(selectedId, true)).catch((caught) => setError(errorMessage(caught))); }}><Square size={16} fill="currentColor" /></button>}<button className="send-button" type="submit" aria-label={running ? "排队发送" : "发送消息"} disabled={!composer.trim() || busy || (newTask && !projects.find((project) => project.id === projectId)?.canStart)}><span>{busy ? <LoaderCircle className="spin" size={20} /> : <ArrowUp size={22} />}</span></button></span></div>
      </form>}
      {!isOnline && token && <div className="offline-banner"><WifiOff size={15} />电脑端不可用，请确认 CodexPhone 正在运行</div>}
      {hostStatus?.lastError && <span className="sr-only">{hostStatus.lastError}</span>}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

if ("serviceWorker" in navigator && window.isSecureContext && import.meta.env.PROD) {
  window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
