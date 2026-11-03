import json
from typing import Any

from .adapters import HealthCheckFailure, ProbeTarget, generate_text
from .chunking import ChunkDraft, estimate_tokens

METADATA_FIELDS = ("dates", "versions", "subjects", "owners", "keywords", "questions")
METADATA_LABELS = {
    "dates": "时间",
    "versions": "版本",
    "subjects": "主体信息",
    "owners": "负责人",
    "keywords": "检索关键词",
    "questions": "可能被问到的问题",
}


def empty_metadata() -> dict[str, list[str]]:
    return {field: [] for field in METADATA_FIELDS}


def normalize_metadata(payload: Any) -> dict[str, list[str]]:
    if not isinstance(payload, dict):
        raise HealthCheckFailure("元数据模型返回的结构无效")
    normalized = empty_metadata()
    for field in METADATA_FIELDS:
        value = payload.get(field, [])
        if not isinstance(value, list):
            raise HealthCheckFailure(f"元数据字段 {field} 不是数组")
        cleaned: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            text = item.strip()[:200]
            if text and text not in cleaned:
                cleaned.append(text)
        normalized[field] = cleaned[:20 if field in {"keywords", "questions"} else 10]
    return normalized


def parse_metadata_json(text: str) -> dict[str, list[str]]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end < start:
        raise HealthCheckFailure("元数据模型没有返回 JSON")
    try:
        return normalize_metadata(json.loads(cleaned[start : end + 1]))
    except json.JSONDecodeError as exc:
        raise HealthCheckFailure("元数据模型返回的 JSON 无效") from exc


def metadata_text(metadata: dict[str, list[str]]) -> str:
    return "\n".join(
        f"{METADATA_LABELS[field]}：{'、'.join(metadata.get(field, []))}"
        for field in METADATA_FIELDS
        if metadata.get(field)
    )


def metadata_chunk(metadata: dict[str, list[str]]) -> ChunkDraft | None:
    content = metadata_text(metadata)
    if not content:
        return None
    return ChunkDraft("metadata", content, estimate_tokens(content), {"source": "metadata"})


async def extract_document_metadata(target: ProbeTarget, text: str) -> dict[str, list[str]]:
    if not text.strip():
        return empty_metadata()
    excerpt = text[:9000] + ("\n\n[文档后段]\n" + text[-3000:] if len(text) > 12000 else text[9000:12000])
    messages = [
        {
            "role": "system",
            "content": (
                "你是文档元数据抽取器。只能抽取正文明确出现的信息，禁止推测或补写。"
                "时间包括发布、更新、生效日期；版本包括文档或制度版本；主体信息包括公司、产品、制度或系统主体；"
                "负责人包括明确列出的负责人、部门或责任主体。关键词用于检索，问题必须是能由正文直接回答的潜在问题。"
                "未知字段返回空数组。只输出 JSON："
                '{"dates":[],"versions":[],"subjects":[],"owners":[],"keywords":[],"questions":[]}。'
            ),
        },
        {"role": "user", "content": "请抽取以下文档的元数据：\n\n" + excerpt},
    ]
    result = await generate_text(target, messages, max_tokens=1200, temperature=0, json_mode=True)
    return parse_metadata_json(result.text)
