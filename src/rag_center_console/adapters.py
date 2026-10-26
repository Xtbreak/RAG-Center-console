import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx

from .models import ModelType, ProviderHealth


class HealthCheckFailure(RuntimeError):
    pass


@dataclass(slots=True)
class ProbeTarget:
    provider_id: str
    preset_id: str
    base_url: str
    api_key: str
    model_id: str
    protocol: str
    timeout_seconds: float


@dataclass(slots=True)
class ProbeResult:
    status: ProviderHealth
    latency_ms: float
    checks: dict[str, bool]
    usage: dict[str, int | float] | None
    message: str


@dataclass(slots=True)
class DiscoveryTarget:
    base_url: str
    api_key: str
    protocol: str
    timeout_seconds: float = 20.0
    preset_id: str | None = None


@dataclass(slots=True)
class RemoteModel:
    id: str
    name: str
    model_type: ModelType
    type_confidence: Literal["high", "medium", "low"]
    vector_dimension: int | None = None


@dataclass(slots=True)
class DiscoveryResult:
    models: list[RemoteModel]
    truncated: bool


def _endpoint(base_url: str, suffix: str) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HealthCheckFailure("Base URL 必须是有效的 HTTP 或 HTTPS 地址")
    if parsed.username or parsed.password:
        raise HealthCheckFailure("Base URL 不允许包含用户名或密码")
    path = f"{parsed.path.rstrip('/')}/{suffix.lstrip('/')}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _redact(value: str, secrets: tuple[str, ...]) -> str:
    sanitized = value
    for secret in secrets:
        if secret:
            sanitized = sanitized.replace(secret, "[REDACTED]")
    return sanitized


def _error_message(response: httpx.Response, api_key: str) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error", payload)
            if isinstance(error, dict):
                message = error.get("message") or error.get("detail")
                if message:
                    return _redact(str(message), (api_key,))[:300]
    except (ValueError, TypeError):
        pass
    return f"供应商返回 HTTP {response.status_code}"


def _usage(payload: Any) -> dict[str, int | float] | None:
    if not isinstance(payload, dict):
        return None
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    return {
        str(key): value
        for key, value in usage.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    } or None


def _discovery_headers(protocol: str, api_key: str) -> dict[str, str]:
    if protocol == "Anthropic Messages":
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Accept": "application/json",
        }
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }


def _model_entries(payload: Any) -> tuple[list[Any], bool]:
    if isinstance(payload, list):
        return payload, False
    if not isinstance(payload, dict):
        raise HealthCheckFailure("供应商返回的模型列表结构无效")

    entries = payload.get("data")
    if isinstance(entries, dict):
        entries = entries.get("models") or entries.get("data")
    if not isinstance(entries, list):
        entries = payload.get("models")
    if not isinstance(entries, list) and isinstance(payload.get("output"), dict):
        output = payload["output"]
        entries = output.get("models")
        total = output.get("total")
        page_no = output.get("page_no", 1)
        page_size = output.get("page_size", 20)
        has_more = (
            isinstance(total, int)
            and isinstance(page_no, int)
            and isinstance(page_size, int)
            and total > page_no * page_size
        )
        if isinstance(entries, list):
            return entries, has_more
    if not isinstance(entries, list):
        raise HealthCheckFailure("响应缺少 data 或 models 模型列表")
    return entries, bool(payload.get("has_more") or payload.get("next") or payload.get("next_page"))


