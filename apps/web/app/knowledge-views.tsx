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
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  UploadCloud,
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
  retryDocument,
  updateChunk,
  updateKnowledgeBase,
  uploadDocument,
  type KnowledgeBaseInput,
} from "./api-client";
import {
  ACCEPTED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  LOCAL_PARSE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  type KnowledgeBase,
  type KnowledgeChunk,
  type KnowledgeDocument,
  type ModelInstance,
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
        {filtered.map((item) => <KnowledgeRow key={item.id} kb={item} onOpen={() => router.push(`/knowledge?kb=${item.id}`)} />)}
      </div> : null}
      {loaded && !filtered.length ? <EmptyState icon={keyword ? Search : Database} title={keyword ? "没有匹配的知识库" : "还没有知识库"} description={keyword ? "请调整搜索关键词。" : "创建知识库后即可导入企业文档。"} action={keyword ? undefined : <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>新建知识库</Button>} /> : null}
      <CreateKnowledgeModal open={createOpen} role={role} onOpenChange={setCreateOpen} onCreated={async (created) => {
        setToast(`知识库“${created.name}”已创建`);
        await refreshKnowledgeBases();
        router.push(`/knowledge?kb=${created.id}`);
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
      <span className="kb-model"><small>Embedding</small><strong>{kb.embeddingModelName}</strong></span>
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
              <span className="document-name"><span className="file-mini"><FileText size={16} /></span><span className="document-title"><strong title={document.filename}>{document.filename}</strong>{document.errorMessage ? <small className={document.status === "failed" ? "document-error" : "document-warning"} title={document.errorMessage}>{document.errorMessage}</small> : null}</span></span>
              <span>{document.extension.toUpperCase()}</span>
              <span className="numeric">{formatBytes(document.sizeBytes)}</span>
              <span className="numeric">{document.chunkCount || "—"}</span>
              <span className="document-status"><StatusBadge status={status.tone}>{status.label}{processing && document.jobProgress ? ` ${document.jobProgress}%` : ""}</StatusBadge>{processing ? <span className="progress-track" aria-hidden="true"><span className="progress-bar" style={{ width: `${Math.max(document.jobProgress, 4)}%` }} /></span> : null}</span>
              <span>{formatTime(document.updatedAt)}</span>
              <span className="row-actions">
                {processing ? <button className="icon-button" aria-label={`取消处理：${document.filename}`} title="取消处理" disabled={busy || document.cancelRequested} onClick={() => void run(document, () => cancelDocument(document.id), "已请求取消处理")}><X size={16} /></button> : null}
                {!processing && document.status !== "ready" ? <button className="icon-button" aria-label={`重新处理：${document.filename}`} title="重新处理" disabled={busy || disabled} onClick={() => void run(document, () => retryDocument(document.id), "已重新提交处理任务")}><RefreshCw size={16} /></button> : null}
                {!processing ? <button className="icon-button" aria-label={`删除：${document.filename}`} title="删除" disabled={busy || disabled} onClick={() => setPendingDelete(document)}><Trash2 size={16} /></button> : null}
              </span>
            </div>
          );
        })}
      </div> : null}
      {loaded && !documents.length && !error ? <EmptyState compact icon={FileText} title="还没有文档" description="导入文件后，解析状态和分段数量会显示在这里。" action={<Button icon={UploadCloud} onClick={onImport} disabled={disabled}>导入第一个文件</Button>} /> : null}
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
  return (
    <div className="retrieval-layout">
      <section className="panel retrieval-query"><h2>测试当前知识库</h2><p>查看向量召回、关键词命中和重排结果。</p><label htmlFor="retrieval-query">测试问题</label><textarea id="retrieval-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入用于验证检索效果的问题" /><div className="form-row"><label><span>召回数量</span><select defaultValue="20"><option>20</option><option>40</option></select></label><label><span>最终引用</span><select defaultValue="5"><option>5</option><option>8</option></select></label></div><Button variant="primary" icon={Zap} disabled>开始检索</Button><p className="form-hint">{hasDocuments ? "检索测试将在阶段 4 接入混合检索后开放。" : "知识库中暂无可检索文档。"}</p></section>
      <section className="panel retrieval-results"><div className="panel-heading compact"><div><h2>召回结果</h2><p>检索完成后显示融合和重排结果</p></div></div><EmptyState compact icon={Search} title="暂无检索结果" description="添加可用文档并输入测试问题后开始检索。" /></section>
    </div>
  );
}

