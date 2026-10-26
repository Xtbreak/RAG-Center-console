import json

import httpx
import pytest

from rag_center_console.adapters import HealthCheckFailure, ProbeTarget, probe_model
from rag_center_console.models import ProviderHealth


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
