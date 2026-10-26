import hashlib
import io

import boto3
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws

from rag_center_console.auth import require_knowledge_manager
from rag_center_console.database import SessionLocal
from rag_center_console.models import Document, KnowledgeBase, ModelDefinition, Provider, Role
from rag_center_console.storage import ObjectStorage, StorageError, document_storage_key
from rag_center_console.uploads import (
    UploadRejected,
    find_duplicate_documents,
    normalize_filename,
    spool_upload,
)

PDF = b"%PDF-1.7 test"
ZIP = b"PK\x03\x04" + b"0" * 20


def spool(name, mime, data, limit=1024):
    return spool_upload(name, mime, io.BytesIO(data), limit)


def test_spool_upload_accepts_valid_file_and_hashes_content():
    upload = spool("资料/说明.PDF", "application/pdf", PDF)
    assert (upload.filename, upload.extension, upload.mime_type, upload.size_bytes) == ("说明.PDF", "pdf", "application/pdf", len(PDF))
    assert upload.sha256 == hashlib.sha256(PDF).hexdigest()
    assert upload.file.read() == PDF


def test_generic_mime_is_replaced_by_the_expected_type():
    assert spool("a.docx", "application/octet-stream", ZIP).mime_type.endswith("wordprocessingml.document")
    assert spool("a.md", None, "# 标题".encode()).mime_type == "text/markdown"


@pytest.mark.parametrize(
    ("name", "mime", "data", "limit", "message"),
    [
        ("a.exe", "application/octet-stream", b"MZ", 1024, "不支持的文件格式"),
        ("noext", None, b"x", 1024, "不支持的文件格式"),
        ("a.pdf", "image/png", PDF, 1024, "不匹配"),
        ("a.pdf", "application/pdf", b"not a pdf", 1024, "不符"),
        ("a.png", "image/png", b"", 1024, "为空"),
        ("a.pdf", "application/pdf", PDF + b"0" * 100, 50, "上限"),
        ("a.csv", "text/csv", b"a,b\x00\x01", 1024, "不符"),
        ("", "application/pdf", PDF, 1024, "文件名"),
    ],
)
def test_spool_upload_rejects_invalid_files(name, mime, data, limit, message):
    with pytest.raises(UploadRejected, match=message):
        spool(name, mime, data, limit)


def test_normalize_filename_strips_directories():
    assert normalize_filename(r"C:\fakepath\报告.docx") == "报告.docx"
    assert normalize_filename("../../etc/passwd.md") == "passwd.md"


def test_find_duplicate_documents_matches_only_same_knowledge_base_and_hash():
    with SessionLocal() as db:
        provider = Provider(preset_id="custom", name="p", base_url="https://x.test", api_key_encrypted="x", api_key_last4="1234", default_protocol="OpenAI Embeddings")
        model = ModelDefinition(provider=provider, name="m", model_id="m", model_type="embedding", protocol="OpenAI Embeddings", vector_dimension=8)
        db.add(model)
        db.flush()
        bases = [KnowledgeBase(name=f"kb{i}", embedding_model_id=model.id, vector_dimension=8, collection_name=f"c{i}") for i in range(2)]
        db.add_all(bases)
        db.flush()
        for kb in bases:
            db.add(Document(knowledge_base_id=kb.id, filename="a.pdf", extension="pdf", mime_type="application/pdf", size_bytes=1, sha256="a" * 64, storage_key="k"))
        db.commit()
        found = find_duplicate_documents(db, bases[0].id, "a" * 64)
        assert [d.knowledge_base_id for d in found] == [bases[0].id]
        assert find_duplicate_documents(db, bases[0].id, "b" * 64) == []


@pytest.fixture
def storage():
    with mock_aws():
        yield ObjectStorage(endpoint_url="https://s3.amazonaws.com", access_key="test", secret_key="test", bucket="unit", region="us-east-1")


def test_storage_creates_bucket_and_round_trips_objects(storage):
    key = document_storage_key("kb", "doc", "pdf")
    storage.put(key, io.BytesIO("你好".encode()), "application/pdf")
    assert storage.get(key) == "你好".encode()
    storage.put("knowledge-bases/kb/documents/doc2/original.md", io.BytesIO(b"x"), "text/markdown")
    storage.delete_prefix("knowledge-bases/kb/")
    with pytest.raises(StorageError):
        storage.get(key)


def test_storage_reports_unavailable_service():
    unreachable = ObjectStorage(endpoint_url="http://127.0.0.1:9", access_key="a", secret_key="b", bucket="x", region="us-east-1")
    with pytest.raises(StorageError, match="对象存储不可用"):
        unreachable.put("k", io.BytesIO(b"x"), "text/plain")


def _guarded_app():
    app = FastAPI()

    @app.get("/guarded")
    def guarded(role: Role = Depends(require_knowledge_manager)):
        return {"role": role.value}

    return app


def test_role_guard_requires_session_and_allowed_role(client):
    with TestClient(_guarded_app()) as bare:
        assert bare.get("/guarded").status_code == 401
        client.put("/api/v1/session", json={"role": "user"})
        bare.cookies.set("rag_session", client.cookies["rag_session"])
        assert bare.get("/guarded").status_code == 403
        client.put("/api/v1/session", json={"role": "manager"})
        assert bare.get("/guarded").json() == {"role": "manager"}
