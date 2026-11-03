from decimal import Decimal
from unittest.mock import AsyncMock, patch

from qdrant_client import QdrantClient
from sqlalchemy import select
from test_apps_api import create_knowledge_base, create_tool
from test_ingestion import h, make_job, pdf_bytes, run  # noqa: F401
from test_retrieval import fake_services, seed_retrieval_data

from rag_center_console.chat import ChatServices
from rag_center_console.chat_api import get_chat_services
from rag_center_console.database import SessionLocal
from rag_center_console.main import app
from rag_center_console.models import IngestionJob, ModelDefinition, ModelPrice
from rag_center_console.vectorstore import VectorStore


def test_model_prices_require_admin_and_validate_input(client):
    kb = create_knowledge_base(client)
    model_id = kb["embedding_model_id"]
    updated = client.put("/api/v1/observability/prices", json={
        "model_id": model_id, "input_price_per_million": 1.25,
        "output_price_per_million": 2.5, "currency": "CNY",
    })
    assert updated.status_code == 200, updated.text
    assert float(updated.json()["input_price_per_million"]) == 1.25
    listed = client.get("/api/v1/observability/prices")
    assert listed.status_code == 200
    assert listed.json()[0]["model_id"] == model_id
    assert client.put("/api/v1/observability/prices", json={
        "model_id": model_id, "input_price_per_million": -1, "output_price_per_million": 0,
    }).status_code == 422
    assert client.put("/api/v1/observability/prices", json={
        "model_id": "missing", "input_price_per_million": 0, "output_price_per_million": 0,
    }).status_code == 404
    client.put("/api/v1/session", json={"role": "manager"})
    assert client.get("/api/v1/observability/prices").status_code == 403
    assert client.get("/api/v1/observability/summary").status_code == 403


def test_tool_operations_capture_status_without_credentials(client):
    tool = create_tool(client)
    with patch("rag_center_console.apps_api.request_external", new=AsyncMock(return_value={
        "status_code": 200, "body": {"ok": True}, "headers": {},
    })):
        assert client.post(f"/api/v1/tools/{tool['id']}/invoke", json={"input": {"city": "杭州"}}).status_code == 200
    page = client.get("/api/v1/observability/operations", params={"kind": "tool"})
    assert page.status_code == 200, page.text
    assert page.json()["total"] == 1
    operation = page.json()["items"][0]
    assert operation["status"] == "completed" and operation["http_status"] == 200
    assert operation["input_json"] == {"city": "杭州"}
    assert "Bearer private" not in str(operation) and "Authorization" not in str(operation)
    assert client.get("/api/v1/observability/operations", params={"kind": "skill"}).json()["total"] == 0
    mcp = create_tool(client, kind="mcp")
    assert client.post(f"/api/v1/tools/{mcp['id']}/health-check").status_code == 422
    failed = client.get("/api/v1/observability/operations", params={"kind": "tool", "status": "failed"}).json()
    assert failed["total"] == 1 and "尚未接入" in failed["items"][0]["error_message"]


