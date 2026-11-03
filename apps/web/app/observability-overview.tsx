"use client";

import { Activity, BarChart3, Bot, Database, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getObservabilityOverview, type OverviewAgent, type OverviewDaily, type OverviewData, type ObservationFilters, type UsageGroup } from "./observability-client";
import { Button, EmptyState, StatusBadge } from "./ui";

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const money = (value: number, currency: string | null = "CNY") => `${currency === "USD" ? "$" : "¥"}${value < 0.01 ? value.toFixed(6) : value.toFixed(2)}`;
const ms = (value: number | null) => value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;

function DailyTrend({ items }: { items: OverviewDaily[] }) {
  if (!items.length) return <EmptyState compact icon={Activity} title="暂无运行趋势" description="完成应用问答后，每日成功、失败和 Token 消耗会显示在这里。" />;
  const maxRuns = Math.max(...items.map((item) => item.run_count), 1);
  const maxTokens = Math.max(...items.map((item) => item.total_tokens), 1);
  return <div className="trend-wrap"><div className="chart-legend"><span><i className="legend-success" />成功</span><span><i className="legend-failed" />失败/中断</span><span><i className="legend-token" />Token</span></div><div className="trend-chart" role="img" aria-label="每日 Agent 运行趋势">{items.map((item) => <div className="trend-column" key={item.date} title={`${item.date}：运行 ${item.run_count}，成功 ${item.completed_count}，失败 ${item.failed_count}，中断 ${item.cancelled_count}，${item.total_tokens} Token，估算 ${money(item.estimated_cost)}`}><div className="trend-token-value">{item.total_tokens.toLocaleString()}</div><div className="trend-bars"><span className="trend-bar-success" style={{ height: `${Math.max(item.completed_count / maxRuns * 100, item.completed_count ? 5 : 0)}%` }} /><span className="trend-bar-failed" style={{ height: `${Math.max((item.failed_count + item.cancelled_count) / maxRuns * 100, item.failed_count + item.cancelled_count ? 5 : 0)}%` }} /><span className="trend-bar-token" style={{ height: `${Math.max(item.total_tokens / maxTokens * 100, 2)}%` }} /></div><strong>{item.run_count}</strong><small>{item.date.slice(5)}</small></div>)}</div><div className="trend-table-wrap"><table className="visual-table"><thead><tr><th>日期</th><th>运行</th><th>成功</th><th>失败</th><th>中断</th><th>Token</th><th>估算费用</th></tr></thead><tbody>{items.map((item) => <tr key={item.date}><td>{item.date}</td><td>{item.run_count}</td><td>{item.completed_count}</td><td>{item.failed_count}</td><td>{item.cancelled_count}</td><td>{item.total_tokens.toLocaleString()}</td><td>{money(item.estimated_cost)}</td></tr>)}</tbody></table></div></div>;
}

