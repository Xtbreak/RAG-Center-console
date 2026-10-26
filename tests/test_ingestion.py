from datetime import timedelta
from uuid import uuid4

import pytest
from qdrant_client import QdrantClient
from sqlalchemy import func, select

from rag_center_console.adapters import EmbeddingResult, HealthCheckFailure
from rag_center_console.database import SessionLocal
from rag_center_console.ingestion import (
    PipelineServices,
    purge_document,
    rebuild_knowledge_base,
    recover_stale_jobs,
    reindex_chunk,
    run_ingestion,
)
from rag_center_console.models import (
    Chunk,
    Document,
    DocumentStatus,
    IngestionJob,
    JobStatus,
    KnowledgeBase,
    KnowledgeBaseStatus,
    ModelDefault,
    ModelDefinition,
    Provider,
    VectorStatus,
    utc_now,
)
from rag_center_console.parsing import Element, ParsedDocument, ParseError
from rag_center_console.security import get_secret_box
from rag_center_console.storage import document_storage_key
from rag_center_console.vectorstore import VectorStore, collection_name

MARKDOWN = "# 手册\n\n" + "\n\n".join(f"第 {i} 段内容，用来测试导入流水线。" for i in range(6))


class FakeStorage:
    def __init__(self):
        self.objects = {}

    def get(self, key):
        return self.objects[key]

    def delete_prefix(self, prefix):
        for key in [k for k in self.objects if k.startswith(prefix)]:
            del self.objects[key]


class Harness:
    def __init__(self):
        self.storage = FakeStorage()
        self.vectors = VectorStore(QdrantClient(":memory:"))
        self.embed_calls = []
        self.embed_hook = None
        self.parsed = ParsedDocument([Element("paragraph", "云端解析的正文", page=1)])
        self.described = []
        self.describe_error = None
        self.services = PipelineServices(
            storage=self.storage,
            vector_store=self.vectors,
            secret_box=get_secret_box(),
            parser_factory=lambda: type("P", (), {"parse": lambda _, data, name, ext, should_cancel: self.parsed})(),
            embed=self._embed,
            describe=self._describe,
        )

    def _embed(self, target, texts, dimension):
        self.embed_calls.append((target.model_id, list(texts), dimension))
        if self.embed_hook:
            self.embed_hook(texts)
        return EmbeddingResult([[1.0] * dimension for _ in texts], None)

    def _describe(self, target, image, mime):
        if self.describe_error:
            raise HealthCheckFailure(self.describe_error)
        self.described.append((target.model_id, mime))
        return "一张折线图"


@pytest.fixture
def h():
    return Harness()


def make_model(db, name="embed", dimension=4, protocol="OpenAI Embeddings", model_type="embedding"):
    provider = Provider(
        preset_id="custom", name=f"p-{name}", base_url="https://api.test/v1",
        api_key_encrypted=get_secret_box().encrypt("sk-test"), api_key_last4="test", default_protocol=protocol,
    )
    model = ModelDefinition(provider=provider, name=name, model_id=name, model_type=model_type, protocol=protocol, vector_dimension=dimension)
    db.add(model)
    db.flush()
    return model


def make_job(h, *, filename="a.md", data=MARKDOWN.encode(), chunk_size=40, enhance=True, model=None):
    with SessionLocal() as db:
        model = model or make_model(db)
        kb = KnowledgeBase(name=f"库-{uuid4()}", embedding_model_id=model.id, vector_dimension=model.vector_dimension, collection_name="placeholder", chunk_size=chunk_size, chunk_overlap=0)
        db.add(kb)
        db.flush()
        kb.collection_name = collection_name(kb.id)
        extension = filename.rsplit(".", 1)[1]
        document = Document(
            knowledge_base_id=kb.id, filename=filename, extension=extension, mime_type="text/markdown" if extension == "md" else "image/png",
            size_bytes=len(data), sha256="0" * 64, storage_key="pending", enhance_images=enhance,
        )
        document.jobs.append(IngestionJob())
        db.add(document)
        db.flush()
        document.storage_key = document_storage_key(kb.id, document.id, extension)
        db.commit()
        h.storage.objects[document.storage_key] = data
        return document.jobs[0].id, document.id, kb.id


def state(document_id):
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        job = document.jobs[-1]
        chunks = db.scalars(select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.position)).all()
        return document, job, chunks


def run(h, job_id):
    run_ingestion(job_id, SessionLocal, h.services)


