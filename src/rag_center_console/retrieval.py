"""阶段 4：知识库自动路由、库内混合检索、跨库融合与可选重排。"""

import asyncio
import hashlib
import json
import math
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from langchain_core.runnables import RunnableLambda
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .adapters import (
    EmbeddingResult,
    GenerationResult,
    HealthCheckFailure,
    ProbeTarget,
    RerankResult,
    embed_texts,
    generate_text,
    rerank_texts,
)
from .models import (
    Chunk,
    Document,
    KnowledgeBase,
    KnowledgeBaseRouteIndex,
    KnowledgeBaseStatus,
    ModelDefault,
    ModelDefinition,
    ModelType,
    Provider,
    VectorStatus,
)
from .security import SecretBox, get_secret_box
from .vectorstore import VectorMatch, VectorStore, VectorStoreError, get_vector_store


class RetrievalError(RuntimeError):
    """可直接向前端展示的路由或检索错误。"""


@dataclass(slots=True)
class RouteSelection:
    knowledge_base_id: str
    name: str
    score: float
    reason: str


@dataclass(slots=True)
class RetrievalHit:
    chunk_id: str
    knowledge_base_id: str
    knowledge_base_name: str
    document_id: str
    filename: str
    position: int
    kind: str
    content: str
    location: dict[str, Any]
    dense_score: float = 0.0
    bm25_score: float = 0.0
    rrf_score: float = 0.0
    rerank_score: float | None = None


@dataclass(slots=True)
class RetrievalResult:
    query: str
    selected_knowledge_bases: list[RouteSelection]
    hits: list[RetrievalHit]
    insufficient: bool
    rerank_applied: bool
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RetrievalServices:
    secret_box: SecretBox
    vector_store: VectorStore
    embed: Callable[..., Awaitable[EmbeddingResult]] = embed_texts
    generate: Callable[..., Awaitable[GenerationResult]] = generate_text
    rerank: Callable[..., Awaitable[RerankResult]] = rerank_texts


def default_retrieval_services() -> RetrievalServices:
    return RetrievalServices(secret_box=get_secret_box(), vector_store=get_vector_store())


def model_target(model: ModelDefinition, secret_box: SecretBox) -> ProbeTarget:
    provider: Provider = model.provider
    return ProbeTarget(
        provider_id=provider.id,
        preset_id=provider.preset_id,
        base_url=provider.base_url,
        api_key=secret_box.decrypt(provider.api_key_encrypted),
        model_id=model.model_id,
        protocol=model.protocol,
        timeout_seconds=model.timeout_seconds,
    )


def get_default_model(db: Session, purpose: str, expected_type: ModelType, *, required: bool) -> ModelDefinition | None:
    default = db.get(ModelDefault, purpose)
    model = db.get(ModelDefinition, default.model_id) if default and default.model_id else None
    if model is None:
        if required:
            raise RetrievalError(f"请先在模型服务中配置{_purpose_name(purpose)}")
        return None
    if not model.enabled or model.model_type != expected_type.value:
        raise RetrievalError(f"{_purpose_name(purpose)}不可用，请重新配置")
    if expected_type == ModelType.EMBEDDING and not model.vector_dimension:
        raise RetrievalError(f"{_purpose_name(purpose)}未配置向量维度")
    return model


def _purpose_name(purpose: str) -> str:
    return {
        "routing_embedding": "路由 Embedding 模型",
        "routing_llm": "路由 LLM",
        "default_rerank": "默认 Rerank 模型",
    }.get(purpose, purpose)


def knowledge_base_profile(kb: KnowledgeBase) -> str:
    lines = [f"知识库：{kb.name}"]
    if kb.description:
        lines.append(f"说明：{kb.description}")
    if kb.tags:
        lines.append(f"标签：{'、'.join(kb.tags)}")
    if kb.sample_questions:
        lines.append("示例问题：\n- " + "\n- ".join(kb.sample_questions))
    return "\n".join(lines)


def _profile_hash(profile: str) -> str:
    return hashlib.sha256(profile.encode("utf-8")).hexdigest()


_ALNUM = re.compile(r"[a-zA-Z0-9_]+")
_CJK_RUN = re.compile(r"[\u3400-\u9fff]+")


def tokenize(text: str) -> list[str]:
    """轻量中英文检索分词：英文按词，中文同时保留单字和双字词。"""
    lowered = text.casefold()
    tokens = _ALNUM.findall(lowered)
    for run in _CJK_RUN.findall(lowered):
        tokens.extend(run)
        tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
    return [token for token in tokens if token.strip()]


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    numerator = sum(a * b for a, b in zip(left, right, strict=True))
    denominator = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return numerator / denominator if denominator else 0.0


