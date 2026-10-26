export type Role = "admin" | "manager" | "user";

export type ChunkMethod = "heading" | "recursive";

export const chunkMethodCopy: Record<ChunkMethod, { name: string; detail: string }> = {
  heading: { name: "按标题切分", detail: "按文档标题划分章节，每节独立成段，过长的章节再递归切分。无 Markdown 标题时自动识别“第一章、一、（一）、1.1”等编号标题。适合制度、手册、规范。" },
  recursive: { name: "递归切分", detail: "依次按段落、换行、句子、标点切分，再合并到目标长度，不受标题边界限制。适合结构不规整的文本。" },
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  embeddingModelId: string;
  embeddingModelName: string;
  vectorDimension: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkMethod: ChunkMethod;
  headingLevel: number;
  status: "ready" | "rebuilding" | "rebuild_failed";
  rebuildError: string | null;
  documentCount: number;
  readyDocumentCount: number;
  processingDocumentCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentStatus =
  | "uploaded"
  | "parsing"
  | "enhancing"
  | "chunking"
  | "embedding"
  | "ready"
  | "partial_failed"
  | "failed"
  | "cancelled";

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  status: DocumentStatus;
  errorMessage: string | null;
  parseStrategy: "smart" | "fast";
  enhanceImages: boolean;
  chunkMethod: ChunkMethod;
  chunkSize: number;
  chunkOverlap: number;
  headingLevel: number;
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
  kind: "text" | "table" | "image";
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
