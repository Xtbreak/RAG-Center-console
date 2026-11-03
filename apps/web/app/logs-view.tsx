"use client";

import { Activity, ArrowLeft, ArrowRight, ListFilter, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  getLogRetention,
  getQueryLog,
  listQueryLogs,
  updateLogRetention,
  type QueryLogDetail,
  type QueryLogSummary,
} from "./api-client";
import { Button, EmptyState, StatusBadge, cn } from "./ui";

const PAGE_SIZE = 20;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatMs(value: number | null) {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function statusView(status: QueryLogSummary["status"]) {
  return {
    completed: { tone: "success", label: "成功" },
    failed: { tone: "error", label: "失败" },
    cancelled: { tone: "warning", label: "已中断" },
    running: { tone: "progress", label: "进行中" },
  }[status];
}

function toIso(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

export function LogsView({ sessionReady }: { sessionReady: boolean }) {
  const [items, setItems] = useState<QueryLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<QueryLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retention, setRetention] = useState(90);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listQueryLogs({ q: appliedQuery, status, start: toIso(start), end: toIso(end), offset, limit: PAGE_SIZE });
      setItems(result.items);
      setTotal(result.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [appliedQuery, end, offset, start, status]);

  useEffect(() => { if (sessionReady) void load(); }, [load, sessionReady]);
  useEffect(() => {
    if (sessionReady) getLogRetention().then(setRetention).catch((reason) => setError(reason instanceof Error ? reason.message : "留存设置加载失败"));
  }, [sessionReady]);

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setAppliedQuery(query.trim());
    if (offset === 0 && appliedQuery === query.trim()) void load();
  };

  const resetFilters = () => {
    setQuery("");
    setAppliedQuery("");
    setStatus("");
    setStart("");
    setEnd("");
    setOffset(0);
  };

  const openLog = async (id: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      setSelected(await getQueryLog(id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "日志详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const saveRetention = async (event: FormEvent) => {
    event.preventDefault();
    setRetentionSaving(true);
    setNotice(null);
    try {
      setRetention(await updateLogRetention(retention));
      setNotice(`查询日志将保留 ${retention} 天，定时任务每小时清理一次。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "留存设置保存失败");
    } finally {
      setRetentionSaving(false);
    }
  };

  return (
    <div className="logs-layout">
      <section className="panel table-panel logs-table-panel">
        <form className="log-filters" onSubmit={applyFilters}>
          <div className="search-box"><Search size={16} /><input aria-label="搜索查询内容" placeholder="搜索问题或回答" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <label><span className="sr-only">状态</span><select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="">全部状态</option><option value="completed">成功</option><option value="failed">失败</option><option value="cancelled">已中断</option><option value="running">进行中</option></select></label>
          <label className="log-date-filter"><span>开始</span><input type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); setOffset(0); }} /></label>
          <label className="log-date-filter"><span>结束</span><input type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); setOffset(0); }} /></label>
          <Button type="submit" icon={ListFilter}>应用筛选</Button>
          <Button type="button" variant="ghost" onClick={resetFilters}>重置</Button>
        </form>
        <div className="log-summary"><strong>问答与路由记录</strong><span>共 {total} 条 · Token 为供应商用量或明确标记的估算值</span></div>
        {notice ? <div className="inline-success" role="status">{notice}</div> : null}
        {error ? <div className="inline-error" role="alert"><span>{error}</span><Button icon={RefreshCw} onClick={() => void load()}>重试</Button></div> : null}
        {loading ? <div className="inline-empty" role="status">正在加载查询日志…</div> : items.length ? (
          <div className="data-table logs-table">
            <div className="data-row data-header log-row"><span>状态</span><span>问题</span><span>命中知识库</span><span>Token</span><span>耗时</span><span>时间</span></div>
            {items.map((item) => {
              const view = statusView(item.status);
              return <button type="button" className={cn("data-row", "log-row", selected?.id === item.id && "selected-row")} key={item.id} onClick={() => void openLog(item.id)}>
                <span><StatusBadge status={view.tone}>{view.label}</StatusBadge></span>
                <span className="query-cell"><strong>{item.question}</strong><small>{item.errorMessage ?? (item.grounded ? "有依据回答" : "无依据回答")}</small></span>
                <span>{item.route.length ? item.route.map((route) => route.name).join("、") : "未选库"}</span>
                <span>{item.totalTokens}{item.estimated ? <small>估算</small> : null}</span>
                <span>{formatMs(item.totalMs)}</span>
                <span>{formatDate(item.createdAt)}</span>
              </button>;
            })}
          </div>
        ) : <EmptyState icon={Activity} title="没有符合条件的日志" description="完成在线问答后，查询、路由、Token、耗时和错误记录会显示在这里。" />}
        <div className="pagination"><span>第 {Math.floor(offset / PAGE_SIZE) + 1} 页 / 共 {Math.max(Math.ceil(total / PAGE_SIZE), 1)} 页</span><div><Button icon={ArrowLeft} disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}>上一页</Button><Button icon={ArrowRight} disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button></div></div>
      </section>
      <aside className="log-detail" aria-label="日志详情">
        <div className="panel-heading compact"><div><h2>调用详情</h2><p>{detailLoading ? "正在加载…" : selected ? formatDate(selected.createdAt) : "选择一条日志查看完整链路"}</p></div>{selected ? <button className="icon-button" aria-label="关闭日志详情" onClick={() => setSelected(null)}><X size={17} /></button> : null}</div>
        {selected ? <>
          <section><h3>问题与回答</h3><p className="log-question">{selected.question}</p><p>{selected.answer || "未生成回答"}</p>{selected.errorMessage ? <p className="error-text">{selected.errorMessage}</p> : null}</section>
          <section><h3>链路与耗时</h3><dl className="log-metrics"><div><dt>总耗时</dt><dd>{formatMs(selected.totalMs)}</dd></div><div><dt>首 Token</dt><dd>{formatMs(selected.firstTokenMs)}</dd></div><div><dt>选库</dt><dd>{formatMs(selected.routeMs)}</dd></div><div><dt>检索</dt><dd>{formatMs(selected.retrievalMs)}</dd></div><div><dt>Rerank</dt><dd>{formatMs(selected.rerankMs)}</dd></div><div><dt>重试</dt><dd>{selected.retryCount} 次</dd></div></dl></section>
          <section><h3>候选与最终选库</h3><p>候选：{selected.routeCandidates.length ? selected.routeCandidates.map((route) => `${route.name}（${route.score.toFixed(3)}）`).join("、") : "无"}</p><p>最终：{selected.route.length ? selected.route.map((route) => route.name).join("、") : "未选库"}</p></section>
          <section><h3>引用（{selected.citations.length}）</h3>{selected.citations.length ? selected.citations.map((citation) => <details key={citation.chunkId}><summary>[{citation.index}] {citation.filename}</summary><p>{citation.content}</p></details>) : <p>本次回答没有引用。</p>}</section>
          <section><h3>模型调用（{selected.modelCalls.length}）</h3><div className="model-call-list">{selected.modelCalls.map((call) => <article key={call.id}><div><strong>{call.purpose}</strong><StatusBadge status={call.status === "completed" ? "success" : "error"}>{call.status === "completed" ? "成功" : "失败"}</StatusBadge></div><p>{call.provider} / {call.modelId}</p><small>{call.protocol} · {formatMs(call.latencyMs)} · 重试 {call.retryCount}</small><span>输入 {call.inputTokens} · 输出 {call.outputTokens} · 总计 {call.totalTokens}{call.estimated ? "（估算）" : ""}</span>{call.errorMessage ? <p className="error-text">{call.errorMessage}</p> : null}</article>)}</div></section>
          <section><h3>日志留存</h3><form className="retention-form" onSubmit={saveRetention}><label><span>保留天数</span><input type="number" min="1" max="3650" value={retention} onChange={(event) => setRetention(Number(event.target.value))} required /></label><Button type="submit" disabled={retentionSaving}>{retentionSaving ? "保存中…" : "保存设置"}</Button></form></section>
        </> : <EmptyState compact icon={Activity} title="未选择日志" description="点击左侧记录，查看回答、引用、路由与各模型调用明细。" />}
      </aside>
    </div>
  );
}
