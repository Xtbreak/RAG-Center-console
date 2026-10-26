import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from rag_center_console.database import SessionLocal
from rag_center_console.models import (
    Chunk,
    Document,
    DocumentStatus,
    IngestionJob,
    KnowledgeBase,
    ModelDefinition,
    Provider,
)


def _embedding_model(db) -> ModelDefinition:
    provider = Provider(
        preset_id="custom",
        name="测试供应商",
        base_url="https://example.test/v1",
        api_key_encrypted="x",
        api_key_last4="1234",
        default_protocol="OpenAI Embeddings",
    )
    model = ModelDefinition(
        provider=provider,
        name="embed",
        model_id="embed-1",
        model_type="embedding",
        protocol="OpenAI Embeddings",
        vector_dimension=8,
    )
    db.add(model)
    db.flush()
    return model


def _knowledge_base(db, name: str = "产品手册") -> KnowledgeBase:
    model = _embedding_model(db) if not db.scalar(select(func.count(ModelDefinition.id))) else db.scalar(select(ModelDefinition))
    kb = KnowledgeBase(
        name=name,
        embedding_model_id=model.id,
        vector_dimension=8,
        collection_name=f"kb_{name}",
    )
    db.add(kb)
    db.flush()
    return kb


def test_deleting_knowledge_base_cascades_to_documents_jobs_and_chunks():
    with SessionLocal() as db:
        kb = _knowledge_base(db)
        document = Document(
            knowledge_base_id=kb.id,
            filename="a.md",
            extension="md",
            mime_type="text/markdown",
            size_bytes=3,
            sha256="0" * 64,
            storage_key="kb/a.md",
        )
        document.jobs.append(IngestionJob())
        document.chunks.append(
            Chunk(knowledge_base_id=kb.id, position=0, content="你好", content_hash="1" * 64, location={"page": 1})
        )
        db.add(document)
        db.commit()

        assert document.status == DocumentStatus.UPLOADED.value
        assert document.chunks[0].location == {"page": 1}

        db.delete(kb)
        db.commit()
        for table in (Document, IngestionJob, Chunk):
            assert db.scalar(select(func.count()).select_from(table)) == 0


def test_chunk_position_is_unique_per_document():
    with SessionLocal() as db:
        kb = _knowledge_base(db)
        document = Document(
            knowledge_base_id=kb.id,
            filename="a.md",
            extension="md",
            mime_type="text/markdown",
            size_bytes=3,
            sha256="0" * 64,
            storage_key="kb/a.md",
        )
        for _ in range(2):
            document.chunks.append(
                Chunk(knowledge_base_id=kb.id, position=0, content="x", content_hash="1" * 64)
            )
        db.add(document)
        with pytest.raises(IntegrityError):
            db.commit()


def test_knowledge_base_name_is_unique():
    with SessionLocal() as db:
        _knowledge_base(db, "同名")
        db.commit()
        db.add(KnowledgeBase(name="同名", embedding_model_id=db.scalar(select(ModelDefinition.id)), vector_dimension=8, collection_name="other"))
        with pytest.raises(IntegrityError):
            db.commit()
