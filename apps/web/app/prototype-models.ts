export type Role = "admin" | "manager" | "user";

export type ChunkMethod = "heading" | "fixed" | "recursive" | "semantic";

export const chunkMethodCopy: Record<ChunkMethod, { name: string; detail: string }> = {
  heading: { name: "按标题切分", detail: "按文档标题划分章节，每节独立成段，过长的章节再递归切分。无 Markdown 标题时自动识别编号标题。" },
  fixed: { name: "固定切分", detail: "严格按目标 Token 长度硬切分，并保留指定重叠；不按标题、段落或句子调整边界。" },
  recursive: { name: "递归切分", detail: "按你配置的分隔符优先级递归切分，再合并到目标长度，可设置段落、换行、空格和自定义格式。" },
  semantic: { name: "语义切分", detail: "使用当前知识库的 Embedding 比较相邻内容，在语义变化超过阈值或达到长度时分段，会产生额外向量调用。" },
};

export const DEFAULT_CHUNK_SEPARATORS = ["\n\n", "\n", "。", "！", "？", "!", "?", "；", ";", ". ", "，", ",", "、", " "];

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  sampleQuestions: string[];
  embeddingModelId: string;
  embeddingModelName: string;
  vectorDimension: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkMethod: ChunkMethod;
  headingLevel: number;
  separators: string[];
  semanticThreshold: number;
  status: "ready" | "rebuilding" | "rebuild_failed";
  rebuildError: string | null;
  documentCount: number;
  readyDocumentCount: number;
  processingDocumentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ChatRouteSelection = {
  knowledgeBaseId: string;
  name: string;
  score: number;
  reason: string;
};

export type ChatCitation = {
  index: number;
  chunkId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  filename: string;
  content: string;
  location: ChunkLocation;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  route: ChatRouteSelection[];
  status: "completed" | "failed" | string;
  errorMessage: string | null;
  createdAt: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationDetail = ConversationSummary & {
  messages: ChatMessage[];
};

export type RetrievalHit = {
  chunkId: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  filename: string;
  position: number;
  kind: KnowledgeChunk["kind"];
  content: string;
  location: ChunkLocation;
  denseScore: number;
  bm25Score: number;
  rrfScore: number;
  rerankScore: number | null;
};

export type RetrievalTestResult = {
  query: string;
  selectedKnowledgeBases: ChatRouteSelection[];
  hits: RetrievalHit[];
  insufficient: boolean;
  rerankApplied: boolean;
  warnings: string[];
};

export type DocumentStatus =
  | "uploaded"
  | "parsing"
  | "enhancing"
  | "metadata"
  | "chunking"
  | "embedding"
  | "ready"
  | "partial_failed"
  | "failed"
  | "cancelled";

export type DocumentMetadata = {
  dates: string[];
  versions: string[];
  subjects: string[];
  owners: string[];
  keywords: string[];
  questions: string[];
};

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  status: DocumentStatus;
  errorMessage: string | null;
  parseStrategy: "local" | "smart" | "fast";
  enhanceImages: boolean;
  chunkMethod: ChunkMethod;
  chunkSize: number;
  chunkOverlap: number;
  headingLevel: number;
  separators: string[];
  semanticThreshold: number;
  metadata: DocumentMetadata;
  metadataStatus: "pending" | "extracting" | "ready" | "failed" | "skipped";
  metadataError: string | null;
  chunkCount: number;
  jobId: string | null;
  jobStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  jobProgress: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChunkLocation = {
  heading_path?: string[];
  page?: number;
  rows?: [number, number];
  sheet?: string;
  source?: string;
};

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  position: number;
  kind: "text" | "table" | "image" | "metadata";
  content: string;
  tokenCount: number;
  location: ChunkLocation;
  vectorStatus: "pending" | "indexed" | "failed";
  edited: boolean;
  updatedAt: string;
};

export const LOCAL_PARSE_EXTENSIONS = ["md", "csv", "xls", "xlsx"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "tiff"];
export const ACCEPTED_EXTENSIONS = ["doc", "docx", "pdf", "md", "png", "jpg", "jpeg", "webp", "tiff", "csv", "xls", "xlsx"];
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type ModelProvider = {
  id: string;
  presetId: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  defaultProtocol: string;
  modelCount: number;
  health: "untested" | "healthy" | "degraded" | "error";
  lastLatencyMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
};

export type ModelInstance = {
  id: string;
  providerId: string;
  name: string;
  modelId: string;
  modelType: "llm" | "embedding" | "rerank" | "vision";
  protocol: string;
  contextLength: number | null;
  vectorDimension: number | null;
  timeoutSeconds: number;
  enabled: boolean;
};

export type ProviderPreset = {
  id: string;
  name: string;
  protocol: string;
  protocolValue: string;
  capabilities: string[];
  description: string;
  baseUrl?: string;
  experimental?: boolean;
  custom?: boolean;
};

export const providerPresets: ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "OpenAI 兼容",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Vision"],
    description: "聚合多家模型服务，通过统一接口调用。",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "aihubmix",
    name: "AIHubMix",
    protocol: "OpenAI 兼容",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Embedding", "Rerank", "Vision"],
    description: "兼容多类模型能力的聚合服务。",
    baseUrl: "https://aihubmix.com/v1",
  },
  {
    id: "dashscope",
    name: "通义",
    protocol: "OpenAI 兼容 / DashScope",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Embedding", "Rerank", "Vision"],
    description: "接入通义系列生成、向量、重排和视觉模型。",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "OpenAI 兼容",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM"],
    description: "接入 DeepSeek 对话与推理模型。",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    protocol: "OpenAI Responses",
    protocolValue: "OpenAI Responses",
    capabilities: ["LLM"],
    description: "实验性编码模型渠道，不用于向量或重排。",
    baseUrl: "https://api.kimi.com/coding/v1",
    experimental: true,
  },
  {
    id: "custom",
    name: "自定义供应商",
    protocol: "常用兼容协议",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Embedding", "Rerank", "Vision"],
    description: "配置 OpenAI、Anthropic 或 Cohere 兼容服务。",
    custom: true,
  },
];

export const roleCopy: Record<Role, { name: string; detail: string }> = {
  admin: { name: "管理员", detail: "配置模型、管理全部知识库并查看全局日志" },
  manager: { name: "知识库管理人员", detail: "维护文档、分段、索引和检索质量" },
  user: { name: "使用者", detail: "通过企业知识进行问答并核对引用" },
};
