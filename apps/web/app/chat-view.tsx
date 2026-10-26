"use client";

import {
  ArrowRight,
  Bot,
  Database,
  FileText,
  History,
  MessageCircle,
  Plus,
  RefreshCw,
  Route,
  ShieldAlert,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConversation,
  listConversations,
  streamChat,
  type ChatStreamEvent,
} from "./api-client";
import type {
  ChatCitation,
  ChatMessage,
  ChatRouteSelection,
  ConversationSummary,
  Role,
} from "./prototype-models";
import { Button, EmptyState, cn } from "./ui";

type ChatViewProps = {
  navigate: (view: "knowledge") => void;
  role: Role;
  hasKnowledgeBase: boolean;
  readyForChat: boolean;
  sessionReady: boolean;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sourceLocation(citation: ChatCitation) {
  const parts: string[] = [];
  if (citation.location.page) parts.push(`第 ${citation.location.page} 页`);
  if (citation.location.sheet) parts.push(`工作表 ${citation.location.sheet}`);
  if (citation.location.rows) parts.push(`第 ${citation.location.rows[0]}–${citation.location.rows[1]} 行`);
  if (citation.location.heading_path?.length) parts.push(citation.location.heading_path.join(" / "));
  return parts.join(" · ") || "原文分段";
}

function replaceAssistant(
  messages: ChatMessage[],
  assistantId: string,
  updater: (message: ChatMessage) => ChatMessage,
) {
  return messages.map((message) => message.id === assistantId ? updater(message) : message);
}

function lastAssistantMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return undefined;
}

