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
  providerPresets,
  roleCopy,
  type DocumentItem,
  type KnowledgeBase,
  type ModelProvider,
  type ProviderPreset,
  type Role,
} from "./prototype-models";

type ViewKey = "overview" | "knowledge" | "chat" | "models" | "logs";
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

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
  const [toast, setToast] = useState<string | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documentsByKnowledgeBase, setDocumentsByKnowledgeBase] = useState<Record<string, DocumentItem[]>>({});
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);

  const allowedNavigation = useMemo(() => navigation.filter((item) => item.roles.includes(role)), [role]);
  const selectedKb = searchParams.get("kb") ?? undefined;

  useEffect(() => {
    const stored = window.localStorage.getItem("rag-role") as Role | null;
    if (stored && roleCopy[stored]) {
      setRole(stored);
    } else {
      setRolePickerOpen(true);
    }
    setRoleReady(true);
  }, []);

  useEffect(() => {
    if (!roleReady) return;
    const allowed = allowedNavigation.some((item) => item.key === current);
    if (!allowed) router.replace(role === "user" ? "/chat" : "/overview");
  }, [allowedNavigation, current, role, roleReady, router]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const chooseRole = (nextRole: Role) => {
    setRole(nextRole);
    window.localStorage.setItem("rag-role", nextRole);
    setRolePickerOpen(false);
    setMobileNav(false);
    router.push(nextRole === "user" ? "/chat" : "/overview");
    setToast(`已切换为${roleCopy[nextRole].name}`);
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
          {activeView === "models" ? <ModelsView setToast={setToast} providers={modelProviders} setProviders={setModelProviders} /> : null}
          {activeView === "logs" ? <LogsView /> : null}
        </main>
      </div>

      <RolePicker open={rolePickerOpen} required={!roleReady || !windowSafeHasRole()} onOpenChange={setRolePickerOpen} onSelect={chooseRole} />
      {toast ? <div className="toast" role="status"><CheckCircle2 size={17} aria-hidden="true" />{toast}</div> : null}
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

function ModelsView({ setToast, providers, setProviders }: { setToast: (message: string) => void; providers: ModelProvider[]; setProviders: (providers: ModelProvider[]) => void }) {
  const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
  const customPreset = providerPresets.find((preset) => preset.custom)!;
  const saveProvider = (provider: ModelProvider) => {
    setProviders([...providers.filter((item) => item.presetId !== provider.presetId), provider]);
  };
  return (
    <div className="content-stack">
      <div className="toolbar"><div className="toolbar-note"><KeyRound size={17} /><span>预设仅提供配置入口，不代表供应商已连接。</span></div><Button variant="primary" icon={Plus} onClick={() => setSelectedPreset(customPreset)}>添加自定义供应商</Button></div>
      <section className="provider-section" aria-labelledby="provider-presets-title">
        <div className="section-heading"><div><h2 id="provider-presets-title">预设供应商</h2><p>选择供应商后填写密钥和服务地址；未配置项不会参与模型调用。</p></div><span>{providers.length} 个已配置</span></div>
        <div className="provider-grid">
          {providerPresets.map((preset) => {
            const configured = providers.find((provider) => provider.presetId === preset.id);
            return (
              <article className="provider-card provider-preset-card" key={preset.id}>
                <div className="provider-top">
                  <div className="provider-logo">{preset.name.slice(0, 2)}</div>
                  <div><h2>{preset.name}</h2><p>{preset.protocol}</p></div>
                  <StatusBadge status={configured ? "success" : preset.experimental ? "warning" : "neutral"}>{configured ? "已配置" : preset.experimental ? "实验性 · 未配置" : "未配置"}</StatusBadge>
                </div>
                <p className="provider-description">{preset.description}</p>
                <div className="provider-capability">{preset.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
                <div className="provider-actions"><Button variant={configured ? "secondary" : "primary"} onClick={() => setSelectedPreset(preset)}>{configured ? "重新配置" : preset.custom ? "添加" : "配置"}</Button>{configured ? <Button icon={Activity} variant="ghost" onClick={() => setToast("后端接入后执行真实连接检测")}>检测连接</Button> : null}</div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="panel defaults-panel"><div className="panel-heading compact"><div><h2>系统默认模型</h2><p>知识库仍可绑定自己的 Embedding 模型</p></div></div><div className="defaults-grid">{["路由 Embedding", "路由 LLM", "默认 Rerank", "视觉模型"].map((label) => <label key={label}><span>{label}</span><select disabled value=""><option value="">未配置</option></select></label>)}</div></section>
      <AddProviderModal preset={selectedPreset} onOpenChange={(open) => !open && setSelectedPreset(null)} setToast={setToast} onAdd={saveProvider} />
    </div>
  );
}

function AddProviderModal({ preset, onOpenChange, setToast, onAdd }: { preset: ProviderPreset | null; onOpenChange: (open: boolean) => void; setToast: (message: string) => void; onAdd: (provider: ModelProvider) => void }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OpenAI Chat Completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (!preset) return;
    setName(preset.custom ? "" : preset.name);
    setProtocol(preset.protocolValue);
    setBaseUrl(preset.baseUrl ?? "");
    setApiKey("");
  }, [preset]);
  const submit = () => {
    if (!preset || !name.trim() || !baseUrl.trim() || !apiKey.trim()) return;
    onAdd({ id: crypto.randomUUID(), presetId: preset.id, name: name.trim(), protocol, models: 0, health: "pending", latency: "未检测", usage: preset.capabilities.join(" · ") });
    onOpenChange(false);
    setToast(`${name.trim()} 已保存到当前原型会话`);
  };
  return <Modal open={Boolean(preset)} onOpenChange={onOpenChange} title={preset?.custom ? "添加自定义供应商" : `配置${preset?.name ?? "供应商"}`} description="当前为前端原型，输入内容只保留在本次浏览器会话中。"><div className="modal-form"><label><span>供应商名称</span><input autoFocus value={name} readOnly={!preset?.custom} onChange={(event) => setName(event.target.value)} placeholder="输入供应商名称" /></label><label><span>协议</span><select value={protocol} onChange={(event) => setProtocol(event.target.value)}><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>OpenAI Embeddings</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label><label><span>Base URL</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="输入 API 地址" /></label><label><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入 API Key" autoComplete="off" /></label>{preset?.experimental ? <div className="provider-warning"><ShieldAlert size={15} aria-hidden="true" /><span>Kimi Code 为实验性 LLM 渠道，需要单独验证普通问答、流式输出和 usage 返回。</span></div> : null}</div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" onClick={submit} disabled={!name.trim() || !baseUrl.trim() || !apiKey.trim()}>保存配置</Button></div></Modal>;
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
