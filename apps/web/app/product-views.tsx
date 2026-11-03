"use client";

import { Activity, AppWindow, ArrowRight, BarChart3, BookOpen, Bot, Check, Copy, Database, ExternalLink, Globe2, KeyRound, MessageCircle, Plus, RefreshCw, Save, Settings2, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ModelsView } from "./prototype-app";
import {
  checkTool, createAgent, createApiKey, createTool, deleteAgent, deleteTool, duplicateAgent,
  emptyAgent, getInsightSummary, invokeTool, listAgents, listApiKeys, listKnowledgeBases, listTools, publishAgent,
  revokeApiKey, updateAgent, updateTool,
  type AgentApp, type AgentInput, type ApiKey, type InsightSummary, type ToolDefinition, type ToolInput,
} from "./api-client";
import { listEvaluations } from "./evaluation-client";
import type { KnowledgeBase, ModelProvider, Role } from "./prototype-models";
import { Button, EmptyState, Metric, Modal, StatusBadge } from "./ui";

type Notify = (message: string) => void;
type CommonProps = { setToast: Notify; setWarningToast: Notify; setErrorToast: Notify; role: Role; providers: ModelProvider[]; setProviders: (providers: ModelProvider[]) => void };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function WorkbenchView({ knowledgeBases, agents }: { knowledgeBases: KnowledgeBase[]; agents: AgentApp[] }) {
  const router = useRouter();
  const [insights, setInsights] = useState<InsightSummary | null>(null);
  useEffect(() => { getInsightSummary().then(setInsights).catch(() => undefined); }, []);
  const ready = knowledgeBases.filter((item) => item.readyDocumentCount > 0).length;
  return <div className="content-stack">
    <section className="workbench-hero"><div><span className="eyebrow">知枢 · RAG 中台</span><h2>让企业知识真正可用</h2><p>从资料解析、知识检索到应用对话，在同一个工作区完成。</p><div className="hero-actions"><Button variant="primary" icon={Plus} onClick={() => router.push("/apps")}>创建应用</Button><Button icon={BookOpen} onClick={() => router.push("/knowledge")}>管理知识库</Button></div></div><AppWindow size={64} strokeWidth={1.2} /></section>
    <section className="metric-strip">
      <Metric label="应用" value={String(agents.length)} note={`${agents.filter((item) => item.published).length} 个已发布`} icon={AppWindow} />
      <Metric label="知识库" value={String(knowledgeBases.length)} note={`${ready} 个有可检索文档`} icon={Database} />
      <Metric label="对话" value={String(insights?.conversation_count ?? 0)} note="真实会话记录" icon={MessageCircle} />
      <Metric label="Token" value={(insights?.total_tokens ?? 0).toLocaleString()} note="模型实际与估算用量" icon={Activity} />
    </section>
    <div className="workbench-grid"><section className="panel"><div className="panel-heading compact"><div><h2>我的应用</h2><p>配置知识库与回答规则，发布后即可对话</p></div><Button variant="ghost" onClick={() => router.push("/apps")}>全部应用<ArrowRight size={14} /></Button></div>{agents.length ? <div className="quick-list">{agents.slice(0, 4).map((agent) => <button key={agent.id} onClick={() => router.push(`/apps/${agent.id}`)}><span className="app-icon" style={{ background: agent.theme_color }}><Bot size={18} /></span><span><strong>{agent.name}</strong><small>{agent.description || "未填写应用描述"}</small></span><StatusBadge status={agent.published ? "success" : "neutral"}>{agent.published ? "已发布" : "草稿"}</StatusBadge></button>)}</div> : <EmptyState compact icon={AppWindow} title="还没有应用" description="创建一个应用，绑定知识库后开始问答。" />}</section>
      <section className="panel"><div className="panel-heading compact"><div><h2>知识库</h2><p>文档、解析和向量索引状态</p></div><Button variant="ghost" onClick={() => router.push("/knowledge")}>管理<ArrowRight size={14} /></Button></div>{knowledgeBases.length ? <div className="quick-list">{knowledgeBases.slice(0, 4).map((kb) => <button key={kb.id} onClick={() => router.push(`/knowledge/${kb.id}`)}><span className="kb-row-icon"><BookOpen size={18} /></span><span><strong>{kb.name}</strong><small>{kb.documentCount} 个文档 · {kb.chunkCount} 个分段</small></span><StatusBadge status={kb.readyDocumentCount ? "success" : "neutral"}>{kb.readyDocumentCount ? "可用" : "待导入"}</StatusBadge></button>)}</div> : <EmptyState compact icon={BookOpen} title="还没有知识库" description="先配置 Embedding 模型，再创建知识库。" />}</section></div>
  </div>;
}

