import json

import httpx
import pytest

from rag_center_console.adapters import (
    DiscoveryTarget,
    HealthCheckFailure,
    ProbeTarget,
    describe_image,
    discover_models,
    embed_texts,
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
        (
            "DashScope Text Embeddings",
            "/api/v1/services/embeddings/text-embedding/text-embedding",
            {"output": {"embeddings": [{"embedding": [0.1]}]}, "usage": {"total_tokens": 1}},
            "input",
        ),
        (
            "DashScope Multimodal Embeddings",
            "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
            {"output": {"embeddings": [{"embedding": [0.1]}]}, "usage": {"total_tokens": 1}},
            "input",
        ),
        ("Anthropic Messages", "/v1/messages", {"content": [{"text": "OK"}], "usage": {"input_tokens": 1}}, "messages"),
        ("Cohere Rerank", "/v1/rerank", {"results": [{"index": 0}], "usage": {"search_units": 1}}, "documents"),
        (
            "DashScope Rerank",
            "/api/v1/services/rerank/text-rerank/text-rerank",
            {"output": {"results": [{"index": 0}]}, "usage": {"total_tokens": 1}},
            "input",
        ),
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

    body = seen["body"]
    if protocol == "DashScope Multimodal Embeddings":
        assert body["input"] == {"contents": [{"text": "connection test"}]}
    if protocol == "DashScope Rerank":
        assert body["input"]["query"] == "connection test"


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
async def test_discovers_dashscope_catalog_with_pagination_and_capability_types():
    requested_pages = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/models"
        requested_pages.append(request.url.params["page_no"])
        page_no = int(request.url.params["page_no"])
        models = [{
            "model": "text-embedding-v4",
            "name": "通用文本向量V4",
            "capabilities": ["TR"],
        }] if page_no == 1 else [{
            "model": "qwen3-vl-plus",
            "name": "通义千问视觉模型",
            "capabilities": ["VU"],
        }]
        return httpx.Response(200, json={
            "output": {
                "total": 101,
                "page_no": page_no,
                "page_size": 100,
                "models": models,
            }
        })

    target = DiscoveryTarget(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "dashscope-secret",
        "OpenAI Chat Completions",
        preset_id="dashscope",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert requested_pages == ["1", "2"]
    assert [(model.id, model.model_type) for model in result.models] == [
        ("qwen3-vl-plus", ModelType.VISION),
        ("text-embedding-v4", ModelType.EMBEDDING),
    ]
    assert result.models[1].vector_dimension == 1024
    assert result.truncated is False


@pytest.mark.asyncio
async def test_dashscope_classifies_rerank_before_ambiguous_capability_code():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "output": {
                "total": 1,
                "page_no": 1,
                "page_size": 100,
                "models": [{"model": "gte-rerank-v2", "capabilities": ["TR"]}],
            }
        })

    target = DiscoveryTarget(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "dashscope-secret",
        "OpenAI Chat Completions",
        preset_id="dashscope",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert [(model.id, model.model_type) for model in result.models] == [
        ("gte-rerank-v2", ModelType.RERANK),
    ]


@pytest.mark.asyncio
async def test_dashscope_filters_retired_and_unsupported_models_but_keeps_future_retirement():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "output": {
                "total": 7,
                "page_no": 1,
                "page_size": 100,
                "models": [
                    {"model": "gte-rerank", "capabilities": ["TR"]},
                    {"model": "retired-chat", "capabilities": ["TG"], "status": "retired"},
                    {"model": "deprecated-chat", "capabilities": ["TG"], "deprecated": True},
                    {"model": "offline-chat", "capabilities": ["TG"], "inference_offline_info": {"offline_time": "2000-01-01T00:00:00Z"}},
                    {"model": "future-chat", "capabilities": ["TG"], "inference_offline_info": {"offline_time": "2999-01-01T00:00:00Z"}},
                    {"model": "image-generator", "capabilities": ["T2I"]},
                    {"model": "speech-recognizer", "capabilities": ["ASR"]},
                ],
            }
        })

    target = DiscoveryTarget(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "dashscope-secret",
        "OpenAI Chat Completions",
        preset_id="dashscope",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert [model.id for model in result.models] == ["future-chat"]
    assert result.truncated is False


@pytest.mark.asyncio
async def test_dashscope_catalog_paginates_beyond_previous_ten_page_limit():
    requested_pages: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page_no = int(request.url.params["page_no"])
        requested_pages.append(page_no)
        return httpx.Response(200, json={
            "output": {
                "total": 1_001,
                "page_no": page_no,
                "page_size": 100,
                "models": [{"model": f"chat-{page_no}", "capabilities": ["TG"]}],
            }
        })

    target = DiscoveryTarget(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "dashscope-secret",
        "OpenAI Chat Completions",
        preset_id="dashscope",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await discover_models(target, client)

    assert requested_pages == list(range(1, 12))
    assert len(result.models) == 11
    assert result.truncated is False


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


def _embedding_target(protocol="OpenAI Embeddings"):
    return ProbeTarget("p", "custom", "https://api.example.test/v1", "sk-secret", "embed-1", protocol, 5)


async def _no_sleep(_):
    return None


@pytest.mark.asyncio
async def test_embed_texts_batches_orders_by_index_and_sums_usage():
    batches = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        batches.append(body["input"])
        data = [{"index": i, "embedding": [float(len(text)), 1.0]} for i, text in enumerate(body["input"])]
        return httpx.Response(200, json={"data": list(reversed(data)), "usage": {"total_tokens": len(data)}})

    texts = [("x" * n) for n in range(1, 71)]
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await embed_texts(_embedding_target(), texts, expected_dimension=2, client=client)
    assert [len(b) for b in batches] == [64, 6]
    assert [v[0] for v in result.vectors] == [float(n) for n in range(1, 71)]
    assert result.usage == {"total_tokens": 70}


@pytest.mark.asyncio
async def test_embed_texts_dashscope_text_uses_texts_field_and_text_index():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, json={"output": {"embeddings": [
            {"text_index": 1, "embedding": [2.0]}, {"text_index": 0, "embedding": [1.0]}]}})

    target = _embedding_target("DashScope Text Embeddings")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await embed_texts(target, ["a", "b"], client=client)
    assert seen["url"] == "https://api.example.test/api/v1/services/embeddings/text-embedding/text-embedding"
    assert seen["body"]["input"] == {"texts": ["a", "b"]} and result.vectors == [[1.0], [2.0]]


@pytest.mark.asyncio
async def test_embed_texts_rejects_wrong_dimension_count_and_redacts_errors():
    def wrong_dimension(request):
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0, 2.0, 3.0]}]})

    def wrong_count(request):
        return httpx.Response(200, json={"data": []})

    def unauthorized(request):
        return httpx.Response(401, json={"error": {"message": "bad key sk-secret"}})

    for handler, message in ((wrong_dimension, "维度"), (wrong_count, "数量"), (unauthorized, "REDACTED")):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(HealthCheckFailure, match=message) as error:
                await embed_texts(_embedding_target(), ["a"], expected_dimension=2, client=client)
        assert "sk-secret" not in str(error.value)
    with pytest.raises(HealthCheckFailure, match="不支持"):
        await embed_texts(_embedding_target("Cohere Rerank"), ["a"])


