export interface Project {
  id: string;
  name: string;
  path?: string;
  canStart: boolean;
  codexProjectId?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
}

export interface ModelSelection { model?: string; effort?: string }

export interface ThreadSummary {
  id: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  model: string | null;
  provider: string | null;
  updatedAt: string | null;
  status: unknown;
  turns: number;
  isPinned: boolean;
  canControl: boolean;
  activeTurnId: string | null;
  writeState: "owned" | "external" | "unknown";
}

export interface ThreadTurn {
  id: string;
  status: string | null;
  items: ThreadItem[];
  startedAt: number | null;
  completedAt: number | null;
}

export interface ThreadItem {
  id: string;
  type: string;
  text: string;
  images: string[];
  status: string | null;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  turns: ThreadTurn[];
  nextCursor: string | null;
  approvals: ApprovalRequest[];
  model: string | null;
  effort: string | null;
}

export interface HostStatus {
  transport?: "stdio" | "websocket";
  status: "ready" | "starting" | "degraded";
  codexVersion: string;
  model: string;
  provider: string;
  authMode: string;
  lastError: string | null;
}

export interface ApiError {
  error: string;
}

export interface ApprovalQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  secret: boolean;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  turnId: string;
  kind: "command" | "file" | "permissions" | "question";
  title: string;
  detail: string;
  canAccept: boolean;
  questions: ApprovalQuestion[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

