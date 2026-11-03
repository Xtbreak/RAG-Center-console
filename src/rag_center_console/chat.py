"""在线对话：检索增强提示词、供应商流式输出与引用结构。"""

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from time import perf_counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .adapters import ProbeTarget, stream_text
from .models import AgentApp, ChatMessage, Conversation, KnowledgeBase, ModelType
from .retrieval import (
    RetrievalPipeline,
    RetrievalResult,
    RetrievalServices,
    RouteSelection,
    get_default_model,
    model_target,
    retrieve_across_bases,
)
from .telemetry import finish_call, messages_text


NO_EVIDENCE_ANSWER = "未检索到能够支持回答的知识库依据。请补充问题细节，或联系知识库管理人员导入相关资料。"


@dataclass(slots=True)
class ChatServices:
    retrieval: RetrievalServices
    stream: Callable[..., AsyncIterator[str]] = stream_text


def citations_from_result(result: RetrievalResult) -> list[dict[str, Any]]:
    return [
        {
            "index": index,
            "chunk_id": hit.chunk_id,
            "knowledge_base_id": hit.knowledge_base_id,
            "knowledge_base_name": hit.knowledge_base_name,
            "document_id": hit.document_id,
            "filename": hit.filename,
            "content": hit.content[:1200],
            "location": hit.location,
        }
        for index, hit in enumerate(result.hits, start=1)
    ]


def route_from_result(result: RetrievalResult) -> list[dict[str, Any]]:
    return [
        {
            "knowledge_base_id": selection.knowledge_base_id,
            "name": selection.name,
            "score": selection.score,
            "reason": selection.reason,
        }
        for selection in result.selected_knowledge_bases
    ]


def answer_messages(
    question: str,
    result: RetrievalResult,
    history: list[ChatMessage],
    custom_prompt: str = "",
) -> list[dict[str, str]]:
    evidence = "\n\n".join(
        f"[{index}] 知识库：{hit.knowledge_base_name}\n文件：{hit.filename}\n位置：{hit.location}\n内容：{hit.content}"
        for index, hit in enumerate(result.hits, start=1)
    )
    system = (
        "你是企业知识库问答助手。必须只依据给出的检索内容回答，不得使用未提供的事实。"
        "每个事实后用 [数字] 标注对应依据；若依据不足，明确说明无法从知识库确认。"
        "不要编造文件、页码、制度或结论。使用简洁、清晰的中文。\n"
        + (f"应用回答要求：{custom_prompt.strip()}\n" if custom_prompt.strip() else "")
        + "\n检索内容：\n"
        + evidence
    )
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    for message in history[-6:]:
        if message.role in {"user", "assistant"} and message.content:
            messages.append({"role": message.role, "content": message.content})
    messages.append({"role": "user", "content": question})
    return messages


def answer_target(db: Session, services: RetrievalServices) -> ProbeTarget:
    # 1.0 复用系统默认“路由 LLM”承担有依据回答；后续如新增回答模型默认项，可在此独立切换。
    model = get_default_model(db, "routing_llm", ModelType.LLM, required=True)
    return model_target(model, services.secret_box)


async def stream_grounded_answer(
    db: Session,
    services: ChatServices,
    conversation: Conversation,
    question: str,
    *,
    top_k: int = 8,
    agent: AgentApp | None = None,
) -> AsyncIterator[tuple[str, Any]]:
    if agent is not None:
        yield "stage", {"name": "routing", "label": "正在读取应用绑定的知识库"}
        bases = list(db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(agent.knowledge_base_ids or []))).all()) if agent.knowledge_base_ids else []
        selections = [RouteSelection(kb.id, kb.name, 1.0, "应用指定知识库") for kb in bases]
        result = await retrieve_across_bases(db, services.retrieval, question, selections, top_k=top_k)
        result.route_ms = 0.0
    else:
        yield "stage", {"name": "routing", "label": "正在自动选择知识库"}
        result = await RetrievalPipeline(services.retrieval).run(db, question, top_k=top_k)
    yield "routing", {"selected": route_from_result(result)}
    yield "stage", {"name": "retrieval", "label": "正在执行混合检索与重排"}
    for warning in result.warnings:
        yield "warning", {"message": warning}
    telemetry = {
        "route_candidates": result.route_candidates,
        "route_ms": result.route_ms,
        "retrieval_ms": result.retrieval_ms,
        "rerank_ms": result.rerank_ms,
        "first_token_ms": None,
    }
    if result.insufficient:
        yield "delta", {"text": NO_EVIDENCE_ANSWER}
        yield "complete", {
            "answer": NO_EVIDENCE_ANSWER,
            "citations": [],
            "route": route_from_result(result),
            "grounded": False,
            "telemetry": telemetry,
        }
        return
    citations = citations_from_result(result) if agent is None or agent.show_citations else []
    yield "citations", {"items": citations}
    yield "stage", {"name": "generation", "label": "正在根据检索依据生成回答"}
    # 当前问题已经写入数据库，历史上下文排除最后一条，避免重复。
    history = list(conversation.messages[:-1])
    messages = answer_messages(question, result, history, agent.prompt if agent else "")
    chunks: list[str] = []
    target = answer_target(db, services.retrieval)
    trace = services.retrieval.trace
    record = trace.start(target, "answer_llm") if trace else None
    started = perf_counter()
    latest_usage: dict[str, int | float] | None = None

    def capture_usage(usage: dict[str, int | float] | None) -> None:
        nonlocal latest_usage
        latest_usage = usage

    try:
        async for delta in services.stream(target, messages, on_usage=capture_usage):
            if not chunks:
                telemetry["first_token_ms"] = round((perf_counter() - started) * 1000, 3)
            chunks.append(delta)
            yield "delta", {"text": delta}
    except BaseException as exc:
        if record:
            finish_call(
                record,
                started=started,
                usage=latest_usage,
                input_text=messages_text(messages),
                output_text="".join(chunks),
                error=exc,
                input_context=messages,
            )
        raise
    answer = "".join(chunks).strip()
    if record:
        finish_call(
            record,
            started=started,
            usage=latest_usage,
            input_text=messages_text(messages),
            output_text=answer,
            input_context=messages,
        )
    if not answer:
        raise RuntimeError("模型没有返回回答")
    yield "complete", {
        "answer": answer,
        "citations": citations,
        "route": route_from_result(result),
        "grounded": True,
        "telemetry": telemetry,
    }
