import json

import httpx
import pytest

from rag_center_console.adapters import (
    DiscoveryTarget,
    HealthCheckFailure,
    ProbeTarget,
    discover_models,
    infer_model_type,
    probe_model,
)
from rag_center_console.models import ModelType, ProviderHealth


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("protocol", "path", "response_payload", "body_key"),
    [
        ("OpenAI Chat Completions", "/v1/chat/completions", {"choices": [], "usage": {"total_tokens": 2}}, "messages"),
        ("OpenAI Responses", "/v1/responses", {"output": [], "usage": {"total_tokens": 2}}, "input"),
        ("OpenAI Embeddings", "/v1/embeddings", {"data": [{"embedding": [0.1]}], "usage": {"total_tokens": 1}}, "input"),
        ("Anthropic Messages", "/v1/messages", {"content": [{"text": "OK"}], "usage": {"input_tokens": 1}}, "messages"),
        ("Cohere Rerank", "/v1/rerank", {"results": [{"index": 0}], "usage": {"search_units": 1}}, "documents"),
    ],
)
async def test_protocol_contracts(protocol, path, response_payload, body_key):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["headers"] = request.headers
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=response_payload)

    target = ProbeTarget("provider", "custom", "https://provider.test/v1", "secret-key", "model-a", protocol, 3)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await probe_model(target, client)

    assert seen["path"] == path
    assert body_key in seen["body"]
    assert result.status == ProviderHealth.HEALTHY
    assert result.checks["request"] is True
    headers = seen["headers"]
    if protocol == "Anthropic Messages":
        assert headers["x-api-key"] == "secret-key"
    else:
        assert headers["authorization"] == "Bearer secret-key"


@pytest.mark.asyncio
async def test_kimi_contract_checks_non_stream_stream_and_usage():
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        if body.get("stream"):
            event = {"type": "response.completed", "usage": {"total_tokens": 3}}
            return httpx.Response(200, text=f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n")
        return httpx.Response(200, json={"output": [], "usage": {"total_tokens": 2}})

    target = ProbeTarget(
        "provider",
        "kimi-code",
        "https://api.kimi.test/coding/v1",
        "secret-key",
        "kimi-model",
        "OpenAI Responses",
        3,
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await probe_model(target, client)

    assert [request["stream"] for request in requests] == [False, True]
    assert result.status == ProviderHealth.HEALTHY
    assert result.checks == {"request": True, "stream": True, "usage": True}


@pytest.mark.asyncio
async def test_provider_error_does_not_echo_api_key():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid credentials: top-secret"}})

    target = ProbeTarget("provider", "custom", "https://provider.test/v1", "top-secret", "model-a", "OpenAI Chat Completions", 3)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HealthCheckFailure) as exc_info:
            await probe_model(target, client)

    assert "top-secret" not in str(exc_info.value)
    assert "invalid credentials" in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)


@pytest.mark.asyncio
async def test_discovers_openai_data_models_with_deduplication_and_sorting():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer secret-key"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "z-model", "name": "Z model"},
                    {"id": "a-model", "display_name": "A model"},
                    {"id": "z-model", "name": "Duplicate"},
                ]
            },
        )

    target = DiscoveryTarget("https://provider.test/v1", "secret-key", "OpenAI Chat Completions")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert [(model.id, model.name) for model in result.models] == [
        ("a-model", "A model"),
        ("z-model", "Z model"),
    ]
    assert result.truncated is False


@pytest.mark.parametrize(
    ("model_id", "metadata", "expected_type", "expected_confidence"),
    [
        ("qwen3.7-text-embedding", None, ModelType.EMBEDDING, "medium"),
        ("qwen3-reranker", None, ModelType.RERANK, "medium"),
        ("qwen2.5-vl-72b", None, ModelType.VISION, "medium"),
        ("opaque-model", {"task": "embedding"}, ModelType.EMBEDDING, "high"),
        ("opaque-model", None, ModelType.LLM, "low"),
    ],
)
def test_infers_model_type_from_metadata_then_model_id(model_id, metadata, expected_type, expected_confidence):
    assert infer_model_type(model_id, metadata) == (expected_type, expected_confidence)


@pytest.mark.asyncio
async def test_discovers_models_array_with_anthropic_headers():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "anthropic-secret"
        assert request.headers["anthropic-version"] == "2023-06-01"
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"models": ["model-b", {"id": "model-a"}]})

    target = DiscoveryTarget("https://provider.test/v1", "anthropic-secret", "Anthropic Messages")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert [model.id for model in result.models] == ["model-a", "model-b"]


@pytest.mark.asyncio
async def test_model_discovery_error_does_not_echo_api_key():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "bad key discovery-secret"}})

    target = DiscoveryTarget("https://provider.test/v1", "discovery-secret", "OpenAI Responses")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(HealthCheckFailure) as exc_info:
            await discover_models(target, client)

    assert "discovery-secret" not in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)
