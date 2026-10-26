import json
from dataclasses import dataclass
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


@dataclass(slots=True)
class RemoteModel:
    id: str
    name: str
    model_type: ModelType
    type_confidence: Literal["high", "medium", "low"]


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
    if entry:
        metadata_type = _type_from_text(_metadata_text(entry))
        if metadata_type is not None:
            return metadata_type, "high"

    normalized_id = model_id.casefold().replace("_", "-")
    id_type = _type_from_text(normalized_id)
    if id_type is not None:
        return id_type, "medium"
    if any(keyword in normalized_id for keyword in ("bge-", "/bge", "gte-", "/gte", "e5-", "/e5", "m3e")):
        return ModelType.EMBEDDING, "medium"
    if any(marker in normalized_id for marker in ("-vl", "/vl", "vl-", "qwen-vl", "llava")):
        return ModelType.VISION, "medium"
    return ModelType.LLM, "low"


def _parse_models(payload: Any, *, limit: int = 500) -> DiscoveryResult:
    entries, has_more = _model_entries(payload)
    models_by_id: dict[str, RemoteModel] = {}
    for entry in entries:
        model_id: str | None = None
        model_name: str | None = None
        if isinstance(entry, str):
            model_id = entry.strip()
        elif isinstance(entry, dict):
            raw_id = entry.get("id") or entry.get("model_id")
            if isinstance(raw_id, str):
                model_id = raw_id.strip()
            raw_name = entry.get("display_name") or entry.get("name")
            if isinstance(raw_name, str):
                model_name = raw_name.strip()
        if not model_id:
            continue
        model_type, type_confidence = infer_model_type(model_id, entry if isinstance(entry, dict) else None)
        models_by_id.setdefault(
            model_id,
            RemoteModel(
                id=model_id,
                name=model_name or model_id,
                model_type=model_type,
                type_confidence=type_confidence,
            ),
        )

    models = sorted(models_by_id.values(), key=lambda item: (item.id.casefold(), item.id))
    truncated = has_more or len(models) > limit
    return DiscoveryResult(models=models[:limit], truncated=truncated)


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
    raise HealthCheckFailure(f"暂不支持协议：{target.protocol}")


def _validate_payload(protocol: str, payload: Any) -> None:
    if not isinstance(payload, dict):
        raise HealthCheckFailure("供应商返回的 JSON 结构无效")
    expected = {
        "OpenAI Chat Completions": "choices",
        "OpenAI Responses": "output",
        "OpenAI Embeddings": "data",
        "Anthropic Messages": "content",
        "Cohere Rerank": "results",
    }[protocol]
    if expected not in payload:
        raise HealthCheckFailure(f"响应缺少 {expected} 字段")


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
