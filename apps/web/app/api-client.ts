import type {
  ChatCitation,
  ChatMessage,
  ChatRouteSelection,
  ChunkMethod,
  ConversationDetail,
  ConversationSummary,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDocument,
  ModelInstance,
  ModelProvider,
  RetrievalHit,
  RetrievalTestResult,
  Role,
} from "./prototype-models";
import { DEFAULT_CHUNK_SEPARATORS } from "./prototype-models";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function errorFromPayload(payload: unknown, status: number): ApiError {
  let message = `请求失败（HTTP ${status}）`;
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") message = detail;
  else if (Array.isArray(detail)) message = detail.map((item: { msg?: string }) => item.msg).filter(Boolean).join("；") || message;
  else if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") message = (detail as { message: string }).message;
  return new ApiError(message, status, detail);
}

type ProviderWire = {
  id: string;
  preset_id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  default_protocol: string;
  health: ModelProvider["health"];
  model_count: number;
  last_latency_ms: number | null;
  last_error: string | null;
  last_checked_at: string | null;
};

type ModelWire = {
  id: string;
  provider_id: string;
  name: string;
  model_id: string;
  model_type: ModelInstance["modelType"];
  protocol: string;
  context_length: number | null;
  vector_dimension: number | null;
  timeout_seconds: number;
  enabled: boolean;
};

export type ProviderInput = {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultProtocol: string;
};

export type ModelInput = {
  providerId: string;
  name: string;
  modelId: string;
  modelType: ModelInstance["modelType"];
  protocol: string;
  contextLength: number | null;
  vectorDimension: number | null;
  timeoutSeconds: number;
  enabled: boolean;
};

export type HealthCheckResult = {
  provider_id: string;
  model_id: string;
  status: ModelProvider["health"];
  latency_ms: number;
  protocol: string;
  checks: Record<string, boolean>;
  usage: Record<string, number> | null;
  message: string;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  modelType: ModelInstance["modelType"];
  typeConfidence: "high" | "medium" | "low";
  vectorDimension: number | null;
};

export type ModelDiscoveryInput = {
  providerId?: string;
  presetId: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
};

export type ModelDiscoveryResult = {
  models: DiscoveredModel[];
  truncated: boolean;
};

