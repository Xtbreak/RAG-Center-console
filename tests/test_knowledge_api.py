import pytest
from qdrant_client import QdrantClient

from rag_center_console.config import get_settings
from rag_center_console.database import SessionLocal
from rag_center_console.ingestion import PipelineServices
from rag_center_console.knowledge_api import get_pipeline_services
from rag_center_console.main import app
from rag_center_console.models import Chunk, IngestionJob, KnowledgeBase
from rag_center_console.security import get_secret_box
from rag_center_console.storage import StorageError
from rag_center_console.vectorstore import VectorStore

MARKDOWN = "# 标题\n\n正文内容。".encode()


class FakeStorage:
    def __init__(self):
        self.objects = {}
        self.fail = False

    def put(self, key, body, content_type):
        if self.fail:
            raise StorageError("对象存储不可用，请检查存储服务和访问密钥")
        self.objects[key] = body.read()

    def get(self, key):
        return self.objects[key]

    def delete_prefix(self, prefix):
        for key in [k for k in self.objects if k.startswith(prefix)]:
            del self.objects[key]


@pytest.fixture
def env(client, monkeypatch):
    storage = FakeStorage()
    vectors = VectorStore(QdrantClient(":memory:"))
    queued = {"ingest": [], "reindex": [], "rebuild": []}
    monkeypatch.setattr("rag_center_console.knowledge_api.get_storage", lambda: storage)
    monkeypatch.setattr("rag_center_console.tasks.enqueue_ingestion", lambda job_id: queued["ingest"].append(job_id) or "task-1")
    monkeypatch.setattr("rag_center_console.tasks.enqueue_chunk_reindex", lambda chunk_id: queued["reindex"].append(chunk_id))
    monkeypatch.setattr("rag_center_console.tasks.enqueue_rebuild", lambda kb_id, model_id: queued["rebuild"].append((kb_id, model_id)))
    app.dependency_overrides[get_pipeline_services] = lambda: PipelineServices(
        storage=storage, vector_store=vectors, secret_box=get_secret_box(),
        parser_factory=None, embed=None, describe=None,
    )
    client.put("/api/v1/session", json={"role": "manager"})
    yield client, storage, vectors, queued
    app.dependency_overrides.clear()


def create_embedding_model(client, model_id="embed-1", dimension=8, model_type="embedding", name="p"):
    provider = client.post("/api/v1/providers", json={
        "preset_id": "custom", "name": name, "base_url": "https://api.test/v1",
        "api_key": "sk-test-key-1234", "default_protocol": "OpenAI Embeddings",
    }).json()
    payload = {"provider_id": provider["id"], "name": model_id, "model_id": model_id, "model_type": model_type,
               "protocol": "OpenAI Embeddings" if model_type == "embedding" else "OpenAI Chat Completions"}
    if model_type == "embedding":
        payload["vector_dimension"] = dimension
    response = client.post("/api/v1/models", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_kb(client, name="产品手册", **extra):
    model_id = extra.pop("embedding_model_id", None) or create_embedding_model(client, name=f"p-{name}")
    response = client.post("/api/v1/knowledge-bases", json={"name": name, "embedding_model_id": model_id, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def upload(client, kb_id, name="手册.md", data=MARKDOWN, mime="text/markdown", **form):
    return client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": (name, data, mime)},
        data={key: str(value).lower() for key, value in form.items()},
    )


def test_knowledge_base_crud_and_validation(env):
    client, *_ = env
    kb = create_kb(client, description=" 说明 ", chunk_size=500, chunk_overlap=50)
    assert (kb["description"], kb["vector_dimension"], kb["document_count"], kb["status"]) == ("说明", 8, 0, "ready")
    assert [item["name"] for item in client.get("/api/v1/knowledge-bases").json()] == ["产品手册"]

    duplicate = client.post("/api/v1/knowledge-bases", json={"name": "产品手册", "embedding_model_id": kb["embedding_model_id"]})
    assert duplicate.status_code == 409
    llm = create_embedding_model(client, "chat", model_type="llm", name="p-llm")
    assert client.post("/api/v1/knowledge-bases", json={"name": "x", "embedding_model_id": llm}).status_code == 422
    bad_overlap = client.post("/api/v1/knowledge-bases", json={"name": "y", "embedding_model_id": kb["embedding_model_id"], "chunk_size": 200, "chunk_overlap": 200})
    assert bad_overlap.status_code == 422

    updated = client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"name": "新名称", "chunk_size": 600})
    assert (updated.json()["name"], updated.json()["chunk_size"]) == ("新名称", 600)
    assert client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"chunk_overlap": 600}).status_code == 422
    assert client.delete(f"/api/v1/knowledge-bases/{kb['id']}").status_code == 204
    assert client.get(f"/api/v1/knowledge-bases/{kb['id']}").status_code == 404


