"use client";

import { Activity, ArrowLeft, ArrowRight, BarChart3, Bot, Database, ListFilter, RefreshCw, Search, Settings2, ShieldAlert, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { listAgents, type AgentApp } from "./api-client";
import { createEvaluation } from "./evaluation-client";
import { EvaluationView } from "./evaluation-view";
import { ObservabilityOverview } from "./observability-overview";
import {
  getAgentRun, getBilling, getIngestionRun, getObservabilitySummary, listAgentRuns,
  listIngestionRuns, listModelPrices, listObservedConversations, listOperations, updateModelPrice,
  type AgentRun, type AgentRunDetail, type Billing, type IngestionDetail, type IngestionRun,
  type ModelCall, type ModelPrice, type ObservabilitySummary, type ObservationFilters, type Operation, type UsageGroup,
} from "./observability-client";
import { Button, EmptyState, Metric, Modal, StatusBadge, cn } from "./ui";

const PAGE_SIZE = 20;
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const statusView = (status: string) => ({
  completed: { tone: "success", label: "成功" }, succeeded: { tone: "success", label: "成功" },
  failed: { tone: "error", label: "失败" }, cancelled: { tone: "warning", label: "已中断" },
  running: { tone: "progress", label: "进行中" }, queued: { tone: "neutral", label: "排队中" },
}[status] ?? { tone: "neutral", label: status });
const formatMs = (value: number | null) => value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const formatDate = (value: string | null) => {
  if (!value) return "—";
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  return new Date(normalized).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};
const money = (value: number, currency: string | null = "CNY") => `${currency === "USD" ? "$" : "¥"}${value < 0.01 ? value.toFixed(6) : value.toFixed(2)}`;
const toIso = (value: string) => value ? new Date(value).toISOString() : undefined;

function Filters({ draft, setDraft, agents, onApply, onReset, conversation }: {
  draft: { q: string; status: string; agentId: string; start: string; end: string };
  setDraft: (value: { q: string; status: string; agentId: string; start: string; end: string }) => void;
  agents: AgentApp[]; onApply: () => void; onReset: () => void; conversation: boolean;
}) {
  return <form className="observation-filters" onSubmit={(event) => { event.preventDefault(); onApply(); }}>
    <div className="search-box"><Search size={15} /><input aria-label="搜索观测内容" placeholder={conversation ? "搜索问题或回答" : "搜索文档或运行内容"} value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} /></div>
    <select aria-label="筛选应用" value={draft.agentId} onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}><option value="">全部应用</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    <select aria-label="筛选运行状态" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="">全部状态</option><option value="completed">成功</option><option value="failed">失败</option><option value="cancelled">已中断</option><option value="running">进行中</option></select>
    <label><span>开始</span><input type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} /></label>
    <label><span>结束</span><input type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} /></label>
    <Button type="submit" icon={ListFilter}>筛选</Button><Button variant="ghost" onClick={onReset}>重置</Button>
  </form>;
}

