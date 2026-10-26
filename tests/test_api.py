def test_anonymous_session_role_persists_in_cookie(client):
    first = client.get("/api/v1/session")
    assert first.status_code == 200
    assert first.json()["role"] == "admin"

    updated = client.put("/api/v1/session", json={"role": "manager"})
    assert updated.status_code == 200
    assert updated.json()["role"] == "manager"
    assert client.get("/api/v1/session").json()["id"] == first.json()["id"]


def test_provider_and_model_are_persisted_without_exposing_secret(client):
    secret = "sk-test-sensitive"
    provider_response = client.post(
        "/api/v1/providers",
        json={
            "preset_id": "openrouter",
            "name": "OpenRouter",
            "base_url": "https://openrouter.test/api/v1",
            "api_key": secret,
            "default_protocol": "OpenAI Chat Completions",
        },
    )
    assert provider_response.status_code == 201
    provider = provider_response.json()
    assert secret not in provider_response.text
    assert provider["api_key_masked"].endswith("tive")
    assert provider["health"] == "untested"

    model_response = client.post(
        "/api/v1/models",
        json={
            "provider_id": provider["id"],
            "name": "Primary chat model",
            "model_id": "provider/model",
            "model_type": "llm",
            "protocol": "OpenAI Chat Completions",
            "context_length": 32000,
            "timeout_seconds": 30,
        },
    )
    assert model_response.status_code == 201
    model = model_response.json()
    assert model["model_id"] == "provider/model"
    assert client.get(f"/api/v1/models?provider_id={provider['id']}").json()[0]["id"] == model["id"]
    assert client.get("/api/v1/providers").json()[0]["model_count"] == 1


def test_embedding_model_requires_vector_dimension(client):
    provider = client.post(
        "/api/v1/providers",
        json={
            "preset_id": "custom",
            "name": "Custom",
            "base_url": "https://provider.test/v1",
            "api_key": "secret",
            "default_protocol": "OpenAI Embeddings",
        },
    ).json()
    response = client.post(
        "/api/v1/models",
        json={
            "provider_id": provider["id"],
            "name": "Embedding",
            "model_id": "embedding-model",
            "model_type": "embedding",
            "protocol": "OpenAI Embeddings",
        },
    )
    assert response.status_code == 422


def test_model_defaults_reject_unknown_model(client):
    response = client.put("/api/v1/model-defaults", json={"routing_llm": "missing"})
    assert response.status_code == 404
from rag_center_console.adapters import ProbeResult
from rag_center_console.models import ProviderHealth




def test_health_check_endpoint_updates_provider_with_real_probe_result(client, monkeypatch):
    provider = client.post(
        "/api/v1/providers",
        json={
            "preset_id": "deepseek",
            "name": "DeepSeek",
            "base_url": "https://provider.test/v1",
            "api_key": "secret",
            "default_protocol": "OpenAI Chat Completions",
        },
    ).json()
    client.post(
        "/api/v1/models",
        json={
            "provider_id": provider["id"],
            "name": "Chat model",
            "model_id": "chat-model",
            "model_type": "llm",
            "protocol": "OpenAI Chat Completions",
        },
    )

    async def successful_probe(_):
        return ProbeResult(
            status=ProviderHealth.HEALTHY,
            latency_ms=42.5,
            checks={"request": True, "stream": False, "usage": True},
            usage={"total_tokens": 2},
            message="连接检测通过",
        )

    monkeypatch.setattr("rag_center_console.services.probe_model", successful_probe)
    response = client.post(f"/api/v1/providers/{provider['id']}/health-check")

    assert response.status_code == 200
    assert response.json()["latency_ms"] == 42.5
    refreshed = client.get("/api/v1/providers").json()[0]
    assert refreshed["health"] == "healthy"
    assert refreshed["last_latency_ms"] == 42.5