def test_roles_gate_knowledge_endpoints(env):
    client, *_ = env
    kb = create_kb(client)
    client.put("/api/v1/session", json={"role": "user"})
    assert client.get("/api/v1/knowledge-bases").status_code == 200  # 使用者可查看知识库概况
    assert client.post("/api/v1/knowledge-bases", json={"name": "n", "embedding_model_id": kb["embedding_model_id"]}).status_code == 403
    assert client.get(f"/api/v1/knowledge-bases/{kb['id']}/documents").status_code == 403
    assert upload(client, kb["id"]).status_code == 403
    client.cookies.clear()
    assert client.get("/api/v1/knowledge-bases").status_code == 401


def test_upload_stores_file_creates_job_and_dispatches(env):
    client, storage, _, queued = env
    kb = create_kb(client)
    response = upload(client, kb["id"], parse_strategy="fast", enhance_images=False)
    assert response.status_code == 201, response.text
    document = response.json()
    assert (document["status"], document["job_status"], document["parse_strategy"], document["enhance_images"]) == ("uploaded", "queued", "fast", False)
    assert queued["ingest"] == [document["job_id"]]
    assert list(storage.objects.values()) == [MARKDOWN]
    listed = client.get(f"/api/v1/knowledge-bases/{kb['id']}/documents").json()
    assert [d["id"] for d in listed] == [document["id"]]
    assert client.get(f"/api/v1/knowledge-bases/{kb['id']}").json()["document_count"] == 1
    with SessionLocal() as db:
        assert db.get(IngestionJob, document["job_id"]).celery_task_id == "task-1"


def test_upload_rejections(env, monkeypatch):
    client, storage, _, queued = env
    kb = create_kb(client)
    assert upload(client, kb["id"], "a.exe", b"MZ", "application/octet-stream").status_code == 422
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 10)
    too_big = upload(client, kb["id"], "a.md", b"x" * 20)
    assert too_big.status_code == 413 and "上限" in too_big.json()["detail"]
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 1024)
    pdf = upload(client, kb["id"], "a.pdf", b"%PDF-1.7", "application/pdf")
    assert pdf.status_code == 422 and "阿里云" in pdf.json()["detail"]
    storage.fail = True
    assert upload(client, kb["id"]).status_code == 503
    assert storage.objects == {} and queued["ingest"] == []

    monkeypatch.setattr(get_settings(), "aliyun_docmind_access_key_id", "id")
    monkeypatch.setattr(get_settings(), "aliyun_docmind_access_key_secret", "secret")
    storage.fail = False
    assert upload(client, kb["id"], "a.pdf", b"%PDF-1.7", "application/pdf").status_code == 201


def test_duplicate_upload_needs_confirmation(env):
    client, *_ = env
    kb = create_kb(client)
    first = upload(client, kb["id"]).json()
    duplicate = upload(client, kb["id"], "副本.md")
    assert duplicate.status_code == 409
    detail = duplicate.json()["detail"]
    assert "手册.md" in detail["message"] and detail["duplicates"][0]["id"] == first["id"]
    assert upload(client, kb["id"], "副本.md", allow_duplicate=True).status_code == 201
    other = create_kb(client, "另一个库")
    assert upload(client, other["id"]).status_code == 201  # 去重只在同一知识库内


def test_queue_unavailable_keeps_document_for_retry(env, monkeypatch):
    client, _, _, queued = env
    kb = create_kb(client)

    def broken(job_id):
        raise ConnectionError("redis down")

    monkeypatch.setattr("rag_center_console.tasks.enqueue_ingestion", broken)
    document = upload(client, kb["id"]).json()
    assert document["status"] == "failed" and "任务队列不可用" in document["error_message"]

    monkeypatch.setattr("rag_center_console.tasks.enqueue_ingestion", lambda job_id: queued["ingest"].append(job_id) or "t")
    retried = client.post(f"/api/v1/documents/{document['id']}/retry").json()
    assert (retried["status"], retried["job_status"], retried["error_message"]) == ("uploaded", "queued", None)
    assert retried["job_id"] != document["job_id"] and queued["ingest"] == [retried["job_id"]]
    assert client.post(f"/api/v1/documents/{document['id']}/retry").status_code == 409


def test_cancel_queued_and_running_jobs(env):
    client, *_ = env
    kb = create_kb(client)
    queued_doc = upload(client, kb["id"]).json()
    cancelled = client.post(f"/api/v1/documents/{queued_doc['id']}/cancel").json()
    assert (cancelled["status"], cancelled["job_status"]) == ("cancelled", "cancelled")
    assert client.post(f"/api/v1/documents/{queued_doc['id']}/cancel").status_code == 409

    running_doc = upload(client, kb["id"], "b.md", "# 另一份".encode()).json()
    with SessionLocal() as db:
        db.get(IngestionJob, running_doc["job_id"]).status = "running"
        db.commit()
    response = client.post(f"/api/v1/documents/{running_doc['id']}/cancel").json()
    assert response["job_status"] == "running"
    with SessionLocal() as db:
        assert db.get(IngestionJob, running_doc["job_id"]).cancel_requested is True
    assert client.delete(f"/api/v1/documents/{running_doc['id']}").status_code == 409
    assert client.delete(f"/api/v1/knowledge-bases/{kb['id']}").status_code == 409


