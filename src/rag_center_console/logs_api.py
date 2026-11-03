from datetime import UTC, datetime, time

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .auth import require_roles
from .database import get_db
from .logs import get_log_retention_days, set_log_retention_days
from .models import QueryLog, Role
from .schemas import (
    LogRetentionRead,
    LogRetentionUpdate,
    ModelCallLogRead,
    QueryLogDetailRead,
    QueryLogPage,
    QueryLogStats,
    QueryLogSummaryRead,
)

router = APIRouter()
require_admin = require_roles(Role.ADMIN)


def _summary(log: QueryLog) -> QueryLogSummaryRead:
    return QueryLogSummaryRead(
        id=log.id,
        conversation_id=log.conversation_id,
        question=log.question,
        status=log.status,
        grounded=log.grounded,
        route=log.route or [],
        first_token_ms=log.first_token_ms,
        total_ms=log.total_ms,
        retry_count=log.retry_count,
        total_tokens=sum(call.total_tokens for call in log.model_calls),
        estimated=any(call.estimated for call in log.model_calls),
        error_message=log.error_message,
        created_at=log.created_at,
    )


@router.get("/logs", response_model=QueryLogPage)
def list_logs(
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, pattern="^(completed|failed|cancelled|running)$"),
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> QueryLogPage:
    filters = []
    if q and q.strip():
        term = f"%{q.strip()}%"
        filters.append(or_(QueryLog.question.ilike(term), QueryLog.answer.ilike(term)))
    if status:
        filters.append(QueryLog.status == status)
    if start:
        filters.append(QueryLog.created_at >= start)
    if end:
        filters.append(QueryLog.created_at <= end)
    statement = select(QueryLog).where(*filters)
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    logs = db.scalars(
        statement.options(selectinload(QueryLog.model_calls))
        .order_by(QueryLog.created_at.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return QueryLogPage(items=[_summary(log) for log in logs], total=total)


@router.get("/logs/stats", response_model=QueryLogStats)
def log_stats(_=Depends(require_admin), db: Session = Depends(get_db)) -> QueryLogStats:
    today = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)
    today_count = db.scalar(select(func.count(QueryLog.id)).where(QueryLog.created_at >= today)) or 0
    average = db.scalar(select(func.avg(QueryLog.total_ms)).where(QueryLog.total_ms.is_not(None)))
    return QueryLogStats(today_count=today_count, average_total_ms=round(average, 3) if average is not None else None)


@router.get("/logs/retention", response_model=LogRetentionRead)
def read_retention(_=Depends(require_admin), db: Session = Depends(get_db)) -> LogRetentionRead:
    return LogRetentionRead(days=get_log_retention_days(db))


@router.put("/logs/retention", response_model=LogRetentionRead)
def update_retention(
    payload: LogRetentionUpdate,
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> LogRetentionRead:
    return LogRetentionRead(days=set_log_retention_days(db, payload.days))


@router.get("/logs/{log_id}", response_model=QueryLogDetailRead)
def get_log(log_id: str, _=Depends(require_admin), db: Session = Depends(get_db)) -> QueryLogDetailRead:
    log = db.scalar(
        select(QueryLog).where(QueryLog.id == log_id).options(selectinload(QueryLog.model_calls))
    )
    if log is None:
        raise HTTPException(status_code=404, detail="查询日志不存在")
    return QueryLogDetailRead(
        **_summary(log).model_dump(),
        answer=log.answer,
        citations=log.citations or [],
        route_candidates=log.route_candidates or [],
        route_ms=log.route_ms,
        retrieval_ms=log.retrieval_ms,
        rerank_ms=log.rerank_ms,
        completed_at=log.completed_at,
        model_calls=[ModelCallLogRead.model_validate(call, from_attributes=True) for call in log.model_calls],
    )
