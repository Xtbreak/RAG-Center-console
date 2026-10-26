"use client";

import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileText,
  Gauge,
  KeyRound,
  Layers3,
  LayoutDashboard,
  ListFilter,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  UsersRound,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  checkProvider,
  createModel,
  createProvider,
  deleteProvider,
  discoverProviderModels,
  getModelDefaults,
  getSession,
  listModels,
  listProviders,
  updateModel,
  updateModelDefaults,
  updateProvider,
  updateSessionRole,
  type DiscoveredModel,
  type ModelDefaults,
} from "./api-client";
import {
  providerPresets,
  roleCopy,
  type DocumentItem,
  type KnowledgeBase,
  type ModelInstance,
  type ModelProvider,
  type ProviderPreset,
  type Role,
} from "./prototype-models";

type ViewKey = "overview" | "knowledge" | "chat" | "models" | "logs";
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

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
  { key: "overview", label: "系统概览", icon: LayoutDashboard, roles: ["admin", "manager"] },
  { key: "knowledge", label: "知识库", icon: Database, roles: ["admin", "manager"] },
  { key: "chat", label: "在线对话", icon: MessageCircle, roles: ["admin", "manager", "user"] },
  { key: "models", label: "模型服务", icon: Bot, roles: ["admin"] },
  { key: "logs", label: "运行日志", icon: Activity, roles: ["admin"] },
];