def _metadata_text(entry: dict[str, Any]) -> str:
    values: list[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, str):
            values.append(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item, nested_value in value.items():
                if nested_value is True:
                    values.append(str(item))
                collect(nested_value)

    for key in (
        "model_type",
        "type",
        "task",
        "category",
        "capability",
        "capabilities",
        "endpoint_types",
        "supported_tasks",
        "architecture",
        "input_modalities",
        "output_modalities",
    ):
        collect(entry.get(key))
    return " ".join(values).casefold()


def _type_from_text(value: str) -> ModelType | None:
    normalized = value.casefold().replace("_", "-")
    if any(keyword in normalized for keyword in ("rerank", "re-rank", "reranker", "ranking")):
        return ModelType.RERANK
    if any(
        keyword in normalized
        for keyword in (
            "embedding",
            "embeddings",
            "embed-",
            "-embed",
            "vectorize",
            "feature-extraction",
            "text2vec",
            "mxbai-embed",
            "jina-embedding",
        )
    ):
        return ModelType.EMBEDDING
    if any(keyword in normalized for keyword in ("vision", "visual", "multimodal", "image-to-text", "image-text")):
        return ModelType.VISION
    if any(keyword in normalized for keyword in ("chat", "completion", "generation", "reasoning", "language-model")):
        return ModelType.LLM
    return None


def infer_model_type(
    model_id: str,
    entry: dict[str, Any] | None = None,
) -> tuple[ModelType, Literal["high", "medium", "low"]]:
    normalized_id = model_id.casefold().replace("_", "-")
    id_type = _type_from_text(normalized_id)
    if id_type is not None:
        return id_type, "medium"

    if entry:
        capabilities = entry.get("capabilities")
        if isinstance(capabilities, list):
            capability_codes = {str(item).casefold() for item in capabilities}
            if capability_codes.intersection({"tr", "me"}):
                return ModelType.EMBEDDING, "high"
            if "vu" in capability_codes:
                return ModelType.VISION, "high"
            if capability_codes.intersection({"tg", "reasoning"}):
                return ModelType.LLM, "high"
        metadata_type = _type_from_text(_metadata_text(entry))
        if metadata_type is not None:
            return metadata_type, "high"

    if any(keyword in normalized_id for keyword in ("bge-", "/bge", "gte-", "/gte", "e5-", "/e5", "m3e")):
        return ModelType.EMBEDDING, "medium"
    if any(marker in normalized_id for marker in ("-vl", "/vl", "vl-", "qwen-vl", "llava")):
        return ModelType.VISION, "medium"
    return ModelType.LLM, "low"


def _default_vector_dimension(model_id: str, entry: dict[str, Any] | None = None) -> int | None:
    if entry:
        for source in (entry, entry.get("model_info")):
            if not isinstance(source, dict):
                continue
            for key in ("default_dimension", "embedding_dimension", "vector_dimension", "dimension"):
                value = source.get(key)
                if isinstance(value, int) and value > 0:
                    return value

    normalized = model_id.casefold()
    exact_dimensions = {
        "qwen3.7-text-embedding": 1024,
        "qwen3.7-text-embedding-flash": 1024,
        "text-embedding-v4": 1024,
        "text-embedding-v3": 1024,
        "text-embedding-v2": 1536,
        "text-embedding-v1": 1536,
        "qwen3-vl-embedding": 2560,
        "qwen2.5-vl-embedding": 1024,
        "tongyi-embedding-vision-plus-2026-03-06": 1152,
        "tongyi-embedding-vision-flash-2026-03-06": 768,
        "tongyi-embedding-vision-plus": 1152,
        "tongyi-embedding-vision-flash": 768,
        "multimodal-embedding-v1": 1024,
    }
    return exact_dimensions.get(normalized)


def _parse_offline_time(value: Any) -> datetime | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        timestamp = value / 1000 if value > 10_000_000_000 else value
        try:
            return datetime.fromtimestamp(timestamp, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(normalized, pattern).replace(tzinfo=UTC)
                break
            except ValueError:
                continue
        else:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _is_retired_model(model_id: str, entry: dict[str, Any] | None = None) -> bool:
    if model_id.casefold() == "gte-rerank":
        return True
    if not entry:
        return False
    if any(entry.get(key) is True for key in ("deprecated", "retired", "disabled", "offline")):
        return True
    retired_statuses = {"deprecated", "retired", "offline", "disabled", "decommissioned", "deprecated_model"}
    for key in ("status", "lifecycle", "model_status", "inference_status"):
        if str(entry.get(key) or "").casefold().replace("-", "_") in retired_statuses:
            return True
    for source in (entry, entry.get("inference_offline_info"), entry.get("deprecation_info")):
        if not isinstance(source, dict):
            continue
        offline_time = _parse_offline_time(
            source.get("offline_time") or source.get("retired_at") or source.get("deprecation_time")
        )
        if offline_time is not None and offline_time <= datetime.now(UTC):
            return True
    return False


def _is_supported_catalog_model(model_id: str, entry: dict[str, Any] | None) -> bool:
    if not entry or not isinstance(entry.get("capabilities"), list):
        return True
    capability_codes = {str(item).casefold() for item in entry["capabilities"]}
    supported_codes = {"tg", "reasoning", "vu", "tr", "me"}
    return bool(capability_codes.intersection(supported_codes)) or _type_from_text(model_id) in {
        ModelType.EMBEDDING,
        ModelType.RERANK,
    }


def _parse_models(
    payload: Any,
    *,
    limit: int | None = None,
    filter_catalog_capabilities: bool = False,
) -> DiscoveryResult:
    entries, has_more = _model_entries(payload)
    models_by_id: dict[str, RemoteModel] = {}
    for entry in entries:
        model_id: str | None = None
        model_name: str | None = None
        if isinstance(entry, str):
            model_id = entry.strip()
        elif isinstance(entry, dict):
            raw_id = entry.get("id") or entry.get("model_id") or entry.get("model")
            if isinstance(raw_id, str):
                model_id = raw_id.strip()
            raw_name = entry.get("display_name") or entry.get("name")
            if isinstance(raw_name, str):
                model_name = raw_name.strip()
        if not model_id:
            continue
        metadata = entry if isinstance(entry, dict) else None
        if _is_retired_model(model_id, metadata):
            continue
        if filter_catalog_capabilities and not _is_supported_catalog_model(model_id, metadata):
            continue
        model_type, type_confidence = infer_model_type(model_id, metadata)
        models_by_id.setdefault(
            model_id,
            RemoteModel(
                id=model_id,
                name=model_name or model_id,
                model_type=model_type,
                type_confidence=type_confidence,
                vector_dimension=_default_vector_dimension(model_id, metadata) if model_type == ModelType.EMBEDDING else None,
            ),
        )

    models = sorted(models_by_id.values(), key=lambda item: (item.id.casefold(), item.id))
    truncated = has_more or (limit is not None and len(models) > limit)
    return DiscoveryResult(models=models if limit is None else models[:limit], truncated=truncated)


async def discover_models(
    target: DiscoveryTarget,
    client: httpx.AsyncClient | None = None,
) -> DiscoveryResult:
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=target.timeout_seconds,
            follow_redirects=False,
            trust_env=False,
        )
    try:
        if target.preset_id == "dashscope":
            catalog_url = _dashscope_catalog_url(target.base_url)
            if catalog_url:
                return await _discover_dashscope_models(target, client, catalog_url)
        response = await client.get(
            _endpoint(target.base_url, "models"),
            headers=_discovery_headers(target.protocol, target.api_key),
        )
        if response.status_code >= 400:
            raise HealthCheckFailure(_error_message(response, target.api_key))
        try:
            payload = response.json()
        except ValueError as exc:
            raise HealthCheckFailure("供应商没有返回有效 JSON") from exc
        return _parse_models(payload)
    except httpx.TimeoutException as exc:
        raise HealthCheckFailure("获取模型列表超时") from exc
    except httpx.RequestError as exc:
        raise HealthCheckFailure(f"无法连接供应商：{exc.__class__.__name__}") from exc
    finally:
        if owns_client:
            await client.aclose()


def _dashscope_catalog_url(base_url: str) -> str | None:
    parsed = urlsplit(base_url)
    host = parsed.hostname or ""
    supported_hosts = {
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "cn-hongkong.dashscope.aliyuncs.com",
    }
    if host not in supported_hosts and not host.endswith(".maas.aliyuncs.com"):
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, "/api/v1/models", "", ""))