function SettingsPanel({ kb, setToast, onSaved, onDeleted }: { kb: KnowledgeBase; setToast: Notify; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const { models, loading, error: modelsError } = useEmbeddingModels(true);
  const [form, setForm] = useState({ name: kb.name, description: kb.description, embeddingModelId: kb.embeddingModelId, chunkSize: String(kb.chunkSize), chunkOverlap: String(kb.chunkOverlap) });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const rebuilding = kb.status === "rebuilding";

  const chunkSize = Number(form.chunkSize);
  const chunkOverlap = Number(form.chunkOverlap);
  const validation = !form.name.trim() ? "请填写知识库名称"
    : !Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 4000 ? "分段大小需为 100–4000 的整数"
    : !Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 1000 ? "分段重叠需为 0–1000 的整数"
    : chunkOverlap >= chunkSize ? "分段重叠必须小于分段大小" : null;
  const changes: Partial<KnowledgeBaseInput> = {};
  if (form.name.trim() !== kb.name) changes.name = form.name.trim();
  if (form.description.trim() !== kb.description) changes.description = form.description.trim();
  if (form.embeddingModelId !== kb.embeddingModelId) changes.embeddingModelId = form.embeddingModelId;
  if (chunkSize !== kb.chunkSize) changes.chunkSize = chunkSize;
  if (chunkOverlap !== kb.chunkOverlap) changes.chunkOverlap = chunkOverlap;
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
        <div className="panel-heading compact"><div><h2>知识库配置</h2><p>更换 Embedding 模型会重建全部向量；分段参数只影响之后导入或重新处理的文档</p></div></div>
        <div className="form-grid">
          <label><span>知识库名称</span><input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={rebuilding} /></label>
          <label><span>Embedding 模型</span>
            <select value={form.embeddingModelId} onChange={(event) => setForm({ ...form, embeddingModelId: event.target.value })} disabled={rebuilding || loading}>
              {currentModelMissing ? <option value={kb.embeddingModelId}>{kb.embeddingModelName}（当前）</option> : null}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.vectorDimension} 维</option>)}
            </select>
            {modelsError ? <small>{modelsError}</small> : null}
          </label>
          <label className="wide-field"><span>知识库说明</span><textarea value={form.description} maxLength={2000} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="说明知识范围，阶段 4 将用于自动选库" disabled={rebuilding} /></label>
          <label><span>分段大小（Token）</span><input type="number" min={100} max={4000} value={form.chunkSize} onChange={(event) => setForm({ ...form, chunkSize: event.target.value })} disabled={rebuilding} /></label>
          <label><span>分段重叠（Token）</span><input type="number" min={0} max={1000} value={form.chunkOverlap} onChange={(event) => setForm({ ...form, chunkOverlap: event.target.value })} disabled={rebuilding} /></label>
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
  const [form, setForm] = useState({ name: "", description: "", embeddingModelId: "", chunkSize: "800", chunkOverlap: "120" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const embeddingModelId = form.embeddingModelId || models[0]?.id || "";
  const chunkSize = Number(form.chunkSize);
  const chunkOverlap = Number(form.chunkOverlap);
  const validation = !Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 4000 ? "分段大小需为 100–4000 的整数"
    : !Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 1000 ? "分段重叠需为 0–1000 的整数"
    : chunkOverlap >= chunkSize ? "分段重叠必须小于分段大小" : null;

  const close = (next: boolean) => {
    if (submitting) return;
    onOpenChange(next);
    if (!next) window.setTimeout(() => { setForm({ name: "", description: "", embeddingModelId: "", chunkSize: "800", chunkOverlap: "120" }); setError(null); }, 150);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const created = await createKnowledgeBase({ name: form.name.trim(), description: form.description.trim(), embeddingModelId, chunkSize, chunkOverlap });
      setSubmitting(false);
      close(false);
      await onCreated(created);
    } catch (reason) {
      setError(errorMessage(reason, "创建失败"));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={close} title="新建知识库" description="每个知识库使用独立的 Embedding 模型和向量集合。">
      <div className="modal-form">
        <label><span>名称</span><input autoFocus value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="输入知识库名称" /></label>
        <label><span>说明</span><textarea value={form.description} maxLength={2000} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="说明知识范围，阶段 4 将用于自动选库" /></label>
        <label><span>Embedding 模型</span>
          <select value={embeddingModelId} onChange={(event) => setForm({ ...form, embeddingModelId: event.target.value })} disabled={loading || !models.length}>
            {loading ? <option value="">正在加载…</option> : null}
            {!loading && !models.length ? <option value="">尚无可用模型</option> : null}
            {models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.vectorDimension} 维</option>)}
          </select>
          {modelsError ? <small className="field-error">{modelsError}</small> : null}
          {!loading && !models.length && !modelsError ? <small>{role === "admin" ? "请先在“模型服务”中添加启用的 Embedding 模型并填写向量维度。" : "请联系管理员在“模型服务”中添加 Embedding 模型。"}</small> : null}
        </label>
        <div className="form-row">
          <label><span>分段大小（Token）</span><input type="number" min={100} max={4000} value={form.chunkSize} onChange={(event) => setForm({ ...form, chunkSize: event.target.value })} /></label>
          <label><span>分段重叠（Token）</span><input type="number" min={0} max={1000} value={form.chunkOverlap} onChange={(event) => setForm({ ...form, chunkOverlap: event.target.value })} /></label>
        </div>
        {validation ? <InlineAlert tone="warning">{validation}</InlineAlert> : null}
        {error ? <InlineAlert>{error}</InlineAlert> : null}
      </div>
      <div className="dialog-actions"><Button onClick={() => close(false)} disabled={submitting}>取消</Button><Button variant="primary" onClick={() => void submit()} disabled={!form.name.trim() || !embeddingModelId || Boolean(validation) || submitting}>{submitting ? "创建中…" : "创建知识库"}</Button></div>
    </Modal>
  );
}