function Pagination({ total, offset, onChange }: { total: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return <div className="pagination"><span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页 / 共 {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页</span><div><Button icon={ArrowLeft} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>上一页</Button><Button icon={ArrowRight} disabled={offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}>下一页</Button></div></div>;
}

function ModelCalls({ calls }: { calls: ModelCall[] }) {
  return <section className="observation-section"><h3>模型调用（{calls.length}）</h3>{calls.length ? <div className="observation-call-list">{calls.map((call, index) => <details key={call.id} open={index === 0}><summary><span><strong>{call.purpose}</strong><small>{call.provider} / {call.model_id}</small></span><StatusBadge status={call.status === "completed" ? "success" : "error"}>{call.status === "completed" ? "成功" : "失败"}</StatusBadge></summary><div className="observation-call-body"><dl className="observation-metrics"><div><dt>Token</dt><dd>{call.input_tokens} + {call.output_tokens} = {call.total_tokens}{call.estimated ? "（估算）" : ""}</dd></div><div><dt>耗时 / 重试</dt><dd>{formatMs(call.latency_ms)} / {call.retry_count}</dd></div><div><dt>估算费用</dt><dd>{call.estimated_cost === null ? "未计价" : money(call.estimated_cost, call.currency)}</dd></div><div><dt>协议</dt><dd>{call.protocol}</dd></div></dl>{call.error_message ? <p className="error-text">{call.error_message}</p> : null}<h4>调用上下文</h4>{call.input_context === null ? <p className="form-hint">历史记录未采集上下文。</p> : <pre className="context-view">{JSON.stringify(call.input_context, null, 2)}</pre>}<h4>模型输出</h4><pre className="context-view">{call.output_content ?? "历史记录未采集输出。"}</pre></div></details>)}</div> : <p className="form-hint">本次没有模型调用。</p>}</section>;
}

function Operations({ operations }: { operations: Operation[] }) {
  const tools = operations.filter((item) => item.kind === "tool");
  const skills = operations.filter((item) => item.kind === "skill");
  const harness = operations.filter((item) => item.kind === "harness" || item.kind === "doc_parser");
  const cards = (items: Operation[]) => <div className="operation-list">{items.map((item) => <article key={item.id}><div><strong>{item.operation}</strong><StatusBadge status={statusView(item.status).tone}>{statusView(item.status).label}</StatusBadge></div><small>{formatDate(item.created_at)} · {formatMs(item.latency_ms)}{item.http_status ? ` · HTTP ${item.http_status}` : ""}</small>{item.error_message ? <p className="error-text">{item.error_type}: {item.error_message}</p> : null}{item.input_json !== null && item.input_json !== undefined ? <details><summary>输入</summary><pre className="context-view">{JSON.stringify(item.input_json, null, 2)}</pre></details> : null}{item.output_json !== null && item.output_json !== undefined ? <details><summary>输出</summary><pre className="context-view">{JSON.stringify(item.output_json, null, 2)}</pre></details> : null}</article>)}</div>;
  return <><section className="observation-section"><h3>工具调用（{tools.length}）</h3>{tools.length ? cards(tools) : <p className="form-hint">本次没有执行工具调用；应用绑定工具不等于实际调用。</p>}</section><section className="observation-section"><h3>Skill 调用（{skills.length}）</h3>{skills.length ? cards(skills) : <p className="form-hint">Skill 运行时未接入，暂无真实调用记录。</p>}</section><section className="observation-section"><h3>Harness 与解析事件（{harness.length}）</h3>{harness.length ? cards(harness) : <p className="form-hint">本次没有 Harness 异常或文档解析事件。</p>}</section></>;
}

function AgentDetail({ detail, loading, onAddCase, caseNotice, savingKind }: { detail: AgentRunDetail | null; loading: boolean; onAddCase: (kind: "good" | "bad") => void; caseNotice: string | null; savingKind: "good" | "bad" | null }) {
  if (loading) return <aside className="observation-detail"><div className="loading-panel">正在加载运行详情…</div></aside>;
  if (!detail) return <aside className="observation-detail"><EmptyState compact icon={Bot} title="选择一次 Agent 运行" description="查看单次输入输出、上下文、工具状态、异常与消耗。" /></aside>;
  return <aside className="observation-detail"><div className="observation-detail-heading"><div><span className="eyebrow">{detail.agent_name}</span><h2>运行详情</h2><p>{formatDate(detail.created_at)}</p></div><StatusBadge status={statusView(detail.status).tone}>{statusView(detail.status).label}</StatusBadge></div>
    <section className="observation-section"><h3>单次输入</h3><p className="run-question">{detail.question}</p><h3>单次输出</h3><p className="run-answer">{detail.answer || "未生成回答"}</p>{detail.error_message ? <p className="error-text">{detail.failed_stage} · {detail.error_type}: {detail.error_message}</p> : null}<div className="case-actions"><Button icon={ThumbsUp} disabled={Boolean(savingKind)} onClick={() => onAddCase("good")}>{savingKind === "good" ? "加入中…" : "加入 Goodcase"}</Button><Button icon={ThumbsDown} disabled={Boolean(savingKind)} onClick={() => onAddCase("bad")}>{savingKind === "bad" ? "加入中…" : "加入 Badcase"}</Button></div>{caseNotice ? <p className="inline-success" role="status">{caseNotice}</p> : null}</section>
    <section className="observation-section"><h3>运行状态与消耗</h3><dl className="observation-metrics"><div><dt>总耗时</dt><dd>{formatMs(detail.total_ms)}</dd></div><div><dt>首 Token</dt><dd>{formatMs(detail.first_token_ms)}</dd></div><div><dt>Token</dt><dd>{detail.total_tokens.toLocaleString()}{detail.estimated_tokens ? `（${detail.estimated_tokens} 估算）` : ""}</dd></div><div><dt>估算费用</dt><dd>{money(detail.estimated_cost)}{detail.has_unpriced_calls ? "，含未计价" : ""}</dd></div><div><dt>选库 / 检索 / Rerank</dt><dd>{formatMs(detail.route_ms)} / {formatMs(detail.retrieval_ms)} / {formatMs(detail.rerank_ms)}</dd></div><div><dt>重试</dt><dd>{detail.retry_count} 次</dd></div></dl></section>
    <section className="observation-section"><h3>知识路由</h3><p>{detail.route.length ? detail.route.map((item) => `${item.name}（${item.score.toFixed(3)}）`).join("、") : "未选择知识库"}</p>{detail.citations.length ? <div className="observation-citations">{detail.citations.map((citation) => <details key={`${citation.index}-${citation.filename}`}><summary>[{citation.index}] {citation.filename}</summary><p>{citation.content}</p></details>)}</div> : <small>没有引用</small>}</section>
    <ModelCalls calls={detail.model_calls} /><Operations operations={detail.operations} />
  </aside>;
}

function AgentRuns({ filters, conversations }: { filters: ObservationFilters; conversations: boolean }) {
  const [items, setItems] = useState<AgentRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [caseNotice, setCaseNotice] = useState<string | null>(null);
  const [savingKind, setSavingKind] = useState<"good" | "bad" | null>(null);
  const addCase = async (kind: "good" | "bad") => {
    if (!detail) return;
    setSavingKind(kind); setCaseNotice(null); setError(null);
    try {
      await createEvaluation({ kind, question: detail.question, actual_answer: detail.answer, notes: "", agent_id: detail.agent_id, source_query_id: detail.id });
      setCaseNotice(`已加入 ${kind === "good" ? "Goodcase" : "Badcase"}，可在“评测集”中编辑和导出。`);
    } catch (reason) { setError(errorMessage(reason, "加入评测集失败")); }
    finally { setSavingKind(null); }
  };
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const request = conversations ? listObservedConversations : listAgentRuns; const result = await request({ ...filters, offset, limit: PAGE_SIZE }); setItems(result.items); setTotal(result.total); }
    catch (reason) { setError(errorMessage(reason, "运行记录加载失败")); }
    finally { setLoading(false); }
  }, [conversations, filters, offset]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { setCaseNotice(null); setDetailLoading(true); try { setDetail(await getAgentRun(id)); } catch (reason) { setError(errorMessage(reason, "运行详情加载失败")); } finally { setDetailLoading(false); } };
  return <div className="observation-split"><section className="panel observation-list-panel"><div className="panel-heading compact"><div><h2>{conversations ? "对话日志" : "Agent 调用"}</h2><p>共 {total} 条真实运行记录</p></div><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>刷新</Button></div>{error ? <div className="inline-error">{error}<Button onClick={() => void load()}>重试</Button></div> : null}{loading ? <div className="loading-panel">正在加载运行记录…</div> : items.length ? <div className="observation-run-list">{items.map((item) => <button key={item.id} className={cn("observation-run-row", detail?.id === item.id && "selected-row")} onClick={() => void open(item.id)}><span className="run-status"><StatusBadge status={statusView(item.status).tone}>{statusView(item.status).label}</StatusBadge></span><span className="run-main"><strong>{item.question}</strong><small>{item.agent_name} · {formatDate(item.created_at)}</small>{item.error_message ? <small className="error-text">{item.error_message}</small> : null}</span><span className="run-usage"><strong>{item.total_tokens}</strong><small>Token</small></span><span className="run-time">{formatMs(item.total_ms)}</span></button>)}</div> : <EmptyState icon={Bot} title="没有符合条件的运行记录" description="完成一次应用问答后，输入输出和真实链路会显示在这里。" />}<Pagination total={total} offset={offset} onChange={setOffset} /></section><AgentDetail detail={detail} loading={detailLoading} onAddCase={(kind) => void addCase(kind)} caseNotice={caseNotice} savingKind={savingKind} /></div>;
}

