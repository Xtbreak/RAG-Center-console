from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from qdrant_client import QdrantClient, models

from .config import get_settings


class VectorStoreError(RuntimeError):
    """向量库不可用或集合与配置不一致，消息可直接展示给用户。"""


@dataclass(slots=True)
class VectorPoint:
    id: str
    vector: list[float]
    payload: dict[str, Any]


@dataclass(slots=True)
class VectorMatch:
    id: str
    score: float
    payload: dict[str, Any]


def collection_name(knowledge_base_id: str, generation: int = 1) -> str:
    """每个知识库独立 collection；整库重建时递增 generation 写入新集合，成功后再切换。"""
    base = f"kb_{knowledge_base_id.replace('-', '')}"
    return base if generation <= 1 else f"{base}_g{generation}"


class VectorStore:
    def __init__(self, client: QdrantClient) -> None:
        self._client = client

    def ensure_collection(self, name: str, dimension: int) -> None:
        try:
            if not self._client.collection_exists(name):
                try:
                    self._client.create_collection(
                        name, vectors_config=models.VectorParams(size=dimension, distance=models.Distance.COSINE)
                    )
                except Exception:
                    if not self._client.collection_exists(name):
                        raise
            existing = self._client.get_collection(name).config.params.vectors
            size = existing.size if isinstance(existing, models.VectorParams) else None
            if size != dimension:
                raise VectorStoreError(f"向量库集合维度为 {size}，与配置的 {dimension} 不一致，请重建知识库")
            for field in ("document_id", "chunk_id"):
                self._client.create_payload_index(name, field, models.PayloadSchemaType.KEYWORD)
        except VectorStoreError:
            raise
        except Exception as exc:
            raise VectorStoreError("向量库不可用，请检查 Qdrant 服务") from exc

    def upsert(self, name: str, points: Sequence[VectorPoint]) -> None:
        if not points:
            return
        try:
            self._client.upsert(
                name,
                points=[models.PointStruct(id=p.id, vector=p.vector, payload=p.payload) for p in points],
                wait=True,
            )
        except Exception as exc:
            raise VectorStoreError("写入向量库失败") from exc

    def delete_document(self, name: str, document_id: str) -> None:
        self._delete_by_filter(name, "document_id", [document_id])

    def delete_chunks(self, name: str, chunk_ids: Sequence[str]) -> None:
        self._delete_by_filter(name, "chunk_id", list(chunk_ids))

    def _delete_by_filter(self, name: str, key: str, values: list[str]) -> None:
        if not values:
            return
        try:
            if not self._client.collection_exists(name):
                return
            self._client.delete(
                name,
                points_selector=models.FilterSelector(
                    filter=models.Filter(must=[models.FieldCondition(key=key, match=models.MatchAny(any=values))])
                ),
                wait=True,
            )
        except Exception as exc:
            raise VectorStoreError("删除向量失败") from exc

    def delete_collection(self, name: str) -> None:
        try:
            self._client.delete_collection(name)
        except Exception as exc:
            raise VectorStoreError("删除向量集合失败") from exc

    def search(
        self, name: str, vector: list[float], *, limit: int = 20, score_threshold: float | None = None
    ) -> list[VectorMatch]:
        try:
            if not self._client.collection_exists(name):
                return []
            response = self._client.query_points(
                name,
                query=vector,
                limit=min(max(limit, 1), 100),
                score_threshold=score_threshold,
                with_payload=True,
                with_vectors=False,
            )
            return [
                VectorMatch(id=str(point.id), score=float(point.score), payload=dict(point.payload or {}))
                for point in response.points
            ]
        except Exception as exc:
            raise VectorStoreError("检索向量库失败") from exc

    def count(self, name: str) -> int:
        try:
            return self._client.count(name, exact=True).count
        except Exception as exc:
            raise VectorStoreError("读取向量库失败") from exc


@lru_cache
def get_vector_store() -> VectorStore:
    settings = get_settings()
    return VectorStore(QdrantClient(url=settings.qdrant_url, api_key=settings.qdrant_api_key or None, timeout=30))
