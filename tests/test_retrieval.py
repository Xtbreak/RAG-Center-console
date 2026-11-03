from uuid import uuid4

import pytest
from qdrant_client import QdrantClient

from rag_center_console.adapters import EmbeddingResult, GenerationResult, RerankItem, RerankResult
from rag_center_console.chat import ChatServices
from rag_center_console.chat_api import get_chat_services
from rag_center_console.database import SessionLocal
from rag_center_console.main import app
from rag_center_console.models import (
    Chunk,
    Document,
    DocumentStatus,
    KnowledgeBase,
    ModelDefault,
    ModelDefinition,
    Provider,
    VectorStatus,
)
from rag_center_console.retrieval import (
    RetrievalError,
    RetrievalPipeline,
    RetrievalServices,
    route_knowledge_bases,
)
from rag_center_console.retrieval_api import get_retrieval_services
from rag_center_console.security import get_secret_box
from rag_center_console.vectorstore import VectorPoint, VectorStore, collection_name


def _uuid() -> str:
    return str(uuid4())


def seed_retrieval_data(db, vectors: VectorStore):
    secret_box = get_secret_box()
    provider = Provider(
        id=_uuid(),
        preset_id="custom",
        name="测试供应商",
        base_url="https://provider.test/v1",
        api_key_encrypted=secret_box.encrypt("secret-key"),
        api_key_last4="-key",
        default_protocol="OpenAI Chat Completions",
    )
    route_embedding = ModelDefinition(
        id=_uuid(), provider=provider, name="路由向量", model_id="route-embedding", model_type="embedding",
        protocol="OpenAI Embeddings", vector_dimension=2,
    )
    finance_embedding = ModelDefinition(
        id=_uuid(), provider=provider, name="财务向量", model_id="finance-embedding", model_type="embedding",
        protocol="OpenAI Embeddings", vector_dimension=2,
    )
    hr_embedding = ModelDefinition(
        id=_uuid(), provider=provider, name="人事向量", model_id="hr-embedding", model_type="embedding",
        protocol="OpenAI Embeddings", vector_dimension=2,
    )
    llm = ModelDefinition(
        id=_uuid(), provider=provider, name="路由模型", model_id="route-llm", model_type="llm",
        protocol="OpenAI Chat Completions",
    )
    reranker = ModelDefinition(
        id=_uuid(), provider=provider, name="重排模型", model_id="reranker", model_type="rerank",
        protocol="Cohere Rerank",
    )
    finance = KnowledgeBase(
        id=_uuid(), name="财务制度", description="报销、预算与发票管理", tags=["财务", "报销"],
        sample_questions=["差旅费如何报销？"], embedding_model=finance_embedding, vector_dimension=2,
        collection_name=collection_name(_uuid()),
    )
    # collection 名必须稳定使用该知识库自身 id
    finance.collection_name = collection_name(finance.id)
    hr = KnowledgeBase(
        id=_uuid(), name="人事制度", description="考勤、休假与入职管理", tags=["人事", "休假"],
        sample_questions=["年假有多少天？"], embedding_model=hr_embedding, vector_dimension=2,
        collection_name=collection_name(_uuid()),
    )
    hr.collection_name = collection_name(hr.id)
    finance_doc = Document(
        id=_uuid(), knowledge_base=finance, filename="差旅报销办法.pdf", extension="pdf", mime_type="application/pdf",
        size_bytes=100, sha256="a" * 64, storage_key="finance.pdf", status=DocumentStatus.READY.value,
        chunk_count=2,
    )
    hr_doc = Document(
        id=_uuid(), knowledge_base=hr, filename="休假制度.md", extension="md", mime_type="text/markdown",
        size_bytes=100, sha256="b" * 64, storage_key="hr.md", status=DocumentStatus.READY.value,
        chunk_count=1,
    )
    chunks = [
        Chunk(
            id=_uuid(), knowledge_base_id=finance.id, document=finance_doc, position=0, content="差旅住宿费凭发票报销，标准为每晚五百元。",
            content_hash="1" * 64, token_count=20, location={"page": 1}, vector_status=VectorStatus.INDEXED.value,
        ),
        Chunk(
            id=_uuid(), knowledge_base_id=finance.id, document=finance_doc, position=1, content="办公用品采购需要部门负责人审批。",
            content_hash="2" * 64, token_count=18, location={"page": 2}, vector_status=VectorStatus.INDEXED.value,
        ),
        Chunk(
            id=_uuid(), knowledge_base_id=hr.id, document=hr_doc, position=0, content="员工每年享有五天年假。",
            content_hash="3" * 64, token_count=12, location={}, vector_status=VectorStatus.INDEXED.value,
        ),
    ]
    db.add_all([
        provider, route_embedding, finance_embedding, hr_embedding, llm, reranker, finance, hr,
        finance_doc, hr_doc, *chunks,
        ModelDefault(purpose="routing_embedding", model_id=route_embedding.id),
        ModelDefault(purpose="routing_llm", model_id=llm.id),
        ModelDefault(purpose="default_rerank", model_id=reranker.id),
    ])
    db.commit()
    for kb in (finance, hr):
        vectors.ensure_collection(kb.collection_name, 2)
    vectors.upsert(finance.collection_name, [
        VectorPoint(chunks[0].id, [1.0, 0.0], {"chunk_id": chunks[0].id, "document_id": finance_doc.id}),
        VectorPoint(chunks[1].id, [0.7, 0.3], {"chunk_id": chunks[1].id, "document_id": finance_doc.id}),
    ])
    vectors.upsert(hr.collection_name, [
        VectorPoint(chunks[2].id, [0.0, 1.0], {"chunk_id": chunks[2].id, "document_id": hr_doc.id}),
    ])
    return {"finance": finance, "hr": hr, "finance_chunk": chunks[0]}


