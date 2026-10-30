import { randomUUID } from "node:crypto";
import { isRecord, type ApprovalQuestion, type ApprovalRequest } from "@codexphone/shared";
import type { AppServerClient, ServerRequest } from "./app-server.js";
import { HttpError } from "./security.js";

export class ApprovalQueue {
  private pending = new Map<string, { publicRequest: ApprovalRequest; original: ServerRequest }>();
  constructor(private client: AppServerClient) {}
  list(threadId?: string): ApprovalRequest[] { return [...this.pending.values()].filter((entry) => threadId === undefined || entry.publicRequest.threadId === threadId).map((entry) => entry.publicRequest); }
  remove(originalId: unknown): void { for (const [id, entry] of this.pending) if (entry.original.id === originalId) this.pending.delete(id); }
  add(original: ServerRequest): ApprovalRequest | null {
    const p = original.params;
    if (typeof p.threadId !== "string" || typeof p.turnId !== "string") {
      if (this.client.transport !== "websocket") this.client.reject(original.id, "Client does not support this request");
      return null;
    }
    const labels: Record<string, [ApprovalRequest["kind"], string]> = {
      "item/commandExecution/requestApproval": ["command", "允许执行命令？"],
      "item/fileChange/requestApproval": ["file", "允许修改文件？"],
      "item/permissions/requestApproval": ["permissions", "允许本轮增加权限？"],
      "item/tool/requestUserInput": ["question", "Codex 需要你的回答"],
      "tool/requestUserInput": ["question", "Codex 需要你的回答"],
    };
    const kind = labels[original.method];
    if (!kind) {
      // Shared connections also receive GUI-owned tool requests. The GUI handles those;
      // rejecting them here would cancel work in the other client.
      if (this.client.transport !== "websocket") this.client.reject(original.id, "Unsupported request; no permission granted");
      return null;
    }
    const questions: ApprovalQuestion[] = (Array.isArray(p.questions) ? p.questions : []).filter(isRecord).flatMap((q) => {
      if (typeof q.id !== "string" || typeof q.question !== "string") return [];
      return [{ id: q.id, question: q.question, secret: q.isSecret === true, options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).flatMap((option) => typeof option.label === "string" ? [{ label: option.label, description: typeof option.description === "string" ? option.description : "" }] : []) }];
    });
    const detail = [p.reason, p.command, p.cwd, p.grantRoot, p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext) : null, kind[0] === "permissions" ? JSON.stringify(p.permissions) : null].filter((value): value is string => typeof value === "string").join("\n").slice(0, 12000);
    const request: ApprovalRequest = { id: randomUUID(), threadId: p.threadId, turnId: p.turnId, kind: kind[0], title: kind[1], detail, canAccept: !Array.isArray(p.availableDecisions) || p.availableDecisions.includes("accept"), questions };
    this.pending.set(request.id, { publicRequest: request, original });
    return request;
  }
  get(id: string): ApprovalRequest { const entry = this.pending.get(id); if (!entry) throw new HttpError(409, "This request has already been resolved"); return entry.publicRequest; }
  answer(id: string, body: Record<string, unknown>): string {
    const entry = this.pending.get(id); if (!entry) throw new HttpError(409, "This request has already been resolved");
    const { original, publicRequest: request } = entry;
    let result: unknown;
    if (request.kind === "question") {
      if (!isRecord(body.answers)) throw new HttpError(400, "Answers are required");
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of request.questions) {
        const value = body.answers[question.id];
        if (typeof value !== "string" || !value.trim() || value.length > 5000) throw new HttpError(400, "Answer every question");
        answers[question.id] = { answers: [value.trim()] };
      }
      result = { answers };
    } else {
      if (body.decision !== "accept" && body.decision !== "decline") throw new HttpError(400, "Choose accept or decline");
      if (body.decision === "accept" && !request.canAccept) throw new HttpError(400, "This operation cannot be approved once");
      result = request.kind === "permissions" ? { permissions: body.decision === "accept" ? original.params.permissions : {}, scope: "turn" } : { decision: body.decision };
    }
    this.client.respond(original.id, result); this.pending.delete(id); return request.threadId;
  }
}