def _add_chunks(document_id, kb_id, texts):
    with SessionLocal() as db:
        db.get(IngestionJob, db.query(IngestionJob).filter_by(document_id=document_id).one().id).status = "succeeded"
        for position, text in enumerate(texts):
            db.add(Chunk(knowledge_base_id=kb_id, document_id=document_id, position=position, content=text, content_hash="0" * 64, vector_status="indexed"))
        db.commit()


def test_list_search_and_edit_chunks(env):
    client, _, _, queued = env
    kb = create_kb(client)
    document = upload(client, kb["id"]).json()
    _add_chunks(document["id"], kb["id"], [f"第{i}段" for i in range(25)] + ["包含关键字 Qdrant"])

    page = client.get(f"/api/v1/knowledge-bases/{kb['id']}/chunks", params={"limit": 10, "offset": 20}).json()
    assert page["total"] == 26 and [c["position"] for c in page["items"]] == [20, 21, 22, 23, 24, 25]
    found = client.get(f"/api/v1/knowledge-bases/{kb['id']}/chunks", params={"q": "qdrant"}).json()
    assert found["total"] == 1 and found["items"][0]["content"] == "包含关键字 Qdrant"

    chunk_id = page["items"][0]["id"]
    edited = client.patch(f"/api/v1/chunks/{chunk_id}", json={"content": "  修改后的内容  "}).json()
    assert (edited["content"], edited["edited"], edited["vector_status"]) == ("修改后的内容", True, "pending")
    assert edited["token_count"] == 6 and queued["reindex"] == [chunk_id]
    assert client.patch(f"/api/v1/chunks/{chunk_id}", json={"content": "   "}).status_code == 422
    assert client.patch("/api/v1/chunks/missing", json={"content": "x"}).status_code == 404


def test_changing_embedding_model_rebuilds_only_when_chunks_exist(env):
    client, _, vectors, queued = env
    kb = create_kb(client)
    other_model = create_embedding_model(client, "embed-2", dimension=16, name="p2")

    vectors.ensure_collection(_collection(kb["id"]), 8)
    empty = client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"embedding_model_id": other_model}).json()
    assert (empty["embedding_model_id"], empty["vector_dimension"], empty["status"]) == (other_model, 16, "ready")
    assert queued["rebuild"] == [] and not vectors._client.collection_exists(_collection(kb["id"]))

    document = upload(client, kb["id"]).json()
    _add_chunks(document["id"], kb["id"], ["内容"])
    third_model = create_embedding_model(client, "embed-3", dimension=4, name="p3")
    rebuilding = client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"embedding_model_id": third_model}).json()
    assert rebuilding["status"] == "rebuilding" and rebuilding["embedding_model_id"] == other_model
    assert queued["rebuild"] == [(kb["id"], third_model)]
    assert upload(client, kb["id"], "c.md", b"# c").status_code == 409
    assert client.patch(f"/api/v1/knowledge-bases/{kb['id']}", json={"name": "改名"}).status_code == 409


def _collection(kb_id):
    with SessionLocal() as db:
        return db.get(KnowledgeBase, kb_id).collection_name


def test_delete_document_and_knowledge_base_purges_storage(env):
    client, storage, *_ = env
    kb = create_kb(client)
    document = upload(client, kb["id"]).json()
    _add_chunks(document["id"], kb["id"], ["x"])
    assert client.delete(f"/api/v1/documents/{document['id']}").status_code == 204
    assert storage.objects == {} and client.get(f"/api/v1/documents/{document['id']}").status_code == 404
    upload(client, kb["id"])
    _add_chunks(client.get(f"/api/v1/knowledge-bases/{kb['id']}/documents").json()[0]["id"], kb["id"], ["y"])
    assert client.delete(f"/api/v1/knowledge-bases/{kb['id']}").status_code == 204
    assert storage.objects == {}


def test_models_used_by_a_knowledge_base_cannot_be_deleted(env):
    client, *_ = env
    kb = create_kb(client)
    response = client.delete(f"/api/v1/models/{kb['embedding_model_id']}")
    assert response.status_code == 409 and "产品手册" in response.json()["detail"]
    provider_id = client.get("/api/v1/models").json()[0]["provider_id"]
    assert client.delete(f"/api/v1/providers/{provider_id}").status_code == 409