async def _discover_dashscope_models(
    target: DiscoveryTarget,
    client: httpx.AsyncClient,
    catalog_url: str,
) -> DiscoveryResult:
    models_by_id: dict[str, RemoteModel] = {}
    truncated = False
    page_no = 1
    max_pages = 100
    while page_no <= max_pages:
        response = await client.get(
            catalog_url,
            params={"page_no": page_no, "page_size": 100},
            headers=_discovery_headers(target.protocol, target.api_key),
        )
        if response.status_code >= 400:
            raise HealthCheckFailure(_error_message(response, target.api_key))
        try:
            payload = response.json()
        except ValueError as exc:
            raise HealthCheckFailure("通义模型目录没有返回有效 JSON") from exc
        result = _parse_models(payload, filter_catalog_capabilities=True)
        for model in result.models:
            models_by_id.setdefault(model.id, model)

        output = payload.get("output") if isinstance(payload, dict) else None
        total = output.get("total") if isinstance(output, dict) else None
        page_size = output.get("page_size") if isinstance(output, dict) else None
        total_pages = math.ceil(total / page_size) if isinstance(total, int) and isinstance(page_size, int) and page_size > 0 else None
        has_next_page = page_no < total_pages if total_pages is not None else result.truncated
        if not has_next_page:
            truncated = False
            break
        page_no += 1
    else:
        truncated = True
    models = sorted(models_by_id.values(), key=lambda item: (item.id.casefold(), item.id))
    return DiscoveryResult(models=models, truncated=truncated)