function IngestionDetailPanel({ detail, loading }: { detail: IngestionDetail | null; loading: boolean }) {
  if (loading) return <aside className="observation-detail"><div className="loading-panel">正在加载构建详情…</div></aside>;
  if (!detail) return <aside className="observation-detail"><EmptyState compact icon={Database} title="选择一次知识构建" description="查看解析、切分、向量化、错误和模型用量。" /></aside>;
  return <aside className="observation-detail"><div className="observation-detail-heading"><div><span className="eyebrow">{detail.knowledge_base_name}</span><h2>{detail.filename}</h2><p>{formatDate(detail.created_at)}</p></div><StatusBadge status={statusView(detail.status).tone}>{statusView(detail.status).label}</StatusBadge></div><section className="observation-section"><h3>构建状态</h3><div className="build-progress"><span>{detail.stage} · {detail.progress}%</span><div className="progress-track"><span className="progress-bar" style={{ width: `${detail.progress}%` }} /></div></div><dl className="observation-metrics"><div><dt>解析策略</dt><dd>{detail.parse_strategy}</dd></div><div><dt>切分方式</dt><dd>{detail.chunk_method}</dd></div><div><dt>分段 / 元数据</dt><dd>{detail.chunk_count} / {detail.metadata_status}</dd></div><div><dt>尝试次数</dt><dd>{detail.attempts}</dd></div><div><dt>Token</dt><dd>{detail.total_tokens.toLocaleString()}{detail.estimated_tokens ? `（${detail.estimated_tokens} 估算）` : ""}</dd></div><div><dt>估算费用</dt><dd>{money(detail.estimated_cost)}{detail.has_unpriced_calls ? "，含未计价" : ""}</dd></div></dl>{detail.error_message ? <p className="error-text">{detail.error_message}</p> : null}</section><ModelCalls calls={detail.model_calls} /><Operations operations={detail.operations} /></aside>;
}

