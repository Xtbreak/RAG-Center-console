from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from rag_center_console.database import SessionLocal
from rag_center_console.main import app
from rag_center_console.models import ApiKey, KnowledgeBase, ToolDefinition


def create_knowledge_base(client: TestClient) -> dict:
    response = client.post("/api/v1/providers", json={
        "preset_id": "custom", "name": "Local", "base_url": "https://example.com/v1",
        "api_key": "secret", "default_protocol": "OpenAI Chat Completions",
    })
    provider_id = response.json()["id"]
    model = client.post("/api/v1/models", json={
        "provider_id": provider_id, "name": "Embedding", "model_id": "embedding-v1",
        "model_type": "embedding", "protocol": "OpenAI Embeddings", "vector_dimension": 8,
    }).json()
    response = client.post("/api/v1/knowledge-bases", json={
        "name": "员工制度", "embedding_model_id": model["id"],
    })
    assert response.status_code == 201, response.text
    return response.json()


def create_tool(client: TestClient, kind: str = "http") -> dict:
    response = client.post("/api/v1/tools", json={
        "name": f"服务工具-{kind}", "kind": kind, "url": "https://example.com/hook",
        "method": "POST", "headers": {"Authorization": "Bearer private"},
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_agent_configuration_lifecycle_and_references(client):
    knowledge_base = create_knowledge_base(client)
    tool = create_tool(client)
    created = client.post("/api/v1/agents", json={
        "name": "员工助手", "knowledge_base_ids": [knowledge_base["id"]], "tool_ids": [tool["id"]],
        "suggestions": ["  年假怎么申请？  "], "prompt": "依据资料回答",
    })
    assert created.status_code == 201, created.text
    agent = created.json()
    assert agent["suggestions"] == ["年假怎么申请？"]
    assert agent["published"] is False
    assert client.post("/api/v1/agents", json={"name": "无效引用", "knowledge_base_ids": ["missing"]}).status_code == 422

    updated = client.patch(f"/api/v1/agents/{agent['id']}", json={"opening": "你好", "show_citations": False})
    assert updated.status_code == 200
    assert updated.json()["opening"] == "你好"
    assert updated.json()["show_citations"] is False
    assert client.post(f"/api/v1/agents/{agent['id']}/publish").json()["published"] is True

    duplicate = client.post(f"/api/v1/agents/{agent['id']}/duplicate")
    assert duplicate.status_code == 201
    assert duplicate.json()["name"] == "员工助手 副本"
    assert duplicate.json()["published"] is False
    assert client.get("/api/v1/agents").json()[0]["id"] in {agent["id"], duplicate.json()["id"]}
    assert client.delete(f"/api/v1/agents/{duplicate.json()['id']}").status_code == 204
    assert client.get(f"/api/v1/agents/{duplicate.json()['id']}").status_code == 404


def test_tool_health_check_failure_and_mcp_capability(client):
    tool = create_tool(client)
    assert "private" not in str(tool)
    with SessionLocal() as db:
        stored = db.get(ToolDefinition, tool["id"])
        assert stored is not None
        assert "Bearer private" not in stored.headers_encrypted

    with patch("rag_center_console.apps_api.request_external", new=AsyncMock(return_value={"status_code": 200, "body": {"ok": True}, "headers": {}})) as request:
        assert client.post(f"/api/v1/tools/{tool['id']}/health-check").json()["status"] == "healthy"
        assert request.await_args.kwargs["headers"] == {"Authorization": "Bearer private"}
        result = client.post(f"/api/v1/tools/{tool['id']}/invoke", json={"input": {"city": "杭州"}})
        assert result.json()["body"] == {"ok": True}
        assert request.await_args.kwargs["payload"] == {"city": "杭州"}

    with patch("rag_center_console.apps_api.request_external", new=AsyncMock(return_value={"status_code": 503, "body": {}, "headers": {}})):
        failed = client.post(f"/api/v1/tools/{tool['id']}/health-check")
        assert failed.status_code == 502
        assert "503" in failed.json()["detail"]

    mcp = create_tool(client, kind="mcp")
    unsupported = client.post(f"/api/v1/tools/{mcp['id']}/health-check")
    assert unsupported.status_code == 422
    assert "尚未接入" in unsupported.json()["detail"]


def test_api_key_full_secret_is_only_returned_once(client):
    created = client.post("/api/v1/settings/api-keys", json={"name": "报表", "quota_per_day": 500})
    assert created.status_code == 201
    secret = created.json()["secret"]
    assert secret.startswith("zs-app-")
    listed = client.get("/api/v1/settings/api-keys")
    assert listed.status_code == 200
    assert listed.json()[0]["prefix"] == secret[:16]
    assert secret not in listed.text
    assert "secret_hash" not in listed.text
    with SessionLocal() as db:
        stored = db.scalar(select(ApiKey))
        assert stored is not None
        assert stored.secret_hash != secret
    assert client.delete(f"/api/v1/settings/api-keys/{created.json()['id']}").status_code == 204
    assert client.get("/api/v1/settings/api-keys").json()[0]["revoked"] is True


def test_insights_use_real_persisted_counts(client):
    response = client.get("/api/v1/insights/summary")
    assert response.status_code == 200
    assert response.json()["knowledge_base_count"] == 0
    create_knowledge_base(client)
    response = client.get("/api/v1/insights/summary")
    assert response.json()["knowledge_base_count"] == 1
    assert response.json()["query_count"] == 0
    assert response.json()["model_usage"] == []


def test_apps_tools_and_settings_require_session_and_manager_role():
    with TestClient(app) as anonymous:
        assert anonymous.get("/api/v1/agents").status_code == 401
        anonymous.get("/api/v1/session")
        assert anonymous.put("/api/v1/session", json={"role": "user"}).status_code == 200
        assert anonymous.get("/api/v1/tools").status_code == 403
        assert anonymous.post("/api/v1/agents", json={"name": "无权限"}).status_code == 403
        assert anonymous.get("/api/v1/insights/summary").status_code == 403
        assert anonymous.get("/api/v1/settings/api-keys").status_code == 403
        assert anonymous.put("/api/v1/session", json={"role": "manager"}).status_code == 200
        assert anonymous.post("/api/v1/agents", json={"name": "管理应用"}).status_code == 201


def test_chat_flow_rejects_non_object_nodes(client):
    response = client.post("/api/v1/agents", json={
        "name": "无效流程", "mode": "chatflow", "flow": {"nodes": ["broken"], "edges": []},
    })
    assert response.status_code == 422
    assert "JSON 对象" in response.json()["detail"]
