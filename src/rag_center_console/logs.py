from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from .models import ModelCallLog, ModelPrice, QueryLog, SystemSetting, utc_now
from .telemetry import CallTrace

LOG_RETENTION_KEY = "log_retention_days"
DEFAULT_LOG_RETENTION_DAYS = 90


def get_log_retention_days(db: Session) -> int:
    setting = db.get(SystemSetting, LOG_RETENTION_KEY)
    if setting is None or not isinstance(setting.value, int):
        return DEFAULT_LOG_RETENTION_DAYS
    return min(max(setting.value, 1), 3650)


def set_log_retention_days(db: Session, days: int) -> int:
    setting = db.get(SystemSetting, LOG_RETENTION_KEY) or SystemSetting(key=LOG_RETENTION_KEY)
    setting.value = days
    setting.updated_at = utc_now()
    db.add(setting)
    db.commit()
    return days


def persist_model_calls(
    db: Session,
    query_log: QueryLog | None,
    trace: CallTrace,
    *,
    ingestion_job_id: str | None = None,
) -> None:
    for record in trace.records:
        price = db.get(ModelPrice, record.definition_id) if record.definition_id else None
        cost = None
        if price is not None:
            cost = (price.input_price_per_million * record.input_tokens + price.output_price_per_million * record.output_tokens) / 1000000
        db.add(
            ModelCallLog(
                query_log_id=query_log.id if query_log else None,
                ingestion_job_id=ingestion_job_id,
                provider_id=record.provider_id,
                provider=record.provider,
                model_id=record.model_id,
                protocol=record.protocol,
                purpose=record.purpose,
                input_context=record.input_context,
                output_content=record.output_content,
                input_tokens=record.input_tokens,
                output_tokens=record.output_tokens,
                total_tokens=record.total_tokens,
                estimated=record.estimated,
                latency_ms=record.latency_ms,
                retry_count=record.retry_count,
                input_price_per_million=price.input_price_per_million if price else None,
                output_price_per_million=price.output_price_per_million if price else None,
                currency=price.currency if price else None,
                estimated_cost=cost,
                status=record.status,
                error_message=record.error_message,
            )
        )
    if query_log:
        query_log.retry_count = sum(record.retry_count for record in trace.records)


def cleanup_expired_logs(db: Session, *, now: datetime | None = None) -> int:
    cutoff = (now or datetime.now(UTC)) - timedelta(days=get_log_retention_days(db))
    ids = list(db.scalars(select(QueryLog.id).where(QueryLog.created_at < cutoff).limit(5000)).all())
    if not ids:
        return 0
    db.execute(delete(ModelCallLog).where(ModelCallLog.query_log_id.in_(ids)))
    result = db.execute(delete(QueryLog).where(QueryLog.id.in_(ids)))
    db.commit()
    return result.rowcount or 0


def cleanup_expired_logs_task(session_factory: sessionmaker[Session]) -> int:
    with session_factory() as db:
        return cleanup_expired_logs(db)
