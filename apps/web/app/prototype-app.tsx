"use client";

import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  Gauge,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Menu,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "./chat-view";
import { KnowledgeView } from "./knowledge-views";
import { LogsView } from "./logs-view";
import { ObservabilityView } from "./observability-view";
import { AgentsView, InsightsView, SettingsView, ToolsView, WorkbenchView } from "./product-views";
import {
  checkProvider,
  createModel,
  createProvider,
  deleteProvider,
  discoverProviderModels,
  getModelDefaults,
  getQueryLogStats,
  getSession,
  listKnowledgeBases,
  listAgents,
  type AgentApp,
  listModels,
  listProviders,
  listQueryLogs,
  type QueryLogSummary,
  updateModel,
  updateModelDefaults,
  updateProvider,
  updateSessionRole,
  type DiscoveredModel,
  type ModelDefaults,
} from "./api-client";
import { Button, EmptyState, Metric, Modal, StatusBadge, cn } from "./ui";
import {
  providerPresets,
  roleCopy,
  type KnowledgeBase,
  type ModelInstance,
  type ModelProvider,
  type ProviderPreset,
  type Role,
} from "./prototype-models";

type ViewKey = "workbench" | "apps" | "knowledge" | "chat" | "tools" | "insights" | "observability" | "settings" | "logs";

const capabilityModelTypes: Record<string, ModelInstance["modelType"]> = {
  LLM: "llm",
  Embedding: "embedding",
  Rerank: "rerank",
  Vision: "vision",
};

function supportedModelTypes(preset: ProviderPreset | undefined): ModelInstance["modelType"][] {
  return preset?.capabilities.map((capability) => capabilityModelTypes[capability]).filter(Boolean) ?? ["llm", "embedding", "rerank", "vision"];
}

function defaultProtocolForType(modelType: ModelInstance["modelType"]) {
  if (modelType === "embedding") return "OpenAI Embeddings";
  if (modelType === "rerank") return "Cohere Rerank";
  return "OpenAI Chat Completions";
}

function isDashScopeMultimodalEmbedding(modelId: string) {
  const normalized = modelId.toLocaleLowerCase();
  return normalized.includes("vl-embedding") || normalized.includes("multimodal-embedding") || normalized.includes("embedding-vision");
}

function protocolForProviderModel(preset: ProviderPreset | undefined, modelType: ModelInstance["modelType"], modelId: string, fallbackProtocol: string) {
  if (preset?.id === "kimi-code") return "OpenAI Responses";
  if (preset?.id === "dashscope") {
    if (modelType === "embedding") return isDashScopeMultimodalEmbedding(modelId) ? "DashScope Multimodal Embeddings" : "DashScope Text Embeddings";
    if (modelType === "rerank") return "DashScope Rerank";
    return "OpenAI Chat Completions";
  }
  if (modelType === "embedding") return "OpenAI Embeddings";
  if (modelType === "rerank") return "Cohere Rerank";
  if (preset && !preset.custom) return preset.protocolValue;
  if (["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages"].includes(fallbackProtocol)) return fallbackProtocol;
  return "OpenAI Chat Completions";
}

function modelTypeLabel(modelType: ModelInstance["modelType"]) {
  return { llm: "LLM", embedding: "Embedding", rerank: "Rerank", vision: "Vision" }[modelType];
}

function inferModelTypeFromId(modelId: string): { modelType: ModelInstance["modelType"]; confidence: "medium" | "low" } {
  const normalized = modelId.toLocaleLowerCase().replaceAll("_", "-");
  if (["rerank", "re-rank", "reranker", "ranking"].some((keyword) => normalized.includes(keyword))) return { modelType: "rerank", confidence: "medium" };
  if (["embedding", "embeddings", "embed-", "-embed", "text2vec", "bge-", "/bge", "gte-", "/gte", "e5-", "/e5", "m3e"].some((keyword) => normalized.includes(keyword))) return { modelType: "embedding", confidence: "medium" };
  if (["vision", "visual", "multimodal", "-vl", "/vl", "vl-", "llava"].some((keyword) => normalized.includes(keyword))) return { modelType: "vision", confidence: "medium" };
  return { modelType: "llm", confidence: "low" };
}

const navigation: Array<{ key: ViewKey; label: string; icon: LucideIcon; roles: Role[] }> = [
  { key: "workbench", label: "工作台", icon: LayoutDashboard, roles: ["admin", "manager"] },
  { key: "apps", label: "应用", icon: Bot, roles: ["admin", "manager"] },
  { key: "knowledge", label: "知识库", icon: Database, roles: ["admin", "manager"] },
  { key: "chat", label: "对话", icon: MessageCircle, roles: ["admin", "manager", "user"] },
  { key: "tools", label: "工具", icon: KeyRound, roles: ["admin", "manager"] },
  { key: "insights", label: "洞察", icon: Gauge, roles: ["admin", "manager"] },
  { key: "observability", label: "观测", icon: Activity, roles: ["admin"] },
  { key: "settings", label: "设置", icon: Settings2, roles: ["admin", "manager"] },
];

