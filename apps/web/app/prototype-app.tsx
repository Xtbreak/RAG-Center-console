"use client";

import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Eye,
  FileSpreadsheet,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  Layers3,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  Menu,
  MessageCircle,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  chunks,
  documents,
  knowledgeBases,
  modelProviders,
  queryLogs,
  roleCopy,
  type KnowledgeBase,
  type Role,
} from "./mock-data";

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
          <div className="service-row"><span>模型网关</span><StatusBadge status="success">正常</StatusBadge></div>
          <div className="service-row"><span>文档队列</span><span className="service-count">3 个任务</span></div>
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
            <StatusBadge status="warning">原型数据</StatusBadge>
          </div>

          {activeView === "overview" ? <OverviewView navigate={navigate} /> : null}
          {activeView === "knowledge" ? <KnowledgeView selectedId={selectedKb} router={router} role={role} setToast={setToast} /> : null}
          {activeView === "chat" ? <ChatView /> : null}
          {activeView === "models" ? <ModelsView setToast={setToast} /> : null}
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

function OverviewView({ navigate }: { navigate: (view: ViewKey) => void }) {
  return (
    <div className="content-stack">
      <div className="notice-banner" role="note">
        <ShieldAlert size={18} aria-hidden="true" />
        <div><strong>当前未启用身份认证</strong><span>角色仅用于演示功能边界。接入企业 SSO 前，请勿作为真实权限控制使用。</span></div>
        <button onClick={() => navigate("models")}>查看系统配置<ArrowRight size={15} aria-hidden="true" /></button>
      </div>

      <section className="metric-strip" aria-label="关键指标">
        <Metric label="知识库" value="3" note="2 个可正常检索" icon={Database} />
        <Metric label="知识分段" value="18,562" note="本周新增 1,248" icon={Layers3} />
        <Metric label="今日问答" value="284" note="成功率 98.6%" icon={MessageCircle} />
        <Metric label="平均耗时" value="2.8 s" note="首 Token 0.72 s" icon={Gauge} />
      </section>

      <div className="overview-grid">
        <section className="panel pipeline-panel">
          <div className="panel-heading">
            <div><h2>知识处理轨道</h2><p>3 个任务正在执行，1 个任务需要处理</p></div>
            <Button icon={UploadCloud} variant="primary" onClick={() => navigate("knowledge")}>导入知识</Button>
          </div>
          <PipelineItem title="办公用品申请流程.docx" meta="产品与交付文档 · 2.1 MB" activeStep={2} progress={46} />
          <PipelineItem title="2026 服务交付白皮书.pdf" meta="产品与交付文档 · 18.7 MB" activeStep={4} progress={86} />
          <PipelineItem title="园区门禁操作图.png" meta="员工制度与行政手册 · 图片理解失败" activeStep={1} progress={18} failed />
        </section>

        <section className="panel model-health">
          <div className="panel-heading compact"><div><h2>模型健康</h2><p>最近一次检测：14:30</p></div><Button variant="ghost" icon={RefreshCw}>重新检测</Button></div>
          <div className="health-score"><div><span>92</span><small>/ 100</small></div><p>5 个渠道中 4 个可用</p></div>
          <div className="health-list">
            <div><span><CheckCircle2 size={15} />通义</span><small>428 ms</small></div>
            <div><span><CheckCircle2 size={15} />DeepSeek</span><small>386 ms</small></div>
            <div className="health-error"><span><AlertCircle size={15} />AIHubMix</span><small>请求超时</small></div>
          </div>
          <Button className="full-button" onClick={() => navigate("models")}>管理模型服务</Button>
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading compact"><div><h2>最近问答</h2><p>包含自动选库和端到端耗时</p></div><Button variant="ghost" onClick={() => navigate("logs")}>查看全部日志</Button></div>
        <div className="compact-table" role="table" aria-label="最近问答">
          <div className="table-row table-header" role="row"><span>查询</span><span>命中知识库</span><span>模型</span><span>Token</span><span>耗时</span></div>
          {queryLogs.slice(0, 3).map((log) => (
            <div className="table-row" role="row" key={log.id}><span className="query-cell">{log.query}</span><span>{log.kb}</span><span>{log.model}</span><span className="numeric">{log.tokens.toLocaleString()}</span><span className="numeric">{log.duration}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PipelineItem({ title, meta, activeStep, progress, failed }: { title: string; meta: string; activeStep: number; progress: number; failed?: boolean }) {
  const steps = ["上传", "解析", "图片理解", "切分", "向量化"];
  return (
    <div className="pipeline-item">
      <div className="pipeline-file">
        <span className={cn("file-glyph", failed && "file-glyph-error")}><FileText size={18} aria-hidden="true" /></span>
        <div><strong>{title}</strong><small>{meta}</small></div>
        <span className="numeric progress-number">{progress}%</span>
      </div>
      <div className="pipeline-track" aria-label={`处理进度 ${progress}%`}>
        {steps.map((step, index) => (
          <div key={step} className={cn("pipeline-step", index < activeStep && "step-done", index === activeStep && (failed ? "step-error" : "step-active"))}>
            <span>{index < activeStep ? <Check size={12} /> : index + 1}</span><small>{step}</small>
          </div>
        ))}
      </div>
      {failed ? <div className="inline-error"><AlertCircle size={15} /><span>视觉模型调用超时，原文件已保留。</span><button>重试图片理解</button></div> : null}
    </div>
  );
}

function KnowledgeView({ selectedId, router, role, setToast }: { selectedId?: string; router: ReturnType<typeof useRouter>; role: Role; setToast: (message: string) => void }) {
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"documents" | "chunks" | "retrieval" | "settings">("documents");
  const [selectedChunk, setSelectedChunk] = useState<(typeof chunks)[number] | null>(null);
  const kb = knowledgeBases.find((item) => item.id === selectedId);

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
        {tab === "documents" ? <DocumentsPanel onImport={() => setImportOpen(true)} setToast={setToast} /> : null}
        {tab === "chunks" ? <ChunksPanel onEdit={setSelectedChunk} /> : null}
        {tab === "retrieval" ? <RetrievalPanel /> : null}
        {tab === "settings" ? <SettingsPanel kb={kb} setToast={setToast} /> : null}
        <ImportWizard open={importOpen} onOpenChange={setImportOpen} setToast={setToast} />
        <ChunkEditor chunk={selectedChunk} onOpenChange={(open) => !open && setSelectedChunk(null)} setToast={setToast} />
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
      <div className="kb-list">
        {filtered.map((item) => <KnowledgeRow key={item.id} kb={item} onOpen={() => router.push(`/knowledge?kb=${item.id}`)} />)}
      </div>
      {!filtered.length ? <div className="empty-state"><Search size={24} /><h2>没有匹配的知识库</h2><p>换一个关键词，或新建知识库后导入资料。</p><Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button></div> : null}
      <CreateKnowledgeModal open={createOpen} onOpenChange={setCreateOpen} setToast={setToast} />
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

function DocumentsPanel({ onImport, setToast }: { onImport: () => void; setToast: (message: string) => void }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading compact"><div><h2>文档</h2><p>原文件、处理状态和可检索分段</p></div><Button icon={UploadCloud} variant="primary" onClick={onImport}>导入文件</Button></div>
      <div className="data-table" role="table" aria-label="知识库文档">
        <div className="data-row data-header" role="row"><span>文件</span><span>类型</span><span>大小</span><span>分段</span><span>状态</span><span>更新时间</span><span><span className="sr-only">操作</span></span></div>
        {documents.map((document) => (
          <div className="data-row" role="row" key={document.name}>
            <span className="document-name"><span className="file-mini"><FileText size={16} /></span><strong>{document.name}</strong></span><span>{document.type}</span><span className="numeric">{document.size}</span><span className="numeric">{document.chunks || "—"}</span><span><StatusBadge status={document.status === "ready" ? "success" : document.status === "processing" ? "progress" : "error"}>{document.status === "ready" ? "可用" : document.status === "processing" ? "解析中" : "失败"}</StatusBadge></span><span>{document.updatedAt}</span><span><button className="icon-button" aria-label={`更多操作：${document.name}`} onClick={() => setToast(document.status === "failed" ? "已重新提交处理任务" : "操作菜单为原型展示")}><MoreHorizontal size={17} /></button></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChunksPanel({ onEdit }: { onEdit: (chunk: (typeof chunks)[number]) => void }) {
  return (
    <section className="panel">
      <div className="panel-heading compact"><div><h2>分段预览</h2><p>编辑内容后将只重新生成受影响的向量</p></div><div className="filter-button"><ListFilter size={15} />按来源筛选</div></div>
      <div className="chunk-list">
        {chunks.map((chunk) => (
          <article className="chunk-card" key={chunk.id}>
            <div className="chunk-meta"><span>{chunk.id}</span><span>{chunk.source}</span><span>{chunk.tokens} tokens</span></div>
            <div className="chunk-body"><div><h3>{chunk.title}</h3><p>{chunk.content}</p></div><button className="icon-button" aria-label={`编辑分段：${chunk.title}`} onClick={() => onEdit(chunk)}><Pencil size={16} /></button></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RetrievalPanel() {
  const [query, setQuery] = useState("年假最多可以结转到什么时候？");
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(true);
  const run = () => {
    setLoading(true); setVisible(false);
    window.setTimeout(() => { setLoading(false); setVisible(true); }, 700);
  };
  return (
    <div className="retrieval-layout">
      <section className="panel retrieval-query"><h2>测试当前知识库</h2><p>查看向量召回、关键词命中和重排结果。</p><label htmlFor="retrieval-query">测试问题</label><textarea id="retrieval-query" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="form-row"><label><span>召回数量</span><select defaultValue="20"><option>20</option><option>40</option></select></label><label><span>最终引用</span><select defaultValue="5"><option>5</option><option>8</option></select></label></div><Button variant="primary" icon={loading ? LoaderCircle : Zap} className={loading ? "is-loading" : ""} onClick={run} disabled={loading || !query.trim()}>{loading ? "检索中" : "开始检索"}</Button></section>
      <section className="panel retrieval-results"><div className="panel-heading compact"><div><h2>召回结果</h2><p>RRF 融合后由 qwen3-rerank 重排</p></div><StatusBadge status="success">186 ms</StatusBadge></div>{visible ? chunks.slice(0, 2).map((chunk, index) => <article className="retrieval-hit" key={chunk.id}><div><span className="rank">{index + 1}</span><div><strong>{chunk.title}</strong><small>{chunk.source}</small></div><span className="score">{index === 0 ? "0.92" : "0.84"}</span></div><p>{chunk.content}</p><div className="score-line"><span style={{ width: index === 0 ? "92%" : "84%" }} /></div></article>) : <div className="skeleton-stack"><span /><span /><span /></div>}</section>
    </div>
  );
}

function SettingsPanel({ kb, setToast }: { kb: KnowledgeBase; setToast: (message: string) => void }) {
  return (
    <section className="panel settings-form">
      <div className="panel-heading compact"><div><h2>知识库配置</h2><p>Embedding 模型变更后需要重新构建全部向量</p></div></div>
      <div className="form-grid"><label><span>知识库名称</span><input defaultValue={kb.name} /></label><label><span>Embedding 模型</span><select defaultValue={kb.model}><option>{kb.model}</option><option>bge-m3</option><option>text-embedding-v4</option></select><small>修改后系统将创建重建任务。</small></label><label className="wide-field"><span>知识库说明</span><textarea defaultValue={kb.description} /></label><label><span>分段大小</span><input type="number" defaultValue="800" /></label><label><span>分段重叠</span><input type="number" defaultValue="120" /></label></div>
      <div className="form-actions"><Button variant="primary" onClick={() => setToast("配置已保存，未触发模型变更")}>保存配置</Button></div>
    </section>
  );
}

function CreateKnowledgeModal({ open, onOpenChange, setToast }: { open: boolean; onOpenChange: (open: boolean) => void; setToast: (message: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => { if (!name.trim()) return; onOpenChange(false); setToast(`知识库“${name}”已创建（原型）`); setName(""); };
  return <Modal open={open} onOpenChange={onOpenChange} title="新建知识库" description="创建后可以导入文档并配置独立的向量模型。"><div className="modal-form"><label><span>名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户服务知识库" /></label><label><span>说明</span><textarea placeholder="说明知识范围，帮助系统自动选库" /></label><label><span>Embedding 模型</span><select defaultValue="qwen3-embedding"><option>qwen3-embedding</option><option>text-embedding-v4</option><option>bge-m3</option></select></label></div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" onClick={submit} disabled={!name.trim()}>创建知识库</Button></div></Modal>;
}

function ImportWizard({ open, onOpenChange, setToast }: { open: boolean; onOpenChange: (open: boolean) => void; setToast: (message: string) => void }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState("员工差旅申请指南.docx");
  const close = (next: boolean) => { onOpenChange(next); if (!next) window.setTimeout(() => setStep(1), 150); };
  const finish = () => { close(false); setToast("导入任务已创建，可在文档列表查看处理进度"); };
  return (
    <Modal open={open} onOpenChange={close} title="导入知识" description="文件将经过云端解析、图片理解、切分和向量化。" width="wide">
      <div className="wizard-steps" aria-label={`当前第 ${step} 步，共 3 步`}>{["选择文件", "解析与切分", "确认任务"].map((label, index) => <div key={label} className={cn(index + 1 < step && "wizard-done", index + 1 === step && "wizard-current")}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}</div>
      {step === 1 ? <div className="wizard-body"><button className="drop-zone" onClick={() => setFile("员工差旅申请指南.docx")}><UploadCloud size={26} /><strong>点击选择文件，或拖放到这里</strong><span>支持 Word、PDF、Markdown、图片、CSV 和 Excel，单文件最大 100 MB</span></button>{file ? <div className="selected-file"><FileText size={18} /><span><strong>{file}</strong><small>2.6 MB · 类型检查通过</small></span><button className="icon-button" aria-label="移除文件" onClick={() => setFile("")}><X size={16} /></button></div> : null}</div> : null}
      {step === 2 ? <div className="wizard-body option-list"><label className="option-card"><input type="radio" name="parse" defaultChecked /><span><strong>智能解析</strong><small>保留标题、表格、页码和图片区域，推荐用于复杂文档。</small></span><Sparkles size={18} /></label><label className="option-card"><input type="radio" name="parse" /><span><strong>快速解析</strong><small>优先提取文本，适合结构简单的数字文档。</small></span><Zap size={18} /></label><div className="switch-row"><span><strong>图片语义描述</strong><small>OCR 后由视觉模型补充流程图和照片语义</small></span><input type="checkbox" defaultChecked aria-label="启用图片语义描述" /></div><div className="form-row"><label><span>分段大小</span><input type="number" defaultValue="800" /></label><label><span>重叠 Token</span><input type="number" defaultValue="120" /></label></div></div> : null}
      {step === 3 ? <div className="wizard-body confirm-grid"><div><span>文件</span><strong>{file}</strong></div><div><span>解析方式</span><strong>智能解析</strong></div><div><span>图片处理</span><strong>OCR + 视觉描述</strong></div><div><span>Embedding</span><strong>qwen3-embedding</strong></div><div className="privacy-note"><ShieldAlert size={17} /><span>文档内容将发送至阿里云文档智能。请确认文件符合企业数据出域规范。</span></div></div> : null}
      <div className="dialog-actions"><Button onClick={() => step === 1 ? close(false) : setStep(step - 1)}>{step === 1 ? "取消" : "上一步"}</Button><Button variant="primary" onClick={() => step === 3 ? finish() : setStep(step + 1)} disabled={!file}>{step === 3 ? "开始导入" : "下一步"}</Button></div>
    </Modal>
  );
}

function ChunkEditor({ chunk, onOpenChange, setToast }: { chunk: (typeof chunks)[number] | null; onOpenChange: (open: boolean) => void; setToast: (message: string) => void }) {
  const [content, setContent] = useState("");
  useEffect(() => { if (chunk) setContent(chunk.content); }, [chunk]);
  return <Modal open={Boolean(chunk)} onOpenChange={onOpenChange} title="编辑知识分段" description={chunk?.source}>{chunk ? <><div className="modal-form"><label><span>分段标题</span><input defaultValue={chunk.title} /></label><label><span>分段内容</span><textarea className="large-textarea" value={content} onChange={(event) => setContent(event.target.value)} /></label><div className="reindex-note"><RefreshCw size={16} /><span>保存后将仅为此分段重新生成向量。</span></div></div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" onClick={() => { onOpenChange(false); setToast("分段已保存，重新向量化任务已创建"); }}>保存并重新向量化</Button></div></> : null}</Modal>;
}

function ChatView() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [answer, setAnswer] = useState("");
  const [citationsOpen, setCitationsOpen] = useState(true);
  const answerRef = useRef("根据《员工休假管理办法 2026》，当年度未使用的年假可以结转至次年第一季度。员工应在结转期限内完成休假申请，具体余额以人力资源平台记录为准。");
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current) window.clearInterval(timerRef.current); }, []);

  const send = () => {
    if (!query.trim() || streaming) return;
    setAsked(true); setStreaming(true); setAnswer("");
    let index = 0;
    timerRef.current = window.setInterval(() => {
      index += 3;
      setAnswer(answerRef.current.slice(0, index));
      if (index >= answerRef.current.length) {
        if (timerRef.current) window.clearInterval(timerRef.current);
        setStreaming(false); setCitationsOpen(true);
      }
    }, 24);
  };

  return (
    <div className="chat-layout">
      <section className="chat-panel">
        {!asked ? <div className="chat-empty"><div className="chat-orbit"><Sparkles size={24} /></div><h2>从企业知识中获得可核对的回答</h2><p>无需手动选择知识库。系统会根据问题自动路由，并展示使用的资料和页码。</p><div className="suggestions">{["年假可以结转到什么时候？", "上海出差住宿标准是多少？", "供应商合同需要哪些审批？"].map((text) => <button key={text} onClick={() => setQuery(text)}>{text}<ArrowRight size={15} /></button>)}</div></div> : <div className="conversation"><div className="message user-message"><span className="message-avatar">我</span><div><p>{query}</p></div></div><div className="routing-card"><div className="routing-title"><Sparkles size={16} /><strong>已自动选择 2 个知识库</strong><span>164 ms</span></div><div className="routing-kbs"><span>员工制度与行政手册 <em>0.94</em></span><span>合规与采购规范 <em>0.61</em></span></div></div><div className="message assistant-message"><span className="message-avatar"><Bot size={16} /></span><div><p>{answer}{streaming ? <span className="stream-cursor" aria-label="正在生成" /> : null}</p>{!streaming && answer ? <div className="answer-footer"><button onClick={() => setCitationsOpen(!citationsOpen)}><PanelRightOpen size={15} />查看 2 条引用</button><span>qwen3.7-plus · 1,842 tokens · 2.84 s</span></div> : null}</div></div></div>}
        <div className="composer"><label htmlFor="chat-input" className="sr-only">输入问题</label><textarea id="chat-input" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="输入问题，系统将自动选择相关知识库" /><div className="composer-footer"><span><Sparkles size={14} />全库自动路由</span><button onClick={send} disabled={!query.trim() || streaming} aria-label="发送问题"><ArrowRight size={18} /></button></div></div>
      </section>
      {asked && citationsOpen ? <aside className="citation-panel" aria-label="回答引用"><div className="citation-heading"><div><h2>回答依据</h2><p>按重排结果展示</p></div><button className="icon-button" onClick={() => setCitationsOpen(false)} aria-label="关闭引用"><X size={17} /></button></div><div className="citation-item"><div><span className="citation-rank">1</span><strong>年假余额与结转</strong><span className="score">0.92</span></div><small>员工休假管理办法 2026.pdf · 第 6 页</small><p>当年度未使用的年假可结转至次年第一季度……</p><button><Eye size={14} />查看原文</button></div><div className="citation-item"><div><span className="citation-rank">2</span><strong>年假申请与审批</strong><span className="score">0.84</span></div><small>员工休假管理办法 2026.pdf · 第 6 页</small><p>员工应至少提前 3 个工作日发起年假申请……</p><button><Eye size={14} />查看原文</button></div><div className="route-detail"><h3>路由与检索</h3><dl><div><dt>候选知识库</dt><dd>3</dd></div><div><dt>最终选库</dt><dd>2</dd></div><div><dt>初始召回</dt><dd>40</dd></div><div><dt>最终引用</dt><dd>2</dd></div></dl></div></aside> : null}
    </div>
  );
}

function ModelsView({ setToast }: { setToast: (message: string) => void }) {
  const [testing, setTesting] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const test = (name: string) => { setTesting(name); window.setTimeout(() => { setTesting(null); setToast(`${name} 连接检测完成`); }, 900); };
  return (
    <div className="content-stack">
      <div className="toolbar"><div className="toolbar-note"><KeyRound size={17} /><span>密钥加密保存，页面和日志只显示掩码。</span></div><Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>添加供应商</Button></div>
      <div className="provider-grid">
        {modelProviders.map((provider) => <article className="provider-card" key={provider.name}><div className="provider-top"><div className="provider-logo">{provider.name.slice(0, 2)}</div><div><h2>{provider.name}</h2><p>{provider.protocol}</p></div><StatusBadge status={provider.health === "healthy" ? "success" : provider.health === "experimental" ? "warning" : "error"}>{provider.health === "healthy" ? "正常" : provider.health === "experimental" ? "实验性" : "异常"}</StatusBadge></div><div className="provider-capability">{provider.usage.split(" · ").map((item) => <span key={item}>{item}</span>)}</div><dl className="provider-stats"><div><dt>模型实例</dt><dd>{provider.models}</dd></div><div><dt>最近延迟</dt><dd>{provider.latency}</dd></div></dl>{provider.health === "experimental" ? <div className="provider-warning"><AlertCircle size={15} />面向编码工具；普通问答需单独验证。</div> : null}<div className="provider-actions"><Button icon={testing === provider.name ? LoaderCircle : Activity} className={testing === provider.name ? "is-loading" : ""} onClick={() => test(provider.name)} disabled={testing === provider.name}>{testing === provider.name ? "检测中" : "检测连接"}</Button><Button variant="ghost">配置</Button></div></article>)}
      </div>
      <section className="panel defaults-panel"><div className="panel-heading compact"><div><h2>系统默认模型</h2><p>知识库仍可绑定自己的 Embedding 模型</p></div></div><div className="defaults-grid"><label><span>路由 Embedding</span><select defaultValue="qwen3-embedding"><option>qwen3-embedding</option></select></label><label><span>路由 LLM</span><select defaultValue="deepseek-flash"><option>deepseek-flash</option></select></label><label><span>默认 Rerank</span><select defaultValue="qwen3-rerank"><option>qwen3-rerank</option></select></label><label><span>视觉模型</span><select defaultValue="qwen3-vl-plus"><option>qwen3-vl-plus</option></select></label></div></section>
      <AddProviderModal open={addOpen} onOpenChange={setAddOpen} setToast={setToast} />
    </div>
  );
}

function AddProviderModal({ open, onOpenChange, setToast }: { open: boolean; onOpenChange: (open: boolean) => void; setToast: (message: string) => void }) {
  const [name, setName] = useState("自定义 OpenAI 服务");
  return <Modal open={open} onOpenChange={onOpenChange} title="添加模型供应商" description="保存前将执行连接检测，密钥不会写入前端日志。"><div className="modal-form"><label><span>供应商名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>协议</span><select defaultValue="OpenAI Chat Completions"><option>OpenAI Chat Completions</option><option>OpenAI Responses</option><option>Anthropic Messages</option><option>Cohere Rerank</option></select></label><label><span>Base URL</span><input defaultValue="https://api.example.com/v1" /></label><label><span>API Key</span><input type="password" defaultValue="sk-prototype-key" /></label></div><div className="dialog-actions"><Button onClick={() => onOpenChange(false)}>取消</Button><Button variant="primary" onClick={() => { onOpenChange(false); setToast(`${name} 已添加（原型）`); }}>检测并保存</Button></div></Modal>;
}

function LogsView() {
  const [selected, setSelected] = useState<(typeof queryLogs)[number] | null>(queryLogs[0]);
  const [filter, setFilter] = useState("all");
  const visible = queryLogs.filter((item) => filter === "all" || item.status === filter);
  return (
    <div className="logs-layout">
      <section className="panel table-panel logs-table-panel">
        <div className="log-filters"><div className="search-box"><Search size={16} /><input aria-label="搜索查询内容" placeholder="搜索查询内容" /></div><label><span className="sr-only">状态</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="success">成功</option><option value="error">失败</option></select></label><Button icon={ListFilter}>更多筛选</Button></div>
        <div className="data-table logs-table" role="table" aria-label="查询日志">
          <div className="data-row log-row data-header"><span>时间</span><span>查询</span><span>供应商 / 模型</span><span>Token</span><span>耗时</span><span>状态</span></div>
          {visible.map((log) => <button className={cn("data-row log-row", selected?.id === log.id && "selected-row")} key={log.id} onClick={() => setSelected(log)}><span className="numeric">{log.time}</span><span className="query-cell"><strong>{log.query}</strong><small>{log.kb}</small></span><span><strong>{log.provider}</strong><small>{log.model}</small></span><span className="numeric">{log.tokens.toLocaleString()}</span><span className="numeric">{log.duration}</span><span><StatusBadge status={log.status === "success" ? "success" : "error"}>{log.status === "success" ? "成功" : "失败"}</StatusBadge></span></button>)}
        </div>
      </section>
      {selected ? <aside className="log-detail"><div className="citation-heading"><div><h2>调用详情</h2><p>{selected.id}</p></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="关闭详情"><X size={17} /></button></div><div className="log-summary"><StatusBadge status={selected.status === "success" ? "success" : "error"}>{selected.status === "success" ? "调用成功" : "调用失败"}</StatusBadge><span>{selected.time}</span></div><section><h3>查询</h3><p>{selected.query}</p></section><section><h3>回答</h3><p>{selected.answer}</p></section><section><h3>自动选库</h3><div className="route-pill"><BookOpen size={14} />{selected.kb}<span>0.94</span></div></section><section><h3>模型调用</h3><dl className="detail-list"><div><dt>供应商</dt><dd>{selected.provider}</dd></div><div><dt>模型</dt><dd>{selected.model}</dd></div><div><dt>输入 Token</dt><dd>{Math.round(selected.tokens * 0.78).toLocaleString()}</dd></div><div><dt>输出 Token</dt><dd>{Math.round(selected.tokens * 0.22).toLocaleString()}</dd></div><div><dt>总耗时</dt><dd>{selected.duration}</dd></div><div><dt>计量来源</dt><dd>供应商 usage</dd></div></dl></section>{selected.status === "error" ? <div className="inline-error"><AlertCircle size={15} /><span>上游请求在 30 秒后超时。</span><button>使用相同输入重试</button></div> : null}</aside> : null}
    </div>
  );
}