def test_agent_observability_has_context_price_and_summary(client):
    vectors = VectorStore(QdrantClient(":memory:"))
    with SessionLocal() as db:
        data = seed_retrieval_data(db, vectors)
        answer_model = db.scalar(select(ModelDefinition).where(ModelDefinition.model_id == "route-llm"))
        db.add(ModelPrice(model_id=answer_model.id, input_price_per_million=Decimal(2), output_price_per_million=Decimal(4), currency="CNY"))
        db.commit()
    agent = client.post("/api/v1/agents", json={
        "name": "观测应用", "knowledge_base_ids": [data["finance"].id], "published": True,
    }).json()

    async def stream(_target, _messages, on_usage=None):
        yield "住宿费凭发票报销 [1]。"
        if on_usage:
            on_usage({"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20})

    app.dependency_overrides[get_chat_services] = lambda: ChatServices(fake_services(vectors, data["finance"].id), stream=stream)
    try:
        response = client.post("/api/v1/chat/stream", json={"question": "差旅怎么报销？", "agent_id": agent["id"]})
        assert response.status_code == 200, response.text
        runs = client.get("/api/v1/observability/agents", params={"agent_id": agent["id"]})
        assert runs.status_code == 200, runs.text
        assert runs.json()["total"] == 1
        summary = runs.json()["items"][0]
        assert summary["agent_name"] == "观测应用" and summary["total_tokens"] > 0
        detail = client.get(f"/api/v1/observability/agents/{summary['id']}")
        assert detail.status_code == 200, detail.text
        payload = detail.json()
        answer_call = next(call for call in payload["model_calls"] if call["purpose"] == "answer_llm")
        assert answer_call["input_context"][0]["role"] == "system"
        assert "差旅怎么报销？" in answer_call["input_context"][-1]["content"]
        assert answer_call["output_content"] == "住宿费凭发票报销 [1]。"
        assert answer_call["estimated_cost"] == 0.000056
        assert payload["has_unpriced_calls"] is True
        embedding_call = next(call for call in payload["model_calls"] if call["purpose"] == "knowledge_embedding")
        assert "vector_count" in embedding_call["output_content"]
        rerank_call = next(call for call in payload["model_calls"] if call["purpose"] == "rerank")
        assert "items" in rerank_call["output_content"]
        stats = client.get("/api/v1/observability/summary").json()
        assert stats["run_count"] == 1 and stats["completed_count"] == 1
        assert stats["estimated_cost"] == 0.000056 and stats["unpriced_call_count"] > 0
        billing = client.get("/api/v1/observability/billing").json()
        assert billing["agents"][0]["keys"][1] == "观测应用"
        assert any(group["estimated_cost"] == 0.000056 for group in billing["models"])
        overview = client.get("/api/v1/observability/overview")
        assert overview.status_code == 200, overview.text
        report = overview.json()
        assert report["daily"][0]["run_count"] == 1 and report["daily"][0]["completed_count"] == 1
        assert report["agents"][0]["agent_name"] == "观测应用" and report["agents"][0]["success_rate"] == 1
        assert report["agents"][0]["total_tokens"] > 0 and report["models"]
        assert report["ingestion"]["total"] == 0 and report["operations"] == []
    finally:
        app.dependency_overrides.clear()


def test_ingestion_observability_links_models_parser_and_cost(h, client):
    job_id, document_id, kb_id = make_job(h)
    with SessionLocal() as db:
        job = db.get(IngestionJob, job_id)
        model = job.document.knowledge_base.embedding_model
        db.add(ModelPrice(model_id=model.id, input_price_per_million=Decimal(1), output_price_per_million=Decimal(0), currency="CNY"))
        db.commit()
    run(h, job_id)
    response = client.get(f"/api/v1/observability/ingestion/{job_id}")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "succeeded" and payload["total_tokens"] > 0
    assert payload["estimated_cost"] > 0
    assert payload["model_calls"][0]["ingestion_job_id"] == job_id
    assert payload["model_calls"][0]["input_context"]["texts"]
    assert not any(operation["kind"] == "doc_parser" for operation in payload["operations"])
    assert any(operation["kind"] == "harness" and operation["status"] == "succeeded" for operation in payload["operations"])
    listed = client.get("/api/v1/observability/ingestion", params={"knowledge_base_id": kb_id})
    assert listed.status_code == 200 and listed.json()["total"] == 1
    assert listed.json()["items"][0]["document_id"] == document_id

    cloud_job_id, _, _ = make_job(h, filename="cloud.pdf", data=pdf_bytes("CLOUD"))
    run(h, cloud_job_id)
    cloud = client.get(f"/api/v1/observability/ingestion/{cloud_job_id}").json()
    assert any(operation["kind"] == "doc_parser" and operation["unit_count"] == 1 for operation in cloud["operations"])
    overview = client.get("/api/v1/observability/overview").json()
    assert overview["ingestion"]["total"] == 2
    assert overview["ingestion"]["chunk_count"] > 0
    assert overview["ingestion"]["status"] == [{"name": "succeeded", "count": 2}]
    assert any(item["kind"] == "doc_parser" and item["total"] == 1 and item["completed"] == 1 for item in overview["operations"])