const titles: Record<ViewKey, { title: string; subtitle: string }> = {
  workbench: { title: "工作台", subtitle: "管理知识资产，构建可使用的企业应用" },
  apps: { title: "应用", subtitle: "配置提示词、知识库和对话发布状态" },
  knowledge: { title: "知识库", subtitle: "组织企业资料，控制解析、切分和检索质量" },
  chat: { title: "应用对话", subtitle: "基于已发布应用和企业知识回答问题" },
  tools: { title: "工具与模型", subtitle: "统一管理应用可用的模型和工具" },
  insights: { title: "数据洞察", subtitle: "查看知识资产、问答质量与评测标注" },
  observability: { title: "观测中心", subtitle: "追踪 Agent、知识构建、工具调用、对话和估算费用" },
  settings: { title: "设置", subtitle: "管理外观、访问边界和 API 密钥" },
  logs: { title: "运行日志", subtitle: "检查查询内容、路由结果、Token 消耗和链路耗时" },
};

function RolePicker({
  open,
  required,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  required: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (role: Role) => void;
}) {
  useEffect(() => {
    if (!open || required) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open, required]);

  if (!open) return null;
  return (
    <div className="dialog-layer">
        <button className="dialog-overlay role-overlay" onClick={() => !required && onOpenChange(false)} aria-label="关闭角色选择" />
        <div className="dialog-content role-dialog" role="dialog" aria-modal="true" aria-labelledby="role-title" aria-describedby="role-description">
          <div className="role-mark" aria-hidden="true"><Layers3 size={22} /></div>
          <h2 id="role-title">选择本次使用角色</h2>
          <p id="role-description">
            1.0 暂不登录。角色用于演示页面和功能边界，不构成真实权限认证。
          </p>
          <div className="role-options">
            {(Object.keys(roleCopy) as Role[]).map((role) => {
              const icons: Record<Role, LucideIcon> = { admin: ShieldAlert, manager: BookOpen, user: UsersRound };
              const Icon = icons[role];
              return (
                <button key={role} className="role-option" onClick={() => onSelect(role)}>
                  <span className="role-option-icon"><Icon size={20} aria-hidden="true" /></span>
                  <span>
                    <strong>{roleCopy[role].name}</strong>
                    <small>{roleCopy[role].detail}</small>
                  </span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {!required ? (
            <Button className="role-cancel" onClick={() => onOpenChange(false)}>取消</Button>
          ) : null}
        </div>
    </div>
  );
}

export function PrototypeApp() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = (pathname.split("/")[1] || "workbench") as ViewKey;
  const [role, setRole] = useState<Role>("admin");
  const [roleReady, setRoleReady] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToastState] = useState<{ message: string; tone: "success" | "warning" | "error" } | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeBasesLoaded, setKnowledgeBasesLoaded] = useState(false);
  const [knowledgeBasesError, setKnowledgeBasesError] = useState<string | null>(null);
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);
  const [agents, setAgents] = useState<AgentApp[]>([]);
  const selectedId = pathname.split("/")[2] || undefined;
  const [logStats, setLogStats] = useState<{ todayCount: number; averageTotalMs: number | null } | null>(null);
  const [recentLogs, setRecentLogs] = useState<QueryLogSummary[]>([]);
  const setToast = (message: string) => setToastState({ message, tone: "success" });
  const setWarningToast = (message: string) => setToastState({ message, tone: "warning" });
  const setErrorToast = (message: string) => setToastState({ message, tone: "error" });

  const allowedNavigation = useMemo(() => navigation.filter((item) => item.roles.includes(role)), [role]);
  const selectedKb = current === "knowledge" ? selectedId : searchParams.get("kb") ?? undefined;

  useEffect(() => {
    if (!roleReady) return;
    listAgents().then(setAgents).catch(() => setAgents([]));
  }, [current, roleReady, role]);

  useEffect(() => {
    const stored = window.localStorage.getItem("rag-role") as Role | null;
    if (stored && roleCopy[stored]) setRole(stored);
    getSession()
      .then((session) => {
        if (stored && roleCopy[stored]) {
          setRole(stored);
          if (session.role !== stored) return updateSessionRole(stored);
        } else {
          setRole(session.role);
          setRolePickerOpen(true);
        }
      })
      .catch((error) => setErrorToast(error instanceof Error ? error.message : "匿名会话初始化失败"))
      .finally(() => setRoleReady(true));
    listProviders().then(setModelProviders).catch(() => undefined);
  }, []);

  const refreshKnowledgeBases = useCallback(async () => {
    try {
      setKnowledgeBases(await listKnowledgeBases());
      setKnowledgeBasesError(null);
    } catch (error) {
      setKnowledgeBasesError(error instanceof Error ? error.message : "知识库加载失败");
    } finally {
      setKnowledgeBasesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (roleReady) void refreshKnowledgeBases();
  }, [refreshKnowledgeBases, role, roleReady]);

  useEffect(() => {
    if (!roleReady || role !== "admin") {
      setLogStats(null);
      setRecentLogs([]);
      return;
    }
    Promise.all([getQueryLogStats(), listQueryLogs({ offset: 0, limit: 3 })])
      .then(([stats, recent]) => { setLogStats(stats); setRecentLogs(recent.items); })
      .catch(() => { setLogStats(null); setRecentLogs([]); });
  }, [current, role, roleReady]);

  useEffect(() => {
    if (!roleReady) return;
    const allowed = allowedNavigation.some((item) => item.key === current);
    if (!allowed) router.replace(role === "user" ? "/chat" : "/workbench");
  }, [allowedNavigation, current, role, roleReady, router]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToastState(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const chooseRole = async (nextRole: Role) => {
    setRole(nextRole);
    window.localStorage.setItem("rag-role", nextRole);
    setRolePickerOpen(false);
    setMobileNav(false);
    router.push(nextRole === "user" ? "/chat" : "/workbench");
    try {
      await updateSessionRole(nextRole);
      setToast(`已切换为${roleCopy[nextRole].name}`);
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "角色保存失败");
    }
  };

  const navigate = (view: ViewKey) => {
    router.push(`/${view}`);
    setMobileNav(false);
  };

  const activeView = titles[current] ? current : "workbench";
  const processingDocumentCount = knowledgeBases.reduce((total, kb) => total + kb.processingDocumentCount, 0);
  const chunkCount = knowledgeBases.reduce((total, kb) => total + kb.chunkCount, 0);

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <aside className={cn("sidebar", mobileNav && "sidebar-open")} aria-label="主导航">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><Layers3 size={19} /></div>
          <div><strong>知枢</strong><small>企业知识库中台</small></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button>
        </div>
        <nav className="nav-list">
          {allowedNavigation.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.key;
            return (
              <button key={item.key} className={cn("nav-item", active && "nav-active")} onClick={() => navigate(item.key)} aria-current={active ? "page" : undefined}>
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <div className="sidebar-status-title"><CircleDot size={14} aria-hidden="true" /><span>系统状态</span></div>
          <div className="service-row"><span>模型网关</span><StatusBadge status={modelProviders.length ? "success" : "warning"}>{modelProviders.length ? "已配置" : "未配置"}</StatusBadge></div>
          <div className="service-row"><span>文档队列</span><span className="service-count">{processingDocumentCount} 个任务</span></div>
        </div>
        <button className="role-switch" onClick={() => setRolePickerOpen(true)} aria-haspopup="dialog">
          <span className="avatar">{roleCopy[role].name.slice(0, 1)}</span>
          <span><strong>{roleCopy[role].name}</strong><small>无登录演示模式</small></span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </aside>

      {mobileNav ? <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航遮罩" /> : null}

      <div className="workspace">
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading">
            <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>
            <div>
              <h1>{selectedKb && activeView === "knowledge" ? "知识库详情" : titles[activeView].title}</h1>
              <p>{titles[activeView].subtitle}</p>
            </div>
          </div>

          {!roleReady ? <div className="loading-panel" role="status">正在初始化工作区…</div> : <>
            {activeView === "workbench" ? <WorkbenchView knowledgeBases={knowledgeBases} agents={agents} /> : null}
            {activeView === "apps" ? <AgentsView selectedId={selectedId} knowledgeBases={knowledgeBases} setToast={setToast} setErrorToast={setErrorToast} /> : null}
            {activeView === "knowledge" ? <KnowledgeView selectedId={selectedKb} router={router} role={role} setToast={setToast} knowledgeBases={knowledgeBases} loaded={knowledgeBasesLoaded} loadError={knowledgeBasesError} refreshKnowledgeBases={refreshKnowledgeBases} /> : null}
            {activeView === "chat" ? <ChatView key={selectedId ?? "global"} agent={agents.find((item) => item.id === selectedId)} agents={agents} navigate={navigate} role={role} hasKnowledgeBase={knowledgeBases.length > 0} readyForChat={selectedId ? Boolean(agents.find((item) => item.id === selectedId)?.knowledge_base_ids.length) : knowledgeBases.some((kb) => kb.readyDocumentCount > 0)} sessionReady={roleReady} /> : null}
            {activeView === "tools" ? <ToolsView role={role} setToast={setToast} setWarningToast={setWarningToast} setErrorToast={setErrorToast} providers={modelProviders} setProviders={setModelProviders} /> : null}
            {activeView === "insights" ? <InsightsView /> : null}
            {activeView === "observability" ? <ObservabilityView sessionReady={roleReady} setToast={setToast} setErrorToast={setErrorToast} /> : null}
            {activeView === "settings" ? <SettingsView role={role} setToast={setToast} setErrorToast={setErrorToast} /> : null}
            {activeView === "logs" ? <LogsView sessionReady={roleReady} /> : null}
          </>}
        </main>
      </div>

      <RolePicker open={rolePickerOpen} required={!roleReady || !windowSafeHasRole()} onOpenChange={setRolePickerOpen} onSelect={chooseRole} />
      {toast ? <div className={cn("toast", toast.tone === "warning" && "toast-warning", toast.tone === "error" && "toast-error")} role="status">{toast.tone === "success" ? <CheckCircle2 size={17} aria-hidden="true" /> : <ShieldAlert size={17} aria-hidden="true" />}{toast.message}</div> : null}
    </div>
  );
}

function windowSafeHasRole() {
  if (typeof window === "undefined") return false;
  return Boolean(window.localStorage.getItem("rag-role"));
}

function OverviewView({ navigate, knowledgeBaseCount, chunkCount, processingDocumentCount, providerCount, logStats, recentLogs }: { navigate: (view: ViewKey) => void; knowledgeBaseCount: number; chunkCount: number; processingDocumentCount: number; providerCount: number; logStats: { todayCount: number; averageTotalMs: number | null } | null; recentLogs: QueryLogSummary[] }) {
  return (
    <div className="content-stack">
      <div className="notice-banner" role="note">
        <ShieldAlert size={18} aria-hidden="true" />
        <div><strong>当前未启用身份认证</strong><span>角色仅用于演示功能边界。接入企业 SSO 前，请勿作为真实权限控制使用。</span></div>
        <button onClick={() => navigate("tools")}>查看系统配置<ArrowRight size={15} aria-hidden="true" /></button>
      </div>

      <section className="metric-strip" aria-label="关键指标">
        <Metric label="知识库" value={String(knowledgeBaseCount)} note={knowledgeBaseCount ? `${processingDocumentCount} 个文档处理中` : "尚未创建"} icon={Database} />
        <Metric label="知识分段" value={chunkCount.toLocaleString()} note={chunkCount ? "已切分并向量化" : "尚未生成"} icon={Layers3} />
        <Metric label="今日问答" value={logStats ? String(logStats.todayCount) : "—"} note={logStats ? "真实调用记录" : "仅管理员可查看"} icon={MessageCircle} />
        <Metric label="平均耗时" value={logStats?.averageTotalMs != null ? `${(logStats.averageTotalMs / 1000).toFixed(2)} s` : "—"} note={logStats?.averageTotalMs != null ? "已完成问答" : "暂无数据"} icon={Gauge} />
      </section>

      <div className="workbench-grid">
        <section className="panel pipeline-panel">
          <div className="panel-heading">
            <div><h2>知识处理轨道</h2><p>查看文件解析、切分和向量化进度</p></div>
            <Button icon={UploadCloud} variant="primary" onClick={() => navigate("knowledge")}>导入知识</Button>
          </div>
          <EmptyState compact icon={UploadCloud} title={processingDocumentCount ? `${processingDocumentCount} 个文档处理中` : "暂无处理任务"} description={processingDocumentCount ? "可在对应知识库的文档列表查看各阶段进度。" : "创建知识库并导入文件后，处理进度会显示在这里。"} />
        </section>

        <section className="panel model-health">
          <div className="panel-heading compact"><div><h2>模型健康</h2><p>{providerCount ? `${providerCount} 个供应商已配置` : "尚未配置供应商"}</p></div></div>
          <EmptyState compact icon={Bot} title="暂无健康数据" description="配置模型供应商后可执行连接检测。" action={<Button onClick={() => navigate("tools")}>配置模型服务</Button>} />
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading compact"><div><h2>最近问答</h2><p>包含自动选库和端到端耗时</p></div>{recentLogs.length ? <Button variant="ghost" onClick={() => navigate("logs")}>查看全部<ArrowRight size={14} /></Button> : null}</div>
        {recentLogs.length ? <div className="recent-log-list">{recentLogs.map((log) => <button key={log.id} onClick={() => navigate("logs")}><span><strong>{log.question}</strong><small>{log.route.length ? log.route.map((route) => route.name).join("、") : "未选库"}</small></span><StatusBadge status={log.status === "completed" ? "success" : "error"}>{log.status === "completed" ? "成功" : "失败"}</StatusBadge><span>{log.totalMs === null ? "—" : `${(log.totalMs / 1000).toFixed(2)} s`}</span></button>)}</div> : <EmptyState compact icon={MessageCircle} title={logStats ? "暂无问答记录" : "仅管理员可查看"} description={logStats ? "完成首次在线问答后，调用摘要会显示在这里。" : "知识库管理人员和使用者的全局问答日志保持隔离。"} />}
      </section>
    </div>
  );
}

export function ModelsView({ setToast, setWarningToast, setErrorToast, providers, setProviders }: { setToast: (message: string) => void; setWarningToast: (message: string) => void; setErrorToast: (message: string) => void; providers: ModelProvider[]; setProviders: (providers: ModelProvider[]) => void }) {
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider | null>(null);
  const [models, setModels] = useState<ModelInstance[]>([]);
  const [defaults, setDefaults] = useState<ModelDefaults>({ routing_embedding: null, routing_llm: null, default_rerank: null, vision: null });
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const customPreset = providerPresets.find((preset) => preset.custom)!;

  const refresh = async () => {
    const [nextProviders, nextModels, nextDefaults] = await Promise.all([listProviders(), listModels(), getModelDefaults()]);
    setProviders(nextProviders);
    setModels(nextModels);
    setDefaults(nextDefaults);
  };

  useEffect(() => {
    refresh().catch((error) => setErrorToast(error instanceof Error ? error.message : "模型配置加载失败"));
  }, []);

  const openConfiguration = (preset: ProviderPreset, provider?: ModelProvider) => {
    setSelectedPreset(preset);
    setSelectedProvider(provider ?? null);
  };

  const runHealthCheck = async (provider: ModelProvider) => {
    setCheckingId(provider.id);
    try {
      const result = await checkProvider(provider.id);
      await refresh();
      const message = `${result.status === "healthy" ? "连接检测通过" : "连接部分通过"}，耗时 ${Math.round(result.latency_ms)} ms：${result.message}`;
      if (result.status === "healthy") setToast(message);
      else setWarningToast(message);
    } catch (error) {
      await refresh().catch(() => undefined);
      setErrorToast(error instanceof Error ? error.message : "连接检测失败");
    } finally {
      setCheckingId(null);
    }
  };

  const changeDefault = async (key: keyof ModelDefaults, value: string) => {
    try {
      const next = await updateModelDefaults({ ...defaults, [key]: value || null });
      setDefaults(next);
      setToast("系统默认模型已更新");
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "默认模型更新失败");
    }
  };

  const statusCopy = (provider: ModelProvider | undefined, experimental?: boolean) => {
    if (!provider) return experimental ? { tone: "warning", label: "实验性 · 未配置" } : { tone: "neutral", label: "未配置" };
    if (provider.health === "healthy") return { tone: "success", label: "正常" };
    if (provider.health === "degraded") return { tone: "warning", label: "部分通过" };
    if (provider.health === "error") return { tone: "error", label: "异常" };
    return { tone: "progress", label: "待检测" };
  };

  const defaultFields: Array<{ key: keyof ModelDefaults; label: string; type: ModelInstance["modelType"] }> = [
    { key: "routing_embedding", label: "路由 Embedding", type: "embedding" },
    { key: "routing_llm", label: "路由 LLM", type: "llm" },
    { key: "default_rerank", label: "默认 Rerank", type: "rerank" },
    { key: "vision", label: "视觉模型", type: "vision" },
  ];

  return (
    <div className="content-stack">
      <div className="toolbar"><div className="toolbar-note"><KeyRound size={17} /><span>密钥由后端加密保存，页面与接口只返回掩码。</span></div><Button variant="primary" icon={Plus} onClick={() => openConfiguration(customPreset)}>添加自定义供应商</Button></div>
      <section className="provider-section" aria-labelledby="provider-presets-title">
        <div className="section-heading"><div><h2 id="provider-presets-title">预设供应商</h2><p>配置供应商和首个模型后，可执行真实连接检测。</p></div><span>{providers.length} 个已配置</span></div>
        <div className="provider-grid">
          {providerPresets.map((preset) => {
            const configured = providers.find((provider) => provider.presetId === preset.id);
            const status = statusCopy(configured, preset.experimental);
            return (
              <article className="provider-card provider-preset-card" key={preset.id}>
                <div className="provider-top">
                  <div className="provider-logo">{preset.name.slice(0, 2)}</div>
                  <div><h2>{preset.name}</h2><p>{configured?.defaultProtocol ?? preset.protocol}</p></div>
                  <StatusBadge status={status.tone}>{status.label}</StatusBadge>
                </div>
                <p className="provider-description">{preset.description}</p>
                <div className="provider-capability">{preset.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
                {configured ? <dl className="provider-stats"><div><dt>模型实例</dt><dd>{configured.modelCount}</dd></div><div><dt>最近延迟</dt><dd>{configured.lastLatencyMs === null ? "未检测" : `${Math.round(configured.lastLatencyMs)} ms`}</dd></div></dl> : null}
                {configured?.lastError ? <div className="provider-warning"><ShieldAlert size={15} aria-hidden="true" /><span>{configured.lastError}</span></div> : null}
                <div className="provider-actions"><Button variant={configured ? "secondary" : "primary"} onClick={() => openConfiguration(preset, configured)}>{configured ? "重新配置" : preset.custom ? "添加" : "配置"}</Button>{configured ? <Button icon={Activity} variant="ghost" disabled={checkingId === configured.id || configured.modelCount === 0} onClick={() => runHealthCheck(configured)}>{checkingId === configured.id ? "检测中…" : configured.modelCount ? "检测连接" : "请先配置模型"}</Button> : null}</div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel model-instances-panel"><div className="panel-heading compact"><div><h2>模型实例</h2><p>模型 ID、能力类型和协议用于真实检测与后续 RAG 调用</p></div><Button icon={Plus} onClick={() => setModelModalOpen(true)} disabled={!providers.length}>添加模型</Button></div>{models.length ? <div className="model-instance-list">{models.map((model) => <div className="model-instance-row" key={model.id}><div><strong>{model.name}</strong><span>{model.modelId}</span></div><span className="model-type-tag">{model.modelType}</span><span>{providers.find((provider) => provider.id === model.providerId)?.name ?? "未知供应商"}</span><span>{model.protocol}</span></div>)}</div> : <div className="inline-empty">配置供应商时可同时创建首个模型实例。</div>}</section>

      <section className="panel defaults-panel"><div className="panel-heading compact"><div><h2>系统默认模型</h2><p>知识库仍可绑定自己的 Embedding 模型</p></div></div><div className="defaults-grid">{defaultFields.map((field) => <label key={field.key}><span>{field.label}</span><select value={defaults[field.key] ?? ""} onChange={(event) => changeDefault(field.key, event.target.value)}><option value="">未配置</option>{models.filter((model) => model.modelType === field.type && model.enabled).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>)}</div></section>

      <AddProviderModal preset={selectedPreset} configuredProvider={selectedProvider} configuredModels={selectedProvider ? models.filter((model) => model.providerId === selectedProvider.id) : []} onOpenChange={(open) => { if (!open) { setSelectedPreset(null); setSelectedProvider(null); } }} setToast={setToast} setErrorToast={setErrorToast} onSaved={refresh} />
      <AddModelModal open={modelModalOpen} providers={providers} onOpenChange={setModelModalOpen} setToast={setToast} setErrorToast={setErrorToast} onSaved={refresh} />
    </div>
  );
}

type ModelSelectionDraft = {
  id: string;
  name: string;
  modelType: ModelInstance["modelType"];
  protocol: string;
  vectorDimension: string;
  typeConfidence: "high" | "medium" | "low";
  typeSource: "automatic" | "corrected" | "saved";
};

function AddProviderModal({ preset, configuredProvider, configuredModels, onOpenChange, setToast, setErrorToast, onSaved }: { preset: ProviderPreset | null; configuredProvider: ModelProvider | null; configuredModels: ModelInstance[]; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; setErrorToast: (message: string) => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OpenAI Chat Completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [step, setStep] = useState<"credentials" | "models">("credentials");
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, ModelSelectionDraft>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualModelId, setManualModelId] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryTruncated, setDiscoveryTruncated] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!preset) return;
    setName(configuredProvider?.name ?? (preset.custom ? "" : preset.name));
    setProtocol(configuredProvider?.defaultProtocol ?? preset.protocolValue);
    setBaseUrl(configuredProvider?.baseUrl ?? preset.baseUrl ?? "");
    setApiKey("");
    setStep("credentials");
    setDiscoveredModels([]);
    setSelectedModels({});
    setExpandedGroups({});
    setSearchQuery("");
    setManualMode(false);
    setManualModelId("");
    setDiscoveryError(null);
    setDiscoveryTruncated(false);
    setSaveError(null);
  }, [preset, configuredProvider]);

  const draftForModel = (model: DiscoveredModel): ModelSelectionDraft => {
    const existing = configuredModels.find((item) => item.modelId === model.id);
    const modelType = model.modelType;
    const expectedProtocol = protocolForProviderModel(preset ?? undefined, modelType, model.id, protocol);
    const corrected = Boolean(existing && (existing.modelType !== modelType || existing.protocol !== expectedProtocol));
    return {
      id: model.id,
      name: existing?.name ?? model.name ?? model.id,
      modelType,
      protocol: expectedProtocol,
      vectorDimension: existing?.vectorDimension ? String(existing.vectorDimension) : model.vectorDimension ? String(model.vectorDimension) : "",
      typeConfidence: model.typeConfidence,
      typeSource: corrected ? "corrected" : existing ? "saved" : "automatic",
    };
  };

  const discover = async () => {
    if (!preset || !name.trim() || !baseUrl.trim() || (!configuredProvider && !apiKey.trim())) return;
    setDiscovering(true);
    setDiscoveryError(null);
    setSaveError(null);
    try {
      const result = await discoverProviderModels({
        providerId: configuredProvider?.id,
        presetId: preset.id,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol,
      });
      setDiscoveredModels(result.models);
      setDiscoveryTruncated(result.truncated);
      const existingSelections: Record<string, ModelSelectionDraft> = {};
      result.models.forEach((model) => {
        if (configuredModels.some((item) => item.modelId === model.id)) {
          existingSelections[model.id] = draftForModel(model);
        }
      });
      setSelectedModels(existingSelections);
      setExpandedGroups({});
      setSearchQuery("");
      setManualMode(result.models.length === 0);
      setStep("models");
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : "未能从供应商获取模型列表");
    } finally {
      setDiscovering(false);
    }
  };

  const toggleModel = (model: DiscoveredModel, checked: boolean) => {
    setSaveError(null);
    setSelectedModels((current) => {
      if (checked) return { ...current, [model.id]: draftForModel(model) };
      const next = { ...current };
      delete next[model.id];
      return next;
    });
  };

  const updateModelDraft = (modelId: string, changes: Partial<ModelSelectionDraft>) => {
    setSelectedModels((current) => ({
      ...current,
      [modelId]: { ...current[modelId], ...changes },
    }));
  };

  const addManualModel = () => {
    const id = manualModelId.trim();
    if (!id) return;
    const inferred = inferModelTypeFromId(id);
    const model: DiscoveredModel = { id, name: id, modelType: inferred.modelType, typeConfidence: inferred.confidence, vectorDimension: null };
    setDiscoveredModels((current) => current.some((item) => item.id === id) ? current : [...current, model].sort((a, b) => a.id.localeCompare(b.id)));
    setSelectedModels((current) => ({ ...current, [id]: current[id] ?? draftForModel(model) }));
    setExpandedGroups((current) => ({ ...current, [inferred.modelType]: true }));
    setManualModelId("");
  };

  const submit = async () => {
    const selections = Object.values(selectedModels);
    if (!preset || !name.trim() || !baseUrl.trim() || (!configuredProvider && !apiKey.trim())) return;
    if (!configuredProvider && selections.length === 0) {
      setSaveError("请至少选择一个模型后再保存。");
      return;
    }
    const missingDimension = selections.find((model) => model.modelType === "embedding" && !Number(model.vectorDimension));
    if (missingDimension) {
      setExpandedGroups((current) => ({ ...current, embedding: true }));
      setSaveError(`模型 ${missingDimension.name} 缺少向量维度，请填写后保存。`);
      return;
    }
    setSaveError(null);
    setSaving(true);
    let createdProviderId: string | null = null;
    try {
      const providerInput = { presetId: preset.id, name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), defaultProtocol: protocol };
      const provider = configuredProvider ? await updateProvider(configuredProvider.id, providerInput) : await createProvider(providerInput);
      if (!configuredProvider) createdProviderId = provider.id;
      for (const selection of selections) {
        const existing = configuredModels.find((model) => model.modelId === selection.id && model.modelType === selection.modelType)
          ?? configuredModels.find((model) => model.modelId === selection.id);
        const modelInput = {
          providerId: provider.id,
          name: existing?.name ?? selection.name.slice(0, 120),
          modelId: selection.id,
          modelType: selection.modelType,
          protocol: selection.protocol,
          contextLength: existing?.contextLength ?? null,
          vectorDimension: selection.modelType === "embedding" ? Number(selection.vectorDimension) : null,
          timeoutSeconds: existing?.timeoutSeconds ?? 30,
          enabled: existing?.enabled ?? true,
        };
        try {
          if (existing) await updateModel(existing.id, modelInput);
          else await createModel(modelInput);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "未知错误";
          throw new Error(`模型 ${selection.name} 保存失败：${reason}`);
        }
      }
      await onSaved();
      onOpenChange(false);
      setToast(`${name.trim()} 已保存，共配置 ${selections.length} 个模型`);
    } catch (error) {
      if (createdProviderId) await deleteProvider(createdProviderId).catch(() => undefined);
      await onSaved().catch(() => undefined);
      setErrorToast(error instanceof Error ? error.message : "供应商配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const selections = Object.values(selectedModels);
  const filteredModels = discoveredModels.filter((model) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return !query || model.id.toLocaleLowerCase().includes(query) || model.name.toLocaleLowerCase().includes(query);
  });
  const visibleModels = filteredModels;
  const groupedModels = (["llm", "embedding", "rerank", "vision"] as const).map((modelType) => ({
    modelType,
    models: visibleModels.filter((model) => (selectedModels[model.id]?.modelType ?? model.modelType) === modelType),
  })).filter((group) => group.models.length > 0);
  const canDiscover = Boolean(name.trim() && baseUrl.trim() && (configuredProvider || apiKey.trim()));
  const canSave = Boolean(
    name.trim()
    && baseUrl.trim()
    && (configuredProvider || apiKey.trim())
    && (configuredProvider || selections.length > 0)
  );

  return <Modal open={Boolean(preset)} onOpenChange={onOpenChange} title={configuredProvider ? `重新配置${configuredProvider.name}` : preset?.custom ? "添加自定义供应商" : `配置${preset?.name ?? "供应商"}`} description={preset?.custom ? "填写连接信息后，系统将从供应商实时获取可用模型。" : "系统已内置官方连接配置，填写 API Key 即可获取可用模型。"} width="wide">
    <div className="provider-setup-progress" aria-label={`配置进度：第 ${step === "credentials" ? 1 : 2} 步，共 2 步`}>
      <span className="is-active"><b>1</b>连接供应商</span>
      <span className={step === "models" ? "is-active" : ""}><b>2</b>选择模型</span>
    </div>
    {step === "credentials" ? <>
      <div className="modal-form">
        {preset?.custom ? <>
          <label><span>供应商名称（必填）</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="输入供应商名称" /></label>
          <label><span>Base URL（必填）</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="供应商 API 地址" /></label>
        </> : null}
        <label><span>API Key{configuredProvider ? "（留空则使用已保存密钥）" : "（必填）"}</span><input autoFocus={!preset?.custom} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configuredProvider ? `当前密钥 ${configuredProvider.apiKeyMasked}` : "输入 API Key"} autoComplete="new-password" /></label>
        {preset?.custom ? <label><span>接口协议（必填）</span><select value={protocol} onChange={(event) => setProtocol(event.target.value)}><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>OpenAI Embeddings</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label> : null}
        {preset?.experimental ? <div className="provider-warning"><ShieldAlert size={15} aria-hidden="true" /><span>Kimi Code 会检测普通问答、流式输出和 usage 返回；不用于向量或重排。</span></div> : null}
        {discoveryError ? <div className="model-discovery-error" role="alert"><div><strong>未能获取模型</strong><span>{discoveryError}</span></div><div><Button icon={RefreshCw} onClick={discover} disabled={discovering}>{discovering ? "重新获取中…" : "重新获取"}</Button><Button variant="ghost" onClick={() => { setManualMode(true); setStep("models"); }}>手动填写模型 ID</Button></div></div> : null}
      </div>
      <div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={discovering}>取消</Button><Button variant="primary" onClick={discover} disabled={!canDiscover || discovering}>{discovering ? "正在获取模型…" : "获取模型"}</Button></div>
    </> : <>
      <div className="model-discovery-toolbar">
        <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep("credentials")} disabled={saving}>返回连接信息</Button>
        <span aria-live="polite">已获取 {discoveredModels.length} 个模型，已选择 {selections.length} 个</span>
      </div>
      {discoveredModels.length ? <div className="model-discovery-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索已获取的模型" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索模型 ID 或名称" /></div> : null}
      {discoveryTruncated ? <div className="provider-warning" role="status"><ShieldAlert size={15} aria-hidden="true" /><span>供应商模型目录未能完成全部分页，可重新获取或手动填写模型 ID。</span></div> : null}
      {visibleModels.length ? <div className="model-discovery-list" aria-label="按类别分组的供应商模型">
        {groupedModels.map((group) => {
          const expanded = Boolean(searchQuery.trim()) || Boolean(expandedGroups[group.modelType]);
          const selectedCount = group.models.filter((model) => selectedModels[model.id]).length;
          return <section className="model-discovery-group" key={group.modelType}>
          <h3><button type="button" aria-expanded={expanded} aria-controls={`model-group-${group.modelType}`} onClick={() => setExpandedGroups((current) => ({ ...current, [group.modelType]: !expanded }))}><ChevronRight className={expanded ? "is-expanded" : ""} size={16} aria-hidden="true" /><strong>{modelTypeLabel(group.modelType)}</strong><span>{group.models.length}</span>{selectedCount ? <small>已选 {selectedCount}</small> : null}</button></h3>
          {expanded ? <div className="model-discovery-group-items" id={`model-group-${group.modelType}`}>{group.models.map((model) => {
            const draft = selectedModels[model.id];
            const isSaved = configuredModels.some((item) => item.modelId === model.id);
            return <div className={cn("model-discovery-item", draft && "is-selected")} key={model.id}>
              <label className="model-discovery-check"><input type="checkbox" checked={Boolean(draft)} onChange={(event) => toggleModel(model, event.target.checked)} /><span><strong>{model.name}</strong>{model.name !== model.id ? <small>{model.id}</small> : null}</span>{isSaved ? <em>已保存</em> : null}</label>
              {draft ? <div className="model-discovery-config"><div className="model-auto-value"><span>调用协议</span><strong>{draft.protocol}</strong></div>{draft.modelType === "embedding" ? <label><span>向量维度（必填）</span><input type="number" min="1" value={draft.vectorDimension} onChange={(event) => { updateModelDraft(model.id, { vectorDimension: event.target.value }); setSaveError(null); }} /></label> : null}{draft.typeSource === "corrected" ? <p className="model-correction-note" role="status">保存后将自动纠正类别或协议</p> : null}</div> : null}
            </div>;
          })}</div> : null}
        </section>;
        })}
      </div> : <div className="model-discovery-empty" role="status">{discoveredModels.length ? "没有符合搜索条件的模型。" : "供应商未返回模型，可重新获取或手动填写模型 ID。"}</div>}
      {configuredModels.length ? <p className="model-preserve-note">已保存的模型不会因取消勾选或本次未返回而被删除。</p> : null}
      <div className="manual-model-section"><button type="button" className="text-action" onClick={() => setManualMode((current) => !current)} aria-expanded={manualMode}>{manualMode ? "收起手动填写" : "手动填写模型 ID"}</button>{manualMode ? <div className="manual-model-input"><label><span>模型 ID</span><input value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} placeholder="输入供应商公布的模型 ID" /></label><Button onClick={addManualModel} disabled={!manualModelId.trim()}>添加并选中</Button></div> : null}</div>
      {saveError ? <div className="model-save-error" role="alert"><ShieldAlert size={16} aria-hidden="true" /><span>{saveError}</span></div> : null}
      <div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button variant="primary" onClick={submit} disabled={!canSave || saving}>{saving ? "保存中…" : "保存配置"}</Button></div>
    </>}
  </Modal>;
}

function AddModelModal({ open, providers, onOpenChange, setToast, setErrorToast, onSaved }: { open: boolean; providers: ModelProvider[]; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; setErrorToast: (message: string) => void; onSaved: () => Promise<void> }) {
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [dimension, setDimension] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const selectedPreset = providerPresets.find((preset) => preset.id === selectedProvider?.presetId);
  const inferredType = inferModelTypeFromId(modelId).modelType;
  const modelType = selectedPreset?.experimental ? "llm" : inferredType;
  const protocol = protocolForProviderModel(selectedPreset, modelType, modelId, selectedProvider?.defaultProtocol ?? defaultProtocolForType(modelType));
  useEffect(() => { if (open) { setProviderId(providers[0]?.id ?? ""); setModelId(""); setDimension(""); } }, [open, providers]);
  const submit = async () => {
    if (!providerId || !modelId.trim() || (modelType === "embedding" && !Number(dimension))) return;
    setSaving(true);
    try {
      await createModel({ providerId, name: modelId.trim(), modelId: modelId.trim(), modelType, protocol, contextLength: null, vectorDimension: modelType === "embedding" ? Number(dimension) : null, timeoutSeconds: 30, enabled: true });
      await onSaved();
      onOpenChange(false);
      setToast(`模型 ${modelId.trim()} 已添加`);
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "模型添加失败");
    } finally {
      setSaving(false);
    }
  };
  return <Modal open={open} onOpenChange={onOpenChange} title="添加模型实例" description="输入模型 ID 后，系统自动识别类别并匹配调用协议。"><div className="modal-form"><label><span>供应商</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label><span>模型 ID</span><input autoFocus value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="填写供应商公布的模型 ID" /></label>{modelId.trim() ? <div className="form-row"><div className="model-auto-value"><span>模型类别</span><strong>{modelTypeLabel(modelType)}</strong></div><div className="model-auto-value"><span>调用协议</span><strong>{protocol}</strong></div></div> : null}{modelType === "embedding" && modelId.trim() ? <label><span>向量维度（必填）</span><input type="number" min="1" value={dimension} onChange={(event) => setDimension(event.target.value)} /></label> : null}</div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button variant="primary" onClick={submit} disabled={saving || !providerId || !modelId.trim() || (modelType === "embedding" && !Number(dimension))}>{saving ? "添加中…" : "添加模型"}</Button></div></Modal>;
}