export function AgentsView({ knowledgeBases, selectedId, setToast, setErrorToast }: { knowledgeBases: KnowledgeBase[]; selectedId?: string } & Pick<CommonProps, "setToast" | "setErrorToast">) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentApp[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState(1);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ name: "", description: "", mode: "simple" as AgentInput["mode"] });
  const [draft, setDraft] = useState<AgentInput>(emptyAgent);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const [nextAgents, nextTools] = await Promise.all([listAgents(), listTools()]); setAgents(nextAgents); setTools(nextTools); setError(null); }
    catch (reason) { setError(message(reason, "应用加载失败")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = agents.find((item) => item.id === selectedId);
  useEffect(() => { if (selected) setDraft({ ...emptyAgent, ...selected }); }, [selected]);
  const openCreate = () => { setCreateStep(1); setCreateError(null); setCreateOpen(true); };
  const closeCreate = (open: boolean) => { setCreateOpen(open); if (!open) { setCreateStep(1); setCreateError(null); } };
  const create = async () => {
    setSaving(true);
    setCreateError(null);
    try { const created = await createAgent({ ...emptyAgent, ...createForm, name: createForm.name.trim(), description: createForm.description.trim() }); setToast("应用已创建"); closeCreate(false); setCreateForm({ name: "", description: "", mode: "simple" }); await load(); router.push(`/apps/${created.id}`); }
    catch (reason) { setCreateError(message(reason, "创建失败")); }
    finally { setSaving(false); }
  };
  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try { await updateAgent(selected.id, { ...draft, name: draft.name.trim() }); setToast("应用配置已保存"); await load(); }
    catch (reason) { setErrorToast(message(reason, "保存失败")); }
    finally { setSaving(false); }
  };
  const action = async (kind: "publish" | "duplicate" | "delete", agent: AgentApp) => {
    setBusy(true);
    try {
      if (kind === "publish") { const updated = await publishAgent(agent.id); setToast(updated.published ? "应用已发布" : "应用已下线"); }
      if (kind === "duplicate") { await duplicateAgent(agent.id); setToast("应用副本已创建"); }
      if (kind === "delete") { await deleteAgent(agent.id); setToast("应用已删除"); router.push("/apps"); }
      await load();
    } catch (reason) { setErrorToast(message(reason, "操作失败")); }
    finally { setBusy(false); }
  };
  if (selectedId && !loading && !selected) return <EmptyState icon={AppWindow} title="应用不存在" description={error || "应用可能已删除，请返回列表。"} action={<Button onClick={() => router.push("/apps")}>返回应用</Button>} />;
  if (selected) return <div className="content-stack agent-config">
    <button className="back-link" onClick={() => router.push("/apps")}>← 返回应用列表</button>
    <section className="agent-config-head"><span className="app-icon large" style={{ background: draft.theme_color }}><Bot size={25} /></span><div><h2>{selected.name}</h2><p>{selected.description || "未填写应用描述"}</p></div><StatusBadge status={selected.published ? "success" : "neutral"}>{selected.published ? "已发布" : "草稿"}</StatusBadge><Button icon={ExternalLink} onClick={() => router.push(`/chat/${selected.id}`)}>对话</Button><Button variant="primary" icon={Save} disabled={saving || !draft.name.trim()} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></section>
    <div className="agent-config-grid"><div className="content-stack">
      <section className="panel form-panel"><div className="panel-heading compact"><div><h2>基础信息</h2><p>应用名称、说明和对话模式</p></div></div><div className="form-grid"><label><span>应用名称</span><input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>对话模式</span><select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as AgentInput["mode"] })}><option value="simple">简单对话</option><option value="chatflow">Chat Flow 草稿</option></select></label><label className="wide-field"><span>应用描述</span><textarea value={draft.description} maxLength={2000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label></div></section>
      <section className="panel form-panel"><div className="panel-heading compact"><div><h2>提示词与开场白</h2><p>回答仍以检索到的知识为依据</p></div></div><div className="form-grid"><label className="wide-field"><span>角色与回答要求</span><textarea className="prompt-input" value={draft.prompt} maxLength={20000} placeholder="例如：你是员工服务助手，使用简洁中文回答。" onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label><label className="wide-field"><span>开场白</span><textarea value={draft.opening} maxLength={4000} onChange={(event) => setDraft({ ...draft, opening: event.target.value })} /></label><label className="wide-field"><span>推荐问题（每行一个，最多 8 个）</span><textarea value={draft.suggestions.join("\n")} onChange={(event) => setDraft({ ...draft, suggestions: event.target.value.split("\n").slice(0, 8) })} /></label></div></section>
      {draft.mode === "chatflow" ? <section className="panel form-panel"><div className="panel-heading compact"><div><h2>Chat Flow 草稿</h2><p>可保存 start、knowledge、http、llm、export 节点；当前对话仍使用简单问答链路。</p></div></div><textarea className="code-input" aria-label="Chat Flow JSON" value={JSON.stringify(draft.flow, null, 2)} onChange={(event) => { try { setDraft({ ...draft, flow: JSON.parse(event.target.value) }); } catch { /* 保留上次有效 JSON */ } }} /></section> : null}
    </div><div className="content-stack">
      <section className="panel form-panel"><div className="panel-heading compact"><div><h2>知识库</h2><p>应用只从选中的知识库检索</p></div></div><div className="check-list">{knowledgeBases.map((kb) => <label key={kb.id}><input type="checkbox" checked={draft.knowledge_base_ids.includes(kb.id)} onChange={(event) => setDraft({ ...draft, knowledge_base_ids: event.target.checked ? [...draft.knowledge_base_ids, kb.id] : draft.knowledge_base_ids.filter((id) => id !== kb.id) })} /><span><strong>{kb.name}</strong><small>{kb.readyDocumentCount} 个可用文档 · {kb.chunkCount} 个分段</small></span></label>)}{!knowledgeBases.length ? <p className="inline-empty">尚未创建知识库。</p> : null}</div></section>
      <section className="panel form-panel"><div className="panel-heading compact"><div><h2>工具</h2><p>保存可用工具绑定；简单对话暂不执行工具调用。</p></div></div><div className="check-list">{tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={draft.tool_ids.includes(tool.id)} onChange={(event) => setDraft({ ...draft, tool_ids: event.target.checked ? [...draft.tool_ids, tool.id] : draft.tool_ids.filter((id) => id !== tool.id) })} /><span><strong>{tool.name}</strong><small>{tool.kind.toUpperCase()} · {tool.enabled ? "已启用" : "已停用"}</small></span></label>)}{!tools.length ? <p className="inline-empty">尚未创建工具。</p> : null}</div></section>
      <section className="panel form-panel"><div className="panel-heading compact"><div><h2>对话与发布</h2></div></div><label className="switch-row"><span><strong>显示引用</strong><small>回答下方展示知识原文</small></span><input type="checkbox" checked={draft.show_citations} onChange={(event) => setDraft({ ...draft, show_citations: event.target.checked })} /></label><label><span>主题色</span><input className="color-input" type="color" value={draft.theme_color} onChange={(event) => setDraft({ ...draft, theme_color: event.target.value })} /></label><div className="form-actions wrap"><Button icon={Copy} disabled={busy} onClick={() => void action("duplicate", selected)}>复制</Button><Button disabled={busy} onClick={() => void action("publish", selected)}>{selected.published ? "下线" : "发布"}</Button><Button variant="danger" icon={Trash2} disabled={busy} onClick={() => { if (window.confirm(`确定删除“${selected.name}”？`)) void action("delete", selected); }}>删除</Button></div></section>
    </div></div>
  </div>;
  return <div className="content-stack"><div className="toolbar"><div className="toolbar-note"><AppWindow size={17} /><span>将知识库、提示词和对话能力组合成应用。</span></div><Button variant="primary" icon={Plus} onClick={openCreate}>创建应用</Button></div>{error ? <div className="panel-alert error-text">{error}<Button icon={RefreshCw} onClick={() => void load()}>重试</Button></div> : null}{loading ? <div className="loading-panel">正在加载应用…</div> : agents.length ? <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}><button className="agent-card-main" onClick={() => router.push(`/apps/${agent.id}`)}><span className="app-icon large" style={{ background: agent.theme_color }}><Bot size={24} /></span><div><h2>{agent.name}</h2><p>{agent.description || "未填写应用描述"}</p></div><div className="agent-card-meta"><StatusBadge status={agent.published ? "success" : "neutral"}>{agent.published ? "已发布" : "草稿"}</StatusBadge><span>{agent.knowledge_base_ids.length} 个知识库 · {agent.mode === "simple" ? "简单对话" : "Chat Flow 草稿"}</span></div></button><div className="agent-card-actions"><Button icon={ExternalLink} onClick={() => router.push(`/chat/${agent.id}`)}>对话</Button><Button onClick={() => router.push(`/apps/${agent.id}`)}>配置</Button></div></article>)}</div> : !error ? <EmptyState icon={AppWindow} title="创建你的第一个应用" description="选择知识库、设置回答要求，然后发布给使用者。" action={<Button variant="primary" icon={Plus} onClick={openCreate}>创建应用</Button>} /> : null}
    <Modal open={createOpen} onOpenChange={closeCreate} title="创建应用" description="两步创建应用，随后配置知识库、提示词和发布状态。">
      <div className="create-agent-steps" aria-label={`创建应用，第 ${createStep} 步，共 2 步`}><div className={createStep === 1 ? "current" : "done"}><span>{createStep === 1 ? "1" : <Check size={13} />}</span><strong>基本信息</strong></div><i /><div className={createStep === 2 ? "current" : ""}><span>2</span><strong>对话模式</strong></div></div>
      <form className="create-agent-form" onSubmit={(event) => { event.preventDefault(); if (createStep === 1) setCreateStep(2); else void create(); }}>
        {createStep === 1 ? <div className="create-agent-fields"><label><span>应用名称 <em>必填</em></span><input autoFocus value={createForm.name} maxLength={120} placeholder="例如：员工制度助手" onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} /><small>{createForm.name.length}/120，使用便于团队识别的名称</small></label><label><span>应用描述 <em>选填</em></span><textarea value={createForm.description} maxLength={2000} placeholder="说明应用服务的对象、知识范围和主要用途" onChange={(event) => setCreateForm({ ...createForm, description: event.target.value })} /><small>创建后仍可修改，不会用于虚构应用能力。</small></label></div> : <>
          <fieldset className="agent-mode-options"><legend>选择对话模式</legend><label className={createForm.mode === "simple" ? "selected" : ""}><input type="radio" name="agent-mode" value="simple" checked={createForm.mode === "simple"} onChange={() => setCreateForm({ ...createForm, mode: "simple" })} /><span className="mode-icon"><MessageCircle size={20} /></span><span><strong>简单对话</strong><small>绑定知识库，自动检索并生成带引用的回答。当前可完整使用。</small></span></label><label className={createForm.mode === "chatflow" ? "selected" : ""}><input type="radio" name="agent-mode" value="chatflow" checked={createForm.mode === "chatflow"} onChange={() => setCreateForm({ ...createForm, mode: "chatflow" })} /><span className="mode-icon"><Wrench size={20} /></span><span><strong>Chat Flow 草稿</strong><small>保存流程节点草稿；执行引擎尚未接入，创建后仍使用简单问答链路。</small></span></label></fieldset>
          <div className="create-agent-summary"><span className="app-icon"><Bot size={18} /></span><div><strong>{createForm.name.trim()}</strong><p>{createForm.description.trim() || "未填写应用描述"}</p></div><StatusBadge status="neutral">{createForm.mode === "simple" ? "简单对话" : "流程草稿"}</StatusBadge></div>
        </>}
        {createError ? <p className="form-error" role="alert">{createError}</p> : null}
        <div className="dialog-actions create-agent-actions">{createStep === 2 ? <Button type="button" variant="ghost" onClick={() => setCreateStep(1)} disabled={saving}>上一步</Button> : null}<span /><Button type="button" onClick={() => closeCreate(false)} disabled={saving}>取消</Button><Button variant="primary" type="submit" disabled={!createForm.name.trim() || saving}>{createStep === 1 ? "下一步" : saving ? "创建中…" : "创建并配置"}</Button></div>
      </form>
    </Modal>
  </div>;
}

