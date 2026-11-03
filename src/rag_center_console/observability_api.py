from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .auth import require_roles
from .database import get_db
from .models import (
    AgentApp,
    Document,
    IngestionJob,
    KnowledgeBase,
    ModelCallLog,
    ModelDefinition,
    ModelPrice,
    OperationLog,
    Provider,
    QueryLog,
    Role,
    utc_now,
)
from .observability_schemas import ModelPriceInput, ModelPriceRead

router = APIRouter()
require_admin = require_roles(Role.ADMIN)


def _time_filters(start: datetime | None, end: datetime | None) -> list[Any]:
    filters = []
    if start:
        filters.append(QueryLog.created_at >= start)
    if end:
        filters.append(QueryLog.created_at <= end)
    return filters


def _number(value: Decimal | float | int | None) -> float:
    return float(value or 0)


def _model_read(call: ModelCallLog) -> dict[str, Any]:
    return {
        "id": call.id,
        "query_log_id": call.query_log_id,
        "ingestion_job_id": call.ingestion_job_id,
        "provider": call.provider,
        "model_id": call.model_id,
        "protocol": call.protocol,
        "purpose": call.purpose,
        "input_context": call.input_context,
        "output_content": call.output_content,
        "input_tokens": call.input_tokens,
        "output_tokens": call.output_tokens,
        "total_tokens": call.total_tokens,
        "estimated": call.estimated,
        "latency_ms": call.latency_ms,
        "retry_count": call.retry_count,
        "input_price_per_million": _number(call.input_price_per_million) if call.input_price_per_million is not None else None,
        "output_price_per_million": _number(call.output_price_per_million) if call.output_price_per_million is not None else None,
        "currency": call.currency,
        "estimated_cost": _number(call.estimated_cost) if call.estimated_cost is not None else None,
        "status": call.status,
        "error_message": call.error_message,
        "created_at": call.created_at,
    }


def _operation_read(operation: OperationLog) -> dict[str, Any]:
    return {
        "id": operation.id,
        "query_log_id": operation.query_log_id,
        "ingestion_job_id": operation.ingestion_job_id,
        "agent_id": operation.agent_id,
        "tool_id": operation.tool_id,
        "kind": operation.kind,
        "operation": operation.operation,
        "status": operation.status,
        "input_json": operation.input_json,
        "output_json": operation.output_json,
        "context_json": operation.context_json,
        "http_status": operation.http_status,
        "latency_ms": operation.latency_ms,
        "unit_count": operation.unit_count,
        "unit_name": operation.unit_name,
        "estimated_cost": _number(operation.estimated_cost) if operation.estimated_cost is not None else None,
        "error_type": operation.error_type,
        "error_message": operation.error_message,
        "created_at": operation.created_at,
    }


def _run_summary(log: QueryLog) -> dict[str, Any]:
    return {
        "id": log.id,
        "agent_id": log.agent_id,
        "agent_name": log.agent_name or "全库知识问答",
        "conversation_id": log.conversation_id,
        "question": log.question,
        "answer": log.answer,
        "status": log.status,
        "grounded": log.grounded,
        "route": log.route or [],
        "total_ms": log.total_ms,
        "first_token_ms": log.first_token_ms,
        "retry_count": log.retry_count,
        "total_tokens": sum(call.total_tokens for call in log.model_calls),
        "estimated_tokens": sum(call.total_tokens for call in log.model_calls if call.estimated),
        "estimated_cost": sum((_number(call.estimated_cost) for call in log.model_calls if call.estimated_cost is not None), 0),
        "has_unpriced_calls": any(call.estimated_cost is None for call in log.model_calls),
        "error_type": log.error_type,
        "failed_stage": log.failed_stage,
        "error_message": log.error_message,
        "created_at": log.created_at,
        "completed_at": log.completed_at,
    }


def _run_detail(log: QueryLog, operations: list[OperationLog]) -> dict[str, Any]:
    return {
        **_run_summary(log),
        "citations": log.citations or [],
        "route_candidates": log.route_candidates or [],
        "route_ms": log.route_ms,
        "retrieval_ms": log.retrieval_ms,
        "rerank_ms": log.rerank_ms,
        "model_calls": [_model_read(call) for call in log.model_calls],
        "operations": [_operation_read(operation) for operation in operations],
    }


