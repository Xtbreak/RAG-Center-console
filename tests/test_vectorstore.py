import pytest
from qdrant_client import QdrantClient

from rag_center_console.vectorstore import VectorPoint, VectorStore, VectorStoreError, collection_name


@pytest.fixture
def store():
    return VectorStore(QdrantClient(":memory:"))


def points(document_id, count, start=0):
    return [
        VectorPoint(f"00000000-0000-0000-0000-{start + i:012d}", [1.0, float(i)], {"document_id": document_id, "chunk_id": f"c{start + i}"})
        for i in range(count)
    ]


def test_collection_name_is_per_knowledge_base_and_versioned():
    assert collection_name("1234-abcd") == "kb_1234abcd"
    assert collection_name("1234-abcd", 3) == "kb_1234abcd_g3"


def test_upsert_and_delete_by_document_and_chunk(store):
    store.ensure_collection("kb", 2)
    store.upsert("kb", points("d1", 3) + points("d2", 2, start=10))
    assert store.count("kb") == 5
    store.delete_chunks("kb", ["c1"])
    assert store.count("kb") == 4
    store.delete_document("kb", "d1")
    assert store.count("kb") == 2
    store.delete_document("missing-collection-is-ignored", "d1")


def test_upsert_is_idempotent_per_point_id(store):
    store.ensure_collection("kb", 2)
    store.upsert("kb", points("d1", 2))
    store.upsert("kb", points("d1", 2))
    assert store.count("kb") == 2


def test_search_returns_ranked_payloads(store):
    store.ensure_collection("kb", 2)
    store.upsert("kb", points("d1", 3))
    matches = store.search("kb", [1.0, 0.0], limit=2)
    assert len(matches) == 2
    assert matches[0].payload["document_id"] == "d1"
    assert matches[0].score >= matches[1].score


def test_search_missing_collection_is_empty(store):
    assert store.search("missing", [1.0, 0.0]) == []


def test_ensure_collection_detects_dimension_mismatch(store):
    store.ensure_collection("kb", 2)
    store.ensure_collection("kb", 2)  # 重复调用安全
    with pytest.raises(VectorStoreError, match="不一致"):
        store.ensure_collection("kb", 3)


def test_unreachable_server_reports_friendly_error():
    store = VectorStore(QdrantClient(url="http://127.0.0.1:9", timeout=1))
    with pytest.raises(VectorStoreError, match="Qdrant"):
        store.ensure_collection("kb", 2)
