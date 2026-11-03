"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Layers3,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  UploadCloud,
  WrapText,
  X,
  Zap,
} from "lucide-react";
import type { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelDocument,
  createKnowledgeBase,
  deleteDocument,
  deleteKnowledgeBase,
  listChunks,
  listDocuments,
  listModels,
  importKnowledgeSource,
  retryDocument,
  testRetrieval,
  updateChunk,
  updateKnowledgeBase,
  uploadDocument,
  type ChunkSettings,
  type KnowledgeBaseInput,
} from "./api-client";
import {
  ACCEPTED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  LOCAL_PARSE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  chunkMethodCopy,
  DEFAULT_CHUNK_SEPARATORS,
  type ChunkMethod,
  type KnowledgeBase,
  type KnowledgeChunk,
  type KnowledgeDocument,
  type ModelInstance,
  type RetrievalTestResult,
  type Role,
} from "./prototype-models";
import { Button, EmptyState, Modal, StatusBadge, cn } from "./ui";

type Router = ReturnType<typeof useRouter>;
type Notify = (message: string) => void;

const POLL_INTERVAL_MS = 2000;
const CHUNK_PAGE_SIZE = 20;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatTime(value: string) {
  // SQLite 返回的时间不带时区，按 UTC 解析
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function extensionOf(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

export function isProcessing(document: KnowledgeDocument) {
  return document.jobStatus === "queued" || document.jobStatus === "running";
}

const stageLabels: Record<string, string> = {
  uploaded: "排队中",
  parsing: "解析中",
  enhancing: "图片增强",
  metadata: "元数据",
  chunking: "切分中",
  embedding: "向量化",
};

function documentStatus(document: KnowledgeDocument): { label: string; tone: string } {
  if (isProcessing(document)) {
    if (document.cancelRequested) return { label: "取消中", tone: "warning" };
    return { label: stageLabels[document.status] ?? "处理中", tone: "progress" };
  }
  return {
    ready: { label: "可用", tone: "success" },
    partial_failed: { label: "部分失败", tone: "warning" },
    failed: { label: "失败", tone: "error" },
    cancelled: { label: "已取消", tone: "neutral" },
  }[document.status as "ready" | "partial_failed" | "failed" | "cancelled"] ?? { label: "待处理", tone: "neutral" };
}

function knowledgeBaseStatus(kb: KnowledgeBase): { label: string; tone: string } {
  if (kb.status === "rebuilding") return { label: "重建中", tone: "progress" };
  if (kb.status === "rebuild_failed") return { label: "重建失败", tone: "error" };
  if (kb.processingDocumentCount) return { label: "处理中", tone: "progress" };
  if (!kb.documentCount) return { label: "待导入", tone: "neutral" };
  if (!kb.readyDocumentCount) return { label: "暂无可用文档", tone: "warning" };
  return { label: "可用", tone: "success" };
}

function useEmbeddingModels(enabled: boolean) {
  const [models, setModels] = useState<ModelInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    listModels()
      .then((items) => alive && setModels(items.filter((item) => item.modelType === "embedding" && item.enabled && item.vectorDimension)))
      .catch((reason) => alive && setError(errorMessage(reason, "无法读取 Embedding 模型")))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [enabled]);
  return { models, loading, error };
}

type ChunkForm = { chunkMethod: ChunkMethod; chunkSize: string; chunkOverlap: string; headingLevel: string; separators: string[]; semanticThreshold: string };

const SEPARATOR_GROUPS = [
  { label: "段落（\\n\\n）", values: ["\n\n"] },
  { label: "换行（\\n）", values: ["\n"] },
  { label: "句末标点", values: ["。", "！", "？", "!", "?"] },
  { label: "句内标点", values: ["；", ";", ". ", "，", ",", "、"] },
  { label: "空格", values: [" "] },
];
const PRESET_SEPARATORS = new Set(SEPARATOR_GROUPS.flatMap((group) => group.values));

function chunkFormFrom(settings: ChunkSettings): ChunkForm {
  return { chunkMethod: settings.chunkMethod, chunkSize: String(settings.chunkSize), chunkOverlap: String(settings.chunkOverlap), headingLevel: String(settings.headingLevel), separators: settings.separators?.length ? settings.separators : DEFAULT_CHUNK_SEPARATORS, semanticThreshold: String(settings.semanticThreshold ?? 0.75) };
}

const DEFAULT_CHUNK_FORM = chunkFormFrom({ chunkMethod: "heading", chunkSize: 800, chunkOverlap: 120, headingLevel: 6, separators: DEFAULT_CHUNK_SEPARATORS, semanticThreshold: 0.75 });

function parseChunkForm(form: ChunkForm): { settings: ChunkSettings; error: string | null } {
  const settings = { chunkMethod: form.chunkMethod, chunkSize: Number(form.chunkSize), chunkOverlap: Number(form.chunkOverlap), headingLevel: Number(form.headingLevel), separators: form.separators, semanticThreshold: Number(form.semanticThreshold) };
  const error = !Number.isInteger(settings.chunkSize) || settings.chunkSize < 100 || settings.chunkSize > 4000 ? "分段大小需为 100–4000 的整数"
    : !Number.isInteger(settings.chunkOverlap) || settings.chunkOverlap < 0 || settings.chunkOverlap > 1000 ? "分段重叠需为 0–1000 的整数"
    : settings.chunkOverlap >= settings.chunkSize ? "分段重叠必须小于分段大小"
    : settings.chunkMethod === "recursive" && (!settings.separators.length || settings.separators.length > 20 || settings.separators.some((item) => !item.length || item.length > 32)) ? "请配置 1–20 个分隔符，每个不超过 32 字符"
    : settings.chunkMethod === "semantic" && (!(settings.semanticThreshold > 0) || settings.semanticThreshold >= 1) ? "语义相似度阈值必须在 0 和 1 之间" : null;
  return { settings, error };
}

function parseTags(value: string) {
  return [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function parseSampleQuestions(value: string) {
  return [...new Set(value.split("\n").map((item) => item.trim()).filter(Boolean))];
}

function routeFieldError(tags: string[], sampleQuestions: string[]) {
  if (tags.length > 20) return "标签最多填写 20 个";
  if (tags.some((item) => item.length > 50)) return "单个标签不能超过 50 个字符";
  if (sampleQuestions.length > 20) return "示例问题最多填写 20 个";
  if (sampleQuestions.some((item) => item.length > 300)) return "单个示例问题不能超过 300 个字符";
  return null;
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function escapeSeparator(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

function customSeparatorText(separators: string[]) {
  return separators.filter((item) => !PRESET_SEPARATORS.has(item)).map(escapeSeparator).join("\n");
}

function parseCustomSeparators(value: string) {
  return value.split("\n").filter((item) => item.length > 0).map((item) => item.replaceAll("\\\\", "\\").replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t"));
}

export function describeChunkSettings(settings: ChunkSettings) {
  const level = settings.chunkMethod === "heading" ? (settings.headingLevel >= 6 ? "（全部标题）" : `（至 H${settings.headingLevel}）`) : settings.chunkMethod === "semantic" ? `（阈值 ${settings.semanticThreshold}）` : settings.chunkMethod === "recursive" ? `（${settings.separators.length} 个分隔符）` : "";
  return `${chunkMethodCopy[settings.chunkMethod].name}${level} · ${settings.chunkSize} Token / 重叠 ${settings.chunkOverlap}`;
}

function ChunkSettingsFields({ id, value, onChange, disabled }: { id: string; value: ChunkForm; onChange: (value: ChunkForm) => void; disabled?: boolean }) {
  const icons: Record<ChunkMethod, typeof ListTree> = { heading: ListTree, fixed: Zap, recursive: WrapText, semantic: Sparkles };
  const custom = value.separators.filter((item) => !PRESET_SEPARATORS.has(item));
  return (
    <fieldset className="chunk-settings" disabled={disabled}>
      <legend>切分方式</legend>
      <div className="chunk-method-options">
        {(Object.keys(chunkMethodCopy) as ChunkMethod[]).map((method) => {
          const Icon = icons[method];
          return <label key={method} className="option-card"><input type="radio" name={`${id}-chunk-method`} checked={value.chunkMethod === method} onChange={() => onChange({ ...value, chunkMethod: method })} /><span><strong>{chunkMethodCopy[method].name}</strong><small>{chunkMethodCopy[method].detail}</small></span><Icon size={18} /></label>;
        })}
      </div>
      <div className="chunk-params">
        {value.chunkMethod === "heading" ? <label><span>切分到标题层级</span><select value={value.headingLevel} onChange={(event) => onChange({ ...value, headingLevel: event.target.value })}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{level === 6 ? "全部标题（H1–H6）" : `第 ${level} 级（H1–H${level}）`}</option>)}</select><small className="field-hint">更深的标题并入所属章节</small></label> : null}
        {value.chunkMethod === "semantic" ? <label><span>语义相似度阈值</span><input type="number" min={0.05} max={0.95} step={0.05} value={value.semanticThreshold} onChange={(event) => onChange({ ...value, semanticThreshold: event.target.value })} /><small className="field-hint">阈值越高，越容易在语义变化处拆分</small></label> : null}
        <label><span>分段大小（Token）</span><input type="number" min={100} max={4000} value={value.chunkSize} onChange={(event) => onChange({ ...value, chunkSize: event.target.value })} /></label>
        <label><span>分段重叠（Token）</span><input type="number" min={0} max={1000} value={value.chunkOverlap} onChange={(event) => onChange({ ...value, chunkOverlap: event.target.value })} /></label>
      </div>
      {value.chunkMethod === "recursive" ? <div className="separator-settings"><span>分隔符优先级</span><div className="separator-presets">{SEPARATOR_GROUPS.map((group) => {
        const checked = group.values.every((item) => value.separators.includes(item));
        return <label key={group.label}><input type="checkbox" checked={checked} onChange={() => onChange({ ...value, separators: checked ? [...SEPARATOR_GROUPS.flatMap((item) => item.values).filter((item) => value.separators.includes(item) && !group.values.includes(item)), ...custom] : [...SEPARATOR_GROUPS.flatMap((item) => item.values).filter((item) => value.separators.includes(item) || group.values.includes(item)), ...custom] })} /><span>{group.label}</span></label>;
      })}</div><label><span>自定义分隔符（每行一个，支持 \\n、\\r、\\t）</span><textarea value={customSeparatorText(value.separators)} onChange={(event) => onChange({ ...value, separators: [...SEPARATOR_GROUPS.flatMap((item) => item.values).filter((item) => value.separators.includes(item)), ...parseCustomSeparators(event.target.value)] })} placeholder={'例如：\\n---\\n'} /></label><small className="field-hint">按上方顺序递归尝试；始终保留按字符硬切分兜底。</small></div> : null}
    </fieldset>
  );
}

function InlineAlert({ tone = "error", title, children, action }: { tone?: "error" | "warning" | "info"; title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn("inline-alert", `inline-alert-${tone}`)} role={tone === "error" ? "alert" : "status"}>
      <ShieldAlert size={16} aria-hidden="true" />
      <div>{title ? <strong>{title}</strong> : null}<span>{children}</span></div>
      {action ? <div className="inline-alert-action">{action}</div> : null}
    </div>
  );
}

function ConfirmDialog({ open, title, description, confirmLabel, busy, error, onConfirm, onOpenChange }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title={title} description={description}>
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      <div className="dialog-actions"><Button onClick={() => onOpenChange(false)} disabled={busy}>取消</Button><Button variant="danger" onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmLabel}</Button></div>
    </Modal>
  );
}

export function KnowledgeView({ selectedId, router, role, knowledgeBases, loaded, loadError, refreshKnowledgeBases, setToast }: {
  selectedId?: string;
  router: Router;
  role: Role;
  knowledgeBases: KnowledgeBase[];
  loaded: boolean;
  loadError: string | null;
  refreshKnowledgeBases: () => Promise<void>;
  setToast: Notify;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  if (selectedId) {
    const kb = knowledgeBases.find((item) => item.id === selectedId);
    if (kb) return <KnowledgeDetail key={kb.id} kb={kb} router={router} refreshKnowledgeBases={refreshKnowledgeBases} setToast={setToast} />;
    return (
      <div className="content-stack">
        <button className="back-link" onClick={() => router.push("/knowledge")}><ArrowLeft size={16} />返回知识库</button>
        {loaded ? <EmptyState icon={Database} title="知识库不存在" description="它可能已被删除，请返回列表查看。" /> : <div className="loading-panel" role="status">正在加载知识库…</div>}
      </div>
    );
  }

  const keyword = search.trim().toLowerCase();
  const filtered = knowledgeBases.filter((item) => `${item.name}${item.description}`.toLowerCase().includes(keyword));
  return (
    <div className="content-stack">
      <div className="toolbar">
        <div className="search-box"><Search size={16} /><label className="sr-only" htmlFor="kb-search">搜索知识库</label><input id="kb-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或说明" /></div>
        <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button>
      </div>
      {loadError ? <InlineAlert title="知识库加载失败" action={<Button icon={RefreshCw} onClick={() => void refreshKnowledgeBases()}>重试</Button>}>{loadError}</InlineAlert> : null}
      {!loaded && !loadError ? <div className="loading-panel" role="status">正在加载知识库…</div> : null}
      {loaded && filtered.length ? <div className="kb-list">
        {filtered.map((item) => <KnowledgeRow key={item.id} kb={item} onOpen={() => router.push(`/knowledge/${item.id}`)} />)}
      </div> : null}
      {loaded && !filtered.length ? <EmptyState icon={keyword ? Search : Database} title={keyword ? "没有匹配的知识库" : "还没有知识库"} description={keyword ? "请调整搜索关键词。" : "创建知识库后即可导入企业文档。"} action={keyword ? undefined : <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button>} /> : null}
      <CreateKnowledgeModal open={createOpen} role={role} onOpenChange={setCreateOpen} onCreated={async (created) => {
        setToast(`知识库“${created.name}”已创建`);
        await refreshKnowledgeBases();
        router.push(`/knowledge/${created.id}`);
      }} />
    </div>
  );
}

function KnowledgeRow({ kb, onOpen }: { kb: KnowledgeBase; onOpen: () => void }) {
  const status = knowledgeBaseStatus(kb);
  return (
    <button className="kb-row" onClick={onOpen}>
      <span className="kb-row-icon"><BookOpen size={20} aria-hidden="true" /></span>
      <span className="kb-main"><span className="title-line"><strong>{kb.name}</strong><StatusBadge status={status.tone}>{status.label}</StatusBadge></span><small>{kb.description || "未填写说明"}</small></span>
      <span className="kb-stat"><small>文档</small><strong>{kb.documentCount}</strong></span>
      <span className="kb-stat"><small>分段</small><strong>{kb.chunkCount.toLocaleString()}</strong></span>
      <span className="kb-model"><small>Embedding</small><strong title={kb.embeddingModelName}>{kb.embeddingModelName}</strong></span>
      <span className="kb-updated"><small>{formatTime(kb.updatedAt)}</small><ChevronRight size={18} aria-hidden="true" /></span>
    </button>
  );
}

function KnowledgeDetail({ kb, router, refreshKnowledgeBases, setToast }: { kb: KnowledgeBase; router: Router; refreshKnowledgeBases: () => Promise<void>; setToast: Notify }) {
  const [tab, setTab] = useState<"documents" | "chunks" | "retrieval" | "settings">("documents");
  const [importOpen, setImportOpen] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const status = knowledgeBaseStatus(kb);
  const rebuilding = kb.status === "rebuilding";

  const loadDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments(kb.id));
      setDocumentsError(null);
    } catch (error) {
      setDocumentsError(errorMessage(error, "文档列表加载失败"));
    } finally {
      setDocumentsLoaded(true);
    }
  }, [kb.id]);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  // 有文档在处理或知识库在重建时轮询；处理结束后再刷新一次知识库统计
  const active = documents.some(isProcessing) || rebuilding;
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) void refreshKnowledgeBases();
    wasActive.current = active;
    if (!active) return;
    const timer = window.setInterval(() => {
      void loadDocuments();
      void refreshKnowledgeBases();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, loadDocuments, refreshKnowledgeBases]);

  const afterDocumentChange = async () => {
    await Promise.all([loadDocuments(), refreshKnowledgeBases()]);
  };

  return (
    <div className="content-stack">
      <button className="back-link" onClick={() => router.push("/knowledge")}><ArrowLeft size={16} />返回知识库</button>
      <section className="kb-hero">
        <div className="kb-symbol"><BookOpen size={22} /></div>
        <div className="kb-hero-copy">
          <div className="title-line"><h2>{kb.name}</h2><StatusBadge status={status.tone}>{status.label}</StatusBadge></div>
          <p>{kb.description || "未填写说明"}</p>
          {kb.tags.length ? <div className="kb-route-tags" aria-label="知识库标签">{kb.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
          <div className="meta-line"><span>{kb.documentCount} 个文档</span><span>{kb.chunkCount.toLocaleString()} 个分段</span><span>{kb.embeddingModelName} · {kb.vectorDimension} 维</span></div>
        </div>
        <Button variant="primary" icon={UploadCloud} onClick={() => setImportOpen(true)} disabled={rebuilding}>导入知识</Button>
      </section>
      {rebuilding ? <InlineAlert tone="info" title="正在重建向量索引">使用新的 Embedding 模型重新向量化全部分段，完成前暂不能导入文档或编辑分段。原索引在重建成功后才会被替换。</InlineAlert> : null}
      {kb.status === "rebuild_failed" ? <InlineAlert tone="warning" title="上次重建失败">{kb.rebuildError ? `原因：${kb.rebuildError}。` : ""}知识库仍在使用原模型 {kb.embeddingModelName} 的索引，检索不受影响。可在“配置”中重新选择模型再次重建。</InlineAlert> : null}
      <div className="tabs" role="tablist" aria-label="知识库详情">
        {(["documents", "chunks", "retrieval", "settings"] as const).map((item) => {
          const labels = { documents: "文档", chunks: "分段", retrieval: "检索测试", settings: "配置" };
          return <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "tab-active" : ""} onClick={() => setTab(item)}>{labels[item]}</button>;
        })}
      </div>
      {tab === "documents" ? <DocumentsPanel documents={documents} loaded={documentsLoaded} error={documentsError} reload={loadDocuments} disabled={rebuilding} onImport={() => setImportOpen(true)} onChanged={afterDocumentChange} setToast={setToast} /> : null}
      {tab === "chunks" ? <ChunksPanel kb={kb} documents={documents} /> : null}
      {tab === "retrieval" ? <RetrievalPanel hasDocuments={kb.readyDocumentCount > 0} /> : null}
      {tab === "settings" ? <SettingsPanel key={`${kb.updatedAt}-${kb.status}`} kb={kb} setToast={setToast} onSaved={refreshKnowledgeBases} onDeleted={async () => { await refreshKnowledgeBases(); router.push("/knowledge"); }} /> : null}
      <ImportWizard open={importOpen} kb={kb} onOpenChange={setImportOpen} onImported={async (document) => {
        setToast(document.status === "failed" ? `“${document.filename}”已上传，但任务未能启动` : `“${document.filename}”已开始处理`);
        setTab("documents");
        await afterDocumentChange();
      }} />
    </div>
  );
}