export function ChatView({ navigate, role, hasKnowledgeBase, readyForChat, sessionReady }: ChatViewProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [route, setRoute] = useState<ChatRouteSelection[]>([]);
  const [citations, setCitations] = useState<ChatCitation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
      setHistoryError(null);
    } catch (error) {
      setHistoryError(errorMessage(error, "对话记录加载失败"));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    void refreshConversations();
    return () => abortRef.current?.abort();
  }, [refreshConversations, sessionReady]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth", block: "end" });
  }, [messages, stage, streaming]);

  const openConversation = async (id: string) => {
    if (streaming) return;
    setSelectedConversationId(id);
    setLoadingHistory(true);
    setHistoryError(null);
    setSendError(null);
    setStage(null);
    setWarnings([]);
    try {
      const conversation = await getConversation(id);
      setMessages(conversation.messages);
      const lastAssistant = lastAssistantMessage(conversation.messages);
      setCitations(lastAssistant?.citations ?? []);
      setRoute(lastAssistant?.route ?? []);
    } catch (error) {
      setHistoryError(errorMessage(error, "对话内容加载失败"));
    } finally {
      setLoadingHistory(false);
    }
  };

  const startNewConversation = () => {
    if (streaming) return;
    setSelectedConversationId(null);
    setMessages([]);
    setRoute([]);
    setCitations([]);
    setWarnings([]);
    setSendError(null);
    setStage(null);
    setDraft("");
  };

  const send = async (questionOverride?: string) => {
    const question = (questionOverride ?? draft).trim();
    if (!question || streaming || !readyForChat) return;
    const assistantId = `stream-assistant-${Date.now()}`;
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: `stream-user-${Date.now()}`,
      role: "user",
      content: question,
      citations: [],
      route: [],
      status: "completed",
      errorMessage: null,
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: [],
      route: [],
      status: "streaming",
      errorMessage: null,
      createdAt: now,
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft("");
    setLastQuestion(question);
    setStreaming(true);
    setStage("正在连接问答服务");
    setRoute([]);
    setCitations([]);
    setWarnings([]);
    setSendError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let conversationId = selectedConversationId;
    let streamFailed = false;

    const handleEvent = (event: ChatStreamEvent) => {
      if (event.event === "conversation") {
        conversationId = event.data.conversationId;
        setSelectedConversationId(event.data.conversationId);
        setConversations((current) => {
          const existing = current.filter((item) => item.id !== event.data.conversationId);
          return [{ id: event.data.conversationId, title: event.data.title, createdAt: now, updatedAt: now }, ...existing];
        });
      } else if (event.event === "stage") {
        setStage(event.data.label);
      } else if (event.event === "routing") {
        setRoute(event.data.selected);
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({ ...message, route: event.data.selected })));
      } else if (event.event === "warning") {
        setWarnings((current) => current.includes(event.data.message) ? current : [...current, event.data.message]);
      } else if (event.event === "citations") {
        setCitations(event.data.items);
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({ ...message, citations: event.data.items })));
      } else if (event.event === "delta") {
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({ ...message, content: message.content + event.data.text })));
      } else if (event.event === "complete") {
        setCitations(event.data.citations);
        setRoute(event.data.route);
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({
          ...message,
          content: event.data.answer,
          citations: event.data.citations,
          route: event.data.route,
          status: "completed",
        })));
      } else if (event.event === "done") {
        setStage(null);
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({ ...message, id: event.data.messageId, status: "completed" })));
      } else if (event.event === "error") {
        streamFailed = true;
        setStage(null);
        setSendError(event.data.message);
        setMessages((current) => replaceAssistant(current, assistantId, (message) => ({
          ...message,
          content: message.content || "回答失败，请检查模型配置或稍后重试。",
          status: "failed",
          errorMessage: event.data.message,
        })));
      }
    };

    try {
      await streamChat({ question, conversationId }, handleEvent, controller.signal);
      if (conversationId) {
        const canonical = await getConversation(conversationId);
        setMessages(canonical.messages);
        const lastAssistant = lastAssistantMessage(canonical.messages);
        setCitations(lastAssistant?.citations ?? []);
        setRoute(lastAssistant?.route ?? []);
      }
      await refreshConversations();
      if (!streamFailed) setSendError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error, "问答请求失败");
      setSendError(message);
      setMessages((current) => replaceAssistant(current, assistantId, (item) => ({
        ...item,
        content: item.content || "回答失败，请稍后重试。",
        status: "failed",
        errorMessage: message,
      })));
    } finally {
      abortRef.current = null;
      setStage(null);
      setStreaming(false);
    }
  };

  const disabledReason = hasKnowledgeBase ? "文档完成解析和向量化后，即可开始在线对话。" : role === "user"
    ? "请联系知识库管理人员创建知识库并导入资料。"
    : "先创建知识库并导入企业资料，系统才能自动选库并生成带引用的回答。";

  if (!readyForChat) {
    return (
      <div className="chat-layout chat-layout-empty">
        <section className="chat-panel">
          <div className="chat-empty"><div className="chat-orbit"><Sparkles size={24} /></div><h2>{hasKnowledgeBase ? "知识库还没有可检索内容" : "还没有可用于问答的知识库"}</h2><p>{disabledReason}</p>{role !== "user" ? <Button variant="primary" icon={Database} onClick={() => navigate("knowledge")}>{hasKnowledgeBase ? "查看知识库" : "创建知识库"}</Button> : null}</div>
          <div className="composer composer-disabled"><label htmlFor="chat-input" className="sr-only">输入问题</label><textarea id="chat-input" disabled placeholder="知识库可检索后开放输入" /><div className="composer-footer"><span><Sparkles size={14} />全库自动路由</span><button disabled aria-label="发送问题"><ArrowRight size={18} /></button></div></div>
        </section>
      </div>
    );
  }

  return (
    <div className="chat-layout">
      <section className="chat-panel">
        <div className="chat-toolbar">
          <label htmlFor="conversation-select" className="sr-only">选择历史对话</label>
          <History size={15} aria-hidden="true" />
          <select id="conversation-select" value={selectedConversationId ?? ""} onChange={(event) => event.target.value ? void openConversation(event.target.value) : startNewConversation()} disabled={streaming}>
            <option value="">新对话</option>
            {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
          <Button icon={Plus} onClick={startNewConversation} disabled={streaming}>新对话</Button>
        </div>

        <div className="conversation" aria-live="polite" aria-busy={streaming}>
          {loadingHistory ? <div className="chat-loading" role="status">正在加载对话…</div> : null}
          {historyError ? <div className="chat-error" role="alert"><ShieldAlert size={16} /><span>{historyError}</span><Button icon={RefreshCw} onClick={() => selectedConversationId ? void openConversation(selectedConversationId) : void refreshConversations()}>重试</Button></div> : null}
          {!loadingHistory && !historyError && !messages.length ? <div className="chat-empty chat-empty-ready"><div className="chat-orbit"><Sparkles size={24} /></div><h2>从企业知识中获得有依据的回答</h2><p>输入问题后，系统会自动选择最多 3 个知识库，执行混合检索，并展示引用来源。</p></div> : null}
          {messages.map((message) => (
            <article key={message.id} className={cn("message", message.role === "user" ? "user-message" : "assistant-message", message.status === "failed" && "message-failed")}>
              <span className="message-avatar" aria-hidden="true">{message.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}</span>
              <div>
                <strong>{message.role === "user" ? "你" : "知识助手"}</strong>
                {message.role === "assistant" && message.route.length ? <div className="routing-card"><div className="routing-title"><Route size={15} /><strong>已自动选择知识库</strong><span>{message.route.length} 个</span></div><div className="routing-kbs">{message.route.map((item) => <span key={item.knowledgeBaseId}>{item.name} <em>匹配 {item.score.toFixed(3)}</em></span>)}</div></div> : null}
                <p className="message-content">{message.content}{streaming && message.id.startsWith("stream-assistant-") ? <span className="stream-cursor" aria-hidden="true" /> : null}</p>
                {message.errorMessage ? <small className="message-error">{message.errorMessage}</small> : null}
                {message.role === "assistant" && message.citations.length ? <div className="answer-footer"><span>回答引用 {message.citations.length} 个知识分段</span><button onClick={() => setCitations(message.citations)}><FileText size={14} />查看引用</button></div> : null}
              </div>
            </article>
          ))}
          {stage ? <div className="chat-stage" role="status"><span className="stage-pulse" aria-hidden="true" />{stage}</div> : null}
          {warnings.map((warning) => <div key={warning} className="chat-warning" role="status"><ShieldAlert size={15} />{warning}</div>)}
          {sendError ? <div className="chat-error" role="alert"><ShieldAlert size={16} /><span>{sendError}</span>{lastQuestion ? <Button icon={RefreshCw} onClick={() => void send(lastQuestion)} disabled={streaming}>重新发送</Button> : null}</div> : null}
          <div ref={threadEndRef} />
        </div>

        <div className="composer">
          <label htmlFor="chat-input" className="sr-only">输入问题</label>
          <textarea
            id="chat-input"
            value={draft}
            maxLength={4000}
            disabled={streaming}
            placeholder="输入关于企业知识的问题"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer"><span><Sparkles size={14} />全库自动路由 · Enter 发送，Shift + Enter 换行</span><button onClick={() => void send()} disabled={!draft.trim() || streaming} aria-label={streaming ? "正在生成回答" : "发送问题"}><ArrowRight size={18} /></button></div>
        </div>
      </section>

      <aside className="citation-panel" aria-label="回答引用">
        <div className="citation-heading"><div><h2>引用来源</h2><p>{citations.length ? `${citations.length} 个知识分段` : "回答生成后显示原始依据"}</p></div><FileText size={18} aria-hidden="true" /></div>
        {citations.length ? citations.map((citation) => <article className="citation-item" key={`${citation.chunkId}-${citation.index}`}><div><span className="citation-index">[{citation.index}]</span><strong>{citation.filename}</strong></div><small>{citation.knowledgeBaseName} · {sourceLocation(citation)}</small><p>{citation.content}</p></article>) : <EmptyState compact icon={MessageCircle} title="暂无引用" description="发送问题后，引用文件和原文位置会显示在这里。" />}
        {route.length ? <div className="route-detail"><h3>自动选库</h3><dl>{route.map((item) => <div key={item.knowledgeBaseId}><dt>{item.name}</dt><dd>{item.score.toFixed(3)}</dd></div>)}</dl></div> : null}
      </aside>
    </div>
  );
}