const titles: Record<ViewKey, { title: string; subtitle: string }> = {
  overview: { title: "系统概览", subtitle: "查看知识处理、模型服务和问答链路的运行状态" },
  knowledge: { title: "知识库", subtitle: "组织企业资料，控制解析、切分和检索质量" },
  chat: { title: "在线对话", subtitle: "系统会自动选择相关知识库，并在回答中标注原始依据" },
  models: { title: "模型服务", subtitle: "管理供应商、模型能力、默认用途和连接状态" },
  logs: { title: "运行日志", subtitle: "检查查询内容、路由结果、Token 消耗和链路耗时" },
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function Button({
  children,
  variant = "secondary",
  icon: Icon,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: LucideIcon;
}) {
  return (
    <button className={cn("button", `button-${variant}`, className)} {...props}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

function StatusBadge({ status, children }: { status: string; children: ReactNode }) {
  return (
    <span className={cn("status-badge", `status-${status}`)}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function Metric({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: LucideIcon }) {
  return (
    <div className="metric-cell">
      <div className="metric-icon" aria-hidden="true"><Icon size={17} /></div>
      <div>
        <p className="metric-label">{label}</p>
        <p className="metric-value">{value}</p>
        <p className="metric-note">{note}</p>
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("empty-state", compact && "empty-state-compact")}>
      <span className="empty-state-icon" aria-hidden="true"><Icon size={24} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = "normal",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: "normal" | "wide";
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, open]);

  if (!open) return null;
  return (
    <div className="dialog-layer">
        <button className="dialog-overlay" onClick={() => onOpenChange(false)} aria-label="关闭弹窗遮罩" />
        <div className={cn("dialog-content", width === "wide" && "dialog-wide")} role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby={description ? "dialog-description" : undefined}>
          <div className="dialog-heading">
            <div>
              <h2 id="dialog-title">{title}</h2>
              {description ? <p id="dialog-description">{description}</p> : null}
            </div>
            <button className="icon-button" aria-label="关闭弹窗" onClick={() => onOpenChange(false)}><X size={18} /></button>
          </div>
          {children}
        </div>
    </div>
  );
}

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
  const current = (pathname.split("/")[1] || "overview") as ViewKey;
  const [role, setRole] = useState<Role>("admin");
  const [roleReady, setRoleReady] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToastState] = useState<{ message: string; tone: "success" | "warning" | "error" } | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documentsByKnowledgeBase, setDocumentsByKnowledgeBase] = useState<Record<string, DocumentItem[]>>({});
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);
  const setToast = (message: string) => setToastState({ message, tone: "success" });
  const setWarningToast = (message: string) => setToastState({ message, tone: "warning" });
  const setErrorToast = (message: string) => setToastState({ message, tone: "error" });

  const allowedNavigation = useMemo(() => navigation.filter((item) => item.roles.includes(role)), [role]);
  const selectedKb = searchParams.get("kb") ?? undefined;

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

  useEffect(() => {
    if (!roleReady) return;
    const allowed = allowedNavigation.some((item) => item.key === current);
    if (!allowed) router.replace(role === "user" ? "/chat" : "/overview");
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
    router.push(nextRole === "user" ? "/chat" : "/overview");
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

  const activeView = titles[current] ? current : "overview";

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
          <div className="service-row"><span>文档队列</span><span className="service-count">0 个任务</span></div>
        </div>
        <button className="role-switch" onClick={() => setRolePickerOpen(true)} aria-haspopup="dialog">
          <span className="avatar">{roleCopy[role].name.slice(0, 1)}</span>
          <span><strong>{roleCopy[role].name}</strong><small>无登录演示模式</small></span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </aside>

      {mobileNav ? <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航遮罩" /> : null}

      <div className="workspace">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>
          <div className="global-search">
            <Search size={17} aria-hidden="true" />
            <label htmlFor="global-search" className="sr-only">搜索知识库、文档或日志</label>
            <input id="global-search" placeholder="搜索知识库、文档或日志" />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-actions">
            <span className="environment"><span aria-hidden="true" />内网环境</span>
            <button className="icon-button" aria-label="系统设置"><Settings2 size={18} /></button>
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>{selectedKb && activeView === "knowledge" ? "知识库详情" : titles[activeView].title}</h1>
              <p>{titles[activeView].subtitle}</p>
            </div>
          </div>

          {activeView === "overview" ? <OverviewView navigate={navigate} knowledgeBaseCount={knowledgeBases.length} providerCount={modelProviders.length} /> : null}
          {activeView === "knowledge" ? <KnowledgeView selectedId={selectedKb} router={router} role={role} setToast={setToast} knowledgeBases={knowledgeBases} setKnowledgeBases={setKnowledgeBases} documentsByKnowledgeBase={documentsByKnowledgeBase} setDocumentsByKnowledgeBase={setDocumentsByKnowledgeBase} /> : null}
          {activeView === "chat" ? <ChatView navigate={navigate} role={role} hasKnowledgeBase={knowledgeBases.length > 0} readyForChat={Object.values(documentsByKnowledgeBase).some((items) => items.some((document) => document.status === "ready"))} /> : null}
          {activeView === "models" ? <ModelsView setToast={setToast} setWarningToast={setWarningToast} setErrorToast={setErrorToast} providers={modelProviders} setProviders={setModelProviders} /> : null}
          {activeView === "logs" ? <LogsView /> : null}
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

function OverviewView({ navigate, knowledgeBaseCount, providerCount }: { navigate: (view: ViewKey) => void; knowledgeBaseCount: number; providerCount: number }) {
  return (
    <div className="content-stack">
      <div className="notice-banner" role="note">
        <ShieldAlert size={18} aria-hidden="true" />
        <div><strong>当前未启用身份认证</strong><span>角色仅用于演示功能边界。接入企业 SSO 前，请勿作为真实权限控制使用。</span></div>
        <button onClick={() => navigate("models")}>查看系统配置<ArrowRight size={15} aria-hidden="true" /></button>
      </div>

      <section className="metric-strip" aria-label="关键指标">
        <Metric label="知识库" value={String(knowledgeBaseCount)} note={knowledgeBaseCount ? "等待导入知识" : "尚未创建"} icon={Database} />
        <Metric label="知识分段" value="0" note="尚未生成" icon={Layers3} />
        <Metric label="今日问答" value="0" note="暂无调用" icon={MessageCircle} />
        <Metric label="平均耗时" value="—" note="暂无数据" icon={Gauge} />
      </section>

      <div className="overview-grid">
        <section className="panel pipeline-panel">
          <div className="panel-heading">
            <div><h2>知识处理轨道</h2><p>查看文件解析、切分和向量化进度</p></div>
            <Button icon={UploadCloud} variant="primary" onClick={() => navigate("knowledge")}>导入知识</Button>
          </div>
          <EmptyState compact icon={UploadCloud} title="暂无处理任务" description="创建知识库并导入文件后，处理进度会显示在这里。" />
        </section>

        <section className="panel model-health">
          <div className="panel-heading compact"><div><h2>模型健康</h2><p>{providerCount ? `${providerCount} 个供应商已配置` : "尚未配置供应商"}</p></div></div>
          <EmptyState compact icon={Bot} title="暂无健康数据" description="配置模型供应商后可执行连接检测。" action={<Button onClick={() => navigate("models")}>配置模型服务</Button>} />
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading compact"><div><h2>最近问答</h2><p>包含自动选库和端到端耗时</p></div></div>
        <EmptyState compact icon={MessageCircle} title="暂无问答记录" description="完成首次在线问答后，调用摘要会显示在这里。" />
      </section>
    </div>
  );
}

function KnowledgeView({
  selectedId,
  router,
  role,
  setToast,
  knowledgeBases,
  setKnowledgeBases,
  documentsByKnowledgeBase,
  setDocumentsByKnowledgeBase,
}: {
  selectedId?: string;
  router: ReturnType<typeof useRouter>;
  role: Role;
  setToast: (message: string) => void;
  knowledgeBases: KnowledgeBase[];
  setKnowledgeBases: (knowledgeBases: KnowledgeBase[]) => void;
  documentsByKnowledgeBase: Record<string, DocumentItem[]>;
  setDocumentsByKnowledgeBase: (documents: Record<string, DocumentItem[]>) => void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"documents" | "chunks" | "retrieval" | "settings">("documents");
  const kb = knowledgeBases.find((item) => item.id === selectedId);
  const kbDocuments = kb ? documentsByKnowledgeBase[kb.id] ?? [] : [];

  const addDocument = (document: DocumentItem) => {
    if (!kb) return;
    const currentDocuments = documentsByKnowledgeBase[kb.id] ?? [];
    setDocumentsByKnowledgeBase({ ...documentsByKnowledgeBase, [kb.id]: [...currentDocuments, document] });
    setKnowledgeBases(knowledgeBases.map((item) => item.id === kb.id ? { ...item, documents: item.documents + 1, status: "processing", updatedAt: "刚刚" } : item));
  };

  if (kb) {
    return (
      <div className="content-stack">
        <button className="back-link" onClick={() => router.push("/knowledge")}><ArrowLeft size={16} />返回知识库</button>
        <section className="kb-hero">
          <div className="kb-symbol"><BookOpen size={22} /></div>
          <div className="kb-hero-copy"><div className="title-line"><h2>{kb.name}</h2><StatusBadge status={kb.status === "ready" ? "success" : kb.status === "processing" ? "progress" : "warning"}>{kb.status === "ready" ? "可用" : kb.status === "processing" ? "更新中" : "需检查"}</StatusBadge></div><p>{kb.description}</p><div className="meta-line"><span>{kb.documents} 个文档</span><span>{kb.chunks.toLocaleString()} 个分段</span><span>{kb.model}</span></div></div>
          {role !== "user" ? <Button variant="primary" icon={UploadCloud} onClick={() => setImportOpen(true)}>导入知识</Button> : null}
        </section>
        <div className="tabs" role="tablist" aria-label="知识库详情">
          {(["documents", "chunks", "retrieval", "settings"] as const).map((item) => {
            const labels = { documents: "文档", chunks: "分段", retrieval: "检索测试", settings: "配置" };
            return <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "tab-active" : ""} onClick={() => setTab(item)}>{labels[item]}</button>;
          })}
        </div>
        {tab === "documents" ? <DocumentsPanel documents={kbDocuments} onImport={() => setImportOpen(true)} setToast={setToast} /> : null}
        {tab === "chunks" ? <ChunksPanel /> : null}
        {tab === "retrieval" ? <RetrievalPanel hasDocuments={kbDocuments.some((document) => document.status === "ready")} /> : null}
        {tab === "settings" ? <SettingsPanel kb={kb} setToast={setToast} /> : null}
        <ImportWizard open={importOpen} onOpenChange={setImportOpen} setToast={setToast} onImport={addDocument} />
      </div>
    );
  }

  const filtered = knowledgeBases.filter((item) => `${item.name}${item.description}${item.tags.join("")}`.includes(search));
  return (
    <div className="content-stack">
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><label className="sr-only" htmlFor="kb-search">搜索知识库</label><input id="kb-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、说明或标签" /></div>
        <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button>
      </div>
      {filtered.length ? <div className="kb-list">
        {filtered.map((item) => <KnowledgeRow key={item.id} kb={item} onOpen={() => router.push(`/knowledge?kb=${item.id}`)} />)}
      </div> : null}
      {!filtered.length ? <EmptyState icon={search ? Search : Database} title={search ? "没有匹配的知识库" : "还没有知识库"} description={search ? "请调整搜索关键词。" : "创建知识库后即可导入企业文档。"} action={<Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button>} /> : null}
      <CreateKnowledgeModal open={createOpen} onOpenChange={setCreateOpen} setToast={setToast} onCreate={(created) => { setKnowledgeBases([...knowledgeBases, created]); router.push(`/knowledge?kb=${created.id}`); }} />
    </div>
  );
}

function KnowledgeRow({ kb, onOpen }: { kb: KnowledgeBase; onOpen: () => void }) {
  return (
    <button className="kb-row" onClick={onOpen}>
      <span className="kb-row-icon"><BookOpen size={20} aria-hidden="true" /></span>
      <span className="kb-main"><span className="title-line"><strong>{kb.name}</strong><StatusBadge status={kb.status === "ready" ? "success" : kb.status === "processing" ? "progress" : "warning"}>{kb.status === "ready" ? "可用" : kb.status === "processing" ? "更新中" : "需检查"}</StatusBadge></span><small>{kb.description}</small><span className="tag-line">{kb.tags.map((tag) => <em key={tag}>{tag}</em>)}</span></span>
      <span className="kb-stat"><small>文档</small><strong>{kb.documents}</strong></span>
      <span className="kb-stat"><small>分段</small><strong>{kb.chunks.toLocaleString()}</strong></span>
      <span className="kb-model"><small>Embedding</small><strong>{kb.model}</strong></span>
      <span className="kb-updated"><small>{kb.updatedAt}</small><ChevronRight size={18} aria-hidden="true" /></span>
    </button>
  );
}

function DocumentsPanel({ documents, onImport, setToast }: { documents: DocumentItem[]; onImport: () => void; setToast: (message: string) => void }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading compact"><div><h2>文档</h2><p>原文件、处理状态和可检索分段</p></div><Button icon={UploadCloud} variant="primary" onClick={onImport}>导入文件</Button></div>
      {documents.length ? <div className="data-table" role="table" aria-label="知识库文档">
        <div className="data-row data-header" role="row"><span>文件</span><span>类型</span><span>大小</span><span>分段</span><span>状态</span><span>更新时间</span><span><span className="sr-only">操作</span></span></div>
        {documents.map((document) => (
          <div className="data-row" role="row" key={document.name}>
            <span className="document-name"><span className="file-mini"><FileText size={16} /></span><strong>{document.name}</strong></span><span>{document.type}</span><span className="numeric">{document.size}</span><span className="numeric">{document.chunks || "—"}</span><span><StatusBadge status={document.status === "ready" ? "success" : document.status === "processing" ? "progress" : "error"}>{document.status === "ready" ? "可用" : document.status === "processing" ? "待处理" : "失败"}</StatusBadge></span><span>{document.updatedAt}</span><span><button className="icon-button" aria-label={`更多操作：${document.name}`} onClick={() => setToast(document.status === "failed" ? "已重新提交处理任务" : "后端接入后提供更多操作")}><MoreHorizontal size={17} /></button></span>
          </div>
        ))}
      </div> : <EmptyState compact icon={FileText} title="还没有文档" description="导入文件后，解析状态和分段数量会显示在这里。" action={<Button icon={UploadCloud} onClick={onImport}>导入第一个文件</Button>} />}
    </section>
  );
}

function ChunksPanel() {
  return (
    <section className="panel">
      <div className="panel-heading compact"><div><h2>分段预览</h2><p>文档处理完成后可在此检查和编辑分段</p></div></div>
      <EmptyState compact icon={Layers3} title="还没有知识分段" description="导入文档并完成处理后，分段会显示在这里。" />
    </section>
  );
}

function RetrievalPanel({ hasDocuments }: { hasDocuments: boolean }) {
  const [query, setQuery] = useState("");
  return (
    <div className="retrieval-layout">
      <section className="panel retrieval-query"><h2>测试当前知识库</h2><p>查看向量召回、关键词命中和重排结果。</p><label htmlFor="retrieval-query">测试问题</label><textarea id="retrieval-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入用于验证检索效果的问题" /><div className="form-row"><label><span>召回数量</span><select defaultValue="20"><option>20</option><option>40</option></select></label><label><span>最终引用</span><select defaultValue="5"><option>5</option><option>8</option></select></label></div><Button variant="primary" icon={Zap} disabled={!hasDocuments || !query.trim()}>开始检索</Button>{!hasDocuments ? <p className="form-hint">知识库中暂无可检索文档。</p> : null}</section>
      <section className="panel retrieval-results"><div className="panel-heading compact"><div><h2>召回结果</h2><p>检索完成后显示融合和重排结果</p></div></div><EmptyState compact icon={Search} title="暂无检索结果" description="添加可用文档并输入测试问题后开始检索。" /></section>
    </div>
  );
}

function SettingsPanel({ kb, setToast }: { kb: KnowledgeBase; setToast: (message: string) => void }) {
  return (
    <section className="panel settings-form">
      <div className="panel-heading compact"><div><h2>知识库配置</h2><p>Embedding 模型变更后需要重新构建全部向量</p></div></div>
      <div className="form-grid"><label><span>知识库名称</span><input defaultValue={kb.name} /></label><label><span>Embedding 模型</span><select disabled value=""><option value="">未配置</option></select><small>请先由管理员配置可用的 Embedding 模型。</small></label><label className="wide-field"><span>知识库说明</span><textarea defaultValue={kb.description} /></label><label><span>分段大小</span><input type="number" defaultValue="800" /></label><label><span>分段重叠</span><input type="number" defaultValue="120" /></label></div>
      <div className="form-actions"><Button variant="primary" onClick={() => setToast("配置已保存到当前原型会话")}>保存配置</Button></div>
    </section>
  );
}

function CreateKnowledgeModal({ open, onOpenChange, setToast, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; onCreate: (knowledgeBase: KnowledgeBase) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    const created: KnowledgeBase = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description: description.trim() || "尚未填写知识库说明。",
      status: "warning",
      documents: 0,
      chunks: 0,
      model: "未配置",
      updatedAt: "刚刚",
      tags: [],
    };
    onCreate(created);
    onOpenChange(false);
    setToast(`知识库“${created.name}”已创建`);
    setName("");
    setDescription("");
  };
  return <Modal open={open} onOpenChange={onOpenChange} title="新建知识库" description="创建后可以导入文档并配置独立的向量模型。"><div className="modal-form"><label><span>名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="输入知识库名称" /></label><label><span>说明</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明知识范围，帮助系统自动选库" /></label><label><span>Embedding 模型</span><select disabled value=""><option value="">尚无可用模型</option></select><small>管理员配置模型供应商后可选择。</small></label></div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" onClick={submit} disabled={!name.trim()}>创建知识库</Button></div></Modal>;
}

function ImportWizard({ open, onOpenChange, setToast, onImport }: { open: boolean; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; onImport: (document: DocumentItem) => void }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const close = (next: boolean) => { onOpenChange(next); if (!next) window.setTimeout(() => { setStep(1); setFile(null); }, 150); };
  const finish = () => {
    if (!file) return;
    const extension = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() ?? "FILE" : "FILE";
    const size = file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    onImport({ name: file.name, type: extension, size, chunks: 0, status: "processing", updatedAt: "待处理" });
    close(false);
    setToast("文件已加入当前原型会话，后端接入后执行处理");
  };
  return (
    <Modal open={open} onOpenChange={close} title="导入知识" description="文件将经过云端解析、图片理解、切分和向量化。" width="wide">
      <div className="wizard-steps" aria-label={`当前第 ${step} 步，共 3 步`}>{["选择文件", "解析与切分", "确认任务"].map((label, index) => <div key={label} className={cn(index + 1 < step && "wizard-done", index + 1 === step && "wizard-current")}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}</div>
      {step === 1 ? <div className="wizard-body"><input className="sr-only" id="knowledge-file" type="file" accept=".doc,.docx,.pdf,.md,.png,.jpg,.jpeg,.webp,.tiff,.csv,.xls,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><label className="drop-zone" htmlFor="knowledge-file"><UploadCloud size={26} /><strong>点击选择文件</strong><span>支持 Word、PDF、Markdown、图片、CSV 和 Excel，单文件最大 100 MB</span></label>{file ? <div className="selected-file"><FileText size={18} /><span><strong>{file.name}</strong><small>{file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`} · 等待提交</small></span><button className="icon-button" aria-label="移除文件" onClick={() => setFile(null)}><X size={16} /></button></div> : null}</div> : null}
      {step === 2 ? <div className="wizard-body option-list"><label className="option-card"><input type="radio" name="parse" defaultChecked /><span><strong>智能解析</strong><small>保留标题、表格、页码和图片区域，推荐用于复杂文档。</small></span><Sparkles size={18} /></label><label className="option-card"><input type="radio" name="parse" /><span><strong>快速解析</strong><small>优先提取文本，适合结构简单的数字文档。</small></span><Zap size={18} /></label><div className="switch-row"><span><strong>图片语义描述</strong><small>OCR 后由视觉模型补充流程图和照片语义</small></span><input type="checkbox" defaultChecked aria-label="启用图片语义描述" /></div><div className="form-row"><label><span>分段大小</span><input type="number" defaultValue="800" /></label><label><span>重叠 Token</span><input type="number" defaultValue="120" /></label></div></div> : null}
      {step === 3 ? <div className="wizard-body confirm-grid"><div><span>文件</span><strong>{file?.name}</strong></div><div><span>解析方式</span><strong>智能解析</strong></div><div><span>图片处理</span><strong>OCR + 视觉描述</strong></div><div><span>Embedding</span><strong>未配置</strong></div><div className="privacy-note"><ShieldAlert size={17} /><span>文档内容将发送至阿里云文档智能。请确认文件符合企业数据出域规范。</span></div></div> : null}
      <div className="dialog-actions"><Button onClick={() => step === 1 ? close(false) : setStep(step - 1)}>{step === 1 ? "取消" : "上一步"}</Button><Button variant="primary" onClick={() => step === 3 ? finish() : setStep(step + 1)} disabled={!file}>{step === 3 ? "开始导入" : "下一步"}</Button></div>
    </Modal>
  );
}

function ChatView({ navigate, role, hasKnowledgeBase, readyForChat }: { navigate: (view: ViewKey) => void; role: Role; hasKnowledgeBase: boolean; readyForChat: boolean }) {
  return (
    <div className="chat-layout chat-layout-empty">
      <section className="chat-panel">
        <div className="chat-empty"><div className="chat-orbit"><Sparkles size={24} /></div><h2>{hasKnowledgeBase ? "知识库还没有可检索内容" : "还没有可用于问答的知识库"}</h2><p>{hasKnowledgeBase ? "文档完成解析和向量化后，即可开始在线对话。" : role === "user" ? "请联系知识库管理人员创建知识库并导入资料。" : "先创建知识库并导入企业资料，系统才能自动选库并生成带引用的回答。"}</p>{role !== "user" ? <Button variant="primary" icon={Database} onClick={() => navigate("knowledge")}>{hasKnowledgeBase ? "查看知识库" : "创建知识库"}</Button> : null}</div>
        <div className="composer composer-disabled"><label htmlFor="chat-input" className="sr-only">输入问题</label><textarea id="chat-input" disabled={!readyForChat} placeholder={readyForChat ? "输入问题，系统将自动选择相关知识库" : "知识库可检索后开放输入"} /><div className="composer-footer"><span><Sparkles size={14} />全库自动路由</span><button disabled aria-label="发送问题"><ArrowRight size={18} /></button></div></div>
      </section>
    </div>
  );
}

function ModelsView({ setToast, setWarningToast, setErrorToast, providers, setProviders }: { setToast: (message: string) => void; setWarningToast: (message: string) => void; setErrorToast: (message: string) => void; providers: ModelProvider[]; setProviders: (providers: ModelProvider[]) => void }) {
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
  typeSource: "automatic" | "corrected" | "saved" | "adjusted";
};

function AddProviderModal({ preset, configuredProvider, configuredModels, onOpenChange, setToast, setErrorToast, onSaved }: { preset: ProviderPreset | null; configuredProvider: ModelProvider | null; configuredModels: ModelInstance[]; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; setErrorToast: (message: string) => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OpenAI Chat Completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [step, setStep] = useState<"credentials" | "models">("credentials");
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, ModelSelectionDraft>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualModelId, setManualModelId] = useState("");
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryTruncated, setDiscoveryTruncated] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const allowedModelTypes = supportedModelTypes(preset ?? undefined);

  useEffect(() => {
    if (!preset) return;
    setName(configuredProvider?.name ?? (preset.custom ? "" : preset.name));
    setProtocol(configuredProvider?.defaultProtocol ?? preset.protocolValue);
    setBaseUrl(configuredProvider?.baseUrl ?? preset.baseUrl ?? "");
    setApiKey("");
    setStep("credentials");
    setDiscoveredModels([]);
    setSelectedModels({});
    setSearchQuery("");
    setManualMode(false);
    setManualModelId("");
    setDiscoveryError(null);
    setDiscoveryTruncated(false);
  }, [preset, configuredProvider]);

  const protocolForType = (modelType: ModelInstance["modelType"]) => {
    if (preset?.experimental) return "OpenAI Responses";
    if (modelType === "embedding") return "OpenAI Embeddings";
    if (modelType === "rerank") return "Cohere Rerank";
    if (["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages"].includes(protocol)) return protocol;
    return "OpenAI Chat Completions";
  };

  const draftForModel = (model: DiscoveredModel): ModelSelectionDraft => {
    const existing = configuredModels.find((item) => item.modelId === model.id);
    const inferredType = allowedModelTypes.includes(model.modelType) ? model.modelType : allowedModelTypes[0] ?? "llm";
    const shouldUseInference = !existing || model.typeConfidence !== "low";
    const modelType = shouldUseInference ? inferredType : existing.modelType;
    const corrected = Boolean(existing && existing.modelType !== modelType);
    return {
      id: model.id,
      name: existing?.name ?? model.name ?? model.id,
      modelType,
      protocol: existing && !corrected ? existing.protocol : protocolForType(modelType),
      vectorDimension: existing?.vectorDimension ? String(existing.vectorDimension) : "",
      typeConfidence: existing ? "high" : model.typeConfidence,
      typeSource: corrected ? "corrected" : existing ? "saved" : "automatic",
    };
  };

  const discover = async () => {
    if (!preset || !name.trim() || !baseUrl.trim() || (!configuredProvider && !apiKey.trim())) return;
    setDiscovering(true);
    setDiscoveryError(null);
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
    const model: DiscoveredModel = { id, name: id, modelType: inferred.modelType, typeConfidence: inferred.confidence };
    setDiscoveredModels((current) => current.some((item) => item.id === id) ? current : [...current, model].sort((a, b) => a.id.localeCompare(b.id)));
    setSelectedModels((current) => ({ ...current, [id]: current[id] ?? draftForModel(model) }));
    setManualModelId("");
  };

  const submit = async () => {
    const selections = Object.values(selectedModels);
    if (!preset || !name.trim() || !baseUrl.trim() || (!configuredProvider && !apiKey.trim())) return;
    if (!configuredProvider && selections.length === 0) return;
    if (selections.some((model) => model.modelType === "embedding" && !Number(model.vectorDimension))) return;
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
        if (existing) await updateModel(existing.id, modelInput);
        else await createModel(modelInput);
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
  const visibleModels = filteredModels.slice(0, 100);
  const canDiscover = Boolean(name.trim() && baseUrl.trim() && (configuredProvider || apiKey.trim()));
  const canSave = Boolean(
    name.trim()
    && baseUrl.trim()
    && (configuredProvider || apiKey.trim())
    && (configuredProvider || selections.length > 0)
    && selections.every((model) => model.modelType !== "embedding" || Number(model.vectorDimension) > 0)
  );

  return <Modal open={Boolean(preset)} onOpenChange={onOpenChange} title={configuredProvider ? `重新配置${configuredProvider.name}` : preset?.custom ? "添加自定义供应商" : `配置${preset?.name ?? "供应商"}`} description="填写连接信息后，系统将从供应商实时获取可用模型。" width="wide">
    <div className="provider-setup-progress" aria-label={`配置进度：第 ${step === "credentials" ? 1 : 2} 步，共 2 步`}>
      <span className="is-active"><b>1</b>连接供应商</span>
      <span className={step === "models" ? "is-active" : ""}><b>2</b>选择模型</span>
    </div>
    {step === "credentials" ? <>
      <div className="modal-form">
        <label><span>供应商名称（必填）</span><input autoFocus value={name} readOnly={!preset?.custom} onChange={(event) => setName(event.target.value)} placeholder="输入供应商名称" /></label>
        <label><span>Base URL（必填）</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="供应商 API 地址" /></label>
        <label><span>API Key{configuredProvider ? "（留空则使用已保存密钥）" : "（必填）"}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configuredProvider ? `当前密钥 ${configuredProvider.apiKeyMasked}` : "输入 API Key"} autoComplete="new-password" /></label>
        <label><span>接口协议（必填）</span><select value={protocol} disabled={Boolean(preset?.experimental)} onChange={(event) => setProtocol(event.target.value)}><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>OpenAI Embeddings</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label>
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
      {discoveryTruncated ? <div className="provider-warning" role="status"><ShieldAlert size={15} aria-hidden="true" /><span>供应商仍有更多模型。本次最多显示 500 个，可使用搜索或手动填写模型 ID。</span></div> : null}
      {visibleModels.length ? <div className="model-discovery-list" aria-label="供应商模型列表">
        {visibleModels.map((model) => {
          const draft = selectedModels[model.id];
          const isSaved = configuredModels.some((item) => item.modelId === model.id);
          return <div className={cn("model-discovery-item", draft && "is-selected")} key={model.id}>
            <label className="model-discovery-check"><input type="checkbox" checked={Boolean(draft)} onChange={(event) => toggleModel(model, event.target.checked)} /><span><strong>{model.name}</strong>{model.name !== model.id ? <small>{model.id}</small> : null}</span>{isSaved ? <em>已保存</em> : null}</label>
            {draft ? <div className="model-discovery-config"><div className="model-auto-value"><span>模型类别</span><strong>{modelTypeLabel(draft.modelType)} <small>{draft.typeSource === "saved" ? "已保存配置" : draft.typeSource === "corrected" ? "自动修正" : draft.typeSource === "adjusted" ? "已调整" : draft.typeConfidence === "low" ? "自动归类" : "自动识别"}</small></strong></div><div className="model-auto-value"><span>调用协议</span><strong>{draft.protocol}</strong></div>{draft.modelType === "embedding" ? <label><span>向量维度（必填）</span><input type="number" min="1" value={draft.vectorDimension} onChange={(event) => updateModelDraft(model.id, { vectorDimension: event.target.value })} /></label> : null}<details className="model-advanced-settings"><summary>调整识别结果</summary><div><label><span>模型类别</span><select value={draft.modelType} disabled={allowedModelTypes.length === 1} onChange={(event) => { const modelType = event.target.value as ModelInstance["modelType"]; updateModelDraft(model.id, { modelType, protocol: protocolForType(modelType), vectorDimension: modelType === "embedding" ? draft.vectorDimension : "", typeSource: "adjusted" }); }}>{allowedModelTypes.map((type) => <option key={type} value={type}>{modelTypeLabel(type)}</option>)}</select></label><label><span>调用协议</span><select value={draft.protocol} disabled={Boolean(preset?.experimental)} onChange={(event) => updateModelDraft(model.id, { protocol: event.target.value })}><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>OpenAI Embeddings</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label></div></details></div> : null}
          </div>;
        })}
      </div> : <div className="model-discovery-empty" role="status">{discoveredModels.length ? "没有符合搜索条件的模型。" : "供应商未返回模型，可重新获取或手动填写模型 ID。"}</div>}
      {filteredModels.length > visibleModels.length ? <p className="model-preserve-note" role="status">当前显示前 100 个匹配模型，可继续输入关键词缩小范围。</p> : null}
      {configuredModels.length ? <p className="model-preserve-note">已保存的模型不会因取消勾选或本次未返回而被删除。</p> : null}
      <div className="manual-model-section"><button type="button" className="text-action" onClick={() => setManualMode((current) => !current)} aria-expanded={manualMode}>{manualMode ? "收起手动填写" : "手动填写模型 ID"}</button>{manualMode ? <div className="manual-model-input"><label><span>模型 ID</span><input value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} placeholder="输入供应商公布的模型 ID" /></label><Button onClick={addManualModel} disabled={!manualModelId.trim()}>添加并选中</Button></div> : null}</div>
      <div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button variant="primary" onClick={submit} disabled={!canSave || saving}>{saving ? "保存中…" : "保存配置"}</Button></div>
    </>}
  </Modal>;
}

function AddModelModal({ open, providers, onOpenChange, setToast, setErrorToast, onSaved }: { open: boolean; providers: ModelProvider[]; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; setErrorToast: (message: string) => void; onSaved: () => Promise<void> }) {
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelType, setModelType] = useState<ModelInstance["modelType"]>("llm");
  const [protocol, setProtocol] = useState("OpenAI Chat Completions");
  const [dimension, setDimension] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const selectedPreset = providerPresets.find((preset) => preset.id === selectedProvider?.presetId);
  const allowedModelTypes = supportedModelTypes(selectedPreset);
  useEffect(() => { if (open) { const provider = providers[0]; const preset = providerPresets.find((item) => item.id === provider?.presetId); const initialType = supportedModelTypes(preset)[0] ?? "llm"; setProviderId(provider?.id ?? ""); setModelId(""); setModelType(initialType); setProtocol(provider?.defaultProtocol ?? defaultProtocolForType(initialType)); setDimension(""); } }, [open, providers]);
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
  return <Modal open={open} onOpenChange={onOpenChange} title="添加模型实例" description="同一供应商可以配置多个 LLM、Embedding、Rerank 或视觉模型。"><div className="modal-form"><label><span>供应商</span><select value={providerId} onChange={(event) => { const provider = providers.find((item) => item.id === event.target.value); const preset = providerPresets.find((item) => item.id === provider?.presetId); const initialType = supportedModelTypes(preset)[0] ?? "llm"; setProviderId(event.target.value); setModelType(initialType); setProtocol(provider?.defaultProtocol ?? defaultProtocolForType(initialType)); }}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label><span>模型 ID</span><input autoFocus value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="填写供应商公布的模型 ID" /></label><div className="form-row"><label><span>模型类型</span><select value={modelType} disabled={allowedModelTypes.length === 1} onChange={(event) => { const nextType = event.target.value as ModelInstance["modelType"]; setModelType(nextType); setProtocol(defaultProtocolForType(nextType)); }}>{allowedModelTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label><span>协议</span><select value={protocol} disabled={selectedPreset?.experimental} onChange={(event) => setProtocol(event.target.value)}><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>OpenAI Embeddings</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label></div>{modelType === "embedding" ? <label><span>向量维度</span><input type="number" min="1" value={dimension} onChange={(event) => setDimension(event.target.value)} /></label> : null}</div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button variant="primary" onClick={submit} disabled={saving || !providerId || !modelId.trim() || (modelType === "embedding" && !Number(dimension))}>{saving ? "添加中…" : "添加模型"}</Button></div></Modal>;
}

function LogsView() {
  return (
    <div className="logs-layout logs-layout-empty">
      <section className="panel table-panel logs-table-panel">
        <div className="log-filters"><div className="search-box"><Search size={16} /><input aria-label="搜索查询内容" placeholder="搜索查询内容" disabled /></div><label><span className="sr-only">状态</span><select disabled value="all"><option value="all">全部状态</option></select></label><Button icon={ListFilter} disabled>更多筛选</Button></div>
        <EmptyState icon={Activity} title="还没有查询日志" description="完成在线问答后，查询、路由、Token、耗时和错误记录会显示在这里。" />
      </section>
    </div>
  );
}