function IngestionRuns({ filters }: { filters: ObservationFilters }) {
  const [items, setItems] = useState<IngestionRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<IngestionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const result = await listIngestionRuns({ ...filters, status: filters.status === "completed" ? "succeeded" : filters.status, offset, limit: PAGE_SIZE }); setItems(result.items); setTotal(result.total); }
    catch (reason) { setError(errorMessage(reason, "构建记录加载失败")); }
    finally { setLoading(false); }
  }, [filters, offset]);
  useEffect(() => { void load(); }, [load]);
  const open = async (id: string) => { setDetailLoading(true); try { setDetail(await getIngestionRun(id)); } catch (reason) { setError(errorMessage(reason, "构建详情加载失败")); } finally { setDetailLoading(false); } };
  return <div className="observation-split"><section className="panel observation-list-panel"><div className="panel-heading compact"><div><h2>知识库构建过程</h2><p>共 {total} 个真实导入任务</p></div><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>刷新</Button></div>{error ? <div className="inline-error">{error}<Button onClick={() => void load()}>重试</Button></div> : null}{loading ? <div className="loading-panel">正在加载构建记录…</div> : items.length ? <div className="observation-run-list">{items.map((item) => <button key={item.id} className={cn("observation-run-row", detail?.id === item.id && "selected-row")} onClick={() => void open(item.id)}><span className="run-status"><StatusBadge status={statusView(item.status).tone}>{statusView(item.status).label}</StatusBadge></span><span className="run-main"><strong>{item.filename}</strong><small>{item.knowledge_base_name} · {item.stage} {item.progress}% · 第 {item.attempts} 次</small>{item.error_message ? <small className="error-text">{item.error_message}</small> : null}</span><span className="run-usage"><strong>{item.total_tokens}</strong><small>Token</small></span><span className="run-time">{formatDate(item.created_at)}</span></button>)}</div> : <EmptyState icon={Database} title="没有符合条件的构建记录" description="导入文档后，解析、切分、向量化与错误会显示在这里。" />}<Pagination total={total} offset={offset} onChange={setOffset} /></section><IngestionDetailPanel detail={detail} loading={detailLoading} /></div>;
}