export function ToolsView(props: CommonProps) {
  const [tab, setTab] = useState<"tools" | "mcp" | "flows" | "models">("tools");
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<ToolDefinition | null>(null);
  const [form, setForm] = useState<ToolInput>({ name: "", kind: "http", description: "", url: "", method: "POST", headers: {}, timeout_seconds: 10, enabled: true });
  const [headers, setHeaders] = useState("");
  const [testing, setTesting] = useState<ToolDefinition | null>(null);
  const [testInput, setTestInput] = useState("{}");
  const [testResult, setTestResult] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setTools(await listTools()); } catch (reason) { props.setErrorToast(message(reason, "工具加载失败")); } finally { setLoading(false); } }, []);
  useEffect(() => { if (tab !== "models") void load(); }, [load, tab]);
  const open = (tool?: ToolDefinition, kind: "http" | "mcp" = "http") => {
    setEditing(tool ?? null);
    setForm(tool ? { name: tool.name, kind: tool.kind, description: tool.description, url: tool.url, method: tool.method, headers: {}, timeout_seconds: tool.timeout_seconds, enabled: tool.enabled } : { name: "", kind, description: "", url: "", method: "POST", headers: {}, timeout_seconds: 10, enabled: true });
    setHeaders(""); setModal(true);
  };
  const save = async () => {
    setBusy(true);
    try { const parsed = headers.trim() ? JSON.parse(headers) as Record<string, string> : {}; const payload = { ...form, headers: parsed }; if (editing) await updateTool(editing.id, payload); else await createTool(payload); setModal(false); setToastSaved(props.setToast, editing); await load(); }
    catch (reason) { props.setErrorToast(reason instanceof SyntaxError ? "请求头必须是有效 JSON 对象" : message(reason, "工具保存失败")); }
    finally { setBusy(false); }
  };
  const test = async (healthOnly: boolean) => {
    if (!testing) return;
    setBusy(true); setTestResult("");
    try { if (healthOnly) { const result = await checkTool(testing.id); setTestResult(`连接正常，HTTP ${result.status_code}`); } else { const result = await invokeTool(testing.id, JSON.parse(testInput)); setTestResult(JSON.stringify(result, null, 2)); } }
    catch (reason) { setTestResult(message(reason, "调用失败")); }
    finally { setBusy(false); }
  };
  const filtered = tools.filter((tool) => tool.kind === (tab === "mcp" ? "mcp" : "http"));
  return <div className="content-stack"><div className="tabs product-tabs">{(["tools", "mcp", "flows", "models"] as const).map((item) => <button key={item} className={tab === item ? "tab-active" : ""} onClick={() => setTab(item)}>{{ tools: "工具库", mcp: "MCP 服务", flows: "工作流插件", models: "模型" }[item]}</button>)}</div>
    {tab === "models" ? props.role === "admin" ? <ModelsView {...props} providers={props.providers} setProviders={props.setProviders} /> : <EmptyState icon={ShieldCheck} title="仅管理员可配置模型" description="切换到管理员角色后可管理模型供应商。" /> : <>
      <div className="toolbar"><div className="toolbar-note"><Wrench size={17} /><span>{tab === "mcp" ? "可保存 MCP 服务配置；协议客户端尚未接入。" : tab === "flows" ? "复用已接入的 HTTP 工具，简单对话暂不执行工具调用。" : "配置一次，在多个应用中复用。"}</span></div>{tab !== "flows" ? <Button variant="primary" icon={Plus} onClick={() => open(undefined, tab === "mcp" ? "mcp" : "http")}>新建{tab === "mcp" ? " MCP 服务" : "工具"}</Button> : null}</div>
      {loading ? <div className="loading-panel">正在加载工具…</div> : filtered.length ? <div className="tool-grid">{filtered.map((tool) => <article className="tool-card" key={tool.id}><div className="row"><span className="app-icon"><Globe2 size={18} /></span><StatusBadge status={tool.enabled ? "success" : "neutral"}>{tool.enabled ? "已启用" : "已停用"}</StatusBadge></div><h2>{tool.name}</h2><p>{tool.description || "未填写工具说明"}</p><code>{tool.method} {tool.url}</code><div className="tool-card-actions"><Button onClick={() => open(tool)}>配置</Button><Button onClick={() => { setTesting(tool); setTestResult(""); setTestInput("{}"); }}>测试</Button><Button variant="ghost" icon={Trash2} aria-label={`删除${tool.name}`} onClick={() => { if (window.confirm(`确定删除“${tool.name}”？`)) void deleteTool(tool.id).then(load).then(() => props.setToast("工具已删除")).catch((reason) => props.setErrorToast(message(reason, "删除失败"))); }} /></div></article>)}</div> : <EmptyState icon={Wrench} title={tab === "flows" ? "暂无可复用的工作流插件" : "还没有工具"} description={tab === "mcp" ? "MCP 调用能力尚未接入，可以先保存服务信息。" : "创建 HTTP 工具后，可在这里执行健康检测与真实调用。"} action={tab !== "flows" ? <Button variant="primary" icon={Plus} onClick={() => open(undefined, tab === "mcp" ? "mcp" : "http")}>新建工具</Button> : undefined} />}
    </>}
    <Modal open={modal} onOpenChange={setModal} title={editing ? "配置工具" : "新建工具"} description="HTTP 工具支持真实健康检测和调用，密钥加密保存。"><div className="form-grid"><label><span>名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label><span>类型</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ToolInput["kind"] })}><option value="http">HTTP</option><option value="mcp">MCP</option></select></label><label className="wide-field"><span>说明</span><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label className="wide-field"><span>服务地址</span><input type="url" value={form.url} placeholder="https://example.com/api" onChange={(event) => setForm({ ...form, url: event.target.value })} /></label><label><span>请求方法</span><select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((item) => <option key={item}>{item}</option>)}</select></label><label><span>超时（秒）</span><input type="number" min={1} max={60} value={form.timeout_seconds} onChange={(event) => setForm({ ...form, timeout_seconds: Number(event.target.value) })} /></label><label className="wide-field"><span>请求头 JSON</span><textarea value={headers} placeholder={'{"Authorization":"Bearer …"}'} onChange={(event) => setHeaders(event.target.value)} /><small>{editing?.has_credentials ? "已保存凭据；留空表示清除，未修改其他字段时不会自动保留。" : "不会通过读取接口返回完整请求头。"}</small></label><label className="switch-row wide-field"><span>启用工具</span><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /></label></div><div className="dialog-actions"><Button onClick={() => setModal(false)}>取消</Button><Button variant="primary" disabled={!form.name.trim() || !form.url.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button></div></Modal>
    <Modal open={Boolean(testing)} onOpenChange={(open) => !open && setTesting(null)} title={`测试 · ${testing?.name ?? ""}`} description="测试会向目标服务发送真实请求。"><div className="form-grid"><label className="wide-field"><span>调用输入 JSON</span><textarea className="code-input" value={testInput} onChange={(event) => setTestInput(event.target.value)} /></label></div>{testResult ? <pre className="test-result">{testResult}</pre> : null}<div className="dialog-actions"><Button disabled={busy} onClick={() => void test(true)}>健康检测</Button><Button variant="primary" disabled={busy} onClick={() => void test(false)}>{busy ? "调用中…" : "执行调用"}</Button></div></Modal>
  </div>;
}
function setToastSaved(setToast: Notify, editing: ToolDefinition | null) { setToast(editing ? "工具配置已保存" : "工具已创建"); }

