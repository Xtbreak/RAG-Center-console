import asyncio
import json
from collections.abc import AsyncIterator
from time import perf_counter
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import get_current_session
from .chat import ChatServices, stream_grounded_answer
from .database import get_db
from .logs import persist_model_calls
from .models import AgentApp, AnonymousSession, ChatMessage, Conversation, QueryLog, Role, utc_now
from .observability import record_operation
from .retrieval import RetrievalError
from .retrieval_api import get_retrieval_services
from .schemas import ChatMessageRead, ChatStreamRequest, ConversationDetail, ConversationRead
from .telemetry import CallTrace


router = APIRouter()


def get_chat_services() -> ChatServices:
    return ChatServices(retrieval=get_retrieval_services())


def _conversation_or_404(db: Session, session_id: str, conversation_id: str) -> Conversation:
    try:
        UUID(conversation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="对话不存在") from exc
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id, Conversation.anonymous_session_id == session_id
        )
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return conversation


def _message_read(message: ChatMessage) -> ChatMessageRead:
    return ChatMessageRead(
        id=message.id,
        role=message.role,
        content=message.content,
        citations=message.citations or [],
        route=message.route or [],
        status=message.status,
        error_message=message.error_message,
        created_at=message.created_at,
    )


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


@router.get("/conversations", response_model=list[ConversationRead])
def list_conversations(
    anonymous_session: AnonymousSession = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[ConversationRead]:
    conversations = db.scalars(
        select(Conversation)
        .where(Conversation.anonymous_session_id == anonymous_session.id)
        .order_by(Conversation.updated_at.desc())
    ).all()
    return [ConversationRead.model_validate(item, from_attributes=True) for item in conversations]


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(
    conversation_id: str,
    anonymous_session: AnonymousSession = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ConversationDetail:
    conversation = _conversation_or_404(db, anonymous_session.id, conversation_id)
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[_message_read(message) for message in conversation.messages],
    )


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatStreamRequest,
    anonymous_session: AnonymousSession = Depends(get_current_session),
    db: Session = Depends(get_db),
    services: ChatServices = Depends(get_chat_services),
) -> StreamingResponse:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="问题不能为空")
    agent = db.get(AgentApp, payload.agent_id) if payload.agent_id else None
    if payload.agent_id and (agent is None or (anonymous_session.role == Role.USER.value and not agent.published)):
        raise HTTPException(status_code=404, detail="应用不存在或未发布")
    if payload.conversation_id:
        conversation = _conversation_or_404(db, anonymous_session.id, payload.conversation_id)
    else:
        conversation = Conversation(
            anonymous_session_id=anonymous_session.id,
            title=question[:40] + ("…" if len(question) > 40 else ""),
        )
        db.add(conversation)
        db.flush()
    conversation.updated_at = utc_now()
    user_message = ChatMessage(conversation=conversation, role="user", content=question)
    trace = CallTrace()
    services.retrieval.trace = trace
    query_log = QueryLog(
        anonymous_session_id=anonymous_session.id,
        conversation_id=conversation.id,
        agent_id=agent.id if agent else None,
        agent_name=agent.name if agent else "全库知识问答",
        question=question,
    )
    db.add_all([user_message, query_log])
    db.commit()
    db.refresh(conversation)
    started = perf_counter()
    current_stage = "request"

    def finish_log(
        status: str,
        completed: dict | None = None,
        error: str | None = None,
        error_type: str | None = None,
    ) -> None:
        telemetry = (completed or {}).get("telemetry", {})
        query_log.status = status
        query_log.answer = completed["answer"] if completed else ("回答失败" if status == "failed" else "")
        query_log.citations = (completed or {}).get("citations", [])
        query_log.route = (completed or {}).get("route", [])
        query_log.grounded = bool((completed or {}).get("grounded", False))
        query_log.route_candidates = telemetry.get("route_candidates", [])
        query_log.route_ms = telemetry.get("route_ms", 0.0)
        query_log.retrieval_ms = telemetry.get("retrieval_ms", 0.0)
        query_log.rerank_ms = telemetry.get("rerank_ms", 0.0)
        query_log.first_token_ms = telemetry.get("first_token_ms")
        query_log.total_ms = round((perf_counter() - started) * 1000, 3)
        query_log.error_type = error_type
        query_log.failed_stage = current_stage if error else None
        query_log.error_message = error
        query_log.completed_at = utc_now()
        persist_model_calls(db, query_log, trace)
        if error:
            record_operation(
                db,
                query_log_id=query_log.id,
                agent_id=agent.id if agent else None,
                kind="harness",
                operation=current_stage,
                status=status,
                input_json={"question": question},
                output_json={"answer": query_log.answer},
                context_json={"conversation_id": conversation.id, "agent_name": query_log.agent_name},
                latency_ms=query_log.total_ms,
                error_type=error_type,
                error_message=error,
            )
        db.add(query_log)

    async def events() -> AsyncIterator[str]:
        nonlocal current_stage
        yield _sse("conversation", {"conversation_id": conversation.id, "title": conversation.title})
        try:
            completed: dict | None = None
            async for event, data in stream_grounded_answer(db, services, conversation, question, agent=agent):
                if event == "stage":
                    current_stage = str(data.get("name", current_stage))
                if event == "complete":
                    completed = data
                yield _sse(event, data)
            if completed is None:
                raise RuntimeError("回答流程未正常结束")
            assistant = ChatMessage(
                conversation_id=conversation.id,
                role="assistant",
                content=completed["answer"],
                citations=completed["citations"],
                route=completed["route"],
            )
            conversation.updated_at = utc_now()
            db.add(assistant)
            finish_log("completed", completed)
            db.commit()
            yield _sse("done", {"message_id": assistant.id, "grounded": completed["grounded"]})
        except asyncio.CancelledError:
            db.rollback()
            finish_log("cancelled", error="客户端断开流式回答", error_type="client_disconnected")
            db.commit()
            raise
        except Exception as exc:
            message = str(exc)[:500]
            assistant = ChatMessage(
                conversation_id=conversation.id,
                role="assistant",
                content="回答失败，请检查模型配置或稍后重试。",
                status="failed",
                error_message=message,
            )
            db.add(assistant)
            finish_log("failed", error=message, error_type=type(exc).__name__)
            db.commit()
            yield _sse("error", {"message": message})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