const metadataStatusViews = {
  pending: { label: "未构建", tone: "neutral" },
  extracting: { label: "构建中", tone: "progress" },
  ready: { label: "已构建", tone: "success" },
  failed: { label: "构建失败", tone: "error" },
  skipped: { label: "已跳过", tone: "neutral" },
};

function DocumentMetadataModal({ document, onClose }: { document: KnowledgeDocument | null; onClose: () => void }) {
  if (!document) return null;
  const fields = [
    { key: "dates", label: "时间" },
    { key: "versions", label: "版本" },
    { key: "subjects", label: "主体信息" },
    { key: "owners", label: "负责人" },
    { key: "keywords", label: "检索关键词" },
    { key: "questions", label: "可能被问到的问题" },
  ] as const;
  const status = metadataStatusViews[document.metadataStatus];
  const hasMetadata = fields.some((field) => document.metadata[field.key]?.length);
  return <Modal open onOpenChange={onClose} title={`元数据 · ${document.filename}`} description="自动从正文抽取，并作为独立分段参与混合检索。" width="wide">
    <div className="metadata-status"><StatusBadge status={status.tone}>{status.label}</StatusBadge><span>{document.metadataStatus === "ready" ? "已生成 metadata 索引分段" : "正文索引进度不受影响"}</span></div>
    {document.metadataError ? <InlineAlert title="元数据构建异常">{document.metadataError}；可重新处理文档重试。</InlineAlert> : null}
    {hasMetadata ? <div className="metadata-grid">{fields.map((field) => <section key={field.key}><h3>{field.label}</h3>{document.metadata[field.key]?.length ? <div className="metadata-values">{document.metadata[field.key].map((value) => <span key={value}>{value}</span>)}</div> : <p>正文未明确提供</p>}</section>)}</div> : <EmptyState compact icon={ListTree} title={document.metadataStatus === "failed" ? "本次构建失败" : "暂无可展示的元数据"} description="未确认的信息保持为空，不会由模型推测补写。" />}
  </Modal>;
}