export function InsightsView() {
  const router = useRouter();
  const [data, setData] = useState<InsightSummary | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [evaluationCounts, setEvaluationCounts] = useState({ good: 0, bad: 0 });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      getInsightSummary(),
      listKnowledgeBases(),
      listEvaluations({ kind: "good", limit: 1 }),
      listEvaluations({ kind: "bad", limit: 1 }),
    ]).then(([summary, bases, good, bad]) => {
      setData(summary);
      setKnowledgeBases(bases);
      setEvaluationCounts({ good: good.total, bad: bad.total });
    }).catch((reason) => setError(message(reason, "数据洞察加载失败")));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error) return <EmptyState icon={BarChart3} title="数据洞察加载失败" description={error} action={<Button icon={RefreshCw} onClick={load}>重试</Button>} />;
  if (!data) return <div className="loading-panel">正在汇总知识资产与质量数据…</div>;

  const successfulQueries = data.query_count - data.failed_query_count;
  const querySuccessRate = data.query_count ? successfulQueries / data.query_count * 100 : 0;
  const evaluationTotal = evaluationCounts.good + evaluationCounts.bad;
  const goodRate = evaluationTotal ? evaluationCounts.good / evaluationTotal * 100 : 0;
  const readyDocuments = knowledgeBases.reduce((total, item) => total + item.readyDocumentCount, 0);

  return <div className="content-stack insights-page">
    <section className="metric-strip">
      <Metric label="知识文档" value={String(data.document_count)} note={`${readyDocuments} 个可检索`} icon={BookOpen} />
      <Metric label="知识分段" value={data.chunk_count.toLocaleString()} note={`${data.knowledge_base_count} 个知识库`} icon={Database} />
      <Metric label="问答次数" value={data.query_count.toLocaleString()} note={`${data.conversation_count} 个真实会话`} icon={MessageCircle} />
      <Metric label="评测样例" value={String(evaluationTotal)} note={`${evaluationCounts.good} Good · ${evaluationCounts.bad} Bad`} icon={BarChart3} />
    </section>

    <div className="insight-quality-grid">
      <section className="panel insight-quality-card">
        <div className="panel-heading compact"><div><h2>问答结果</h2><p>成功与失败的真实问答分布</p></div></div>
        <div className="quality-content">
          <div className="quality-donut" style={{ background: data.query_count ? `conic-gradient(var(--success) 0 ${querySuccessRate}%, var(--danger) ${querySuccessRate}% 100%)` : "var(--surface-soft)" }}><div><strong>{data.query_count ? `${querySuccessRate.toFixed(1)}%` : "—"}</strong><span>成功率</span></div></div>
          <dl className="quality-legend"><div><dt><i className="quality-success" />成功问答</dt><dd>{successfulQueries}</dd></div><div><dt><i className="quality-danger" />失败问答</dt><dd>{data.failed_query_count}</dd></div><div><dt>总问答</dt><dd>{data.query_count}</dd></div></dl>
        </div>
      </section>
      <section className="panel insight-quality-card">
        <div className="panel-heading compact"><div><h2>评测标注</h2><p>Goodcase 与 Badcase 的质量样本构成</p></div><Button variant="ghost" onClick={() => router.push("/observability?tab=evaluations")}>管理评测</Button></div>
        <div className="quality-content">
          <div className="quality-donut" style={{ background: evaluationTotal ? `conic-gradient(var(--primary) 0 ${goodRate}%, var(--danger) ${goodRate}% 100%)` : "var(--surface-soft)" }}><div><strong>{evaluationTotal || "—"}</strong><span>总样例</span></div></div>
          <dl className="quality-legend"><div><dt><i className="quality-primary" />Goodcase</dt><dd>{evaluationCounts.good}</dd></div><div><dt><i className="quality-danger" />Badcase</dt><dd>{evaluationCounts.bad}</dd></div><div><dt>Goodcase 占比</dt><dd>{evaluationTotal ? `${goodRate.toFixed(1)}%` : "—"}</dd></div></dl>
        </div>
      </section>
    </div>

    <section className="panel insight-kb-panel">
      <div className="panel-heading compact"><div><h2>知识库资产明细</h2><p>对比文档就绪情况、分段规模和可检索状态</p></div><Button variant="ghost" onClick={() => router.push("/knowledge")}>管理知识库</Button></div>
      {knowledgeBases.length ? <div className="insight-kb-table"><div className="insight-kb-row insight-kb-head"><span>知识库</span><span>文档</span><span>可检索</span><span>知识分段</span><span>单文档分段</span><span>状态</span></div>{knowledgeBases.map((item) => <button className="insight-kb-row" key={item.id} onClick={() => router.push(`/knowledge/${item.id}`)}><span><strong>{item.name}</strong><small>{item.description || "未填写知识库说明"}</small></span><span>{item.documentCount}</span><span>{item.readyDocumentCount}</span><span>{item.chunkCount.toLocaleString()}</span><span>{item.documentCount ? (item.chunkCount / item.documentCount).toFixed(1) : "—"}</span><span><StatusBadge status={item.readyDocumentCount ? "success" : "neutral"}>{item.readyDocumentCount ? "可检索" : "待构建"}</StatusBadge></span></button>)}</div> : <EmptyState compact icon={BookOpen} title="还没有知识库" description="创建知识库并导入文档后，资产明细会显示在这里。" />}
    </section>
    <div className="insight-footer-note"><span>模型用量、运行延迟与费用已统一归入观测中心。</span><Button variant="ghost" onClick={() => router.push("/observability")}>查看运行观测<ArrowRight size={14} /></Button></div>
  </div>;
}