function AgentPerformance({ items }: { items: OverviewAgent[] }) {
  if (!items.length) return <EmptyState compact icon={Bot} title="暂无 Agent 对比数据" description="不同应用的运行数、成功率、延迟和消耗会显示在这里。" />;
  return <div className="visual-table-scroll"><table className="visual-table agent-performance"><thead><tr><th>应用</th><th>运行</th><th>成功率</th><th>失败</th><th>平均耗时</th><th>P95</th><th>Token</th><th>估算费用</th><th>最近运行</th></tr></thead><tbody>{items.map((item) => <tr key={item.agent_name}><td><strong>{item.agent_name}</strong></td><td>{item.run_count}</td><td><div className="success-cell"><span>{item.success_rate === null ? "—" : `${(item.success_rate * 100).toFixed(1)}%`}</span><div className="success-meter"><i style={{ width: `${(item.success_rate ?? 0) * 100}%` }} /></div></div></td><td>{item.failed_count}</td><td>{ms(item.average_total_ms)}</td><td>{ms(item.p95_total_ms)}</td><td>{item.total_tokens.toLocaleString()}</td><td>{money(item.estimated_cost)}</td><td>{new Date(item.last_run_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</td></tr>)}</tbody></table></div>;
}

function Distribution({ title, items, total }: { title: string; items: Array<{ name: string; count: number }>; total: number }) {
  return <div className="distribution-block"><h3>{title}</h3>{items.length ? items.map((item) => <div className="distribution-row" key={item.name}><span>{item.name}</span><div className="distribution-track"><i style={{ width: `${total ? item.count / total * 100 : 0}%` }} /></div><strong>{item.count}</strong></div>) : <p className="form-hint">暂无数据</p>}</div>;
}

function OperationOverview({ items }: { items: OverviewData["operations"] }) {
  if (!items.length) return <EmptyState compact icon={Wrench} title="暂无操作事件" description="工具、Harness 和 DocMind 的实际状态会显示在这里。" />;
  return <div className="visual-table-scroll"><table className="visual-table"><thead><tr><th>类型</th><th>总数</th><th>成功</th><th>失败</th><th>中断</th><th>进行中</th><th>失败率</th></tr></thead><tbody>{items.map((item) => <tr key={item.kind}><td>{item.kind}</td><td>{item.total}</td><td>{item.completed}</td><td>{item.failed}</td><td>{item.cancelled}</td><td>{item.running}</td><td>{item.total ? `${(item.failed / item.total * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></div>;
}

function ModelUsage({ items }: { items: UsageGroup[] }) {
  if (!items.length) return <EmptyState compact icon={BarChart3} title="暂无模型用量" description="模型调用次数、输入输出 Token、估算值和费用会显示在这里。" />;
  return <div className="visual-table-scroll"><table className="visual-table"><thead><tr><th>供应商 / 模型</th><th>调用</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>其中估算</th><th>估算费用</th><th>未计价</th></tr></thead><tbody>{items.map((item, index) => <tr key={`${item.keys.join("-")}-${index}`}><td><strong>{item.keys[0]}</strong><small className="table-subline">{item.keys[1]} · {item.keys.at(-1) ?? "未配置币种"}</small></td><td>{item.call_count}</td><td>{item.input_tokens.toLocaleString()}</td><td>{item.output_tokens.toLocaleString()}</td><td>{item.total_tokens.toLocaleString()}</td><td>{item.estimated_tokens.toLocaleString()}</td><td>{money(item.estimated_cost, item.keys.at(-1))}</td><td>{item.unpriced_call_count}</td></tr>)}</tbody></table></div>;
}

export function ObservabilityOverview({ filters }: { filters: ObservationFilters }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getObservabilityOverview(filters)); }
    catch (reason) { setError(errorMessage(reason, "运行概览加载失败")); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <div className="loading-panel">正在汇总可视化数据…</div>;
  if (error) return <EmptyState icon={BarChart3} title="运行概览加载失败" description={error} action={<Button icon={RefreshCw} onClick={() => void load()}>重试</Button>} />;
  return <div className="observability-dashboard">
    <section className="panel dashboard-wide"><div className="panel-heading compact"><div><h2>每日运行趋势</h2><p>按真实运行日期汇总成功、失败、中断、Token 和估算费用</p></div><Button variant="ghost" icon={RefreshCw} onClick={() => void load()}>刷新</Button></div><DailyTrend items={data?.daily ?? []} /></section>
    <section className="panel dashboard-wide"><div className="panel-heading compact"><div><h2>Agent 性能对比</h2><p>运行量、成功率、延迟、Token、费用和最近运行时间</p></div></div><AgentPerformance items={data?.agents ?? []} /></section>
    <div className="dashboard-grid"><section className="panel"><div className="panel-heading compact"><div><h2>知识构建分布</h2><p>{data?.ingestion.total ?? 0} 个任务 · {data?.ingestion.chunk_count.toLocaleString() ?? 0} 个分段</p></div></div><div className="distribution-grid"><Distribution title="解析方式" items={data?.ingestion.parse_strategy ?? []} total={data?.ingestion.total ?? 0} /><Distribution title="任务状态" items={data?.ingestion.status ?? []} total={data?.ingestion.total ?? 0} /><Distribution title="元数据状态" items={data?.ingestion.metadata_status ?? []} total={data?.ingestion.total ?? 0} /></div></section><section className="panel"><div className="panel-heading compact"><div><h2>操作状态</h2><p>Tool、Skill、Harness 与 DocMind 的实际事件</p></div></div><OperationOverview items={data?.operations ?? []} /></section></div>
    <section className="panel dashboard-wide"><div className="panel-heading compact"><div><h2>模型调用与消耗</h2><p>输入输出 Token、估算 Token、估算费用和未计价次数</p></div></div><ModelUsage items={data?.models ?? []} /></section>
  </div>;
}