@router.get("/observability/summary")
def observability_summary(
    start: datetime | None = None,
    end: datetime | None = None,
    agent_id: str | None = None,
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = _time_filters(start, end)
    if agent_id:
        filters.append(QueryLog.agent_id == agent_id)
    run_count = db.scalar(select(func.count(QueryLog.id)).where(*filters)) or 0
    completed = db.scalar(select(func.count(QueryLog.id)).where(*filters, QueryLog.status == "completed")) or 0
    failed = db.scalar(select(func.count(QueryLog.id)).where(*filters, QueryLog.status == "failed")) or 0
    cancelled = db.scalar(select(func.count(QueryLog.id)).where(*filters, QueryLog.status == "cancelled")) or 0
    running = db.scalar(select(func.count(QueryLog.id)).where(*filters, QueryLog.status == "running")) or 0
    durations = list(db.scalars(select(QueryLog.total_ms).where(*filters, QueryLog.total_ms.is_not(None)).order_by(QueryLog.total_ms)).all())
    call_statement = select(ModelCallLog).join(QueryLog, ModelCallLog.query_log_id == QueryLog.id).where(*filters)
    calls = list(db.scalars(call_statement).all())
    job_filters = []
    if start:
        job_filters.append(IngestionJob.created_at >= start)
    if end:
        job_filters.append(IngestionJob.created_at <= end)
    operation_filters = []
    if start:
        operation_filters.append(OperationLog.created_at >= start)
    if end:
        operation_filters.append(OperationLog.created_at <= end)
    return {
        "run_count": run_count,
        "completed_count": completed,
        "failed_count": failed,
        "cancelled_count": cancelled,
        "running_count": running,
        "success_rate": completed / run_count if run_count else None,
        "p50_total_ms": durations[int(len(durations) * 0.5)] if durations else None,
        "p95_total_ms": durations[min(len(durations) - 1, int(len(durations) * 0.95))] if durations else None,
        "total_tokens": sum(call.total_tokens for call in calls),
        "estimated_tokens": sum(call.total_tokens for call in calls if call.estimated),
        "estimated_cost": sum((_number(call.estimated_cost) for call in calls if call.estimated_cost is not None), 0),
        "unpriced_call_count": sum(1 for call in calls if call.estimated_cost is None),
        "ingestion_count": db.scalar(select(func.count(IngestionJob.id)).where(*job_filters)) or 0,
        "failed_operation_count": db.scalar(select(func.count(OperationLog.id)).where(*operation_filters, OperationLog.status == "failed")) or 0,
    }


@router.get("/observability/overview")
def observability_overview(
    start: datetime | None = None,
    end: datetime | None = None,
    agent_id: str | None = None,
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = _time_filters(start, end)
    if agent_id:
        filters.append(QueryLog.agent_id == agent_id)
    logs = list(db.scalars(select(QueryLog).where(*filters).options(selectinload(QueryLog.model_calls)).order_by(QueryLog.created_at)).all())
    daily: dict[str, dict[str, Any]] = {}
    agent_groups: dict[str, list[QueryLog]] = {}
    for log in logs:
        day = log.created_at.date().isoformat()
        bucket = daily.setdefault(day, {"date": day, "run_count": 0, "completed_count": 0, "failed_count": 0, "cancelled_count": 0, "total_tokens": 0, "estimated_cost": 0.0})
        bucket["run_count"] += 1
        if log.status == "completed":
            bucket["completed_count"] += 1
        elif log.status == "failed":
            bucket["failed_count"] += 1
        elif log.status == "cancelled":
            bucket["cancelled_count"] += 1
        bucket["total_tokens"] += sum(call.total_tokens for call in log.model_calls)
        bucket["estimated_cost"] += sum((_number(call.estimated_cost) for call in log.model_calls if call.estimated_cost is not None), 0)
        agent_groups.setdefault(log.agent_name or "全库知识问答", []).append(log)
    agent_rows = []
    for name, items in agent_groups.items():
        durations = sorted(item.total_ms for item in items if item.total_ms is not None)
        completed = sum(item.status == "completed" for item in items)
        calls = [call for item in items for call in item.model_calls]
        agent_rows.append({
            "agent_name": name,
            "run_count": len(items),
            "completed_count": completed,
            "failed_count": sum(item.status == "failed" for item in items),
            "success_rate": completed / len(items) if items else None,
            "average_total_ms": sum(durations) / len(durations) if durations else None,
            "p95_total_ms": durations[min(len(durations) - 1, int(len(durations) * 0.95))] if durations else None,
            "total_tokens": sum(call.total_tokens for call in calls),
            "estimated_cost": sum((_number(call.estimated_cost) for call in calls if call.estimated_cost is not None), 0),
            "last_run_at": max(item.created_at for item in items),
        })
    agent_rows.sort(key=lambda item: item["run_count"], reverse=True)

    job_filters = []
    if start:
        job_filters.append(IngestionJob.created_at >= start)
    if end:
        job_filters.append(IngestionJob.created_at <= end)
    jobs = list(db.scalars(select(IngestionJob).where(*job_filters)).all())
    parse_strategy: dict[str, int] = {}
    metadata_status: dict[str, int] = {}
    job_status: dict[str, int] = {}
    for job in jobs:
        document = job.document
        parse_strategy[document.parse_strategy] = parse_strategy.get(document.parse_strategy, 0) + 1
        metadata_status[document.metadata_status] = metadata_status.get(document.metadata_status, 0) + 1
        job_status[job.status] = job_status.get(job.status, 0) + 1

    operation_filters = []
    if start:
        operation_filters.append(OperationLog.created_at >= start)
    if end:
        operation_filters.append(OperationLog.created_at <= end)
    operations = list(db.scalars(select(OperationLog).where(*operation_filters)).all())
    operation_groups: dict[str, dict[str, Any]] = {}
    for operation in operations:
        bucket = operation_groups.setdefault(operation.kind, {"kind": operation.kind, "total": 0, "completed": 0, "failed": 0, "cancelled": 0, "running": 0})
        bucket["total"] += 1
        if operation.status in bucket:
            bucket[operation.status] += 1

    call_filters = []
    if start:
        call_filters.append(ModelCallLog.created_at >= start)
    if end:
        call_filters.append(ModelCallLog.created_at <= end)
    call_statement = select(ModelCallLog).where(*call_filters)
    if agent_id:
        call_statement = call_statement.join(QueryLog, ModelCallLog.query_log_id == QueryLog.id).where(QueryLog.agent_id == agent_id)
    calls = list(db.scalars(call_statement).all())
    model_groups: dict[tuple[Any, ...], list[ModelCallLog]] = {}
    for call in calls:
        model_groups.setdefault((call.provider, call.model_id, call.currency), []).append(call)
    return {
        "daily": list(daily.values()),
        "agents": agent_rows,
        "ingestion": {
            "total": len(jobs),
            "status": [{"name": key, "count": value} for key, value in job_status.items()],
            "parse_strategy": [{"name": key, "count": value} for key, value in parse_strategy.items()],
            "metadata_status": [{"name": key, "count": value} for key, value in metadata_status.items()],
            "chunk_count": sum(job.document.chunk_count for job in jobs),
        },
        "operations": list(operation_groups.values()),
        "models": [_usage_group(keys, items) for keys, items in model_groups.items()],
    }


def _list_agent_runs(
    *,
    q: str | None,
    status: str | None,
    agent_id: str | None,
    start: datetime | None,
    end: datetime | None,
    offset: int,
    limit: int,
    db: Session,
) -> dict[str, Any]:
    filters = _time_filters(start, end)
    if q and q.strip():
        term = f"%{q.strip()}%"
        filters.append((QueryLog.question.ilike(term)) | (QueryLog.answer.ilike(term)))
    if status:
        filters.append(QueryLog.status == status)
    if agent_id:
        filters.append(QueryLog.agent_id == agent_id)
    statement = select(QueryLog).where(*filters)
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    logs = list(db.scalars(statement.options(selectinload(QueryLog.model_calls)).order_by(QueryLog.created_at.desc()).offset(offset).limit(limit)).all())
    return {"items": [_run_summary(log) for log in logs], "total": total}


@router.get("/observability/agents")
def list_agent_runs(
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern="^(completed|failed|cancelled|running)$"),
    agent_id: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _list_agent_runs(q=q, status=status, agent_id=agent_id, start=start, end=end, offset=offset, limit=limit, db=db)


@router.get("/observability/agents/{run_id}")
def get_agent_run(run_id: str, _=Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    log = db.scalar(select(QueryLog).where(QueryLog.id == run_id).options(selectinload(QueryLog.model_calls)))
    if log is None:
        raise HTTPException(status_code=404, detail="Agent 运行记录不存在")
    operations = list(db.scalars(select(OperationLog).where(OperationLog.query_log_id == run_id).order_by(OperationLog.created_at)).all())
    return _run_detail(log, operations)


@router.get("/observability/conversations")
def list_observed_conversations(
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern="^(completed|failed|cancelled|running)$"),
    agent_id: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return _list_agent_runs(q=q, status=status, agent_id=agent_id, start=start, end=end, offset=offset, limit=limit, db=db)


def _job_summary(job: IngestionJob, calls: list[ModelCallLog]) -> dict[str, Any]:
    document = job.document
    return {
        "id": job.id,
        "document_id": document.id,
        "filename": document.filename,
        "knowledge_base_id": document.knowledge_base_id,
        "knowledge_base_name": document.knowledge_base.name,
        "parse_strategy": document.parse_strategy,
        "chunk_method": document.chunk_method,
        "metadata_status": document.metadata_status,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "attempts": job.attempts,
        "cancel_requested": job.cancel_requested,
        "error_message": job.error_message,
        "chunk_count": document.chunk_count,
        "total_tokens": sum(call.total_tokens for call in calls),
        "estimated_tokens": sum(call.total_tokens for call in calls if call.estimated),
        "estimated_cost": sum((_number(call.estimated_cost) for call in calls if call.estimated_cost is not None), 0),
        "has_unpriced_calls": any(call.estimated_cost is None for call in calls),
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
    }


def _job_calls(db: Session, job_id: str) -> list[ModelCallLog]:
    return list(db.scalars(select(ModelCallLog).where(ModelCallLog.ingestion_job_id == job_id).order_by(ModelCallLog.created_at)).all())


@router.get("/observability/ingestion")
def list_ingestion_runs(
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern="^(queued|running|succeeded|failed|cancelled)$"),
    knowledge_base_id: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = []
    if q and q.strip():
        filters.append(Document.filename.ilike(f"%{q.strip()}%"))
    if status:
        filters.append(IngestionJob.status == status)
    if knowledge_base_id:
        filters.append(Document.knowledge_base_id == knowledge_base_id)
    if start:
        filters.append(IngestionJob.created_at >= start)
    if end:
        filters.append(IngestionJob.created_at <= end)
    statement = select(IngestionJob).join(Document).where(*filters)
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    jobs = list(db.scalars(statement.order_by(IngestionJob.created_at.desc()).offset(offset).limit(limit)).all())
    return {"items": [_job_summary(job, _job_calls(db, job.id)) for job in jobs], "total": total}


@router.get("/observability/ingestion/{job_id}")
def get_ingestion_run(job_id: str, _=Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    job = db.get(IngestionJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="知识构建记录不存在")
    calls = _job_calls(db, job.id)
    operations = list(db.scalars(select(OperationLog).where(OperationLog.ingestion_job_id == job_id).order_by(OperationLog.created_at)).all())
    return {**_job_summary(job, calls), "model_calls": [_model_read(call) for call in calls], "operations": [_operation_read(operation) for operation in operations]}


@router.get("/observability/operations")
def list_operations(
    kind: str | None = Query(default=None, pattern="^(tool|skill|harness|doc_parser)$"),
    status: str | None = Query(default=None, pattern="^(completed|failed|cancelled|running)$"),
    tool_id: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = []
    if kind:
        filters.append(OperationLog.kind == kind)
    if status:
        filters.append(OperationLog.status == status)
    if tool_id:
        filters.append(OperationLog.tool_id == tool_id)
    if start:
        filters.append(OperationLog.created_at >= start)
    if end:
        filters.append(OperationLog.created_at <= end)
    statement = select(OperationLog).where(*filters)
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    operations = list(db.scalars(statement.order_by(OperationLog.created_at.desc()).offset(offset).limit(limit)).all())
    return {"items": [_operation_read(operation) for operation in operations], "total": total}


def _usage_group(keys: tuple[Any, ...], calls: list[ModelCallLog]) -> dict[str, Any]:
    return {
        "keys": list(keys),
        "call_count": len(calls),
        "input_tokens": sum(call.input_tokens for call in calls),
        "output_tokens": sum(call.output_tokens for call in calls),
        "total_tokens": sum(call.total_tokens for call in calls),
        "estimated_tokens": sum(call.total_tokens for call in calls if call.estimated),
        "estimated_cost": sum((_number(call.estimated_cost) for call in calls if call.estimated_cost is not None), 0),
        "unpriced_call_count": sum(1 for call in calls if call.estimated_cost is None),
    }


@router.get("/observability/billing")
def billing_summary(
    start: datetime | None = None,
    end: datetime | None = None,
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = []
    if start:
        filters.append(ModelCallLog.created_at >= start)
    if end:
        filters.append(ModelCallLog.created_at <= end)
    calls = list(db.scalars(select(ModelCallLog).where(*filters).options(selectinload(ModelCallLog.query_log)).order_by(ModelCallLog.created_at)).all())
    models: dict[tuple[Any, ...], list[ModelCallLog]] = {}
    agents: dict[tuple[Any, ...], list[ModelCallLog]] = {}
    days: dict[tuple[Any, ...], list[ModelCallLog]] = {}
    for call in calls:
        models.setdefault((call.provider, call.model_id, call.currency), []).append(call)
        if call.query_log:
            agents.setdefault((call.query_log.agent_id, call.query_log.agent_name or "全库知识问答", call.currency), []).append(call)
        days.setdefault((call.created_at.date().isoformat(), call.currency), []).append(call)
    operation_filters = [OperationLog.kind == "doc_parser"]
    if start:
        operation_filters.append(OperationLog.created_at >= start)
    if end:
        operation_filters.append(OperationLog.created_at <= end)
    operations = list(db.scalars(select(OperationLog).where(*operation_filters).order_by(OperationLog.created_at)).all())
    return {
        "models": [_usage_group(keys, items) for keys, items in models.items()],
        "agents": [_usage_group(keys, items) for keys, items in agents.items()],
        "days": [_usage_group(keys, items) for keys, items in days.items()],
        "doc_parser": {
            "call_count": len(operations),
            "document_count": sum(operation.unit_count for operation in operations),
            "estimated_cost": sum((_number(operation.estimated_cost) for operation in operations if operation.estimated_cost is not None), 0),
            "unpriced_call_count": sum(1 for operation in operations if operation.estimated_cost is None),
        },
    }


@router.get("/observability/prices", response_model=list[ModelPriceRead])
def list_model_prices(_=Depends(require_admin), db: Session = Depends(get_db)) -> list[ModelPriceRead]:
    models = list(db.scalars(select(ModelDefinition).join(Provider).order_by(Provider.name, ModelDefinition.model_id)).all())
    result = []
    for model in models:
        model_price = db.get(ModelPrice, model.id)
        result.append(ModelPriceRead(
            model_id=model.id,
            model_name=model.name,
            provider=model.provider.name,
            model_type=model.model_type,
            enabled=model.enabled,
            input_price_per_million=model_price.input_price_per_million if model_price else Decimal(0),
            output_price_per_million=model_price.output_price_per_million if model_price else Decimal(0),
            currency=model_price.currency if model_price else "CNY",
            updated_at=model_price.updated_at if model_price else None,
        ))
    return result


@router.put("/observability/prices", response_model=ModelPriceRead)
def update_model_price(payload: ModelPriceInput, _=Depends(require_admin), db: Session = Depends(get_db)) -> ModelPriceRead:
    model = db.get(ModelDefinition, payload.model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    price = db.get(ModelPrice, model.id) or ModelPrice(model_id=model.id)
    price.input_price_per_million = payload.input_price_per_million
    price.output_price_per_million = payload.output_price_per_million
    price.currency = payload.currency
    price.updated_at = utc_now()
    db.add(price)
    db.commit()
    return ModelPriceRead(
        model_id=model.id,
        model_name=model.name,
        provider=model.provider.name,
        model_type=model.model_type,
        enabled=model.enabled,
        input_price_per_million=price.input_price_per_million,
        output_price_per_million=price.output_price_per_million,
        currency=price.currency,
        updated_at=price.updated_at,
    )