def _lexical_overlap(query: str, profile: str) -> float:
    query_terms = set(tokenize(query))
    if not query_terms:
        return 0.0
    profile_terms = set(tokenize(profile))
    return len(query_terms & profile_terms) / len(query_terms)


async def route_knowledge_bases(
    db: Session,
    services: RetrievalServices,
    query: str,
    *,
    max_selected: int = 3,
    candidate_limit: int = 8,
) -> list[RouteSelection]:
    bases = list(
        db.scalars(
            select(KnowledgeBase)
            .where(KnowledgeBase.status == KnowledgeBaseStatus.READY.value)
            .where(select(Chunk.id).where(Chunk.knowledge_base_id == KnowledgeBase.id).exists())
            .order_by(KnowledgeBase.updated_at.desc())
        ).all()
    )
    if not bases:
        return []
    embedding_model = get_default_model(db, "routing_embedding", ModelType.EMBEDDING, required=True)
    llm_model = get_default_model(db, "routing_llm", ModelType.LLM, required=True)
    profiles = {kb.id: knowledge_base_profile(kb) for kb in bases}
    stale = [
        kb
        for kb in bases
        if kb.route_index is None
        or kb.route_index.model_id != embedding_model.id
        or kb.route_index.profile_hash != _profile_hash(profiles[kb.id])
    ]
    texts = [query, *(profiles[kb.id] for kb in stale)]
    try:
        embedded = await services.embed(
            model_target(embedding_model, services.secret_box),
            texts,
            expected_dimension=embedding_model.vector_dimension,
        )
    except HealthCheckFailure as exc:
        raise RetrievalError(f"知识库路由向量化失败：{exc}") from exc
    query_vector = embedded.vectors[0]
    for kb, vector in zip(stale, embedded.vectors[1:], strict=True):
        index = kb.route_index or KnowledgeBaseRouteIndex(knowledge_base_id=kb.id)
        index.model_id = embedding_model.id
        index.profile_hash = _profile_hash(profiles[kb.id])
        index.profile_text = profiles[kb.id]
        index.vector = vector
        kb.route_index = index
        db.add(index)
    if stale:
        db.commit()

    scored: list[tuple[KnowledgeBase, float, float, float]] = []
    for kb in bases:
        route_index = db.get(KnowledgeBaseRouteIndex, kb.id)
        vector_score = max(_cosine(query_vector, route_index.vector), 0.0) if route_index else 0.0
        lexical_score = _lexical_overlap(query, profiles[kb.id])
        scored.append((kb, 0.8 * vector_score + 0.2 * lexical_score, vector_score, lexical_score))
    scored.sort(key=lambda item: item[1], reverse=True)
    candidates = scored[: min(max(candidate_limit, max_selected), len(scored))]
    candidate_payload = [
        {
            "id": kb.id,
            "name": kb.name,
            "profile": profiles[kb.id],
            "recall_score": round(score, 6),
        }
        for kb, score, _, _ in candidates
    ]
    messages = [
        {
            "role": "system",
            "content": (
                "你是企业知识库路由器。只能从候选知识库中选择与问题直接相关的知识库，最多选择 "
                f"{max_selected} 个；没有相关知识库时返回空数组。只输出 JSON："
                '{"selected_ids":["id"],"reasons":{"id":"简短原因"}}。'
            ),
        },
        {
            "role": "user",
            "content": json.dumps({"query": query, "candidates": candidate_payload}, ensure_ascii=False),
        },
    ]
    try:
        generated = await services.generate(
            model_target(llm_model, services.secret_box), messages, max_tokens=500, temperature=0, json_mode=True
        )
        selected_ids, reasons = _parse_route_json(generated.text)
    except (HealthCheckFailure, ValueError, json.JSONDecodeError) as exc:
        raise RetrievalError(f"自动选库失败：{exc}") from exc
    candidate_map = {kb.id: (kb, score) for kb, score, _, _ in candidates}
    selections: list[RouteSelection] = []
    for knowledge_base_id in selected_ids:
        if knowledge_base_id not in candidate_map or any(item.knowledge_base_id == knowledge_base_id for item in selections):
            continue
        kb, score = candidate_map[knowledge_base_id]
        selections.append(
            RouteSelection(
                knowledge_base_id=kb.id,
                name=kb.name,
                score=round(score, 6),
                reason=str(reasons.get(kb.id) or "路由模型判定相关")[:200],
            )
        )
        if len(selections) >= max_selected:
            break
    return selections