function DocumentsPanel({ documents, loaded, error, reload, disabled, onImport, onChanged, setToast }: {
  documents: KnowledgeDocument[];
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
  disabled: boolean;
  onImport: () => void;
  onChanged: () => Promise<void>;
  setToast: Notify;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(null);
  const [metadataDocument, setMetadataDocument] = useState<KnowledgeDocument | null>(null);

  const run = async (document: KnowledgeDocument, action: () => Promise<unknown>, success: string) => {
    setBusyId(document.id);
    setActionError(null);
    try {
      await action();
      setToast(success);
      await onChanged();
      return true;
    } catch (reason) {
      setActionError(`${document.filename}：${errorMessage(reason, "操作失败")}`);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel table-panel">
      <div className="panel-heading compact"><div><h2>文档</h2><p>原文件、处理状态和可检索分段</p></div><Button icon={UploadCloud} variant="primary" onClick={onImport} disabled={disabled}>导入文件</Button></div>
      {error ? <div className="panel-alert"><InlineAlert title="文档列表加载失败" action={<Button icon={RefreshCw} onClick={() => void reload()}>重试</Button>}>{error}</InlineAlert></div> : null}
      {actionError ? <div className="panel-alert"><InlineAlert>{actionError}</InlineAlert></div> : null}
      {!loaded ? <div className="loading-panel" role="status">正在加载文档…</div> : null}
      {loaded && documents.length ? <div className="data-table" role="table" aria-label="知识库文档">
        <div className="data-row data-header" role="row"><span>文件</span><span>类型</span><span>大小</span><span>分段</span><span>状态</span><span>更新时间</span><span><span className="sr-only">操作</span></span></div>
        {documents.map((document) => {
          const status = documentStatus(document);
          const processing = isProcessing(document);
          const busy = busyId === document.id;
          return (
            <div className="data-row" role="row" key={document.id}>
              <span className="document-name"><span className="file-mini"><FileText size={16} /></span><span className="document-title"><strong title={document.filename}>{document.filename}</strong>{document.errorMessage ? <small className={document.status === "failed" ? "document-error" : "document-warning"} title={document.errorMessage}>{document.errorMessage}</small> : <small className="document-meta">{describeChunkSettings(document)}</small>}</span></span>
              <span>{document.extension.toUpperCase()}</span>
              <span className="numeric">{formatBytes(document.sizeBytes)}</span>
              <span className="numeric">{document.chunkCount || "—"}</span>
              <span className="document-status"><StatusBadge status={status.tone}>{status.label}{processing && document.jobProgress ? ` ${document.jobProgress}%` : ""}</StatusBadge>{processing ? <span className="progress-track" aria-hidden="true"><span className="progress-bar" style={{ width: `${Math.max(document.jobProgress, 4)}%` }} /></span> : null}</span>
              <span>{formatTime(document.updatedAt)}</span>
              <span className="row-actions">
                <button className="icon-button" aria-label={`查看元数据：${document.filename}`} title={`元数据：${metadataStatusViews[document.metadataStatus].label}`} onClick={() => setMetadataDocument(document)}><ListTree size={16} /></button>
                {processing ? <button className="icon-button" aria-label={`取消处理：${document.filename}`} title="取消处理" disabled={busy || document.cancelRequested} onClick={() => void run(document, () => cancelDocument(document.id), "已请求取消处理")}><X size={16} /></button> : null}
                {!processing && document.status !== "ready" ? <button className="icon-button" aria-label={`重新处理：${document.filename}`} title="重新处理" disabled={busy || disabled} onClick={() => void run(document, () => retryDocument(document.id), "已重新提交处理任务")}><RefreshCw size={16} /></button> : null}
                {!processing ? <button className="icon-button" aria-label={`删除：${document.filename}`} title="删除" disabled={busy || disabled} onClick={() => setPendingDelete(document)}><Trash2 size={16} /></button> : null}
              </span>
            </div>
          );
        })}
      </div> : null}
      {loaded && !documents.length && !error ? <EmptyState compact icon={FileText} title="还没有文档" description="导入文件后，解析状态和分段数量会显示在这里。" action={<Button icon={UploadCloud} onClick={onImport} disabled={disabled}>导入第一个文件</Button>} /> : null}
      <DocumentMetadataModal document={metadataDocument} onClose={() => setMetadataDocument(null)} />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="删除文档"
        description={pendingDelete ? `将删除“${pendingDelete.filename}”的原文件、${pendingDelete.chunkCount} 个分段和对应向量，且无法恢复。` : ""}
        confirmLabel="删除文档"
        busy={Boolean(pendingDelete && busyId === pendingDelete.id)}
        error={null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={() => pendingDelete && void run(pendingDelete, () => deleteDocument(pendingDelete.id), "文档已删除").then(() => setPendingDelete(null))}
      />
    </section>
  );
}

function ChunksPanel({ kb, documents }: { kb: KnowledgeBase; documents: KnowledgeDocument[] }) {
  const [documentId, setDocumentId] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ items: KnowledgeChunk[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const documentsById = useMemo(() => new Map(documents.map((document) => [document.id, document])), [documents]);

  const load = useCallback(async () => {
    try {
      setPage(await listChunks(kb.id, { documentId: documentId || undefined, q: query, offset, limit: CHUNK_PAGE_SIZE }));
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, "分段加载失败"));
    }
  }, [documentId, kb.id, offset, query]);

  useEffect(() => { void load(); }, [load]);

  const pending = page?.items.some((chunk) => chunk.vectorStatus === "pending") ?? false;
  useEffect(() => {
    if (!pending || editingId) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [editingId, load, pending]);

  const startEdit = (chunk: KnowledgeChunk) => {
    setEditingId(chunk.id);
    setDraft(chunk.content);
    setSaveError(null);
  };

  const save = async (chunk: KnowledgeChunk) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateChunk(chunk.id, draft);
      setPage((current) => current && { ...current, items: current.items.map((item) => item.id === updated.id ? updated : item) });
      setEditingId(null);
    } catch (reason) {
      setSaveError(errorMessage(reason, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const filtersActive = Boolean(documentId || query);
  const total = page?.total ?? 0;
  return (
    <section className="panel">
      <div className="panel-heading compact"><div><h2>分段</h2><p>检查切分结果，修改后仅重新向量化该分段</p></div></div>
      <form className="chunk-toolbar" onSubmit={(event) => { event.preventDefault(); setOffset(0); setQuery(queryInput); }}>
        <label className="sr-only" htmlFor="chunk-document">按文档筛选</label>
        <select id="chunk-document" value={documentId} onChange={(event) => { setDocumentId(event.target.value); setOffset(0); }}>
          <option value="">全部文档</option>
          {documents.map((document) => <option key={document.id} value={document.id}>{document.filename}</option>)}
        </select>
        <div className="search-box"><Search size={16} /><label className="sr-only" htmlFor="chunk-search">搜索分段内容</label><input id="chunk-search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索分段内容，回车确认" /></div>
        {filtersActive ? <Button variant="ghost" type="button" onClick={() => { setDocumentId(""); setQuery(""); setQueryInput(""); setOffset(0); }}>清除筛选</Button> : null}
      </form>
      {error ? <div className="panel-alert"><InlineAlert title="分段加载失败" action={<Button icon={RefreshCw} onClick={() => void load()}>重试</Button>}>{error}</InlineAlert></div> : null}
      {!page && !error ? <div className="loading-panel" role="status">正在加载分段…</div> : null}
      {page && page.items.length ? <div className="chunk-list">
        {page.items.map((chunk) => {
          const document = documentsById.get(chunk.documentId);
          const locked = kb.status === "rebuilding" || Boolean(document && isProcessing(document));
          const location = chunk.location;
          return (
            <article className="chunk-card" key={chunk.id}>
              <div className="chunk-meta">
                <span>#{chunk.position + 1}</span>
                {document ? <span>{document.filename}</span> : null}
                {location.heading_path?.length ? <span>{location.heading_path.join(" › ")}</span> : null}
                {location.page ? <span>第 {location.page} 页</span> : null}
                {location.sheet ? <span>工作表 {location.sheet}</span> : null}
                {location.rows ? <span>第 {location.rows[0]}–{location.rows[1]} 行</span> : null}
                {chunk.kind !== "text" ? <span>{chunk.kind === "table" ? "表格" : "图片"}</span> : null}
                <span>{chunk.tokenCount} Token</span>
                {chunk.edited ? <span className="chunk-edited">已编辑</span> : null}
                <StatusBadge status={{ indexed: "success", pending: "progress", failed: "error" }[chunk.vectorStatus]}>{{ indexed: "已索引", pending: "向量化中", failed: "向量化失败" }[chunk.vectorStatus]}</StatusBadge>
              </div>
              {editingId === chunk.id ? (
                <div className="chunk-edit">
                  <label className="sr-only" htmlFor={`chunk-${chunk.id}`}>分段内容</label>
                  <textarea id={`chunk-${chunk.id}`} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} />
                  {saveError ? <InlineAlert>{saveError}</InlineAlert> : null}
                  <div className="chunk-edit-actions"><Button onClick={() => setEditingId(null)} disabled={saving}>取消</Button><Button variant="primary" icon={Check} onClick={() => void save(chunk)} disabled={saving || !draft.trim() || draft.trim() === chunk.content}>{saving ? "保存中…" : "保存并重新向量化"}</Button></div>
                </div>
              ) : (
                <div className="chunk-body">
                  <p className={cn("chunk-content", chunk.kind === "table" && "chunk-content-table")}>{chunk.content}</p>
                  <button className="icon-button" aria-label={`编辑分段 ${chunk.position + 1}`} title={locked ? "文档处理或知识库重建期间不能编辑" : "编辑分段"} disabled={locked || Boolean(editingId)} onClick={() => startEdit(chunk)}><Pencil size={16} /></button>
                </div>
              )}
            </article>
          );
        })}
      </div> : null}
      {page && !page.items.length ? <EmptyState compact icon={filtersActive ? Search : Layers3} title={filtersActive ? "没有匹配的分段" : "还没有知识分段"} description={filtersActive ? "请调整筛选条件。" : "导入文档并完成处理后，分段会显示在这里。"} /> : null}
      {total > CHUNK_PAGE_SIZE ? <div className="pagination">
        <span>第 {offset + 1}–{Math.min(offset + CHUNK_PAGE_SIZE, total)} 条，共 {total} 条</span>
        <div><Button icon={ChevronLeft} onClick={() => setOffset(Math.max(0, offset - CHUNK_PAGE_SIZE))} disabled={offset === 0}>上一页</Button><Button onClick={() => setOffset(offset + CHUNK_PAGE_SIZE)} disabled={offset + CHUNK_PAGE_SIZE >= total}>下一页<ChevronRight size={16} aria-hidden="true" /></Button></div>
      </div> : null}
    </section>
  );
}

function RetrievalPanel({ hasDocuments }: { hasDocuments: boolean }) {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(8);
  const [result, setResult] = useState<RetrievalTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await testRetrieval(query.trim(), topK));
    } catch (reason) {
      setError(errorMessage(reason, "检索测试失败"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="retrieval-layout">
      <section className="panel retrieval-query">
        <div className="retrieval-query-heading"><h2>测试自动选库与混合检索</h2><p>按正式问答链路执行候选库召回、每库向量查询、BM25、RRF 和可选 Rerank。</p></div>
        <div className="retrieval-fields">
          <label htmlFor="retrieval-query">测试问题<textarea id="retrieval-query" value={query} maxLength={2000} onChange={(event) => setQuery(event.target.value)} placeholder="输入用于验证检索效果的问题" aria-describedby="retrieval-query-hint" /></label>
          <div className="retrieval-form-row">
            <label><span>返回分段</span><select value={topK} onChange={(event) => setTopK(Number(event.target.value))}><option value={5}>5</option><option value={8}>8</option><option value={12}>12</option><option value={20}>20</option></select></label>
            <Button variant="primary" icon={Zap} onClick={() => void run()} disabled={!hasDocuments || !query.trim() || running}>{running ? "检索中…" : "开始检索"}</Button>
          </div>
          <p className="form-hint" id="retrieval-query-hint">{hasDocuments ? "该测试使用全库自动路由，结果不限定在当前知识库。" : "当前还没有可检索文档。"}</p>
          {error ? <InlineAlert title="检索测试失败">{error}</InlineAlert> : null}
        </div>
      </section>
      <section className="panel retrieval-results">
        <div className="panel-heading compact"><div><h2>召回结果</h2><p>{result ? `命中 ${result.hits.length} 个分段${result.rerankApplied ? "，已执行重排" : ""}` : "检索完成后显示融合和重排结果"}</p></div></div>
        {running ? <div className="loading-panel" role="status">正在自动选库并检索…</div> : null}
        {result?.selectedKnowledgeBases.length ? <div className="retrieval-route"><strong>自动选库</strong><div>{result.selectedKnowledgeBases.map((item) => <span key={item.knowledgeBaseId}>{item.name} · 匹配 {item.score.toFixed(3)}</span>)}</div></div> : null}
        {result?.warnings.map((warning) => <div className="panel-alert" key={warning}><InlineAlert tone="warning">{warning}</InlineAlert></div>)}
        {result && result.insufficient ? <EmptyState compact icon={Search} title="未检索到充分依据" description="可调整问题、补充知识库路由信息，或导入相关资料后重试。" /> : null}
        {result && !result.insufficient ? <div className="retrieval-hit-list">{result.hits.map((hit, index) => <article key={hit.chunkId} className="retrieval-hit"><div><span>[{index + 1}]</span><strong>{hit.filename}</strong><small>{hit.knowledgeBaseName}</small></div><p>{hit.content}</p><dl><div><dt>Dense</dt><dd>{hit.denseScore.toFixed(3)}</dd></div><div><dt>BM25</dt><dd>{hit.bm25Score.toFixed(3)}</dd></div><div><dt>RRF</dt><dd>{hit.rrfScore.toFixed(3)}</dd></div>{hit.rerankScore !== null ? <div><dt>Rerank</dt><dd>{hit.rerankScore.toFixed(3)}</dd></div> : null}</dl></article>)}</div> : null}
        {!running && !result ? <EmptyState compact icon={Search} title="暂无检索结果" description="添加可用文档并输入测试问题后开始检索。" /> : null}
      </section>
    </div>
  );
}

function SettingsPanel({ kb, setToast, onSaved, onDeleted }: { kb: KnowledgeBase; setToast: Notify; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const { models, loading, error: modelsError } = useEmbeddingModels(true);
  const [form, setForm] = useState({
    name: kb.name,
    description: kb.description,
    tags: kb.tags.join("，"),
    sampleQuestions: kb.sampleQuestions.join("\n"),
    embeddingModelId: kb.embeddingModelId,
  });
  const [chunkForm, setChunkForm] = useState<ChunkForm>(chunkFormFrom(kb));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const rebuilding = kb.status === "rebuilding";

  const { settings: chunk, error: chunkError } = parseChunkForm(chunkForm);
  const tags = parseTags(form.tags);
  const sampleQuestions = parseSampleQuestions(form.sampleQuestions);
  const validation = !form.name.trim() ? "请填写知识库名称" : routeFieldError(tags, sampleQuestions) ?? chunkError;
  const changes: Partial<KnowledgeBaseInput> = {};
  if (form.name.trim() !== kb.name) changes.name = form.name.trim();
  if (form.description.trim() !== kb.description) changes.description = form.description.trim();
  if (!sameStrings(tags, kb.tags)) changes.tags = tags;
  if (!sameStrings(sampleQuestions, kb.sampleQuestions)) changes.sampleQuestions = sampleQuestions;
  if (form.embeddingModelId !== kb.embeddingModelId) changes.embeddingModelId = form.embeddingModelId;
  if (chunk.chunkSize !== kb.chunkSize) changes.chunkSize = chunk.chunkSize;
  if (chunk.chunkOverlap !== kb.chunkOverlap) changes.chunkOverlap = chunk.chunkOverlap;
  if (chunk.chunkMethod !== kb.chunkMethod) changes.chunkMethod = chunk.chunkMethod;
  if (chunk.headingLevel !== kb.headingLevel) changes.headingLevel = chunk.headingLevel;
  if (!sameStrings(chunk.separators, kb.separators)) changes.separators = chunk.separators;
  if (chunk.semanticThreshold !== kb.semanticThreshold) changes.semanticThreshold = chunk.semanticThreshold;
  const dirty = Object.keys(changes).length > 0;
  const modelChanged = Boolean(changes.embeddingModelId);
  const currentModelMissing = !models.some((model) => model.id === kb.embeddingModelId);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateKnowledgeBase(kb.id, changes);
      setToast(updated.status === "rebuilding" ? "已开始使用新模型重建向量索引" : "知识库配置已保存");
      await onSaved();
    } catch (reason) {
      setSaveError(errorMessage(reason, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteKnowledgeBase(kb.id);
      setToast(`知识库“${kb.name}”已删除`);
      setDeleteOpen(false);
      await onDeleted();
    } catch (reason) {
      setDeleteError(errorMessage(reason, "删除失败"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="settings-stack">
      <section className="panel settings-form">
        <div className="panel-heading compact"><div><h2>知识库配置</h2><p>更换 Embedding 模型会重建全部向量；切分设置是导入新文档时的默认值，已导入的文档保留原设置</p></div></div>
        <div className="form-grid">
          <label><span>知识库名称</span><input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={rebuilding} /></label>
          <label><span>Embedding 模型</span>
            <select value={form.embeddingModelId} onChange={(event) => setForm({ ...form, embeddingModelId: event.target.value })} disabled={rebuilding || loading}>
              {currentModelMissing ? <option value={kb.embeddingModelId}>{kb.embeddingModelName}（当前）</option> : null}
              {models.map((model) => <option key={model.id} value={model.id}>{model.modelId} · {model.vectorDimension} 维</option>)}
            </select>
            {modelsError ? <small>{modelsError}</small> : null}
            <small className="field-hint">显示真实模型 ID；新加入的模型会出现在列表中，切换后需要重建向量索引。</small>
          </label>
          <label className="wide-field"><span>知识库说明</span><textarea value={form.description} maxLength={2000} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="说明知识范围，阶段 4 将用于自动选库" disabled={rebuilding} /></label>
          <label className="wide-field"><span>路由标签</span><input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="使用逗号分隔，最多 20 个" disabled={rebuilding} /><small className="field-hint">用于自动选库的关键词，单个标签最多 50 个字符。</small></label>
          <label className="wide-field"><span>示例问题</span><textarea value={form.sampleQuestions} onChange={(event) => setForm({ ...form, sampleQuestions: event.target.value })} placeholder="每行填写一个问题，最多 20 个" disabled={rebuilding} /><small className="field-hint">系统会将问题与这些表达进行匹配，以提高选库准确性。</small></label>
          <div className="wide-field"><ChunkSettingsFields id="kb-settings" value={chunkForm} onChange={setChunkForm} disabled={rebuilding} /></div>
        </div>
        {modelChanged && kb.chunkCount ? <div className="panel-alert"><InlineAlert tone="warning" title="保存后将重建向量索引">将使用新模型重新向量化全部 {kb.chunkCount.toLocaleString()} 个分段，期间不能导入文档或编辑分段；重建失败时保留原索引。</InlineAlert></div> : null}
        {dirty && validation ? <div className="panel-alert"><InlineAlert tone="warning">{validation}</InlineAlert></div> : null}
        {saveError ? <div className="panel-alert"><InlineAlert>{saveError}</InlineAlert></div> : null}
        <div className="form-actions"><Button variant="primary" onClick={() => void save()} disabled={!dirty || Boolean(validation) || saving || rebuilding}>{saving ? "保存中…" : modelChanged && kb.chunkCount ? "保存并重建" : "保存配置"}</Button></div>
      </section>
      <section className="panel danger-zone">
        <div><h2>删除知识库</h2><p>删除全部文档、原文件、分段和向量索引，且无法恢复。</p></div>
        <Button variant="danger" icon={Trash2} onClick={() => { setDeleteError(null); setDeleteOpen(true); }} disabled={rebuilding}>删除知识库</Button>
      </section>
      <ConfirmDialog open={deleteOpen} title={`删除“${kb.name}”`} description={`将删除 ${kb.documentCount} 个文档和 ${kb.chunkCount.toLocaleString()} 个分段，且无法恢复。`} confirmLabel="确认删除" busy={deleting} error={deleteError} onOpenChange={setDeleteOpen} onConfirm={() => void remove()} />
    </div>
  );
}

function CreateKnowledgeModal({ open, role, onOpenChange, onCreated }: { open: boolean; role: Role; onOpenChange: (open: boolean) => void; onCreated: (kb: KnowledgeBase) => Promise<void> }) {
  const { models, loading, error: modelsError } = useEmbeddingModels(open);
  const [form, setForm] = useState({ name: "", description: "", tags: "", sampleQuestions: "", embeddingModelId: "" });
  const [chunkForm, setChunkForm] = useState<ChunkForm>(DEFAULT_CHUNK_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embeddingModelId = form.embeddingModelId || models[0]?.id || "";
  const tags = parseTags(form.tags);
  const sampleQuestions = parseSampleQuestions(form.sampleQuestions);
  const { settings: chunk, error: chunkError } = parseChunkForm(chunkForm);
  const validation = routeFieldError(tags, sampleQuestions) ?? chunkError;

  const close = (next: boolean) => {
    if (submitting) return;
    onOpenChange(next);
    if (!next) window.setTimeout(() => { setForm({ name: "", description: "", tags: "", sampleQuestions: "", embeddingModelId: "" }); setChunkForm(DEFAULT_CHUNK_FORM); setShowAdvanced(false); setError(null); }, 150);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await createKnowledgeBase({ name: form.name.trim(), description: form.description.trim(), tags, sampleQuestions, embeddingModelId, ...chunk });
      setSubmitting(false);
      close(false);
      await onCreated(created);
    } catch (reason) {
      setError(errorMessage(reason, "创建失败"));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={close} title="新建知识库" description="每个知识库使用独立的 Embedding 模型和向量集合。" width="wide">
      <div className="modal-form">
        <label><span>名称（必填）</span><input autoFocus value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="输入知识库名称" /></label>
        <label><span>Embedding 模型（必选）</span>
          <select value={embeddingModelId} onChange={(event) => setForm({ ...form, embeddingModelId: event.target.value })} disabled={loading || !models.length}>
            {loading ? <option value="">正在加载…</option> : null}
            {!loading && !models.length ? <option value="">尚无可用模型</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.modelId} · {model.vectorDimension} 维</option>)}
          </select>
          {modelsError ? <small className="field-error">{modelsError}</small> : null}
          {!loading && !models.length && !modelsError ? <small>{role === "admin" ? "请先在“模型服务”中添加启用的 Embedding 模型并填写向量维度。" : "请联系管理员在“模型服务”中添加 Embedding 模型。"}</small> : null}
          <small className="field-hint">新增模型会自动出现在列表中；创建后也可切换，切换时需要重建向量索引。</small>
        </label>
        <button type="button" className="text-action advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((current) => !current)}>{showAdvanced ? "收起" : "展开"}高级设置（可选）<ChevronRight className={showAdvanced ? "is-expanded" : ""} size={15} /></button>
        {showAdvanced ? <div className="advanced-settings-content">
          <p className="form-hint">默认按标题切分，不产生语义切分的额外 Embedding 调用；以下项目均可稍后修改。</p>
          <label><span>说明</span><textarea value={form.description} maxLength={2000} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="说明知识范围，用于自动选库" /></label>
          <label><span>路由标签</span><input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="使用逗号分隔，最多 20 个" /><small className="field-hint">用于自动选库的关键词。</small></label>
          <label><span>示例问题</span><textarea value={form.sampleQuestions} onChange={(event) => setForm({ ...form, sampleQuestions: event.target.value })} placeholder="每行填写一个问题，最多 20 个" /><small className="field-hint">帮助系统识别这个知识库适合回答的问题。</small></label>
          <ChunkSettingsFields id="kb-create" value={chunkForm} onChange={setChunkForm} />
        </div> : null}
        {validation ? <InlineAlert tone="warning">{validation}</InlineAlert> : null}
        {error ? <InlineAlert>{error}</InlineAlert> : null}
      </div>
      <div className="dialog-actions"><Button onClick={() => close(false)} disabled={submitting}>取消</Button><Button variant="primary" onClick={() => void submit()} disabled={!form.name.trim() || !embeddingModelId || Boolean(validation) || submitting}>{submitting ? "创建中…" : "创建知识库"}</Button></div>
    </Modal>
  );
}

type KnowledgeSourceTab = "file" | "text" | "qa" | "web" | "feishu" | "api";
function SourceImportPanel({ kb, onImported, disabled, source, setSource }: { kb: KnowledgeBase; onImported: (document: KnowledgeDocument) => Promise<void>; disabled: boolean; source: KnowledgeSourceTab; setSource: (source: KnowledgeSourceTab) => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [pairs, setPairs] = useState<Array<{ question: string; answer: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const document = await importKnowledgeSource(kb.id, source === "web" ? { source, title, url } : source === "qa" ? { source, title, qa_pairs: pairs } : { source: "text", title, content });
      await onImported(document);
    } catch (reason) { setError(errorMessage(reason, "数据源导入失败")); }
    finally { setBusy(false); }
  };
  return <div className="source-import">
    <div className="source-tabs" aria-label="知识数据源">{(["file", "text", "qa", "web", "feishu", "api"] as const).map((item) => <button type="button" key={item} className={source === item ? "source-active" : ""} onClick={() => { setSource(item); setError(null); }}>{{ file: "本地文件", text: "自定义文本", qa: "问答对", web: "网页链接", feishu: "飞书", api: "API" }[item]}</button>)}</div>
    {source !== "file" && source !== "feishu" && source !== "api" ? <div className="source-form">
      <label><span>资料名称{source === "web" ? "（可选）" : ""}</span><input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={source === "web" ? "默认使用网页域名" : "导入资料的名称"} /></label>
      {source === "text" ? <label><span>正文</span><textarea className="source-textarea" value={content} maxLength={1000000} onChange={(event) => setContent(event.target.value)} placeholder="粘贴需要解析、切分和检索的文本" /></label> : null}
      {source === "web" ? <><label><span>公开网页地址</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article" /></label><p className="form-hint">服务端抓取单个公开网页并提取正文，保留来源地址；不支持需要登录或私有网络链接。</p></> : null}
      {source === "qa" ? <><div className="qa-input-grid"><label><span>问题</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label><span>答案</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} /></label></div><Button icon={Plus} disabled={!question.trim() || !answer.trim()} onClick={() => { setPairs((current) => [...current, { question: question.trim(), answer: answer.trim() }]); setQuestion(""); setAnswer(""); }}>添加问答对</Button>{pairs.length ? <div className="qa-pair-list">{pairs.map((pair, index) => <div key={`${pair.question}-${index}`}><span><strong>{pair.question}</strong><small>{pair.answer}</small></span><button className="icon-button" aria-label={`删除问答对 ${index + 1}`} onClick={() => setPairs((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={15} /></button></div>)}</div> : null}<p className="form-hint">CSV/XLSX 问答表也可通过“本地文件”上传；此处适合直接录入。</p></> : null}
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      <Button variant="primary" disabled={disabled || busy || (source === "text" ? !content.trim() : source === "web" ? !url.trim() : !pairs.length)} onClick={() => void submit()}>{busy ? "正在抓取并创建任务…" : `导入到 ${kb.name}`}</Button>
    </div> : null}
    {source === "feishu" ? <EmptyState compact icon={BookOpen} title="飞书连接器尚未配置" description="当前版本未保存飞书应用凭据，也不能执行同步。完成企业飞书应用配置后再启用此入口。" action={<Button disabled>手动同步（未接入）</Button>} /> : null}
    {source === "api" ? <div className="api-import-doc"><p>使用现有文档上传接口，文件会进入与页面相同的处理队列：</p><pre>{`curl -X POST '/api/v1/knowledge-bases/${kb.id}/documents' \\
  -H 'Cookie: rag_session=<你的匿名会话 ID>' \\
  -F 'file=@./手册.md' \\
  -F 'parse_strategy=local' \\
  -F 'chunk_method=${kb.chunkMethod}'`}</pre><Button onClick={() => void navigator.clipboard.writeText(`/api/v1/knowledge-bases/${kb.id}/documents`)}>复制接口路径</Button></div> : null}
  </div>;
}

function ImportWizard({ open, kb, onOpenChange, onImported }: { open: boolean; kb: KnowledgeBase; onOpenChange: (open: boolean) => void; onImported: (document: KnowledgeDocument) => Promise<void> }) {
  const [step, setStep] = useState(1);
  const [sourceTab, setSourceTab] = useState<KnowledgeSourceTab>("file");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [parseStrategy, setParseStrategy] = useState<"local" | "smart" | "fast">("local");
  const [enhanceImages, setEnhanceImages] = useState(true);
  const [chunkForm, setChunkForm] = useState<ChunkForm>(chunkFormFrom(kb));
  const { settings: chunk, error: chunkError } = parseChunkForm(chunkForm);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const localCount = files.filter((file) => {
    const extension = extensionOf(file.name);
    return LOCAL_PARSE_EXTENSIONS.includes(extension) || (parseStrategy === "local" && ["pdf", "doc", "docx"].includes(extension));
  }).length;
  const cloudCount = files.length - localCount;
  const cloudOptionalCount = files.filter((file) => !LOCAL_PARSE_EXTENSIONS.includes(extensionOf(file.name))).length;
  const hasImages = files.some((file) => IMAGE_EXTENSIONS.includes(extensionOf(file.name)));
  const totalSize = files.reduce((total, file) => total + file.size, 0);

  const reset = () => { setStep(1); setFiles([]); setFileError(null); setDragging(false); setParseStrategy("local"); setEnhanceImages(true); setChunkForm(chunkFormFrom(kb)); setProgress(0); setSubmitError(null); setDuplicate(null); };
  const close = (next: boolean) => {
    if (uploading) return;
    onOpenChange(next);
    if (!next) window.setTimeout(reset, 150);
  };

  const choose = (selected: File[]) => {
    setSubmitError(null);
    setDuplicate(null);
    const errors: string[] = [];
    const valid = selected.filter((file) => {
      const extension = extensionOf(file.name);
      if (!ACCEPTED_EXTENSIONS.includes(extension)) { errors.push(`${file.name}：不支持 .${extension || "无扩展名"}`); return false; }
      if (file.size === 0) { errors.push(`${file.name}：文件内容为空`); return false; }
      if (file.size > MAX_UPLOAD_BYTES) { errors.push(`${file.name}：超过 100 MB 上限`); return false; }
      return true;
    });
    setFiles((current) => {
      const existing = new Set(current.map((file) => `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`));
      const additions = valid.filter((file) => {
        const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      return [...current, ...additions];
    });
    setFileError(errors.length ? errors.join("；") : null);
  };

  const submit = async (allowDuplicate: boolean) => {
    if (!files.length) return;
    setUploading(true);
    setProgress(0);
    setSubmitError(null);
    setDuplicate(null);
    const remaining: File[] = [];
    const errors: string[] = [];
    let duplicateFound = false;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      let document: KnowledgeDocument | null = null;
      try {
        document = await uploadDocument(kb.id, file, { parseStrategy, enhanceImages, allowDuplicate, ...chunk }, (fraction) => setProgress((index + fraction) / files.length));
      } catch (reason) {
        remaining.push(file);
        if (reason instanceof ApiError && reason.status === 409 && typeof reason.detail === "object") duplicateFound = true;
        else errors.push(`${file.name}：${errorMessage(reason, "上传失败")}`);
      }
      if (document) {
        try {
          await onImported(document);
        } catch (reason) {
          errors.push(`${file.name} 已导入，但列表刷新失败：${errorMessage(reason, "请手动刷新")}`);
        }
      }
      setProgress((index + 1) / files.length);
    }
    setUploading(false);
    setFiles(remaining);
    if (duplicateFound) setDuplicate("部分文件与知识库已有内容重复。已成功的文件不会重复导入，可仅重试剩余文件。");
    if (errors.length) setSubmitError(errors.join("；"));
    if (!remaining.length) close(false);
  };

  const parseLabel = parseStrategy === "local" ? "本地优先（失败转快速云端）" : cloudCount === 0 ? "本地结构化解析" : parseStrategy === "smart" ? "智能云端（大模型增强）" : "快速云端";
  return (
    <Modal open={open} onOpenChange={close} title="导入知识" description={`导入到“${kb.name}”，依次完成解析、切分和向量化。`} width="wide">
      <div className="wizard-steps" aria-label={`当前第 ${step} 步，共 3 步`}>{["选择文件", "解析与切分", "确认导入"].map((label, index) => <div key={label} className={cn(index + 1 < step && "wizard-done", index + 1 === step && "wizard-current")}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}</div>
      {step === 1 ? <div className="wizard-body">
        <SourceImportPanel kb={kb} disabled={uploading} source={sourceTab} setSource={setSourceTab} onImported={async (document) => { await onImported(document); close(false); }} />
        {sourceTab === "file" ? <div className="file-source-form">
          <input className="sr-only" id="knowledge-file" type="file" multiple accept={ACCEPTED_EXTENSIONS.map((item) => `.${item}`).join(",")} onChange={(event) => { choose(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <input className="sr-only" id="knowledge-folder" type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => { choose(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <label className={cn("drop-zone", dragging && "drop-zone-active")} htmlFor="knowledge-file" onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); choose(Array.from(event.dataTransfer.files)); }}><UploadCloud size={26} /><strong>{dragging ? "松开以上传文件" : "拖入多个文件，或点击选择"}</strong><span>支持 Word、PDF、Markdown、图片、CSV 和 Excel，单文件最大 100 MB</span></label>
          <div className="upload-secondary-action"><label className="button button-secondary" htmlFor="knowledge-folder"><Plus size={16} /><span>选择文件夹</span></label><span>文件夹内不支持的格式会单独提示并跳过</span></div>
          {files.length ? <><div className="selected-files-summary"><strong>已选择 {files.length} 个文件</strong><span>{formatBytes(totalSize)} · 本地 {localCount} 个 / 云端 {cloudCount} 个</span></div><div className="selected-files-list">{files.map((file, index) => <div className="selected-file" key={`${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`}><FileText size={18} /><span><strong>{file.webkitRelativePath || file.name}</strong><small>{formatBytes(file.size)} · {LOCAL_PARSE_EXTENSIONS.includes(extensionOf(file.name)) ? "本地解析" : "云端解析"}</small></span><button className="icon-button" aria-label={`移除文件：${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={16} /></button></div>)}</div></> : null}
          {fileError ? <InlineAlert>{fileError}</InlineAlert> : null}
        </div> : null}
      </div> : null}
      {step === 2 ? <div className="wizard-body option-list">
        {cloudOptionalCount === 0 ? <InlineAlert tone="info" title="本地结构化解析">Markdown、CSV 和 Excel 直接在服务器解析，保留标题层级、表头和工作表名，不发送到云端。</InlineAlert> : <>
          <InlineAlert tone="info" title={`预计本地 ${localCount} 个 / 云端 ${cloudCount} 个`}>本地优先不调用 DocMind；扫描件或本地无法可靠提取时回退快速云端。智能与快速云端均产生阿里云文档解析费用，具体以账号计费页为准。</InlineAlert>
          <label className="option-card"><input type="radio" name="parse" checked={parseStrategy === "local"} onChange={() => setParseStrategy("local")} /><span><strong>本地优先</strong><small>本地解析文字型 PDF、DOCX、DOC；失败自动回退快速云端，减少云端调用。</small></span><Database size={18} /></label>
          <label className="option-card"><input type="radio" name="parse" checked={parseStrategy === "smart"} onChange={() => setParseStrategy("smart")} /><span><strong>智能云端</strong><small>开启 DocMind 大模型增强，更好还原复杂版面；云端耗时和费用通常更高。</small></span><Sparkles size={18} /></label>
          <label className="option-card"><input type="radio" name="parse" checked={parseStrategy === "fast"} onChange={() => setParseStrategy("fast")} /><span><strong>快速云端</strong><small>关闭大模型增强，使用标准云端版面解析，适合简单数字文档。</small></span><Zap size={18} /></label>
        </>}
        {hasImages ? <label className="switch-row"><span><strong>图片语义描述</strong><small>除云端 OCR 外，调用管理员配置的视觉模型，按该模型的 Token/调用规则计费</small></span><input type="checkbox" checked={enhanceImages} onChange={(event) => setEnhanceImages(event.target.checked)} aria-label="启用图片语义描述" /></label> : null}
        <ChunkSettingsFields id="import" value={chunkForm} onChange={setChunkForm} />
        {chunk.chunkMethod === "semantic" ? <InlineAlert tone="info" title="语义切分额外调用 Embedding">切分计算在本地执行，但相邻内容的语义向量由当前知识库绑定的 Embedding 服务生成，之后写库还会再次向量化最终分段。</InlineAlert> : null}
        <p className="form-hint">每个文档会自动复用路由 LLM 抽取一次元数据；失败不影响正文导入。切分默认值来自知识库配置，检索时的 Rerank 和回答模型用量独立计算。</p>
        {chunkError ? <InlineAlert tone="warning">{chunkError}</InlineAlert> : null}
      </div> : null}
      {step === 3 ? <div className="wizard-body confirm-grid">
        <div><span>文件</span><strong>{files.length} 个</strong></div>
        <div><span>总大小</span><strong>{formatBytes(totalSize)}</strong></div>
        <div><span>解析方式</span><strong>{parseLabel}</strong></div>
        <div><span>切分方式</span><strong>{describeChunkSettings(chunk)}</strong></div>
        <div><span>Embedding</span><strong>{kb.embeddingModelName} · {kb.vectorDimension} 维</strong></div>
        {hasImages ? <div><span>图片处理</span><strong>{enhanceImages ? "OCR + 视觉描述" : "仅 OCR"}</strong></div> : null}
        {cloudCount || (parseStrategy === "local" && cloudOptionalCount) ? <div className="privacy-note"><ShieldAlert size={17} /><span>{cloudCount ? `${cloudCount} 个文件将使用云端解析；` : ""}{parseStrategy === "local" && cloudOptionalCount ? "本地无法可靠提取时会回退云端；" : ""}其余文件仅在本地处理。请确认符合企业数据出域规范。</span></div> : null}
        {uploading ? <div className="upload-progress" role="status"><span>{progress < 1 ? `正在批量上传 ${Math.round(progress * 100)}%` : "上传完成，正在创建处理任务…"}</span><span className="progress-track"><span className="progress-bar" style={{ width: `${Math.max(progress * 100, 3)}%` }} /></span></div> : null}
        {duplicate ? <div className="wide-field"><InlineAlert tone="warning" title="文件可能重复" action={<Button onClick={() => void submit(true)} disabled={uploading}>仅重试剩余文件</Button>}>{duplicate}</InlineAlert></div> : null}
        {submitError ? <div className="wide-field"><InlineAlert title="部分文件导入失败">{submitError}</InlineAlert></div> : null}
      </div> : null}
      <div className="dialog-actions">
        <Button onClick={() => step === 1 ? close(false) : setStep(step - 1)} disabled={uploading}>{step === 1 ? "取消" : "上一步"}</Button>
        <Button variant="primary" onClick={() => step === 3 ? void submit(false) : setStep(step + 1)} disabled={(step === 1 && sourceTab !== "file") || !files.length || uploading || (step >= 2 && Boolean(chunkError))}>{step === 3 ? (uploading ? "导入中…" : submitError || duplicate ? "重试剩余文件" : "开始导入") : "下一步"}</Button>
      </div>
    </Modal>
  );
}