function OperationEvents({ filters }: { filters: ObservationFilters }) {
  const [kind, setKind] = useState("tool");
  const [items, setItems] = useState<Operation[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const result = await listOperations({ ...filters, kind, offset, limit: PAGE_SIZE }); setItems(result.items); setTotal(result.total); }
    catch (reason) { setError(errorMessage(reason, "工具与事件加载失败")); }
    finally { setLoading(false); }
  }, [filters, kind, offset]);
  useEffect(() => { void load(); }, [load]);
  return <section className="panel"><div className="panel-heading compact"><div><h2>工具、Skill 与 Harness 事件</h2><p>独立记录手动工具调用及未关联 Agent 的操作</p></div><div className="row"><select aria-label="事件类型" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }}><option value="tool">Tool</option><option value="skill">Skill</option><option value="harness">Harness</option><option value="doc_parser">DocMind</option></select><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>刷新</Button></div></div>{error ? <div className="inline-error">{error}<Button onClick={() => void load()}>重试</Button></div> : null}{loading ? <div className="loading-panel">正在加载事件…</div> : items.length ? <div className="event-card-grid">{items.map((item) => <article className="event-card" key={item.id}><div><span className="eyebrow">{item.kind}</span><StatusBadge status={statusView(item.status).tone}>{statusView(item.status).label}</StatusBadge></div><h3>{item.operation}</h3><p>{formatDate(item.created_at)} · {formatMs(item.latency_ms)}{item.http_status ? ` · HTTP ${item.http_status}` : ""}{item.unit_count ? ` · ${item.unit_count} ${item.unit_name ?? "次"}` : ""}</p>{item.error_message ? <p className="error-text">{item.error_type}: {item.error_message}</p> : null}{item.context_json !== null && item.context_json !== undefined ? <details><summary>调用上下文</summary><pre className="context-view">{JSON.stringify(item.context_json, null, 2)}</pre></details> : null}{item.input_json !== null && item.input_json !== undefined ? <details><summary>输入</summary><pre className="context-view">{JSON.stringify(item.input_json, null, 2)}</pre></details> : null}{item.output_json !== null && item.output_json !== undefined ? <details><summary>输出</summary><pre className="context-view">{JSON.stringify(item.output_json, null, 2)}</pre></details> : null}</article>)}</div> : <EmptyState icon={Wrench} title={kind === "skill" ? "Skill 运行时未接入" : "没有符合条件的操作记录"} description={kind === "skill" ? "当前没有真实 Skill 调用，不会生成示例数据。" : "执行工具、构建或异常操作后，真实事件会显示在这里。"} />}<Pagination total={total} offset={offset} onChange={setOffset} /></section>;
}

function UsageTable({ title, groups }: { title: string; groups: UsageGroup[] }) {
  return <section className="panel"><div className="panel-heading compact"><div><h2>{title}</h2><p>Token 来自实际返回或明确标记的估算</p></div></div>{groups.length ? <div className="usage-table"><div className="usage-row usage-header"><span>对象 / 币种</span><span>调用</span><span>输入 / 输出 Token</span><span>总 Token</span><span>估算费用</span></div>{groups.map((group, index) => <div className="usage-row" key={`${group.keys.join("-")}-${index}`}><span><strong>{group.keys[0] ?? "未关联对象"}</strong><small>{group.keys[1] ? `${group.keys[1]} · ` : ""}{group.keys.at(-1) ?? "未配置币种"}</small></span><span>{group.call_count}</span><span>{group.input_tokens.toLocaleString()} / {group.output_tokens.toLocaleString()}</span><span>{group.total_tokens.toLocaleString()}{group.estimated_tokens ? <small>{group.estimated_tokens} 估算</small> : null}</span><span>{money(group.estimated_cost, group.keys.at(-1))}{group.unpriced_call_count ? <small>{group.unpriced_call_count} 次未计价</small> : null}</span></div>)}</div> : <EmptyState compact icon={BarChart3} title="暂无消耗记录" description="执行模型调用后，费用与 Token 会显示在这里。" />}</section>;
}

