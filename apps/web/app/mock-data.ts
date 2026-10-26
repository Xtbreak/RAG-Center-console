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

export const knowledgeBases: KnowledgeBase[] = [
  {
    id: "employee-handbook",
    name: "员工制度与行政手册",
    description: "覆盖考勤、休假、报销、信息安全及常用行政流程。",
    status: "ready",
    documents: 42,
    chunks: 3864,
    model: "qwen3-embedding",
    updatedAt: "10 分钟前",
    tags: ["人事", "行政"],
  },
  {
    id: "product-docs",
    name: "产品与交付文档",
    description: "产品说明、交付标准、常见问题和客户实施手册。",
    status: "processing",
    documents: 128,
    chunks: 12590,
    model: "text-embedding-v4",
    updatedAt: "正在更新",
    tags: ["产品", "交付"],
  },
  {
    id: "compliance",
    name: "合规与采购规范",
    description: "供应商准入、合同审批、采购流程及审计检查表。",
    status: "warning",
    documents: 29,
    chunks: 2108,
    model: "bge-m3",
    updatedAt: "昨天 18:42",
    tags: ["法务", "采购"],
  },
];

export const documents = [
  { name: "员工休假管理办法 2026.pdf", type: "PDF", size: "4.8 MB", chunks: 186, status: "ready", updatedAt: "10 分钟前" },
  { name: "费用报销标准.xlsx", type: "XLSX", size: "820 KB", chunks: 74, status: "ready", updatedAt: "1 小时前" },
  { name: "办公用品申请流程.docx", type: "DOCX", size: "2.1 MB", chunks: 95, status: "processing", updatedAt: "解析中" },
  { name: "园区门禁操作图.png", type: "PNG", size: "1.4 MB", chunks: 0, status: "failed", updatedAt: "3 小时前" },
];

export const chunks = [
  {
    id: "CH-0186",
    title: "年假申请与审批",
    source: "员工休假管理办法 2026.pdf · 第 6 页",
    content: "员工应至少提前 3 个工作日发起年假申请。连续休假超过 5 个工作日时，需要由部门负责人和人力资源负责人共同审批。",
    tokens: 86,
  },
  {
    id: "CH-0187",
    title: "年假余额与结转",
    source: "员工休假管理办法 2026.pdf · 第 6 页",
    content: "当年度未使用的年假可结转至次年第一季度，逾期未使用的部分按照公司制度处理。系统中的余额数据以人力资源平台为准。",
    tokens: 103,
  },
  {
    id: "CH-0241",
    title: "差旅住宿标准",
    source: "费用报销标准.xlsx · 差旅标准表",
    content: "一线城市住宿标准：普通员工 550 元/晚，部门负责人 750 元/晚。超出标准需在报销单中说明原因并补充审批记录。",
    tokens: 94,
  },
];

export const modelProviders = [
  { name: "通义", protocol: "OpenAI / DashScope", models: 6, health: "healthy", latency: "428 ms", usage: "LLM · Embedding · Rerank · Vision" },
  { name: "OpenRouter", protocol: "OpenAI", models: 4, health: "healthy", latency: "612 ms", usage: "LLM · Embedding · Rerank" },
  { name: "DeepSeek", protocol: "OpenAI", models: 2, health: "healthy", latency: "386 ms", usage: "LLM" },
  { name: "Kimi Code", protocol: "OpenAI Responses", models: 1, health: "experimental", latency: "未检测", usage: "LLM · 实验性" },
  { name: "AIHubMix", protocol: "OpenAI", models: 3, health: "error", latency: "超时", usage: "LLM · Embedding" },
];

export const queryLogs = [
  { id: "LOG-10284", query: "年假最多可以结转到什么时候？", answer: "未使用的年假可以结转至次年第一季度。", provider: "通义", model: "qwen3.7-plus", tokens: 1842, duration: "2.84 s", status: "success", time: "14:32:18", kb: "员工制度与行政手册" },
  { id: "LOG-10283", query: "上海出差住宿报销标准是多少？", answer: "普通员工在一线城市的住宿标准为 550 元/晚。", provider: "DeepSeek", model: "deepseek-flash", tokens: 1376, duration: "2.17 s", status: "success", time: "14:29:04", kb: "员工制度与行政手册" },
  { id: "LOG-10282", query: "供应商合同需要谁审批？", answer: "请求在模型生成阶段超时。", provider: "AIHubMix", model: "gemini-2.5-pro", tokens: 612, duration: "30.00 s", status: "error", time: "14:21:56", kb: "合规与采购规范" },
  { id: "LOG-10281", query: "产品交付验收包含哪些材料？", answer: "交付验收通常包含部署记录、测试报告和用户确认单。", provider: "OpenRouter", model: "claude-sonnet", tokens: 2234, duration: "4.62 s", status: "success", time: "14:18:33", kb: "产品与交付文档" },
];

export const roleCopy: Record<Role, { name: string; detail: string }> = {
  admin: { name: "管理员", detail: "配置模型、管理全部知识库并查看全局日志" },
  manager: { name: "知识库管理人员", detail: "维护文档、分段、索引和检索质量" },
  user: { name: "使用者", detail: "通过企业知识进行问答并核对引用" },
};