export type ModelDefaults = {
  routing_embedding: string | null;
  routing_llm: string | null;
  default_rerank: string | null;
  vision: string | null;
};

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Keep the status-based fallback when an upstream service does not return JSON.
    }
    throw errorFromPayload(payload, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function mapProvider(provider: ProviderWire): ModelProvider {
  return {
    id: provider.id,
    presetId: provider.preset_id,
    name: provider.name,
    baseUrl: provider.base_url,
    apiKeyMasked: provider.api_key_masked,
    defaultProtocol: provider.default_protocol,
    health: provider.health,
    modelCount: provider.model_count,
    lastLatencyMs: provider.last_latency_ms,
    lastError: provider.last_error,
    lastCheckedAt: provider.last_checked_at,
  };
}

function mapModel(model: ModelWire): ModelInstance {
  return {
    id: model.id,
    providerId: model.provider_id,
    name: model.name,
    modelId: model.model_id,
    modelType: model.model_type,
    protocol: model.protocol,
    contextLength: model.context_length,
    vectorDimension: model.vector_dimension,
    timeoutSeconds: model.timeout_seconds,
    enabled: model.enabled,
  };
}

export async function getSession(): Promise<{ id: string; role: Role }> {
  return apiRequest("/session");
}

export async function updateSessionRole(role: Role): Promise<{ id: string; role: Role }> {
  return apiRequest("/session", { method: "PUT", body: JSON.stringify({ role }) });
}

export async function listProviders(): Promise<ModelProvider[]> {
  return (await apiRequest<ProviderWire[]>("/providers")).map(mapProvider);
}

export async function createProvider(input: ProviderInput): Promise<ModelProvider> {
  const provider = await apiRequest<ProviderWire>("/providers", {
    method: "POST",
    body: JSON.stringify({
      preset_id: input.presetId,
      name: input.name,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      default_protocol: input.defaultProtocol,
    }),
  });
  return mapProvider(provider);
}

export async function updateProvider(id: string, input: ProviderInput): Promise<ModelProvider> {
  const body: Record<string, string> = {
    name: input.name,
    base_url: input.baseUrl,
    default_protocol: input.defaultProtocol,
  };
  if (input.apiKey) body.api_key = input.apiKey;
  const provider = await apiRequest<ProviderWire>(`/providers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return mapProvider(provider);
}

export async function deleteProvider(id: string): Promise<void> {
  return apiRequest(`/providers/${id}`, { method: "DELETE" });
}

export async function discoverProviderModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const body: Record<string, string> = {
    preset_id: input.presetId,
    base_url: input.baseUrl,
    protocol: input.protocol,
  };
  if (input.providerId) body.provider_id = input.providerId;
  if (input.apiKey) body.api_key = input.apiKey;
  const result = await apiRequest<{
    models: Array<{ id: string; name: string; model_type: ModelInstance["modelType"]; type_confidence: "high" | "medium" | "low"; vector_dimension: number | null }>;
    truncated: boolean;
  }>("/providers/discover-models", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    models: result.models.map((model) => ({
      id: model.id,
      name: model.name,
      modelType: model.model_type,
      typeConfidence: model.type_confidence,
      vectorDimension: model.vector_dimension,
    })),
    truncated: result.truncated,
  };
}

export async function listModels(providerId?: string): Promise<ModelInstance[]> {
  const query = providerId ? `?provider_id=${encodeURIComponent(providerId)}` : "";
  return (await apiRequest<ModelWire[]>(`/models${query}`)).map(mapModel);
}

export async function createModel(input: ModelInput): Promise<ModelInstance> {
  const model = await apiRequest<ModelWire>("/models", {
    method: "POST",
    body: JSON.stringify({
      provider_id: input.providerId,
      name: input.name,
      model_id: input.modelId,
      model_type: input.modelType,
      protocol: input.protocol,
      context_length: input.contextLength,
      vector_dimension: input.vectorDimension,
      timeout_seconds: input.timeoutSeconds,
      enabled: input.enabled,
    }),
  });
  return mapModel(model);
}

export async function updateModel(id: string, input: ModelInput): Promise<ModelInstance> {
  const model = await apiRequest<ModelWire>(`/models/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      model_id: input.modelId,
      model_type: input.modelType,
      protocol: input.protocol,
      context_length: input.contextLength,
      vector_dimension: input.vectorDimension,
      timeout_seconds: input.timeoutSeconds,
      enabled: input.enabled,
    }),
  });
  return mapModel(model);
}

export async function checkProvider(id: string): Promise<HealthCheckResult> {
  return apiRequest(`/providers/${id}/health-check`, { method: "POST" });
}

export async function getModelDefaults(): Promise<ModelDefaults> {
  return apiRequest("/model-defaults");
}

export async function updateModelDefaults(defaults: ModelDefaults): Promise<ModelDefaults> {
  return apiRequest("/model-defaults", { method: "PUT", body: JSON.stringify(defaults) });
}

type KnowledgeBaseWire = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  sample_questions: string[];
  embedding_model_id: string;
  embedding_model_name: string;
  vector_dimension: number;
  chunk_size: number;
  chunk_overlap: number;
  chunk_method: ChunkMethod;
  heading_level: number;
  separators: string[];
  semantic_threshold: number;
  status: KnowledgeBase["status"];
  rebuild_error: string | null;
  document_count: number;
  ready_document_count: number;
  processing_document_count: number;
  chunk_count: number;
  created_at: string;
  updated_at: string;
};

