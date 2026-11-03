from datetime import timedelta

from celery import Celery

from .config import get_settings
from .database import SessionLocal
from .ingestion import default_services, recover_stale_jobs, rebuild_knowledge_base, reindex_chunk, run_ingestion
from .logs import cleanup_expired_logs_task

settings = get_settings()
STALE_AFTER = timedelta(minutes=20)

celery_app = Celery("rag_center", broker=settings.redis_url)
celery_app.conf.update(
    task_acks_late=True,  # worker 崩溃时任务会重新投递，run_ingestion 对重复投递幂等
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    beat_schedule={
        "recover-stale-ingestion-jobs": {"task": "rag_center.recover_stale_jobs", "schedule": 300.0},
        "cleanup-expired-query-logs": {"task": "rag_center.cleanup_expired_logs", "schedule": 3600.0},
    },
)


@celery_app.task(name="rag_center.ingest_document")
def ingest_document(job_id: str) -> None:
    run_ingestion(job_id, SessionLocal, default_services())


@celery_app.task(name="rag_center.reindex_chunk")
def reindex_chunk_task(chunk_id: str) -> None:
    reindex_chunk(chunk_id, SessionLocal, default_services())


@celery_app.task(name="rag_center.rebuild_knowledge_base")
def rebuild_knowledge_base_task(knowledge_base_id: str, embedding_model_id: str) -> None:
    rebuild_knowledge_base(knowledge_base_id, embedding_model_id, SessionLocal, default_services())


@celery_app.task(name="rag_center.recover_stale_jobs")
def recover_stale_jobs_task() -> list[str]:
    return recover_stale_jobs(SessionLocal, ingest_document.delay, STALE_AFTER)


@celery_app.task(name="rag_center.cleanup_expired_logs")
def cleanup_expired_logs_task_entry() -> int:
    return cleanup_expired_logs_task(SessionLocal)
