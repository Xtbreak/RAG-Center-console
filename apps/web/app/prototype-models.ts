export type Role = "admin" | "manager" | "user";

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  status: "ready" | "processing" | "warning";
  documents: number;
  chunks: number;
  model: string;
  updatedAt: string;
  tags: string[];
};

export type DocumentItem = {
  name: string;
  type: string;
  size: string;
  chunks: number;
  status: "ready" | "processing" | "failed";
  updatedAt: string;
};

export type ModelProvider = {
  id: string;
  presetId?: string;
  name: string;
  protocol: string;
  models: number;
  health: "healthy" | "experimental" | "error" | "pending";
  latency: string;
  usage: string;
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
  },
  {
    id: "aihubmix",
    name: "AIHubMix",
    protocol: "OpenAI 兼容",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Embedding", "Rerank", "Vision"],
    description: "兼容多类模型能力的聚合服务。",
  },
  {
    id: "dashscope",
    name: "通义",
    protocol: "OpenAI 兼容 / DashScope",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM", "Embedding", "Rerank", "Vision"],
    description: "接入通义系列生成、向量、重排和视觉模型。",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "OpenAI 兼容",
    protocolValue: "OpenAI Chat Completions",
    capabilities: ["LLM"],
    description: "接入 DeepSeek 对话与推理模型。",
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