type DocumentWire = {
  id: string;
  knowledge_base_id: string;
  filename: string;
  extension: string;
  size_bytes: number;
  status: KnowledgeDocument["status"];
  error_message: string | null;
  parse_strategy: KnowledgeDocument["parseStrategy"];
  enhance_images: boolean;
  chunk_method: ChunkMethod;
  chunk_size: number;
  chunk_overlap: number;
  heading_level: number;
  separators: string[];
  semantic_threshold: number;
  metadata: KnowledgeDocument["metadata"];
  metadata_status: KnowledgeDocument["metadataStatus"];
  metadata_error: string | null;
  chunk_count: number;
  job_id: string | null;
  job_status: KnowledgeDocument["jobStatus"];
  job_progress: number;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
};

type ChunkWire = {
  id: string;
  document_id: string;
  position: number;
  kind: KnowledgeChunk["kind"];
  content: string;
  token_count: number;
  location: KnowledgeChunk["location"];
  vector_status: KnowledgeChunk["vectorStatus"];
  edited: boolean;
  updated_at: string;
};

export type ChunkSettings = {
  chunkMethod: ChunkMethod;
  chunkSize: number;
  chunkOverlap: number;
  headingLevel: number;
  separators: string[];
  semanticThreshold: number;
};

export type KnowledgeBaseInput = ChunkSettings & {
  name: string;
  description: string;
  tags: string[];
  sampleQuestions: string[];
  embeddingModelId: string;
};

export type DuplicateDocument = { id: string; filename: string; created_at: string };

function mapKnowledgeBase(kb: KnowledgeBaseWire): KnowledgeBase {
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    tags: kb.tags,
    sampleQuestions: kb.sample_questions,
    embeddingModelId: kb.embedding_model_id,
    embeddingModelName: kb.embedding_model_name,
    vectorDimension: kb.vector_dimension,
    chunkSize: kb.chunk_size,
    chunkOverlap: kb.chunk_overlap,
    chunkMethod: kb.chunk_method,
    headingLevel: kb.heading_level,
    separators: kb.separators?.length ? kb.separators : DEFAULT_CHUNK_SEPARATORS,
    semanticThreshold: kb.semantic_threshold ?? 0.75,
    status: kb.status,
    rebuildError: kb.rebuild_error,
    documentCount: kb.document_count,
    readyDocumentCount: kb.ready_document_count,
    processingDocumentCount: kb.processing_document_count,
    chunkCount: kb.chunk_count,
    createdAt: kb.created_at,
    updatedAt: kb.updated_at,
  };
}

function mapDocument(document: DocumentWire): KnowledgeDocument {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledge_base_id,
    filename: document.filename,
    extension: document.extension,
    sizeBytes: document.size_bytes,
    status: document.status,
    errorMessage: document.error_message,
    parseStrategy: document.parse_strategy,
    enhanceImages: document.enhance_images,
    chunkMethod: document.chunk_method,
    chunkSize: document.chunk_size,
    chunkOverlap: document.chunk_overlap,
    headingLevel: document.heading_level,
    separators: document.separators?.length ? document.separators : DEFAULT_CHUNK_SEPARATORS,
    semanticThreshold: document.semantic_threshold ?? 0.75,
    metadata: document.metadata ?? { dates: [], versions: [], subjects: [], owners: [], keywords: [], questions: [] },
    metadataStatus: document.metadata_status ?? "pending",
    metadataError: document.metadata_error,
    chunkCount: document.chunk_count,
    jobId: document.job_id,
    jobStatus: document.job_status,
    jobProgress: document.job_progress,
    cancelRequested: document.cancel_requested,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
  };
}

function mapChunk(chunk: ChunkWire): KnowledgeChunk {
  return {
    id: chunk.id,
    documentId: chunk.document_id,
    position: chunk.position,
    kind: chunk.kind,
    content: chunk.content,
    tokenCount: chunk.token_count,
    location: chunk.location ?? {},
    vectorStatus: chunk.vector_status,
    edited: chunk.edited,
    updatedAt: chunk.updated_at,
  };
}