@pytest.mark.asyncio
async def test_embed_texts_retries_rate_limits_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, json={"error": {"message": "slow down"}})
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0]}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await embed_texts(_embedding_target(), ["a"], client=client, sleep=_no_sleep)
    assert len(calls) == 3 and result.vectors == [[1.0]]

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503))) as client:
        with pytest.raises(HealthCheckFailure, match="HTTP 503"):
            await embed_texts(_embedding_target(), ["a"], client=client, sleep=_no_sleep)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("protocol", "response", "check"),
    [
        ("OpenAI Chat Completions", {"choices": [{"message": {"content": " 一张折线图 "}}]}, lambda b: b["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")),
        ("OpenAI Responses", {"output": [{"content": [{"type": "output_text", "text": "一张折线图"}]}]}, lambda b: b["input"][0]["content"][1]["type"] == "input_image"),
        ("Anthropic Messages", {"content": [{"type": "text", "text": "一张折线图"}]}, lambda b: b["messages"][0]["content"][0]["source"]["media_type"] == "image/png"),
    ],
)
async def test_describe_image_builds_protocol_specific_payloads(protocol, response, check):
    sent = {}

    def handler(request):
        sent["body"] = json.loads(request.content)
        return httpx.Response(200, json=response)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        text = await describe_image(_embedding_target(protocol), b"\x89PNG", "image/png", client=client)
    assert text == "一张折线图" and check(sent["body"])


@pytest.mark.asyncio
async def test_describe_image_rejects_empty_answers_and_unsupported_protocols():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}))) as client:
        with pytest.raises(HealthCheckFailure, match="没有返回描述"):
            await describe_image(_embedding_target("OpenAI Chat Completions"), b"x", "image/png", client=client)
    with pytest.raises(HealthCheckFailure, match="不支持"):
        await describe_image(_embedding_target("OpenAI Embeddings"), b"x", "image/png")
