import pytest

from rag_center_console.adapters import HealthCheckFailure
from rag_center_console.metadata import empty_metadata, metadata_chunk, metadata_text, normalize_metadata, parse_metadata_json


def test_metadata_json_is_normalized_and_rendered_without_invented_fields():
    payload = parse_metadata_json('```json\n{"dates":["2026-09-01"],"versions":[],"subjects":["安全中心"],"owners":[],"keywords":["信誉分","信誉分"],"questions":["90 分能做什么？"]}\n```')
    assert payload["dates"] == ["2026-09-01"]
    assert payload["versions"] == [] and payload["owners"] == []
    assert payload["keywords"] == ["信誉分"]
    text = metadata_text(payload)
    assert "时间：2026-09-01" in text and "90 分能做什么" in text
    assert "版本" not in text and "负责人" not in text
    chunk = metadata_chunk(payload)
    assert chunk.kind == "metadata" and chunk.location["source"] == "metadata"


def test_invalid_or_empty_metadata_is_handled_explicitly():
    with pytest.raises(HealthCheckFailure, match="JSON"):
        parse_metadata_json("not json")
    with pytest.raises(HealthCheckFailure, match="不是数组"):
        normalize_metadata({"dates": "2026-09-01"})
    assert metadata_chunk(empty_metadata()) is None