def test_markdown_import_reaches_ready_and_indexes_every_chunk(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    document, job, chunks = state(document_id)
    assert (document.status, job.status, job.progress, job.attempts) == ("ready", "succeeded", 100, 1)
    assert len(chunks) == document.chunk_count > 1
    assert all(c.vector_status == "indexed" for c in chunks)
    assert chunks[0].location["heading_path"] == ["手册"]
    assert h.vectors.count(collection_name(kb_id)) == len(chunks)
    assert h.embed_calls[0][1][0].startswith("手册\n")  # 向量化文本带标题路径


def test_partial_embedding_failure_is_reported(h):
    def hook(texts):
        if any("第 24 段" in text for text in texts):
            raise HealthCheckFailure("限流")

    h.embed_hook = hook
    many = "\n\n".join(f"第 {i} 段内容，用来测试导入流水线。" for i in range(25))
    with SessionLocal() as db:  # DashScope 协议每批 10 条，25 个分段分 3 批，仅最后一批失败
        dashscope = make_model(db, "ds", protocol="DashScope Text Embeddings")
        db.commit()
        dashscope_id = dashscope.id
    with SessionLocal() as db:
        model = db.get(ModelDefinition, dashscope_id)
        job_id, document_id, kb_id = make_job(h, data=many.encode(), chunk_size=15, model=model)
    run(h, job_id)
    document, job, chunks = state(document_id)
    assert document.status == "partial_failed" and job.status == "succeeded"
    assert "向量化失败：限流" in document.error_message
    failed = [c for c in chunks if c.vector_status == "failed"]
    assert len(failed) == 5 and h.vectors.count(collection_name(kb_id)) == 20


def test_all_embedding_failures_mark_document_failed(h):
    h.embed_hook = lambda texts: (_ for _ in ()).throw(HealthCheckFailure("无效密钥"))
    job_id, document_id, _ = make_job(h)
    run(h, job_id)
    document, job, _ = state(document_id)
    assert (document.status, job.status) == ("failed", "failed") and "无效密钥" in job.error_message


def test_parse_error_and_unexpected_error_fail_with_messages(h):
    job_id, document_id, _ = make_job(h, data=b"  \n")
    run(h, job_id)
    document, job, _ = state(document_id)
    assert document.status == "failed" and "没有可解析" in document.error_message

    h2 = Harness()
    h2.embed_hook = lambda texts: (_ for _ in ()).throw(RuntimeError("boom secret"))
    job_id, document_id, _ = make_job(h2)
    run(h2, job_id)
    document, _, _ = state(document_id)
    assert document.status == "failed" and "boom" not in document.error_message


def test_cancel_during_embedding_cleans_everything_up(h):
    state_box = {}

    def hook(texts):
        with SessionLocal() as db:
            db.get(IngestionJob, state_box["job"]).cancel_requested = True
            db.commit()

    h.embed_hook = hook
    job_id, document_id, kb_id = make_job(h)
    state_box["job"] = job_id
    run(h, job_id)
    document, job, chunks = state(document_id)
    assert (document.status, job.status, chunks) == ("cancelled", "cancelled", [])
    assert h.vectors.count(collection_name(kb_id)) == 0


def test_retry_replaces_old_chunks_and_points(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    first_ids = {c.id for c in state(document_id)[2]}
    with SessionLocal() as db:
        retry = IngestionJob(document_id=document_id)
        db.add(retry)
        db.commit()
        retry_id = retry.id
    run(h, retry_id)
    _, _, chunks = state(document_id)
    assert not first_ids & {c.id for c in chunks}
    assert h.vectors.count(collection_name(kb_id)) == len(chunks)


def test_running_or_finished_jobs_are_not_claimed_twice(h):
    job_id, document_id, _ = make_job(h)
    run(h, job_id)
    calls = len(h.embed_calls)
    run(h, job_id)
    assert len(h.embed_calls) == calls and state(document_id)[1].attempts == 1


def test_cloud_image_gets_vision_description_when_model_is_configured(h):
    h.parsed = ParsedDocument([Element("paragraph", "OCR 文字")])
    job_id, document_id, _ = make_job(h, filename="chart.png", data=b"\x89PNG\r\n\x1a\n")
    with SessionLocal() as db:
        vision = make_model(db, "vision-1", None, "OpenAI Chat Completions", "vision")
        db.add(ModelDefault(purpose="vision", model_id=vision.id))
        db.commit()
    run(h, job_id)
    document, _, chunks = state(document_id)
    assert document.status == "ready" and h.described == [("vision-1", "image/png")]
    assert [c.kind for c in chunks] == ["text", "image"] and "一张折线图" in chunks[1].content


def test_image_without_vision_model_or_with_failing_one_is_partial(h):
    h.parsed = ParsedDocument([Element("paragraph", "OCR 文字")])
    job_id, document_id, _ = make_job(h, filename="chart.png", data=b"\x89PNG\r\n\x1a\n")
    run(h, job_id)
    document, _, _ = state(document_id)
    assert document.status == "partial_failed" and "未配置视觉模型" in document.error_message

    h.describe_error = "视觉模型限流"
    job_id, document_id, _ = make_job(h, filename="chart.png", data=b"\x89PNG\r\n\x1a\n")
    with SessionLocal() as db:
        vision = make_model(db, "vision-2", None, "OpenAI Chat Completions", "vision")
        db.add(ModelDefault(purpose="vision", model_id=vision.id))
        db.commit()
    run(h, job_id)
    document, _, _ = state(document_id)
    assert document.status == "partial_failed" and "视觉模型限流" in document.error_message

    job_id, document_id, _ = make_job(h, filename="chart.png", data=b"\x89PNG\r\n\x1a\n", enhance=False)
    run(h, job_id)
    assert state(document_id)[0].status == "ready"


def test_edited_chunk_is_reindexed_and_failure_is_recorded(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    chunk = state(document_id)[2][0]
    with SessionLocal() as db:
        db.get(Chunk, chunk.id).content = "改写后的内容"
        db.get(Chunk, chunk.id).vector_status = VectorStatus.PENDING.value
        db.commit()
    reindex_chunk(chunk.id, SessionLocal, h.services)
    assert state(document_id)[2][0].vector_status == "indexed"
    assert h.embed_calls[-1][1] == ["手册\n改写后的内容"]

    h.embed_hook = lambda texts: (_ for _ in ()).throw(HealthCheckFailure("down"))
    with pytest.raises(HealthCheckFailure):
        reindex_chunk(chunk.id, SessionLocal, h.services)
    assert state(document_id)[2][0].vector_status == "failed"


def test_rebuild_switches_to_new_collection_only_after_full_success(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    with SessionLocal() as db:
        new_model = make_model(db, "embed-v2", dimension=6)
        db.commit()
        new_id = new_model.id
    old = collection_name(kb_id)
    rebuild_knowledge_base(kb_id, new_id, SessionLocal, h.services)
    with SessionLocal() as db:
        kb = db.get(KnowledgeBase, kb_id)
        assert (kb.status, kb.embedding_model_id, kb.vector_dimension, kb.collection_name) == ("ready", new_id, 6, collection_name(kb_id, 2))
        assert h.vectors.count(kb.collection_name) == kb.documents[0].chunk_count
    assert not h.vectors._client.collection_exists(old)
    assert h.embed_calls[-1][2] == 6


def test_failed_rebuild_keeps_old_index_and_marks_the_knowledge_base(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    with SessionLocal() as db:
        new_id = make_model(db, "embed-v2", dimension=6).id
        db.commit()
    h.embed_hook = lambda texts: (_ for _ in ()).throw(HealthCheckFailure("额度不足"))
    with pytest.raises(HealthCheckFailure):
        rebuild_knowledge_base(kb_id, new_id, SessionLocal, h.services)
    with SessionLocal() as db:
        kb = db.get(KnowledgeBase, kb_id)
        assert (kb.status, kb.collection_name, kb.vector_dimension) == ("rebuild_failed", collection_name(kb_id), 4)
    assert h.vectors.count(collection_name(kb_id)) > 0
    assert not h.vectors._client.collection_exists(collection_name(kb_id, 2))


def test_rebuild_requires_a_vector_dimension(h):
    _, _, kb_id = make_job(h)
    with SessionLocal() as db:
        new_id = make_model(db, "no-dim", dimension=None).id
        db.commit()
    with pytest.raises(ParseError, match="向量维度"):
        rebuild_knowledge_base(kb_id, new_id, SessionLocal, h.services)


def test_recover_stale_jobs_requeues_or_cancels(h):
    stale_id, stale_doc, _ = make_job(h)
    cancel_id, cancel_doc, _ = make_job(h)
    fresh_id, _, _ = make_job(h)
    old = utc_now() - timedelta(hours=1)
    with SessionLocal() as db:
        db.get(IngestionJob, stale_id).status = JobStatus.RUNNING.value
        db.get(IngestionJob, stale_id).updated_at = old
        cancel = db.get(IngestionJob, cancel_id)
        cancel.cancel_requested, cancel.updated_at = True, old
        db.commit()
    dispatched = []
    recovered = recover_stale_jobs(SessionLocal, dispatched.append, timedelta(minutes=20))
    assert recovered == dispatched == [stale_id]
    assert state(stale_doc)[1].status == "queued"
    assert state(cancel_doc)[1].status == "cancelled" and state(cancel_doc)[0].status == "cancelled"
    with SessionLocal() as db:
        assert db.get(IngestionJob, fresh_id).status == "queued"


def test_purge_document_removes_points_objects_and_rows(h):
    job_id, document_id, kb_id = make_job(h)
    run(h, job_id)
    with SessionLocal() as db:
        purge_document(db, h.services, db.get(Document, document_id))
        assert db.scalar(select(func.count()).select_from(Chunk)) == 0
    assert h.vectors.count(collection_name(kb_id)) == 0 and h.storage.objects == {}
