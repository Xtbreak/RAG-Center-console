"""接口层投递异步任务的入口。单独成模块，便于测试中替换且避免接口导入时连接 Redis。"""


def enqueue_ingestion(job_id: str) -> str:
    from .worker import ingest_document

    return ingest_document.delay(job_id).id


def enqueue_chunk_reindex(chunk_id: str) -> None:
    from .worker import reindex_chunk_task

    reindex_chunk_task.delay(chunk_id)


def enqueue_rebuild(knowledge_base_id: str, embedding_model_id: str) -> None:
    from .worker import rebuild_knowledge_base_task

    rebuild_knowledge_base_task.delay(knowledge_base_id, embedding_model_id)