function knowledgeBaseBody(input: Partial<KnowledgeBaseInput>) {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.tags !== undefined) body.tags = input.tags;
  if (input.sampleQuestions !== undefined) body.sample_questions = input.sampleQuestions;
  if (input.embeddingModelId !== undefined) body.embedding_model_id = input.embeddingModelId;
  if (input.chunkSize !== undefined) body.chunk_size = input.chunkSize;
  if (input.chunkOverlap !== undefined) body.chunk_overlap = input.chunkOverlap;
  if (input.chunkMethod !== undefined) body.chunk_method = input.chunkMethod;
  if (input.headingLevel !== undefined) body.heading_level = input.headingLevel;
  if (input.separators !== undefined) body.separators = input.separators;
  if (input.semanticThreshold !== undefined) body.semantic_threshold = input.semanticThreshold;
  return JSON.stringify(body);
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return (await apiRequest<KnowledgeBaseWire[]>("/knowledge-bases")).map(mapKnowledgeBase);
}

export async function createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBase> {
  return mapKnowledgeBase(await apiRequest<KnowledgeBaseWire>("/knowledge-bases", { method: "POST", body: knowledgeBaseBody(input) }));
}

export async function updateKnowledgeBase(id: string, input: Partial<KnowledgeBaseInput>): Promise<KnowledgeBase> {
  return mapKnowledgeBase(await apiRequest<KnowledgeBaseWire>(`/knowledge-bases/${id}`, { method: "PATCH", body: knowledgeBaseBody(input) }));
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  return apiRequest(`/knowledge-bases/${id}`, { method: "DELETE" });
}

export async function listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocument[]> {
  return (await apiRequest<DocumentWire[]>(`/knowledge-bases/${knowledgeBaseId}/documents`)).map(mapDocument);
}

