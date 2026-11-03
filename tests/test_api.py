from rag_center_console.adapters import DiscoveryResult, DiscoveryTarget, ProbeResult, RemoteModel
from rag_center_console.models import ProviderHealth


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


def test_new_provider_can_discover_models_before_saving(client, monkeypatch):
    captured: dict[str, DiscoveryTarget] = {}

    async def successful_discovery(target: DiscoveryTarget):
        captured["target"] = target
        return DiscoveryResult(
            models=[
                RemoteModel(
                    id="qwen3.7-text-embedding",
                    name="Qwen embedding",
                    model_type="embedding",
                    type_confidence="medium",
                )
            ],
            truncated=False,
        )

    monkeypatch.setattr("rag_center_console.api.discover_models", successful_discovery)
    response = client.post(
        "/api/v1/providers/discover-models",
        json={
            "preset_id": "custom",
            "base_url": "https://provider.test/v1",
            "api_key": "direct-secret",
            "protocol": "OpenAI Chat Completions",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "models": [
            {
                "id": "qwen3.7-text-embedding",
                "name": "Qwen embedding",
                "model_type": "embedding",
                "type_confidence": "medium",
                "vector_dimension": None,
            }
        ],
        "truncated": False,
    }
    assert captured["target"].api_key == "direct-secret"
    assert client.get("/api/v1/providers").json() == []


def test_saved_provider_discovery_reuses_encrypted_key(client, monkeypatch):
    provider = client.post(
        "/api/v1/providers",
        json={
            "preset_id": "deepseek",
            "name": "DeepSeek",
            "base_url": "https://old-provider.test/v1",
            "api_key": "stored-secret",
            "default_protocol": "OpenAI Chat Completions",
        },
    ).json()
    captured: dict[str, DiscoveryTarget] = {}

    async def successful_discovery(target: DiscoveryTarget):
        captured["target"] = target
        return DiscoveryResult(models=[], truncated=False)

    monkeypatch.setattr("rag_center_console.api.discover_models", successful_discovery)
    response = client.post(
        "/api/v1/providers/discover-models",
        json={
            "provider_id": provider["id"],
            "base_url": "https://new-provider.test/v1",
            "protocol": "OpenAI Responses",
        },
    )

    assert response.status_code == 200
    assert captured["target"].api_key == "stored-secret"
    assert captured["target"].base_url == "https://new-provider.test/v1"
    assert captured["target"].protocol == "OpenAI Responses"
    assert "stored-secret" not in response.text


def test_model_configuration_mutations_require_admin(client):
    provider = client.post("/api/v1/providers", json={
        "preset_id": "custom", "name": "Custom", "base_url": "https://provider.test/v1",
        "api_key": "secret", "default_protocol": "OpenAI Chat Completions",
    }).json()
    model = client.post("/api/v1/models", json={
        "provider_id": provider["id"], "name": "Chat", "model_id": "chat",
        "model_type": "llm", "protocol": "OpenAI Chat Completions",
    }).json()
    client.put("/api/v1/session", json={"role": "manager"})
    assert client.post("/api/v1/providers", json={}).status_code == 403
    assert client.post("/api/v1/providers/discover-models", json={"provider_id": provider["id"]}).status_code == 403
    assert client.patch(f"/api/v1/providers/{provider['id']}", json={"name": "changed"}).status_code == 403
    assert client.post(f"/api/v1/providers/{provider['id']}/health-check").status_code == 403
    assert client.post("/api/v1/models", json={}).status_code == 403
    assert client.patch(f"/api/v1/models/{model['id']}", json={"name": "changed"}).status_code == 403
    assert client.delete(f"/api/v1/models/{model['id']}").status_code == 403
    assert client.put("/api/v1/model-defaults", json={"routing_llm": model["id"]}).status_code == 403
    assert client.delete(f"/api/v1/providers/{provider['id']}").status_code == 403
    client.cookies.clear()
    assert client.delete(f"/api/v1/providers/{provider['id']}").status_code == 401
