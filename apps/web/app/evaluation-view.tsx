"use client";

import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Download, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentApp } from "./api-client";
import {
  createEvaluation, deleteEvaluation, downloadEvaluations, listEvaluations, updateEvaluation,
  type EvaluationCase, type EvaluationInput,
} from "./evaluation-client";
import type { ObservationFilters } from "./observability-client";
import { Button, EmptyState, Modal, StatusBadge } from "./ui";

const PAGE_SIZE = 20;
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const emptyForm: EvaluationInput = { kind: "good", question: "", actual_answer: "", notes: "", agent_id: null, source_query_id: null };
const formatDate = (value: string) => new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

export function EvaluationView({ filters, agents, setToast, setErrorToast }: {
  filters: ObservationFilters;
  agents: AgentApp[];
  setToast: (message: string) => void;
  setErrorToast: (message: string) => void;
}) {
  const [kind, setKind] = useState("");
  const [agentId, setAgentId] = useState(filters.agentId ?? "");
  const [query, setQuery] = useState(filters.q ?? "");
  const [appliedQuery, setAppliedQuery] = useState(filters.q ?? "");
  const [items, setItems] = useState<EvaluationCase[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState(false);
  const [detail, setDetail] = useState<EvaluationCase | null>(null);
  const [editing, setEditing] = useState<EvaluationCase | null>(null);
  const [form, setForm] = useState<EvaluationInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const activeFilters = { q: appliedQuery.trim() || undefined, agentId: agentId || undefined };
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await listEvaluations({ ...activeFilters, kind: kind || undefined, offset, limit: PAGE_SIZE });
      setItems(result.items); setTotal(result.total);
    } catch (reason) { setError(errorMessage(reason, "评测集加载失败")); }
    finally { setLoading(false); }
  }, [agentId, appliedQuery, kind, offset]);
  useEffect(() => { void load(); }, [load]);

  const open = (item?: EvaluationCase) => {
    setDetail(null);
    setEditing(item ?? null);
    setForm(item ? { kind: item.kind, question: item.question, actual_answer: item.actual_answer, notes: item.notes, agent_id: item.agent_id, source_query_id: item.source_query_id } : { ...emptyForm, agent_id: agentId || null });
    setFormError(null);
    setModal(true);
  };
  const save = async () => {
    setSaving(true); setFormError(null);
    try {
      const input = { ...form, question: form.question.trim(), notes: form.notes.trim() };
      if (editing) await updateEvaluation(editing.id, input);
      else await createEvaluation(input);
      setModal(false);
      setToast(editing ? "评测样例已更新" : "已加入评测集");
      await load();
    } catch (reason) { setFormError(errorMessage(reason, "保存失败")); }
    finally { setSaving(false); }
  };
  const remove = async (item: EvaluationCase) => {
    if (!window.confirm(`确定删除这条 ${item.kind === "good" ? "goodcase" : "badcase"}？`)) return;
    try { await deleteEvaluation(item.id); setToast("评测样例已删除"); await load(); }
    catch (reason) { setErrorToast(errorMessage(reason, "删除失败")); }
  };
  const exportData = async (format: "csv" | "jsonl") => {
    setExporting(true);
    try { await downloadEvaluations(format, { ...activeFilters, kind: kind || undefined }); setToast(`已导出 ${format.toUpperCase()} 评测集`); }
    catch (reason) { setErrorToast(errorMessage(reason, "导出失败")); }
    finally { setExporting(false); }
  };

  return <div className="content-stack evaluation-page">
    <div className="toolbar evaluation-toolbar">
      <form className="evaluation-filters" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query); setOffset(0); }}>
        <div className="search-box"><Search size={15} /><input aria-label="搜索评测样例" placeholder="搜索问题或回答" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <select aria-label="筛选评测应用" value={agentId} onChange={(event) => { setAgentId(event.target.value); setOffset(0); }}><option value="">全部应用</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
        <select aria-label="筛选样例类型" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }}><option value="">全部样例</option><option value="good">Goodcase</option><option value="bad">Badcase</option></select>
        <Button type="submit">查询</Button>
      </form>
      <div className="evaluation-actions">
        <details className="export-menu"><summary className="button button-secondary"><Download size={16} /><span>{exporting ? "导出中…" : "导出"}</span><ChevronDown size={14} /></summary><div><button disabled={exporting} onClick={() => void exportData("csv")}>导出 CSV</button><button disabled={exporting} onClick={() => void exportData("jsonl")}>导出 JSONL</button></div></details>
        <Button variant="primary" icon={Plus} onClick={() => open()}>新增样例</Button>
      </div>
    </div>
    <section className="panel">
      <div className="panel-heading compact"><div><h2>评测样例</h2><p>共 {total} 条真实标注样例，点击问题查看完整内容</p></div><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>刷新</Button></div>
      {error ? <div className="inline-error">{error}<Button onClick={() => void load()}>重试</Button></div> : null}
      {loading ? <div className="loading-panel">正在加载评测样例…</div> : items.length ? <div className="evaluation-list">
        <div className="evaluation-list-head"><span>类型</span><span>问题与原始回答</span><span>应用 / 来源</span><span>操作</span></div>
        {items.map((item) => <article className="evaluation-row" key={item.id}>
          <StatusBadge status={item.kind === "good" ? "success" : "error"}>{item.kind === "good" ? "Goodcase" : "Badcase"}</StatusBadge>
          <button className="evaluation-row-main" onClick={() => setDetail(item)}><strong>{item.question}</strong><span>{item.actual_answer || "未填写原始回答"}</span>{item.notes ? <small>备注：{item.notes}</small> : null}</button>
          <span className="evaluation-meta"><strong>{item.agent_name}</strong><small>{item.source_query_id ? "来自对话" : "手工创建"} · {formatDate(item.created_at)}</small></span>
          <div className="evaluation-row-actions"><Button variant="ghost" icon={Pencil} onClick={() => open(item)}>编辑</Button><Button variant="ghost" icon={Trash2} onClick={() => void remove(item)}>删除</Button></div>
        </article>)}
      </div> : <EmptyState icon={CheckCircle2} title="没有符合条件的评测样例" description="可调整筛选条件，或从对话详情标记 goodcase/badcase。" action={<Button variant="primary" icon={Plus} onClick={() => open()}>新增样例</Button>} />}
      {total > PAGE_SIZE ? <div className="pagination"><span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页 / 共 {Math.ceil(total / PAGE_SIZE)} 页</span><div><Button icon={ArrowLeft} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button><Button icon={ArrowRight} disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button></div></div> : null}
    </section>

    <Modal open={Boolean(detail)} onOpenChange={(openState) => !openState && setDetail(null)} title="评测样例详情" description={detail ? `${detail.kind === "good" ? "Goodcase" : "Badcase"} · ${detail.agent_name}` : undefined} width="wide">
      {detail ? <div className="evaluation-detail"><section><h3>问题</h3><p>{detail.question}</p></section><section><h3>原始回答</h3><p>{detail.actual_answer || "未填写"}</p></section>{detail.notes ? <section><h3>备注</h3><p>{detail.notes}</p></section> : null}<div className="dialog-actions"><Button onClick={() => setDetail(null)}>关闭</Button><Button variant="primary" icon={Pencil} onClick={() => open(detail)}>编辑样例</Button></div></div> : null}
    </Modal>

    <Modal open={modal} onOpenChange={setModal} title={editing ? "编辑评测样例" : "新增评测样例"} description="保存问题、实际回答和人工备注。" width="wide"><div className="evaluation-form"><div className="form-grid"><label><span>样例类型</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "good" | "bad" })}><option value="good">Goodcase（正确示例）</option><option value="bad">Badcase（问题示例）</option></select></label><label><span>关联应用</span><select value={form.agent_id ?? ""} onChange={(event) => setForm({ ...form, agent_id: event.target.value || null })}><option value="">全库知识问答</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="wide-field"><span>问题（必填）</span><textarea value={form.question} maxLength={10000} onChange={(event) => setForm({ ...form, question: event.target.value })} /></label><label className="wide-field"><span>原始回答</span><textarea value={form.actual_answer} maxLength={20000} onChange={(event) => setForm({ ...form, actual_answer: event.target.value })} /></label><label className="wide-field"><span>备注</span><textarea value={form.notes} maxLength={4000} placeholder="记录正确点、错误原因或改进建议" onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label></div>{formError ? <p className="form-error" role="alert">{formError}</p> : null}<div className="dialog-actions"><Button onClick={() => setModal(false)} disabled={saving}>取消</Button><Button variant="primary" disabled={!form.question.trim() || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存样例"}</Button></div></div></Modal>
  </div>;
}
