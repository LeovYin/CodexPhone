import type { ModelOption, ModelSelection } from "@codexphone/shared";
import { isRecord } from "@codexphone/shared";
import { HttpError } from "./security.js";

export function normalizeModel(value: unknown): ModelOption | null {
  if (!isRecord(value) || typeof value.model !== "string") return null;
  return {
    id: value.model, name: typeof value.displayName === "string" ? value.displayName : value.model,
    efforts: Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts.flatMap((entry) => isRecord(entry) && typeof entry.reasoningEffort === "string" ? [entry.reasoningEffort] : []) : [],
    defaultEffort: typeof value.defaultReasoningEffort === "string" ? value.defaultReasoningEffort : "medium",
  };
}

export function modelSelection(body: Record<string, unknown>, models: ModelOption[]): ModelSelection {
  if (body.model === undefined && body.effort === undefined) return {};
  const model = models.find((entry) => entry.id === body.model);
  if (!model) throw new HttpError(400, "请选择列表中的模型");
  if (body.effort !== undefined && (typeof body.effort !== "string" || !model.efforts.includes(body.effort))) throw new HttpError(400, "该模型不支持所选思考强度");
  return { model: model.id, ...(body.effort ? { effort: body.effort as string } : {}) };
}