def _parse_route_json(text: str) -> tuple[list[str], dict[str, str]]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end < start:
        raise ValueError("路由模型没有返回 JSON")
    payload = json.loads(cleaned[start : end + 1])
    selected = payload.get("selected_ids")
    reasons = payload.get("reasons") or {}
    if not isinstance(selected, list) or not all(isinstance(item, str) for item in selected):
        raise ValueError("路由模型返回的 selected_ids 无效")
    if not isinstance(reasons, dict):
        reasons = {}
    return selected, {str(key): str(value) for key, value in reasons.items()}


def _query_terms(query: str) -> list[str]:
    counts = Counter(tokenize(query))
    # 优先较长且非纯单字的词，限制 SQL 条件数量。
    return [term for term, _ in sorted(counts.items(), key=lambda item: (-len(item[0]), -item[1], item[0]))[:8]]


def _bm25_scores(query: str, chunks: list[Chunk], corpus_size: int) -> dict[str, float]:
    if not chunks or corpus_size <= 0:
        return {}
    query_terms = _query_terms(query)
    if not query_terms:
        return {}
    tokenized = {chunk.id: tokenize(chunk.content) for chunk in chunks}
    avgdl = sum(len(tokens) for tokens in tokenized.values()) / max(len(tokenized), 1)
    document_frequency = {
        term: sum(1 for tokens in tokenized.values() if term in set(tokens)) for term in query_terms
    }
    scores: dict[str, float] = {}
    k1, b = 1.5, 0.75
    for chunk in chunks:
        counts = Counter(tokenized[chunk.id])
        dl = max(len(tokenized[chunk.id]), 1)
        score = 0.0
        for term in query_terms:
            tf = counts[term]
            if not tf:
                continue
            df = max(document_frequency[term], 1)
            idf = math.log(1 + (corpus_size - df + 0.5) / (df + 0.5))
            score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / max(avgdl, 1)))
        if score > 0:
            scores[chunk.id] = score
    return scores


def _rrf(ranked_lists: list[list[str]], k: int = 60) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, item_id in enumerate(ranked, start=1):
            scores[item_id] = scores.get(item_id, 0.0) + 1 / (k + rank)
    return scores


async def _retrieve_one_base(
    db: Session,
    services: RetrievalServices,
    query: str,
    selection: RouteSelection,
    *,
    per_base_limit: int,
) -> list[RetrievalHit]:
    kb = db.get(KnowledgeBase, selection.knowledge_base_id)
    if kb is None or kb.status != KnowledgeBaseStatus.READY.value:
        raise RetrievalError(f"知识库“{selection.name}”当前不可用")
    model = db.get(ModelDefinition, kb.embedding_model_id)
    if model is None or not model.enabled:
        raise RetrievalError(f"知识库“{kb.name}”绑定的 Embedding 模型不可用")
    try:
        embedded = await services.embed(
            model_target(model, services.secret_box), [query], expected_dimension=kb.vector_dimension
        )
        dense_matches = services.vector_store.search(
            kb.collection_name, embedded.vectors[0], limit=max(per_base_limit * 3, 20)
        )
    except (HealthCheckFailure, VectorStoreError) as exc:
        raise RetrievalError(f"知识库“{kb.name}”向量检索失败：{exc}") from exc

    dense_by_id = {match.id: match for match in dense_matches}
    terms = _query_terms(query)
    lexical_stmt = select(Chunk).where(
        Chunk.knowledge_base_id == kb.id,
        Chunk.vector_status == VectorStatus.INDEXED.value,
    )
    if terms:
        lexical_stmt = lexical_stmt.where(or_(*(Chunk.content.ilike(f"%{term}%") for term in terms)))
    lexical_chunks = list(db.scalars(lexical_stmt.limit(max(per_base_limit * 10, 100))).all()) if terms else []
    dense_chunks = list(db.scalars(select(Chunk).where(Chunk.id.in_(dense_by_id))).all()) if dense_by_id else []
    chunks_by_id = {chunk.id: chunk for chunk in [*dense_chunks, *lexical_chunks]}
    corpus_size = db.scalar(
        select(func.count(Chunk.id)).where(
            Chunk.knowledge_base_id == kb.id, Chunk.vector_status == VectorStatus.INDEXED.value
        )
    ) or 0
    bm25 = _bm25_scores(query, list(chunks_by_id.values()), corpus_size)
    dense_rank = [match.id for match in dense_matches if match.id in chunks_by_id]
    lexical_rank = [item[0] for item in sorted(bm25.items(), key=lambda item: item[1], reverse=True)]
    fused = _rrf([dense_rank, lexical_rank])
    relevant_ids = [
        chunk_id
        for chunk_id, _ in sorted(fused.items(), key=lambda item: item[1], reverse=True)
        if bm25.get(chunk_id, 0.0) > 0 or dense_by_id.get(chunk_id, VectorMatch("", 0.0, {})).score >= 0.25
    ][:per_base_limit]
    if not relevant_ids:
        return []
    documents = {
        document.id: document
        for document in db.scalars(
            select(Document).where(Document.id.in_({chunks_by_id[item].document_id for item in relevant_ids}))
        ).all()
    }
    return [
        RetrievalHit(
            chunk_id=chunk.id,
            knowledge_base_id=kb.id,
            knowledge_base_name=kb.name,
            document_id=chunk.document_id,
            filename=documents[chunk.document_id].filename,
            position=chunk.position,
            kind=chunk.kind,
            content=chunk.content,
            location=chunk.location or {},
            dense_score=round(dense_by_id.get(chunk.id, VectorMatch("", 0.0, {})).score, 6),
            bm25_score=round(bm25.get(chunk.id, 0.0), 6),
            rrf_score=round(fused.get(chunk.id, 0.0), 8),
        )
        for chunk in (chunks_by_id[item] for item in relevant_ids)
    ]