def _request_for(target: ProbeTarget, *, stream: bool = False) -> tuple[str, dict[str, str], dict[str, Any]]:
    bearer_headers = {
        "Authorization": f"Bearer {target.api_key}",
        "Content-Type": "application/json",
    }
    if target.protocol == "OpenAI Chat Completions":
        return _endpoint(target.base_url, "chat/completions"), bearer_headers, {
            "model": target.model_id,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 8,
            "stream": stream,
        }
    if target.protocol == "OpenAI Responses":
        return _endpoint(target.base_url, "responses"), bearer_headers, {
            "model": target.model_id,
            "input": "Reply with OK.",
            "max_output_tokens": 8,
            "stream": stream,
        }
    if target.protocol == "OpenAI Embeddings":
        return _endpoint(target.base_url, "embeddings"), bearer_headers, {
            "model": target.model_id,
            "input": ["connection test"],
        }
    if target.protocol == "DashScope Text Embeddings":
        return _dashscope_native_url(target.base_url, "services/embeddings/text-embedding/text-embedding"), bearer_headers, {
            "model": target.model_id,
            "input": ["connection test"],
        }
    if target.protocol == "DashScope Multimodal Embeddings":
        return _dashscope_native_url(target.base_url, "services/embeddings/multimodal-embedding/multimodal-embedding"), bearer_headers, {
            "model": target.model_id,
            "input": {"contents": [{"text": "connection test"}]},
        }
    if target.protocol == "Anthropic Messages":
        return _endpoint(target.base_url, "messages"), {
            "x-api-key": target.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }, {
            "model": target.model_id,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "stream": stream,
        }
    if target.protocol == "Cohere Rerank":
        return _endpoint(target.base_url, "rerank"), bearer_headers, {
            "model": target.model_id,
            "query": "connection test",
            "documents": ["connection test", "unrelated text"],
            "top_n": 1,
        }
    if target.protocol == "DashScope Rerank":
        return _dashscope_native_url(target.base_url, "services/rerank/text-rerank/text-rerank"), bearer_headers, {
            "model": target.model_id,
            "input": {
                "query": "connection test",
                "documents": ["connection test", "unrelated text"],
            },
            "parameters": {"top_n": 1},
        }
    raise HealthCheckFailure(f"暂不支持协议：{target.protocol}")


def _validate_payload(protocol: str, payload: Any) -> None:
    if not isinstance(payload, dict):
        raise HealthCheckFailure("供应商返回的 JSON 结构无效")
    if protocol in {"DashScope Text Embeddings", "DashScope Multimodal Embeddings", "DashScope Rerank"}:
        output = payload.get("output")
        expected = "results" if protocol == "DashScope Rerank" else "embeddings"
        if not isinstance(output, dict) or expected not in output:
            raise HealthCheckFailure(f"响应缺少 output.{expected} 字段")
        return
    expected = {
        "OpenAI Chat Completions": "choices",
        "OpenAI Responses": "output",
        "OpenAI Embeddings": "data",
        "Anthropic Messages": "content",
        "Cohere Rerank": "results",
    }[protocol]
    if expected not in payload:
        raise HealthCheckFailure(f"响应缺少 {expected} 字段")