function BillingView({ filters, setErrorToast }: { filters: ObservationFilters; setErrorToast: (message: string) => void }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ModelPrice | null>(null);
  const [inputPrice, setInputPrice] = useState("0");
  const [outputPrice, setOutputPrice] = useState("0");
  const [currency, setCurrency] = useState<"CNY" | "USD">("CNY");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const [usage, modelPrices] = await Promise.all([getBilling(filters), listModelPrices()]); setBilling(usage); setPrices(modelPrices); }
    catch (reason) { setErrorToast(errorMessage(reason, "计费数据加载失败")); }
    finally { setLoading(false); }
  }, [filters, setErrorToast]);
  useEffect(() => { void load(); }, [load]);
  const edit = (price: ModelPrice) => { setEditing(price); setInputPrice(price.input_price_per_million); setOutputPrice(price.output_price_per_million); setCurrency(price.currency); };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try { await updateModelPrice({ model_id: editing.model_id, input_price_per_million: Number(inputPrice), output_price_per_million: Number(outputPrice), currency }); setEditing(null); await load(); }
    catch (reason) { setErrorToast(errorMessage(reason, "价格保存失败")); }
    finally { setSaving(false); }
  };
  if (loading) return <div className="loading-panel">正在汇总真实计费数据…</div>;
  return <div className="content-stack"><div className="notice-banner"><BarChart3 size={17} /><div><strong>费用是按所填单价计算的估算值</strong><span>新价格只影响之后调用，历史快照不改写；未配置价格的调用单独标记，不代表供应商账单。</span></div></div><UsageTable title="按模型汇总" groups={billing?.models ?? []} /><UsageTable title="按 Agent 汇总" groups={billing?.agents ?? []} /><section className="panel"><div className="panel-heading compact"><div><h2>DocMind 文档解析</h2><p>只统计真实云端解析，本地解析不计入</p></div></div><dl className="observation-metrics billing-parser"><div><dt>云端调用</dt><dd>{billing?.doc_parser.call_count ?? 0} 次</dd></div><div><dt>文档数量</dt><dd>{billing?.doc_parser.document_count ?? 0}</dd></div><div><dt>未计价调用</dt><dd>{billing?.doc_parser.unpriced_call_count ?? 0}</dd></div><div><dt>估算费用</dt><dd>{money(billing?.doc_parser.estimated_cost ?? 0)}</dd></div></dl></section><section className="panel"><div className="panel-heading compact"><div><h2>模型单价配置</h2><p>单位：每 100 万 Token；仅用于后续调用的估算费用</p></div></div><div className="price-list">{prices.map((price) => <div key={price.model_id}><span><strong>{price.model_name}</strong><small>{price.provider} · {price.model_type}</small></span><span>{price.updated_at ? `${price.currency} ${price.input_price_per_million} / ${price.output_price_per_million}` : "未配置"}</span><Button icon={Settings2} onClick={() => edit(price)}>设置单价</Button></div>)}</div></section><Modal open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} title={`模型单价 · ${editing?.model_name ?? ""}`} description="输入和输出价格均按每 100 万 Token 计，不改变历史调用快照。"><div className="form-grid"><label><span>输入单价</span><input type="number" min="0" step="0.000001" value={inputPrice} onChange={(event) => setInputPrice(event.target.value)} /></label><label><span>输出单价</span><input type="number" min="0" step="0.000001" value={outputPrice} onChange={(event) => setOutputPrice(event.target.value)} /></label><label><span>币种</span><select value={currency} onChange={(event) => setCurrency(event.target.value as "CNY" | "USD")}><option value="CNY">CNY</option><option value="USD">USD</option></select></label></div><div className="dialog-actions"><Button onClick={() => setEditing(null)}>取消</Button><Button variant="primary" disabled={saving || Number(inputPrice) < 0 || Number(outputPrice) < 0} onClick={() => void save()}>{saving ? "保存中…" : "保存单价"}</Button></div></Modal></div>;
}