async def retrieve_across_bases(
    db: Session,
    services: RetrievalServices,
    query: str,
    selections: list[RouteSelection],
    *,
    top_k: int = 8,
    per_base_limit: int = 8,
) -> RetrievalResult:
    if not selections:
        return RetrievalResult(query=query, selected_knowledge_bases=[], hits=[], insufficient=True, rerank_applied=False)
    outcomes = await asyncio.gather(
        *(
            _retrieve_one_base(db, services, query, selection, per_base_limit=per_base_limit)
            for selection in selections
        ),
        return_exceptions=True,
    )
    warnings: list[str] = []
    per_base_hits: list[list[RetrievalHit]] = []
    for selection, outcome in zip(selections, outcomes, strict=True):
        if isinstance(outcome, Exception):
            warnings.append(str(outcome))
        else:
            per_base_hits.append(outcome)
    if not per_base_hits and warnings:
        raise RetrievalError("；".join(warnings))
    by_id = {hit.chunk_id: hit for hits in per_base_hits for hit in hits}
    cross_scores = _rrf([[hit.chunk_id for hit in hits] for hits in per_base_hits])
    ranked = [
        by_id[chunk_id]
        for chunk_id, _ in sorted(cross_scores.items(), key=lambda item: item[1], reverse=True)
    ]
    for hit in ranked:
        hit.rrf_score = round(cross_scores[hit.chunk_id], 8)

    rerank_applied = False
    rerank_model = get_default_model(db, "default_rerank", ModelType.RERANK, required=False)
    if rerank_model and ranked:
        try:
            result = await services.rerank(
                model_target(rerank_model, services.secret_box),
                query,
                [hit.content for hit in ranked],
                top_n=min(top_k, len(ranked)),
            )
            reranked: list[RetrievalHit] = []
            for item in result.items:
                if 0 <= item.index < len(ranked):
                    hit = ranked[item.index]
                    hit.rerank_score = round(item.score, 6)
                    reranked.append(hit)
            if reranked:
                ranked = reranked
                rerank_applied = True
        except HealthCheckFailure as exc:
            warnings.append(f"Rerank 调用失败，已使用 RRF 结果：{exc}")
    hits = ranked[:top_k]
    insufficient = not hits or (rerank_applied and (hits[0].rerank_score or 0) < 0.05)
    if insufficient:
        hits = []
    return RetrievalResult(
        query=query,
        selected_knowledge_bases=selections,
        hits=hits,
        insufficient=insufficient,
        rerank_applied=rerank_applied,
        warnings=warnings,
    )


class RetrievalPipeline:
    """使用 LangChain Runnable 串联自动选库与检索步骤。"""

    def __init__(self, services: RetrievalServices) -> None:
        self.services = services
        self.chain = RunnableLambda(self._route_step) | RunnableLambda(self._retrieve_step)

    async def _route_step(self, state: dict[str, Any]) -> dict[str, Any]:
        selections = await route_knowledge_bases(state["db"], self.services, state["query"])
        return {**state, "selections": selections}

    async def _retrieve_step(self, state: dict[str, Any]) -> RetrievalResult:
        return await retrieve_across_bases(
            state["db"],
            self.services,
            state["query"],
            state["selections"],
            top_k=state["top_k"],
        )

    async def run(self, db: Session, query: str, *, top_k: int = 8) -> RetrievalResult:
        return await self.chain.ainvoke({"db": db, "query": query.strip(), "top_k": top_k})
