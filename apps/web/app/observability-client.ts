import { apiRequest } from "./api-client";

export type ObservationFilters = { q?: string; status?: string; agentId?: string; knowledgeBaseId?: string; start?: string; end?: string; offset?: number; limit?: number };
export type ModelCall = {
  id: string; provider: string; model_id: string; protocol: string; purpose: string;
  input_context: unknown; output_content: string | null; input_tokens: number; output_tokens: number;
  total_tokens: number; estimated: boolean; latency_ms: number; retry_count: number;
  input_price_per_million: number | null; output_price_per_million: number | null;
  currency: string | null; estimated_cost: number | null; status: string; error_message: string | null; created_at: string;
};
export type Operation = {
  id: string; kind: "tool" | "skill" | "harness" | "doc_parser"; operation: string; status: string;
  input_json: unknown; output_json: unknown; context_json: unknown; http_status: number | null;
  latency_ms: number; unit_count: number; unit_name: string | null; estimated_cost: number | null;
  error_type: string | null; error_message: string | null; created_at: string;
};
export type AgentRun = {
  id: string; agent_id: string | null; agent_name: string; conversation_id: string | null;
  question: string; answer: string; status: "completed" | "failed" | "cancelled" | "running";
  grounded: boolean; route: Array<{ name: string; score: number }>; total_ms: number | null;
  first_token_ms: number | null; retry_count: number; total_tokens: number; estimated_tokens: number;
  estimated_cost: number; has_unpriced_calls: boolean; error_type: string | null;
  failed_stage: string | null; error_message: string | null; created_at: string; completed_at: string | null;
};
export type AgentRunDetail = AgentRun & {
  citations: Array<{ index: number; filename: string; content: string }>;
  route_candidates: Array<{ name: string; score: number }>; route_ms: number; retrieval_ms: number;
  rerank_ms: number; model_calls: ModelCall[]; operations: Operation[];
};
export type IngestionRun = {
  id: string; document_id: string; filename: string; knowledge_base_id: string; knowledge_base_name: string;
  parse_strategy: string; chunk_method: string; metadata_status: string; status: string; stage: string;
  progress: number; attempts: number; cancel_requested: boolean; error_message: string | null;
  chunk_count: number; total_tokens: number; estimated_tokens: number; estimated_cost: number;
  has_unpriced_calls: boolean; created_at: string; started_at: string | null; finished_at: string | null;
};
export type IngestionDetail = IngestionRun & { model_calls: ModelCall[]; operations: Operation[] };
export type ObservabilitySummary = {
  run_count: number; completed_count: number; failed_count: number; cancelled_count: number;
  running_count: number; success_rate: number | null; p50_total_ms: number | null; p95_total_ms: number | null;
  total_tokens: number; estimated_tokens: number; estimated_cost: number; unpriced_call_count: number;
  ingestion_count: number; failed_operation_count: number;
};
export type UsageGroup = {
  keys: Array<string | null>; call_count: number; input_tokens: number; output_tokens: number;
  total_tokens: number; estimated_tokens: number; estimated_cost: number; unpriced_call_count: number;
};
export type Billing = {
  models: UsageGroup[]; agents: UsageGroup[]; days: UsageGroup[];
  doc_parser: { call_count: number; document_count: number; estimated_cost: number; unpriced_call_count: number };
};
export type ModelPrice = {
  model_id: string; model_name: string; provider: string; model_type: string; enabled: boolean;
  input_price_per_million: string; output_price_per_million: string; currency: "CNY" | "USD"; updated_at: string | null;
};

function query(filters: ObservationFilters) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.agentId) params.set("agent_id", filters.agentId);
  if (filters.knowledgeBaseId) params.set("knowledge_base_id", filters.knowledgeBaseId);
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  params.set("offset", String(filters.offset ?? 0));
  params.set("limit", String(filters.limit ?? 20));
  return params.toString();
}
function dateQuery(filters: ObservationFilters) {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  if (filters.agentId) params.set("agent_id", filters.agentId);
  return params.toString();
}

export const getObservabilitySummary = (filters: ObservationFilters) => apiRequest<ObservabilitySummary>(`/observability/summary?${dateQuery(filters)}`);
export const listAgentRuns = (filters: ObservationFilters) => apiRequest<{ items: AgentRun[]; total: number }>(`/observability/agents?${query(filters)}`);
export const getAgentRun = (id: string) => apiRequest<AgentRunDetail>(`/observability/agents/${id}`);
export const listObservedConversations = (filters: ObservationFilters) => apiRequest<{ items: AgentRun[]; total: number }>(`/observability/conversations?${query(filters)}`);
export const listIngestionRuns = (filters: ObservationFilters) => apiRequest<{ items: IngestionRun[]; total: number }>(`/observability/ingestion?${query(filters)}`);
export const getIngestionRun = (id: string) => apiRequest<IngestionDetail>(`/observability/ingestion/${id}`);
export const listOperations = (filters: ObservationFilters & { kind?: string; toolId?: string }) => {
  const params = new URLSearchParams(query(filters));
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.toolId) params.set("tool_id", filters.toolId);
  return apiRequest<{ items: Operation[]; total: number }>(`/observability/operations?${params}`);
};
export const getBilling = (filters: ObservationFilters) => apiRequest<Billing>(`/observability/billing?${dateQuery(filters)}`);
export const listModelPrices = () => apiRequest<ModelPrice[]>("/observability/prices");
export const updateModelPrice = (input: { model_id: string; input_price_per_million: number; output_price_per_million: number; currency: "CNY" | "USD" }) => apiRequest<ModelPrice>("/observability/prices", { method: "PUT", body: JSON.stringify(input) });

export type OverviewDaily = { date: string; run_count: number; completed_count: number; failed_count: number; cancelled_count: number; total_tokens: number; estimated_cost: number };
export type OverviewAgent = { agent_name: string; run_count: number; completed_count: number; failed_count: number; success_rate: number | null; average_total_ms: number | null; p95_total_ms: number | null; total_tokens: number; estimated_cost: number; last_run_at: string };
export type OverviewData = {
  daily: OverviewDaily[];
  agents: OverviewAgent[];
  ingestion: { total: number; chunk_count: number; status: Array<{ name: string; count: number }>; parse_strategy: Array<{ name: string; count: number }>; metadata_status: Array<{ name: string; count: number }> };
  operations: Array<{ kind: string; total: number; completed: number; failed: number; cancelled: number; running: number }>;
  models: UsageGroup[];
};
export const getObservabilityOverview = (filters: ObservationFilters) => apiRequest<OverviewData>(`/observability/overview?${dateQuery(filters)}`);