function ImportWizard({ open, kb, onOpenChange, onImported }: { open: boolean; kb: KnowledgeBase; onOpenChange: (open: boolean) => void; onImported: (document: KnowledgeDocument) => Promise<void> }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [parseStrategy, setParseStrategy] = useState<"smart" | "fast">("smart");
  const [enhanceImages, setEnhanceImages] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const extension = file ? extensionOf(file.name) : "";
  const local = LOCAL_PARSE_EXTENSIONS.includes(extension);
  const image = IMAGE_EXTENSIONS.includes(extension);

  const reset = () => { setStep(1); setFile(null); setFileError(null); setParseStrategy("smart"); setEnhanceImages(true); setProgress(0); setSubmitError(null); setDuplicate(null); };
  const close = (next: boolean) => {
    if (uploading) return;
    onOpenChange(next);
    if (!next) window.setTimeout(reset, 150);
  };

  const choose = (selected: File | null) => {
    setSubmitError(null);
    setDuplicate(null);
    if (!selected) { setFile(null); setFileError(null); return; }
    const selectedExtension = extensionOf(selected.name);
    if (!ACCEPTED_EXTENSIONS.includes(selectedExtension)) setFileError(`不支持 .${selectedExtension || "无扩展名"} 文件`);
    else if (selected.size === 0) setFileError("文件内容为空");
    else if (selected.size > MAX_UPLOAD_BYTES) setFileError(`文件为 ${formatBytes(selected.size)}，超过 100 MB 上限`);
    else setFileError(null);
    setFile(selected);
  };

  const submit = async (allowDuplicate: boolean) => {
    if (!file) return;
    setUploading(true);
    setProgress(0);
    setSubmitError(null);
    setDuplicate(null);
    try {
      const document = await uploadDocument(kb.id, file, { parseStrategy, enhanceImages, allowDuplicate }, setProgress);
      setUploading(false);
      close(false);
      await onImported(document);
    } catch (reason) {
      setUploading(false);
      if (reason instanceof ApiError && reason.status === 409 && typeof reason.detail === "object") setDuplicate(reason.message);
      else setSubmitError(errorMessage(reason, "上传失败"));
    }
  };

  const parseLabel = local ? "本地结构化解析" : parseStrategy === "smart" ? "智能解析（大模型增强）" : "快速解析";
  return (
    <Modal open={open} onOpenChange={close} title="导入知识" description={`导入到“${kb.name}”，依次完成解析、切分和向量化。`} width="wide">
      <div className="wizard-steps" aria-label={`当前第 ${step} 步，共 3 步`}>{["选择文件", "解析设置", "确认导入"].map((label, index) => <div key={label} className={cn(index + 1 < step && "wizard-done", index + 1 === step && "wizard-current")}><span>{index + 1 < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}</div>
      {step === 1 ? <div className="wizard-body">
        <input className="sr-only" id="knowledge-file" type="file" accept={ACCEPTED_EXTENSIONS.map((item) => `.${item}`).join(",")} onChange={(event) => { choose(event.target.files?.[0] ?? null); event.target.value = ""; }} />
        <label className="drop-zone" htmlFor="knowledge-file"><UploadCloud size={26} /><strong>点击选择文件</strong><span>支持 Word、PDF、Markdown、图片、CSV 和 Excel，单文件最大 100 MB</span></label>
        {file ? <div className="selected-file"><FileText size={18} /><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {local ? "本地结构化解析" : "云端文档解析"}</small></span><button className="icon-button" aria-label="移除文件" onClick={() => choose(null)}><X size={16} /></button></div> : null}
        {fileError ? <InlineAlert>{fileError}</InlineAlert> : null}
      </div> : null}
      {step === 2 ? <div className="wizard-body option-list">
        {local ? <InlineAlert tone="info" title="本地结构化解析">Markdown、CSV 和 Excel 直接在服务器解析，保留标题层级、表头和工作表名，不发送到云端。</InlineAlert> : <>
          <label className="option-card"><input type="radio" name="parse" checked={parseStrategy === "smart"} onChange={() => setParseStrategy("smart")} /><span><strong>智能解析</strong><small>开启大模型增强，更好地还原标题层级、表格和复杂版面；耗时和费用更高。</small></span><Sparkles size={18} /></label>
          <label className="option-card"><input type="radio" name="parse" checked={parseStrategy === "fast"} onChange={() => setParseStrategy("fast")} /><span><strong>快速解析</strong><small>标准版面解析，适合结构简单的数字文档，速度更快、费用更低。</small></span><Zap size={18} /></label>
        </>}
        {image ? <label className="switch-row"><span><strong>图片语义描述</strong><small>OCR 之外，由管理员配置的视觉模型补充图表和照片的语义描述</small></span><input type="checkbox" checked={enhanceImages} onChange={(event) => setEnhanceImages(event.target.checked)} aria-label="启用图片语义描述" /></label> : null}
        <p className="form-hint">分段大小 {kb.chunkSize} Token，重叠 {kb.chunkOverlap} Token，可在知识库“配置”中调整。</p>
      </div> : null}
      {step === 3 ? <div className="wizard-body confirm-grid">
        <div><span>文件</span><strong>{file?.name}</strong></div>
        <div><span>大小</span><strong>{file ? formatBytes(file.size) : "—"}</strong></div>
        <div><span>解析方式</span><strong>{parseLabel}</strong></div>
        <div><span>Embedding</span><strong>{kb.embeddingModelName} · {kb.vectorDimension} 维</strong></div>
        {image ? <div><span>图片处理</span><strong>{enhanceImages ? "OCR + 视觉描述" : "仅 OCR"}</strong></div> : null}
        {!local ? <div className="privacy-note"><ShieldAlert size={17} /><span>文档内容将发送至阿里云文档智能解析。请确认文件符合企业数据出域规范。</span></div> : null}
        {uploading ? <div className="upload-progress" role="status"><span>{progress < 1 ? `正在上传 ${Math.round(progress * 100)}%` : "上传完成，正在创建处理任务…"}</span><span className="progress-track"><span className="progress-bar" style={{ width: `${Math.max(progress * 100, 3)}%` }} /></span></div> : null}
        {duplicate ? <div className="wide-field"><InlineAlert tone="warning" title="文件可能重复" action={<Button onClick={() => void submit(true)} disabled={uploading}>仍然导入</Button>}>{duplicate}</InlineAlert></div> : null}
        {submitError ? <div className="wide-field"><InlineAlert title="导入失败">{submitError}</InlineAlert></div> : null}
      </div> : null}
      <div className="dialog-actions">
        <Button onClick={() => step === 1 ? close(false) : setStep(step - 1)} disabled={uploading}>{step === 1 ? "取消" : "上一步"}</Button>
        <Button variant="primary" onClick={() => step === 3 ? void submit(false) : setStep(step + 1)} disabled={!file || Boolean(fileError) || uploading}>{step === 3 ? (uploading ? "导入中…" : submitError ? "重试导入" : "开始导入") : "下一步"}</Button>
      </div>
    </Modal>
  );
}