def fake_services(vectors: VectorStore, finance_id: str, *, invalid_route=False) -> RetrievalServices:
    async def embed(_target, texts, **_kwargs):
        result = []
        for text in texts:
            result.append([1.0, 0.0] if any(term in text for term in ("报销", "财务", "差旅")) else [0.0, 1.0])
        return EmbeddingResult(vectors=result, usage={"total_tokens": len(texts)})

    async def generate(_target, _messages, **_kwargs):
        text = "not-json" if invalid_route else f'{{"selected_ids":["{finance_id}"],"reasons":{{"{finance_id}":"涉及差旅报销"}}}}'
        return GenerationResult(text=text, usage={"total_tokens": 5})

    async def rerank(_target, _query, documents, **_kwargs):
        best = next(index for index, text in enumerate(documents) if "住宿费" in text)
        return RerankResult(items=[RerankItem(best, 0.98)], usage={"total_tokens": 3})

    return RetrievalServices(get_secret_box(), vectors, embed=embed, generate=generate, rerank=rerank)


@pytest.mark.asyncio
async def test_route_index_is_built_and_llm_selects_relevant_base():
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
        services = fake_services(vectors, data["finance"].id)
        selected = await route_knowledge_bases(db, services, "差旅住宿费怎么报销？")
        assert [(item.knowledge_base_id, item.reason) for item in selected] == [
            (data["finance"].id, "涉及差旅报销")
        ]
        assert data["finance"].route_index is not None
        assert data["hr"].route_index is not None


@pytest.mark.asyncio
async def test_empty_profile_uses_content_fallback_only_with_strong_coverage():
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
        data["finance"].description = ""
        data["finance"].tags = []
        data["finance"].sample_questions = []
        db.commit()
        services = fake_services(vectors, data["finance"].id)

        async def select_none(_target, _messages, **_kwargs):
            return GenerationResult(text='{"selected_ids":[],"reasons":{}}', usage=None)

        services.generate = select_none
        selected = await route_knowledge_bases(db, services, "差旅住宿费怎么报销？")
        assert [item.knowledge_base_id for item in selected] == [data["finance"].id]
        assert "回退检索" in selected[0].reason
        assert await route_knowledge_bases(db, services, "火星办公室怎样报销？") == []


@pytest.mark.asyncio
async def test_langchain_pipeline_runs_hybrid_retrieval_and_rerank():
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
        result = await RetrievalPipeline(fake_services(vectors, data["finance"].id)).run(
            db, "差旅住宿费怎么报销？", top_k=5
        )
        assert result.insufficient is False
        assert result.rerank_applied is True
        assert result.hits[0].chunk_id == data["finance_chunk"].id
        assert result.hits[0].dense_score > 0
        assert result.hits[0].bm25_score > 0
        assert result.hits[0].rerank_score == 0.98


@pytest.mark.asyncio
async def test_invalid_route_response_is_reported():
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
        with pytest.raises(RetrievalError, match="自动选库失败"):
            await route_knowledge_bases(
                db, fake_services(vectors, data["finance"].id, invalid_route=True), "差旅报销"
            )