export function SettingsView({ role, setToast, setErrorToast }: Pick<CommonProps, "role" | "setToast" | "setErrorToast">) {
  const [tab, setTab] = useState<"appearance" | "access" | "api">("appearance");
  const [density, setDensity] = useState("comfortable");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const load = useCallback(async () => { try { setKeys(await listApiKeys()); } catch (reason) { setErrorToast(message(reason, "密钥加载失败")); } }, []);
  useEffect(() => { if (tab === "api") void load(); }, [load, tab]);
  useEffect(() => { const saved = localStorage.getItem("zhishu-density") ?? "comfortable"; setDensity(saved); document.documentElement.dataset.density = saved; }, []);
  const changeDensity = (value: string) => { setDensity(value); localStorage.setItem("zhishu-density", value); document.documentElement.dataset.density = value; setToast("外观设置已保存到当前浏览器"); };
  const create = async () => { try { const created = await createApiKey(name.trim(), null); setSecret(created.secret); setName(""); await load(); } catch (reason) { setErrorToast(message(reason, "创建失败")); } };
  return <div className="content-stack settings-page"><div className="tabs product-tabs"><button className={tab === "appearance" ? "tab-active" : ""} onClick={() => setTab("appearance")}>外观</button><button className={tab === "access" ? "tab-active" : ""} onClick={() => setTab("access")}>访问控制</button><button className={tab === "api" ? "tab-active" : ""} onClick={() => setTab("api")}>API 密钥</button></div>
    {tab === "appearance" ? <section className="panel form-panel settings-narrow"><div className="panel-heading compact"><div><h2>界面外观</h2><p>使用原型统一的浅色主题，密度设置仅保存在当前浏览器。</p></div></div><div className="field-label">主题</div><div className="theme-choice"><span className="theme-preview" /><div><strong>知枢浅色</strong><p>白色工作区、蓝色主色、紧凑圆角</p></div><Check size={18} /></div><label><span>内容密度</span><select value={density} onChange={(event) => changeDensity(event.target.value)}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label></section> : null}
    {tab === "access" ? <section className="panel form-panel settings-narrow"><div className="panel-heading compact"><div><h2>访问控制</h2><p>当前是匿名会话角色分流，不是企业身份认证。</p></div></div><div className="notice-banner"><ShieldCheck size={18} /><div><strong>当前角色：{{ admin: "管理员", manager: "知识库管理人员", user: "使用者" }[role]}</strong><span>管理员可配置模型；管理员与知识库管理人员可维护应用和知识；使用者可对话。</span></div></div><p className="form-hint">点击左下角头像可切换角色。接入企业 SSO 前，请勿将角色分流作为真实安全鉴权。</p></section> : null}
    {tab === "api" ? <section className="panel"><div className="panel-heading compact"><div><h2>API 密钥</h2><p>完整密钥只在创建时显示一次；当前用于保存接入凭据，接口鉴权与额度执行尚未启用。</p></div><Button variant="primary" icon={Plus} onClick={() => { setSecret(""); setModal(true); }}>创建密钥</Button></div>{keys.length ? <div className="api-key-list">{keys.map((key) => <div key={key.id}><span><strong>{key.name}</strong><small>{new Date(key.created_at).toLocaleString("zh-CN")}</small></span><code>{key.prefix}••••••••</code><StatusBadge status={key.revoked ? "neutral" : "success"}>{key.revoked ? "已撤销" : "有效"}</StatusBadge><Button variant="ghost" disabled={key.revoked} onClick={() => { if (window.confirm(`确定撤销“${key.name}”？`)) void revokeApiKey(key.id).then(load).then(() => setToast("密钥已撤销")); }}>撤销</Button></div>)}</div> : <EmptyState compact icon={KeyRound} title="还没有 API 密钥" description="创建后请立即复制并妥善保管。" />}</section> : null}
    <Modal open={modal} onOpenChange={setModal} title={secret ? "保存 API 密钥" : "创建 API 密钥"} description={secret ? "关闭后无法再次查看完整密钥。" : "密钥将以哈希形式存储，完整值不会写入数据库。"}>{secret ? <><pre className="secret-value">{secret}</pre><Button icon={Copy} onClick={() => { void navigator.clipboard.writeText(secret); setToast("密钥已复制"); }}>复制密钥</Button></> : <label><span>密钥名称</span><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>}<div className="dialog-actions"><Button onClick={() => setModal(false)}>关闭</Button>{!secret ? <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>创建</Button> : null}</div></Modal>
  </div>;
}