/** 使用 XMLHttpRequest 上传以获得上传进度；fetch 目前无法报告请求体发送进度。 */
export function uploadDocument(
  knowledgeBaseId: string,
  file: File,
  options: ChunkSettings & { parseStrategy: KnowledgeDocument["parseStrategy"]; enhanceImages: boolean; allowDuplicate: boolean },
  onProgress?: (fraction: number) => void,
): Promise<KnowledgeDocument> {
  const form = new FormData();
  form.append("file", file);
  form.append("parse_strategy", options.parseStrategy);
  form.append("enhance_images", String(options.enhanceImages));
  form.append("allow_duplicate", String(options.allowDuplicate));
  form.append("chunk_method", options.chunkMethod);
  form.append("chunk_size", String(options.chunkSize));
  form.append("chunk_overlap", String(options.chunkOverlap));
  form.append("heading_level", String(options.headingLevel));
  form.append("separators", JSON.stringify(options.separators));
  form.append("semantic_threshold", String(options.semanticThreshold));
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/v1/knowledge-bases/${knowledgeBaseId}/documents`);
    request.withCredentials = true;
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve(mapDocument(request.response as DocumentWire));
      else reject(errorFromPayload(request.response, request.status));
    };
    request.onerror = () => reject(new ApiError("网络错误，文件未能上传", 0));
    request.send(form);
  });
}

export async function retryDocument(id: string): Promise<KnowledgeDocument> {
  return mapDocument(await apiRequest<DocumentWire>(`/documents/${id}/retry`, { method: "POST" }));
}

export async function cancelDocument(id: string): Promise<KnowledgeDocument> {
  return mapDocument(await apiRequest<DocumentWire>(`/documents/${id}/cancel`, { method: "POST" }));
}

export async function deleteDocument(id: string): Promise<void> {
  return apiRequest(`/documents/${id}`, { method: "DELETE" });
}

export async function listChunks(
  knowledgeBaseId: string,
  query: { documentId?: string; q?: string; offset: number; limit: number },
): Promise<{ items: KnowledgeChunk[]; total: number }> {
  const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit) });
  if (query.documentId) params.set("document_id", query.documentId);
  if (query.q?.trim()) params.set("q", query.q.trim());
  const page = await apiRequest<{ items: ChunkWire[]; total: number }>(`/knowledge-bases/${knowledgeBaseId}/chunks?${params}`);
  return { items: page.items.map(mapChunk), total: page.total };
}

export async function updateChunk(id: string, content: string): Promise<KnowledgeChunk> {
  return mapChunk(await apiRequest<ChunkWire>(`/chunks/${id}`, { method: "PATCH", body: JSON.stringify({ content }) }));
}

type RouteSelectionWire = {
  knowledge_base_id: string;
  name: string;
  score: number;
  reason: string;
};

type CitationWire = {
  index: number;
  chunk_id: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  document_id: string;
  filename: string;
  content: string;
  location: ChatCitation["location"];
};

type ChatMessageWire = {
  id: string;
  role: ChatMessage["role"];
  content: string;
  citations: CitationWire[];
  route: RouteSelectionWire[];
  status: string;
  error_message: string | null;
  created_at: string;
};

type ConversationWire = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type RetrievalHitWire = {
  chunk_id: string;
  knowledge_base_id: string;
  knowledge_base_name: string;
  document_id: string;
  filename: string;
  position: number;
  kind: RetrievalHit["kind"];
  content: string;
  location: RetrievalHit["location"];
  dense_score: number;
  bm25_score: number;
  rrf_score: number;
  rerank_score: number | null;
};

function mapRouteSelection(item: RouteSelectionWire): ChatRouteSelection {
  return {
    knowledgeBaseId: item.knowledge_base_id,
    name: item.name,
    score: item.score,
    reason: item.reason,
  };
}

function mapCitation(item: CitationWire): ChatCitation {
  return {
    index: item.index,
    chunkId: item.chunk_id,
    knowledgeBaseId: item.knowledge_base_id,
    knowledgeBaseName: item.knowledge_base_name,
    documentId: item.document_id,
    filename: item.filename,
    content: item.content,
    location: item.location ?? {},
  };
}

function mapChatMessage(item: ChatMessageWire): ChatMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    citations: (item.citations ?? []).map(mapCitation),
    route: (item.route ?? []).map(mapRouteSelection),
    status: item.status,
    errorMessage: item.error_message,
    createdAt: item.created_at,
  };
}

function mapConversation(item: ConversationWire): ConversationSummary {
  return { id: item.id, title: item.title, createdAt: item.created_at, updatedAt: item.updated_at };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return (await apiRequest<ConversationWire[]>("/conversations")).map(mapConversation);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const item = await apiRequest<ConversationWire & { messages: ChatMessageWire[] }>(`/conversations/${id}`);
  return { ...mapConversation(item), messages: item.messages.map(mapChatMessage) };
}

export async function testRetrieval(query: string, topK: number): Promise<RetrievalTestResult> {
  const result = await apiRequest<{
    query: string;
    selected_knowledge_bases: RouteSelectionWire[];
    hits: RetrievalHitWire[];
    insufficient: boolean;
    rerank_applied: boolean;
    warnings: string[];
  }>("/retrieval/test", { method: "POST", body: JSON.stringify({ query, top_k: topK }) });
  return {
    query: result.query,
    selectedKnowledgeBases: result.selected_knowledge_bases.map(mapRouteSelection),
    hits: result.hits.map((item) => ({
      chunkId: item.chunk_id,
      knowledgeBaseId: item.knowledge_base_id,
      knowledgeBaseName: item.knowledge_base_name,
      documentId: item.document_id,
      filename: item.filename,
      position: item.position,
      kind: item.kind,
      content: item.content,
      location: item.location ?? {},
      denseScore: item.dense_score,
      bm25Score: item.bm25_score,
      rrfScore: item.rrf_score,
      rerankScore: item.rerank_score,
    })),
    insufficient: result.insufficient,
    rerankApplied: result.rerank_applied,
    warnings: result.warnings,
  };
}

export type ChatStreamEvent =
  | { event: "conversation"; data: { conversationId: string; title: string } }
  | { event: "stage"; data: { name: string; label: string } }
  | { event: "routing"; data: { selected: ChatRouteSelection[] } }
  | { event: "warning"; data: { message: string } }
  | { event: "citations"; data: { items: ChatCitation[] } }
  | { event: "delta"; data: { text: string } }
  | { event: "complete"; data: { answer: string; citations: ChatCitation[]; route: ChatRouteSelection[]; grounded: boolean } }
  | { event: "done"; data: { messageId: string; grounded: boolean } }
  | { event: "error"; data: { message: string } };

function parseSseBlock(block: string): { event: ChatStreamEvent["event"]; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  return { event: event as ChatStreamEvent["event"], data: JSON.parse(dataLines.join("\n")) };
}

function normalizeChatStreamEvent(raw: { event: ChatStreamEvent["event"]; data: unknown }): ChatStreamEvent {
  const data = raw.data as Record<string, unknown>;
  if (raw.event === "conversation") return { event: raw.event, data: { conversationId: String(data.conversation_id), title: String(data.title) } };
  if (raw.event === "routing") return { event: raw.event, data: { selected: ((data.selected as RouteSelectionWire[]) ?? []).map(mapRouteSelection) } };
  if (raw.event === "citations") return { event: raw.event, data: { items: ((data.items as CitationWire[]) ?? []).map(mapCitation) } };
  if (raw.event === "complete") return {
    event: raw.event,
    data: {
      answer: String(data.answer ?? ""),
      citations: ((data.citations as CitationWire[]) ?? []).map(mapCitation),
      route: ((data.route as RouteSelectionWire[]) ?? []).map(mapRouteSelection),
      grounded: Boolean(data.grounded),
    },
  };
  if (raw.event === "done") return { event: raw.event, data: { messageId: String(data.message_id), grounded: Boolean(data.grounded) } };
  if (raw.event === "stage") return { event: raw.event, data: { name: String(data.name), label: String(data.label) } };
  if (raw.event === "warning" || raw.event === "error") return { event: raw.event, data: { message: String(data.message) } };
  return { event: "delta", data: { text: String(data.text ?? "") } };
}

export async function streamChat(
  input: { question: string; conversationId: string | null; agentId?: string },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/v1/chat/stream", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question: input.question, conversation_id: input.conversationId, agent_id: input.agentId }),
    signal,
  });
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Keep the status-based fallback when the upstream does not return JSON.
    }
    throw errorFromPayload(payload, response.status);
  }
  if (!response.body) throw new ApiError("浏览器未收到流式回答", 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const parsed = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (parsed) onEvent(normalizeChatStreamEvent(parsed));
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  const parsed = parseSseBlock(buffer.trim());
  if (parsed) onEvent(normalizeChatStreamEvent(parsed));
}

export type QueryLogSummary = {
  id: string;
  conversationId: string | null;
  question: string;
  status: "completed" | "failed" | "cancelled" | "running";
  grounded: boolean;
  route: Array<{ knowledge_base_id: string; name: string; score: number; reason?: string }>;
  firstTokenMs: number | null;
  totalMs: number | null;
  retryCount: number;
  totalTokens: number;
  estimated: boolean;
  errorMessage: string | null;
  createdAt: string;
};

export type ModelCallLog = {
  id: string;
  provider: string;
  modelId: string;
  protocol: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  latencyMs: number;
  retryCount: number;
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

export type QueryLogDetail = QueryLogSummary & {
  answer: string;
  citations: ChatCitation[];
  routeCandidates: Array<{ knowledge_base_id: string; name: string; score: number }>;
  routeMs: number;
  retrievalMs: number;
  rerankMs: number;
  completedAt: string | null;
  modelCalls: ModelCallLog[];
};

type QueryLogSummaryWire = {
  id: string;
  conversation_id: string | null;
  question: string;
  status: QueryLogSummary["status"];
  grounded: boolean;
  route: QueryLogSummary["route"];
  first_token_ms: number | null;
  total_ms: number | null;
  retry_count: number;
  total_tokens: number;
  estimated: boolean;
  error_message: string | null;
  created_at: string;
};

type ModelCallLogWire = {
  id: string;
  provider: string;
  model_id: string;
  protocol: string;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated: boolean;
  latency_ms: number;
  retry_count: number;
  status: string;
  error_message: string | null;
  created_at: string;
};

type QueryLogDetailWire = QueryLogSummaryWire & {
  answer: string;
  citations: CitationWire[];
  route_candidates: QueryLogDetail["routeCandidates"];
  route_ms: number;
  retrieval_ms: number;
  rerank_ms: number;
  completed_at: string | null;
  model_calls: ModelCallLogWire[];
};

function mapQueryLogSummary(log: QueryLogSummaryWire): QueryLogSummary {
  return {
    id: log.id,
    conversationId: log.conversation_id,
    question: log.question,
    status: log.status,
    grounded: log.grounded,
    route: log.route ?? [],
    firstTokenMs: log.first_token_ms,
    totalMs: log.total_ms,
    retryCount: log.retry_count,
    totalTokens: log.total_tokens,
    estimated: log.estimated,
    errorMessage: log.error_message,
    createdAt: log.created_at,
  };
}

function mapModelCallLog(call: ModelCallLogWire): ModelCallLog {
  return {
    id: call.id,
    provider: call.provider,
    modelId: call.model_id,
    protocol: call.protocol,
    purpose: call.purpose,
    inputTokens: call.input_tokens,
    outputTokens: call.output_tokens,
    totalTokens: call.total_tokens,
    estimated: call.estimated,
    latencyMs: call.latency_ms,
    retryCount: call.retry_count,
    status: call.status,
    errorMessage: call.error_message,
    createdAt: call.created_at,
  };
}

export async function listQueryLogs(params: { q?: string; status?: string; start?: string; end?: string; offset: number; limit: number }) {
  const search = new URLSearchParams({ offset: String(params.offset), limit: String(params.limit) });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.start) search.set("start", params.start);
  if (params.end) search.set("end", params.end);
  const result = await apiRequest<{ items: QueryLogSummaryWire[]; total: number }>(`/logs?${search}`);
  return { items: result.items.map(mapQueryLogSummary), total: result.total };
}

export async function getQueryLog(id: string): Promise<QueryLogDetail> {
  const log = await apiRequest<QueryLogDetailWire>(`/logs/${id}`);
  return {
    ...mapQueryLogSummary(log),
    answer: log.answer,
    citations: (log.citations ?? []).map(mapCitation),
    routeCandidates: log.route_candidates ?? [],
    routeMs: log.route_ms,
    retrievalMs: log.retrieval_ms,
    rerankMs: log.rerank_ms,
    completedAt: log.completed_at,
    modelCalls: log.model_calls.map(mapModelCallLog),
  };
}

export async function getQueryLogStats(): Promise<{ todayCount: number; averageTotalMs: number | null }> {
  const result = await apiRequest<{ today_count: number; average_total_ms: number | null }>("/logs/stats");
  return { todayCount: result.today_count, averageTotalMs: result.average_total_ms };
}

export async function getLogRetention(): Promise<number> {
  return (await apiRequest<{ days: number }>("/logs/retention")).days;
}

export async function updateLogRetention(days: number): Promise<number> {
  return (await apiRequest<{ days: number }>("/logs/retention", { method: "PUT", body: JSON.stringify({ days }) })).days;
}

export type AgentApp = {
  id: string;
  name: string;
  description: string;
  mode: "simple" | "chatflow";
  prompt: string;
  opening: string;
  suggestions: string[];
  knowledge_base_ids: string[];
  tool_ids: string[];
  flow: Record<string, unknown>;
  published: boolean;
  theme_color: string;
  show_citations: boolean;
  allow_images: boolean;
  access_limit_per_minute: number;
  allowed_domains: string[];
  created_at: string;
  updated_at: string;
};
export type AgentInput = Omit<AgentApp, "id" | "created_at" | "updated_at">;
export const emptyAgent: AgentInput = {
  name: "", description: "", mode: "simple", prompt: "", opening: "", suggestions: [],
  knowledge_base_ids: [], tool_ids: [], flow: {}, published: false, theme_color: "#3370ff",
  show_citations: true, allow_images: false, access_limit_per_minute: 20, allowed_domains: [],
};
export async function listAgents() { return apiRequest<AgentApp[]>("/agents"); }
export async function createAgent(input: AgentInput) { return apiRequest<AgentApp>("/agents", { method: "POST", body: JSON.stringify(input) }); }
export async function updateAgent(id: string, input: Partial<AgentInput>) { return apiRequest<AgentApp>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) }); }
export async function duplicateAgent(id: string) { return apiRequest<AgentApp>(`/agents/${id}/duplicate`, { method: "POST" }); }
export async function publishAgent(id: string) { return apiRequest<AgentApp>(`/agents/${id}/publish`, { method: "POST" }); }
export async function deleteAgent(id: string) { return apiRequest<void>(`/agents/${id}`, { method: "DELETE" }); }

export type ToolDefinition = {
  id: string; name: string; kind: "http" | "mcp"; description: string; url: string; method: string;
  has_credentials: boolean; timeout_seconds: number; enabled: boolean; created_at: string; updated_at: string;
};
export type ToolInput = { name: string; kind: "http" | "mcp"; description: string; url: string; method: string; headers: Record<string, string>; timeout_seconds: number; enabled: boolean };
export async function listTools() { return apiRequest<ToolDefinition[]>("/tools"); }
export async function createTool(input: ToolInput) { return apiRequest<ToolDefinition>("/tools", { method: "POST", body: JSON.stringify(input) }); }
export async function updateTool(id: string, input: Partial<ToolInput>) { return apiRequest<ToolDefinition>(`/tools/${id}`, { method: "PATCH", body: JSON.stringify(input) }); }
export async function deleteTool(id: string) { return apiRequest<void>(`/tools/${id}`, { method: "DELETE" }); }
export async function checkTool(id: string) { return apiRequest<{ status: string; status_code: number }>(`/tools/${id}/health-check`, { method: "POST" }); }
export async function invokeTool(id: string, input: Record<string, unknown>) { return apiRequest<{ status_code: number; body: unknown }>(`/tools/${id}/invoke`, { method: "POST", body: JSON.stringify({ input }) }); }

export type ApiKey = { id: string; name: string; prefix: string; quota_per_day: number | null; last_used_at: string | null; revoked: boolean; created_at: string };
export async function listApiKeys() { return apiRequest<ApiKey[]>("/settings/api-keys"); }
export async function createApiKey(name: string, quota: number | null) { return apiRequest<ApiKey & { secret: string }>("/settings/api-keys", { method: "POST", body: JSON.stringify({ name, quota_per_day: quota }) }); }
export async function revokeApiKey(id: string) { return apiRequest<void>(`/settings/api-keys/${id}`, { method: "DELETE" }); }

export type InsightSummary = {
  knowledge_base_count: number; document_count: number; chunk_count: number; conversation_count: number;
  query_count: number; failed_query_count: number; total_tokens: number; estimated_tokens: number;
  average_total_ms: number | null; p95_total_ms: number | null;
  model_usage: Array<{ provider: string; model_id: string; total_tokens: number | null; call_count: number }>;
};
export async function getInsightSummary() { return apiRequest<InsightSummary>("/insights/summary"); }
export async function importKnowledgeSource(knowledgeBaseId: string, input: { source: "text" | "qa" | "web"; title?: string; content?: string; url?: string; qa_pairs?: Array<{ question: string; answer: string }>; allow_duplicate?: boolean }) {
  return mapDocument(await apiRequest<DocumentWire>(`/knowledge-bases/${knowledgeBaseId}/documents/from-source`, { method: "POST", body: JSON.stringify(input) }));
}