def test_retrieval_test_endpoint_runs_real_pipeline_shape(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
    app.dependency_overrides[get_retrieval_services] = lambda: fake_services(vectors, data["finance"].id)
    try:
        client.put("/api/v1/session", json={"role": "manager"})
        response = client.post("/api/v1/retrieval/test", json={"query": "差旅住宿费怎么报销？", "top_k": 5})
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["selected_knowledge_bases"][0]["name"] == "财务制度"
        assert payload["hits"][0]["filename"] == "差旅报销办法.pdf"
        assert payload["rerank_applied"] is True
    finally:
        app.dependency_overrides.clear()


def test_chat_stream_returns_stages_citations_deltas_and_persists_history(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)

    async def stream(_target, _messages, on_usage=None):
        for delta in ("住宿费", "凭发票报销 [1]。"):
            yield delta
        if on_usage:
            on_usage({"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20})

    services = ChatServices(fake_services(vectors, data["finance"].id), stream=stream)
    app.dependency_overrides[get_chat_services] = lambda: services
    try:
        client.put("/api/v1/session", json={"role": "user"})
        response = client.post("/api/v1/chat/stream", json={"question": "差旅住宿费怎么报销？"})
        assert response.status_code == 200, response.text
        assert "event: routing" in response.text
        assert "event: citations" in response.text
        assert "event: delta" in response.text
        assert "event: done" in response.text
        assert "差旅报销办法.pdf" in response.text
        conversations = client.get("/api/v1/conversations").json()
        assert len(conversations) == 1
        detail = client.get(f"/api/v1/conversations/{conversations[0]['id']}").json()
        assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
        assert detail["messages"][1]["content"] == "住宿费凭发票报销 [1]。"
        assert detail["messages"][1]["citations"][0]["filename"] == "差旅报销办法.pdf"
        assert client.get("/api/v1/logs").status_code == 403
        client.put("/api/v1/session", json={"role": "admin"})
        page = client.get("/api/v1/logs").json()
        assert page["total"] == 1 and page["items"][0]["status"] == "completed"
        assert page["items"][0]["total_tokens"] >= 20 and page["items"][0]["estimated"] is False
        log = client.get(f"/api/v1/logs/{page['items'][0]['id']}").json()
        assert log["answer"] == "住宿费凭发票报销 [1]。"
        assert {call["purpose"] for call in log["model_calls"]} == {"routing_embedding", "routing_llm", "knowledge_embedding", "rerank", "answer_llm"}
        assert log["route_candidates"] and log["retrieval_ms"] >= 0 and log["first_token_ms"] >= 0
    finally:
        app.dependency_overrides.clear()


def test_chat_stream_with_no_selected_base_returns_no_evidence_without_calling_answer_model(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
    services = fake_services(vectors, data["finance"].id)

    async def select_none(_target, _messages, **_kwargs):
        return GenerationResult(text='{"selected_ids":[],"reasons":{}}', usage=None)

    services.generate = select_none

    async def should_not_stream(*_args, **_kwargs):
        raise AssertionError("无依据时不应调用回答模型")
        yield ""  # pragma: no cover

    app.dependency_overrides[get_chat_services] = lambda: ChatServices(services, stream=should_not_stream)
    try:
        client.put("/api/v1/session", json={"role": "user"})
        response = client.post("/api/v1/chat/stream", json={"question": "完全无关的问题"})
        assert response.status_code == 200
        assert "未检索到能够支持回答的知识库依据" in response.text
        assert '"grounded":false' in response.text
        assert "event: done" in response.text
    finally:
        app.dependency_overrides.clear()


def test_failed_chat_is_logged_with_sanitized_error(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
    services = ChatServices(fake_services(vectors, data["finance"].id, invalid_route=True))
    app.dependency_overrides[get_chat_services] = lambda: services
    try:
        client.put("/api/v1/session", json={"role": "user"})
        response = client.post("/api/v1/chat/stream", json={"question": "触发失败日志"})
        assert response.status_code == 200 and "event: error" in response.text
        client.put("/api/v1/session", json={"role": "admin"})
        page = client.get("/api/v1/logs", params={"status": "failed"}).json()
        assert page["total"] == 1 and page["items"][0]["error_message"]
        assert "secret-key" not in response.text and "secret-key" not in str(page)
        assert client.get("/api/v1/logs/stats").json()["today_count"] == 1
    finally:
        app.dependency_overrides.clear()


def test_agent_chat_uses_bound_base_custom_prompt_and_hides_citations(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
    created = client.post("/api/v1/agents", json={
        "name": "限定知识助手", "knowledge_base_ids": [data["finance"].id],
        "prompt": "自定义回答规则标记", "show_citations": False, "published": True,
    })
    assert created.status_code == 201, created.text
    captured = []

    async def stream(_target, messages, on_usage=None):
        captured.extend(messages)
        yield "依据回答"

    app.dependency_overrides[get_chat_services] = lambda: ChatServices(fake_services(vectors, data["hr"].id), stream=stream)
    try:
        client.put("/api/v1/session", json={"role": "user"})
        assert [item["name"] for item in client.get("/api/v1/agents").json()] == ["限定知识助手"]
        response = client.post("/api/v1/chat/stream", json={"question": "差旅怎么报销？", "agent_id": created.json()["id"]})
        assert response.status_code == 200, response.text
        assert "正在读取应用绑定的知识库" in response.text
        assert "财务制度" in response.text and "人事制度" not in response.text
        assert '"items":[]' in response.text and "差旅报销办法.pdf" not in response.text
        assert any("自定义回答规则标记" in item["content"] for item in captured if item["role"] == "system")
        conversations = client.get("/api/v1/conversations").json()
        detail = client.get(f"/api/v1/conversations/{conversations[0]['id']}").json()
        assert detail["messages"][1]["citations"] == []
        assert client.post(f"/api/v1/agents/{created.json()['id']}/publish").status_code == 403
        client.put("/api/v1/session", json={"role": "admin"})
        assert client.post(f"/api/v1/agents/{created.json()['id']}/publish").status_code == 200
        client.put("/api/v1/session", json={"role": "user"})
        assert client.get("/api/v1/agents").json() == []
        assert client.post("/api/v1/chat/stream", json={"question": "测试", "agent_id": created.json()["id"]}).status_code == 404
    finally:
        app.dependency_overrides.clear()
