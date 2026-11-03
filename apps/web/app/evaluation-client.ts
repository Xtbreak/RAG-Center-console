import { apiRequest, ApiError } from "./api-client";
import type { ObservationFilters } from "./observability-client";

export type EvaluationCase = {
  id: string; kind: "good" | "bad"; question: string; actual_answer: string;
  notes: string; agent_id: string | null; agent_name: string; source_query_id: string | null;
  created_at: string; updated_at: string;
};
export type EvaluationInput = {
  kind: "good" | "bad"; question: string; actual_answer: string;
  notes: string; agent_id: string | null; source_query_id: string | null;
};

function params(filters: ObservationFilters & { kind?: string; format?: string }) {
  const search = new URLSearchParams();
  if (filters.kind) search.set("kind", filters.kind);
  if (filters.format) search.set("format", filters.format);
  if (filters.agentId) search.set("agent_id", filters.agentId);
  if (filters.q) search.set("q", filters.q);
  if (filters.start) search.set("start", filters.start);
  if (filters.end) search.set("end", filters.end);
  return search;
}

export const listEvaluations = (filters: ObservationFilters & { kind?: string }) => {
  const search = params(filters);
  search.set("offset", String(filters.offset ?? 0));
  search.set("limit", String(filters.limit ?? 20));
  return apiRequest<{ items: EvaluationCase[]; total: number }>(`/evaluations?${search}`);
};
export const createEvaluation = (input: EvaluationInput) => apiRequest<EvaluationCase>("/evaluations", { method: "POST", body: JSON.stringify(input) });
export const updateEvaluation = (id: string, input: Partial<EvaluationInput>) => apiRequest<EvaluationCase>(`/evaluations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteEvaluation = (id: string) => apiRequest<void>(`/evaluations/${id}`, { method: "DELETE" });

export async function downloadEvaluations(format: "csv" | "jsonl", filters: ObservationFilters & { kind?: string }) {
  const response = await fetch(`/api/v1/evaluations/export?${params({ ...filters, format })}`, { credentials: "include" });
  if (!response.ok) {
    let detail: { detail?: string } | null = null;
    try { detail = await response.json(); } catch { /* 使用状态码提示 */ }
    throw new ApiError(detail?.detail || `导出失败（HTTP ${response.status}）`, response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `evaluation-cases${filters.kind ? `-${filters.kind}` : ""}.${format}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