export function ObservabilityView({ sessionReady, setToast, setErrorToast }: { sessionReady: boolean; setToast: (message: string) => void; setErrorToast: (message: string) => void }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"overview" | "agents" | "ingestion" | "operations" | "conversations" | "evaluations" | "billing">(searchParams.get("tab") === "evaluations" ? "evaluations" : "overview");
  const [agents, setAgents] = useState<AgentApp[]>([]);
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const emptyDraft = { q: "", status: "", agentId: "", start: "", end: "" };
  const [draft, setDraft] = useState(emptyDraft);
  const [applied, setApplied] = useState<ObservationFilters>({});
  const loadSummary = useCallback(async () => {
    try { setSummary(await getObservabilitySummary(applied)); setSummaryError(null); }
    catch (reason) { setSummaryError(errorMessage(reason, "观测汇总加载失败")); }
  }, [applied]);
  useEffect(() => { if (sessionReady) { void loadSummary(); listAgents().then(setAgents).catch(() => setAgents([])); } }, [loadSummary, sessionReady]);
  return <div className={cn("content-stack observability-page", tab === "evaluations" && "observability-evaluation")}>{summaryError ? <div className="inline-error">{summaryError}<Button icon={RefreshCw} onClick={() => void loadSummary()}>重试</Button></div> : null}<section className="metric-strip"><Metric label="Agent 运行" value={String(summary?.run_count ?? 0)} note={summary?.success_rate == null ? "暂无完成记录" : `成功率 ${(summary.success_rate * 100).toFixed(1)}%`} icon={Bot} /><Metric label="知识构建" value={String(summary?.ingestion_count ?? 0)} note={`${summary?.failed_count ?? 0} 次问答失败`} icon={Database} /><Metric label="Token" value={(summary?.total_tokens ?? 0).toLocaleString()} note={`${summary?.estimated_tokens ?? 0} 为估算`} icon={Activity} /><Metric label="估算费用" value={money(summary?.estimated_cost ?? 0)} note={`${summary?.unpriced_call_count ?? 0} 次未计价`} icon={BarChart3} /></section><div className="observation-submetrics"><span>P50 {formatMs(summary?.p50_total_ms ?? null)}</span><span>P95 {formatMs(summary?.p95_total_ms ?? null)}</span><span>失败操作 {summary?.failed_operation_count ?? 0}</span><span>取消 {summary?.cancelled_count ?? 0} · 进行中 {summary?.running_count ?? 0}</span></div><Filters draft={draft} setDraft={setDraft} agents={agents} conversation={tab !== "ingestion"} onApply={() => setApplied({ q: draft.q.trim() || undefined, status: draft.status || undefined, agentId: draft.agentId || undefined, start: toIso(draft.start), end: toIso(draft.end) })} onReset={() => { setDraft(emptyDraft); setApplied({}); }} /><div className="tabs product-tabs">{(["overview", "agents", "ingestion", "operations", "conversations", "evaluations", "billing"] as const).map((item) => <button key={item} className={tab === item ? "tab-active" : ""} onClick={() => setTab(item)}>{{ overview: "运行概览", agents: "Agent 调用", ingestion: "知识构建", operations: "工具与事件", conversations: "对话日志", evaluations: "评测集", billing: "计费消耗" }[item]}</button>)}</div>{tab === "overview" ? <ObservabilityOverview filters={applied} /> : null}{tab === "agents" ? <AgentRuns filters={applied} conversations={false} /> : null}{tab === "ingestion" ? <IngestionRuns filters={applied} /> : null}{tab === "operations" ? <OperationEvents filters={applied} /> : null}{tab === "conversations" ? <AgentRuns filters={applied} conversations /> : null}{tab === "evaluations" ? <EvaluationView filters={applied} agents={agents} setToast={setToast} setErrorToast={setErrorToast} /> : null}{tab === "billing" ? <BillingView filters={applied} setErrorToast={setErrorToast} /> : null}</div>;
}
