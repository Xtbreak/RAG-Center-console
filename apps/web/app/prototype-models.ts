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
  name: string;
  protocol: string;
  models: number;
  health: "healthy" | "experimental" | "error" | "pending";
  latency: string;
  usage: string;
};

export const roleCopy: Record<Role, { name: string; detail: string }> = {
  admin: { name: "管理员", detail: "配置模型、管理全部知识库并查看全局日志" },
  manager: { name: "知识库管理人员", detail: "维护文档、分段、索引和检索质量" },
  user: { name: "使用者", detail: "通过企业知识进行问答并核对引用" },
};