def _dashscope_native_url(base_url: str, suffix: str) -> str:
    parsed = urlsplit(base_url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/api/v1/{suffix.lstrip('/')}", "", ""))


async def probe_model(target: ProbeTarget, client: httpx.AsyncClient | None = None) -> ProbeResult:
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=target.timeout_seconds,
            follow_redirects=False,
            trust_env=False,
        )
    started = perf_counter()
    try:
        url, headers, payload = _request_for(target)
        response = await client.post(url, headers=headers, json=payload)
        if response.status_code >= 400:
            raise HealthCheckFailure(_error_message(response, target.api_key))
        try:
            response_payload = response.json()
        except ValueError as exc:
            raise HealthCheckFailure("供应商没有返回有效 JSON") from exc
        _validate_payload(target.protocol, response_payload)

        checks = {"request": True, "stream": False, "usage": _usage(response_payload) is not None}
        usage = _usage(response_payload)
        status = ProviderHealth.HEALTHY
        message = "连接检测通过"

        if target.preset_id == "kimi-code" and target.protocol == "OpenAI Responses":
            stream_url, stream_headers, stream_payload = _request_for(target, stream=True)
            stream_seen = False
            stream_usage = None
            async with client.stream("POST", stream_url, headers=stream_headers, json=stream_payload) as stream_response:
                if stream_response.status_code >= 400:
                    await stream_response.aread()
                    raise HealthCheckFailure(_error_message(stream_response, target.api_key))
                async for line in stream_response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    stream_seen = True
                    try:
                        stream_usage = stream_usage or _usage(json.loads(data))
                    except ValueError:
                        continue
            checks["stream"] = stream_seen
            usage = usage or stream_usage
            checks["usage"] = usage is not None
            if not checks["stream"] or not checks["usage"]:
                status = ProviderHealth.DEGRADED
                missing = "流式输出" if not checks["stream"] else "usage"
                message = f"基础请求通过，但未验证到{missing}"

        return ProbeResult(
            status=status,
            latency_ms=round((perf_counter() - started) * 1000, 2),
            checks=checks,
            usage=usage,
            message=message,
        )
    except httpx.TimeoutException as exc:
        raise HealthCheckFailure("连接供应商超时") from exc
    except httpx.RequestError as exc:
        raise HealthCheckFailure(f"无法连接供应商：{exc.__class__.__name__}") from exc
    finally:
        if owns_client:
            await client.aclose()


# 各协议单次请求可携带的文本条数上限（DashScope 文本向量接口单次最多 10 条）
EMBEDDING_BATCH_SIZES = {
    "OpenAI Embeddings": 64,
    "DashScope Text Embeddings": 10,
    "DashScope Multimodal Embeddings": 10,
}
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


@dataclass(slots=True)
class EmbeddingResult:
    vectors: list[list[float]]
    usage: dict[str, int | float] | None


async def _post_json(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    api_key: str,
    *,
    attempts: int = 3,
    sleep: Any = None,
) -> Any:
    import asyncio

    pause = sleep or asyncio.sleep
    for attempt in range(1, attempts + 1):
        try:
            response = await client.post(url, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            if attempt == attempts:
                raise HealthCheckFailure("调用供应商超时") from exc
        except httpx.RequestError as exc:
            if attempt == attempts:
                raise HealthCheckFailure(f"无法连接供应商：{exc.__class__.__name__}") from exc
        else:
            if response.status_code in RETRYABLE_STATUS and attempt < attempts:
                await pause(2 ** (attempt - 1))
                continue
            if response.status_code >= 400:
                raise HealthCheckFailure(_error_message(response, api_key))
            try:
                return response.json()
            except ValueError as exc:
                raise HealthCheckFailure("供应商没有返回有效 JSON") from exc
        await pause(2 ** (attempt - 1))
    raise HealthCheckFailure("调用供应商失败")


def _embedding_request(target: ProbeTarget, texts: list[str]) -> tuple[str, dict[str, str], dict[str, Any]]:
    headers = {"Authorization": f"Bearer {target.api_key}", "Content-Type": "application/json"}
    if target.protocol == "OpenAI Embeddings":
        return _endpoint(target.base_url, "embeddings"), headers, {
            "model": target.model_id,
            "input": texts,
            "encoding_format": "float",
        }
    if target.protocol == "DashScope Text Embeddings":
        return _dashscope_native_url(target.base_url, "services/embeddings/text-embedding/text-embedding"), headers, {
            "model": target.model_id,
            "input": {"texts": texts},
        }
    if target.protocol == "DashScope Multimodal Embeddings":
        return _dashscope_native_url(
            target.base_url, "services/embeddings/multimodal-embedding/multimodal-embedding"
        ), headers, {
            "model": target.model_id,
            "input": {"contents": [{"text": text} for text in texts]},
        }
    raise HealthCheckFailure(f"协议 {target.protocol} 不支持文本向量化")


def _embedding_items(protocol: str, payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise HealthCheckFailure("供应商返回的 JSON 结构无效")
    items = payload.get("data") if protocol == "OpenAI Embeddings" else (payload.get("output") or {}).get("embeddings")
    if not isinstance(items, list):
        raise HealthCheckFailure("响应缺少向量字段")
    return items


async def embed_texts(
    target: ProbeTarget,
    texts: list[str],
    *,
    expected_dimension: int | None = None,
    client: httpx.AsyncClient | None = None,
    sleep: Any = None,
) -> EmbeddingResult:
    """把文本转成向量，按协议的批量上限自动分批，返回顺序与输入一致。"""
    if not texts:
        return EmbeddingResult(vectors=[], usage=None)
    batch_size = EMBEDDING_BATCH_SIZES.get(target.protocol)
    if batch_size is None:
        raise HealthCheckFailure(f"协议 {target.protocol} 不支持文本向量化")
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=target.timeout_seconds, follow_redirects=False, trust_env=False)
    vectors: list[list[float]] = []
    usage_total: dict[str, int | float] = {}
    try:
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            url, headers, payload = _embedding_request(target, batch)
            body = await _post_json(client, url, headers, payload, target.api_key, sleep=sleep)
            items = _embedding_items(target.protocol, body)
            if len(items) != len(batch):
                raise HealthCheckFailure("供应商返回的向量数量与请求不一致")
            ordered = sorted(items, key=lambda item: item.get("index", item.get("text_index", 0)))
            for item in ordered:
                vector = item.get("embedding")
                if not isinstance(vector, list) or not vector:
                    raise HealthCheckFailure("响应中的向量为空")
                if expected_dimension is not None and len(vector) != expected_dimension:
                    raise HealthCheckFailure(
                        f"向量维度为 {len(vector)}，与知识库配置的 {expected_dimension} 不一致"
                    )
                vectors.append([float(value) for value in vector])
            for key, value in (_usage(body) or {}).items():
                usage_total[key] = usage_total.get(key, 0) + value
    finally:
        if owns_client:
            await client.aclose()
    return EmbeddingResult(vectors=vectors, usage=usage_total or None)


IMAGE_PROMPT = "请用中文客观描述这张图片的内容，包括其中的文字、图表数据和关键信息，用于知识库检索。不要编造图片中没有的内容。"


async def describe_image(
    target: ProbeTarget,
    image: bytes,
    mime_type: str,
    *,
    prompt: str = IMAGE_PROMPT,
    client: httpx.AsyncClient | None = None,
    sleep: Any = None,
) -> str:
    """调用视觉模型生成图片的语义描述。"""
    import base64

    data_url = f"data:{mime_type};base64,{base64.b64encode(image).decode('ascii')}"
    bearer = {"Authorization": f"Bearer {target.api_key}", "Content-Type": "application/json"}
    if target.protocol == "OpenAI Chat Completions":
        url, headers, payload = _endpoint(target.base_url, "chat/completions"), bearer, {
            "model": target.model_id,
            "max_tokens": 600,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}],
        }
    elif target.protocol == "OpenAI Responses":
        url, headers, payload = _endpoint(target.base_url, "responses"), bearer, {
            "model": target.model_id,
            "max_output_tokens": 600,
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": data_url},
            ]}],
        }
    elif target.protocol == "Anthropic Messages":
        url = _endpoint(target.base_url, "messages")
        headers = {"x-api-key": target.api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        payload = {
            "model": target.model_id,
            "max_tokens": 600,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": base64.b64encode(image).decode("ascii")}},
                {"type": "text", "text": prompt},
            ]}],
        }
    else:
        raise HealthCheckFailure(f"协议 {target.protocol} 不支持图片理解")

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=target.timeout_seconds, follow_redirects=False, trust_env=False)
    try:
        body = await _post_json(client, url, headers, payload, target.api_key, sleep=sleep)
    finally:
        if owns_client:
            await client.aclose()
    text = _extract_text(target.protocol, body)
    if not text:
        raise HealthCheckFailure("视觉模型没有返回描述")
    return text


def _extract_text(protocol: str, body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    if protocol == "OpenAI Chat Completions":
        choices = body.get("choices") or [{}]
        return str((choices[0].get("message") or {}).get("content") or "").strip()
    if protocol == "OpenAI Responses":
        if body.get("output_text"):
            return str(body["output_text"]).strip()
        parts = [
            part.get("text", "")
            for item in body.get("output") or []
            for part in (item.get("content") or [] if isinstance(item, dict) else [])
            if isinstance(part, dict)
        ]
        return "".join(parts).strip()
    return "".join(block.get("text", "") for block in body.get("content") or [] if isinstance(block, dict)).strip()
