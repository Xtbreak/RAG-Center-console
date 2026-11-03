"""文档导入流水线：解析 → 图片增强 → 切分 → 向量化。

同步实现，由 Celery 任务（worker.py）调用；所有外部依赖通过 PipelineServices 注入，便于测试。
"""

import asyncio
import io
import json
import logging
from time import perf_counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from .adapters import EMBEDDING_BATCH_SIZES, IMAGE_PROMPT, EmbeddingResult, HealthCheckFailure, ProbeTarget, describe_image, embed_texts
from .chunking import ChunkDraft, chunk_document
from .config import get_settings
from .docmind import DocmindParser, ParseCancelled, fetch_docmind_image
from .local_documents import parse_local_document
from .logs import persist_model_calls
from .metadata import empty_metadata, extract_document_metadata, metadata_chunk, normalize_metadata
from .models import (
    Chunk,
    Document,
    DocumentStatus,
    IngestionJob,
    JobStatus,
    KnowledgeBase,
    KnowledgeBaseStatus,
    ModelDefault,
    ModelDefinition,
    ModelType,
    VectorStatus,
    utc_now,
)
from .observability import record_operation
from .parsing import LOCAL_EXTENSIONS, Element, ParsedDocument, ParseError, parse_local
from .security import SecretBox, get_secret_box
from .storage import ObjectStorage, StorageError, get_storage
from .telemetry import CallTrace, trace_call
from .vectorstore import VectorPoint, VectorStore, VectorStoreError, collection_name, get_vector_store

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp", "tiff"})
DEFAULT_EMBEDDING_BATCH = 10
KNOWN_ERRORS = (ParseError, StorageError, VectorStoreError, HealthCheckFailure)


@dataclass
class PipelineServices:
    storage: ObjectStorage
    vector_store: VectorStore
    secret_box: SecretBox
    parser_factory: Callable[[], DocmindParser]
    embed: Callable[[ProbeTarget, list[str], int], EmbeddingResult]
    describe: Callable[[ProbeTarget, bytes, str], str]
    fetch_image: Callable[[str], tuple[bytes, str]] = fetch_docmind_image
    extract_metadata: Callable[[ProbeTarget, str], dict[str, list[str]]] | None = None


def default_services() -> PipelineServices:
    settings = get_settings()
    return PipelineServices(
        storage=get_storage(),
        vector_store=get_vector_store(),
        secret_box=get_secret_box(),
        parser_factory=lambda: DocmindParser(
            settings.aliyun_docmind_access_key_id,
            settings.aliyun_docmind_access_key_secret,
            settings.aliyun_docmind_endpoint,
        ),
        embed=lambda target, texts, dimension: asyncio.run(
            embed_texts(target, texts, expected_dimension=dimension)
        ),
        describe=lambda target, image, mime: asyncio.run(describe_image(target, image, mime)),
        extract_metadata=lambda target, text: asyncio.run(extract_document_metadata(target, text)),
    )


class JobCancelled(Exception):
    pass


def target_for(model: ModelDefinition, secret_box: SecretBox) -> ProbeTarget:
    provider = model.provider
    return ProbeTarget(
        provider_id=provider.id,
        preset_id=provider.preset_id,
        base_url=provider.base_url,
        api_key=secret_box.decrypt(provider.api_key_encrypted),
        model_id=model.model_id,
        protocol=model.protocol,
        timeout_seconds=model.timeout_seconds,
        definition_id=model.id,
    )


def embedding_text(chunk: Chunk) -> str:
    path = (chunk.location or {}).get("heading_path") or []
    return f"{' > '.join(path)}\n{chunk.content}" if path else chunk.content


def _point(chunk: Chunk, vector: list[float]) -> VectorPoint:
    location = chunk.location or {}
    payload = {
        "knowledge_base_id": chunk.knowledge_base_id,
        "document_id": chunk.document_id,
        "chunk_id": chunk.id,
        "position": chunk.position,
        "kind": chunk.kind,
        "heading_path": location.get("heading_path", []),
        "page": location.get("page"),
    }
    return VectorPoint(chunk.id, vector, payload)


def _embed_chunks(
    services: PipelineServices,
    model: ModelDefinition,
    dimension: int,
    chunks: list[Chunk],
    collection: str,
    trace: CallTrace | None = None,
) -> None:
    """向量化一批分段并写入 collection；失败时抛出，分段状态由调用方在确认成功后更新。"""
    target = target_for(model, services.secret_box)
    texts = [embedding_text(c) for c in chunks]
    result = asyncio.run(trace_call(
        trace,
        target,
        "ingestion_embedding",
        lambda: asyncio.to_thread(services.embed, target, texts, dimension),
        input_text="\n".join(texts),
        input_context={"texts": texts, "chunk_ids": [chunk.id for chunk in chunks]},
        output_text=lambda result: json.dumps({"vector_count": len(result.vectors), "usage": result.usage}, ensure_ascii=False),
    ))
    services.vector_store.upsert(collection, [_point(c, v) for c, v in zip(chunks, result.vectors, strict=True)])


def _vision_target(db: Session, services: PipelineServices) -> ProbeTarget | None:
    default = db.get(ModelDefault, "vision")
    model = db.get(ModelDefinition, default.model_id) if default and default.model_id else None
    return target_for(model, services.secret_box) if model and model.enabled else None


def _check_cancel(db: Session, job: IngestionJob) -> None:
    db.refresh(job)
    if job.cancel_requested:
        raise JobCancelled()
    job.updated_at = utc_now()
    db.commit()


def _set_stage(db: Session, job: IngestionJob, document: Document, stage: DocumentStatus, progress: int) -> None:
    job.stage = stage.value
    job.progress = progress
    document.status = stage.value
    record_operation(
        db,
        ingestion_job_id=job.id,
        kind="harness",
        operation=stage.value,
        status="running",
        context_json={"document_id": document.id, "filename": document.filename, "progress": progress},
    )
    db.commit()
    _check_cancel(db, job)


def _purge_chunks(db: Session, services: PipelineServices, kb: KnowledgeBase, document: Document) -> None:
    services.vector_store.delete_document(kb.collection_name, document.id)
    db.execute(delete(Chunk).where(Chunk.document_id == document.id))
    document.chunk_count = 0
    db.commit()


def _parse(
    db: Session, services: PipelineServices, job: IngestionJob, document: Document
) -> tuple[ParsedDocument, bytes, str]:
    data = services.storage.get(document.storage_key)
    if document.extension in LOCAL_EXTENSIONS:
        return parse_local(document.extension, data), data, document.mime_type
    if document.parse_strategy == "local" and document.extension in {"pdf", "doc", "docx"}:
        try:
            return parse_local_document(document.extension, data), data, document.mime_type
        except ParseError as exc:
            settings = get_settings()
            if not (settings.aliyun_docmind_access_key_id and settings.aliyun_docmind_access_key_secret):
                raise ParseError(f"{exc}；云端解析也未配置") from exc
            logger.info("文档 %s 本地解析失败，回退快速云端：%s", document.id, exc)
    parse_data = data
    parse_filename = document.filename
    parse_extension = document.extension
    enhancement_mime = document.mime_type
    if document.extension in {"webp", "tiff"}:
        from PIL import Image, UnidentifiedImageError
        try:
            with Image.open(io.BytesIO(data)) as image:
                output = io.BytesIO()
                image.save(output, format="PNG")
                parse_data = output.getvalue()
        except (UnidentifiedImageError, OSError) as exc:
            raise ParseError("无法读取图片并转换为 PNG，文件可能已损坏") from exc
        parse_filename = f"{Path(document.filename).stem}.png"
        parse_extension = "png"
        enhancement_mime = "image/png"
    parser = services.parser_factory()
    started = perf_counter()
    parsed = None
    outcome = "completed"
    error_message = None
    try:
        parsed = parser.parse(
            parse_data,
            parse_filename,
            parse_extension,
            should_cancel=lambda: _is_cancelled(db, job),
            llm_enhancement=document.parse_strategy == "smart",
        )
    except ParseCancelled as exc:
        outcome = "cancelled"
        error_message = str(exc)
        raise JobCancelled() from exc
    except BaseException as exc:
        outcome = "failed"
        error_message = str(exc)[:500]
        raise
    finally:
        record_operation(
            db,
            ingestion_job_id=job.id,
            kind="doc_parser",
            operation="docmind_smart" if document.parse_strategy == "smart" else "docmind_fast",
            status=outcome,
            input_json={"filename": parse_filename, "extension": parse_extension},
            output_json={"element_count": len(parsed.elements)} if parsed else None,
            context_json={"document_id": document.id, "llm_enhancement": document.parse_strategy == "smart"},
            latency_ms=round((perf_counter() - started) * 1000, 3),
            unit_count=1,
            unit_name="document",
            error_type="DocmindError" if error_message else None,
            error_message=error_message,
        )
        db.commit()
    return parsed, parse_data, enhancement_mime


def _is_cancelled(db: Session, job: IngestionJob) -> bool:
    try:
        _check_cancel(db, job)
    except JobCancelled:
        return True
    return False


def _enhance_images(
    db: Session,
    services: PipelineServices,
    document: Document,
    parsed: ParsedDocument,
    data: bytes,
    mime_type: str,
    warnings: list[str],
    trace: CallTrace,
) -> None:
    def describe(image: bytes, image_mime: str) -> str:
        return asyncio.run(trace_call(
            trace,
            target,
            "vision_description",
            lambda: asyncio.to_thread(services.describe, target, image, image_mime),
            input_text=IMAGE_PROMPT,
            output_text=lambda result: result,
            input_context={"prompt": IMAGE_PROMPT, "mime_type": image_mime, "image": "[二进制未记录]"},
        ))

    standalone = document.extension in IMAGE_EXTENSIONS
    embedded: list[tuple[Element, str | None, bytes | None, str | None]] = []
    for element in parsed.elements:
        source_url = element.extra.pop("source_url", None)
        image_data = element.extra.pop("image_data", None)
        image_mime = element.extra.pop("mime_type", None)
        if not standalone and element.kind == "image":
            embedded.append((element, source_url, image_data, image_mime))
    if not document.enhance_images:
        return
    target = _vision_target(db, services)
    if target is None:
        if standalone or embedded:
            warnings.append("未配置视觉模型，已跳过图片语义描述")
        return
    if standalone:
        try:
            description = describe(data, mime_type)
            parsed.elements.append(Element("image", text=f"图片描述：{description}", extra={"source": "vision"}))
        except KNOWN_ERRORS as exc:
            warnings.append(f"图片语义描述失败：{exc}")
        return
    for index, (element, source_url, image_data, image_mime) in enumerate(embedded, start=1):
        if image_data is None and not source_url:
            warnings.append(f"第 {index} 张内嵌图片缺少可获取的图片来源，未生成视觉描述")
            continue
        try:
            image, mime_type = (image_data, image_mime) if image_data is not None else services.fetch_image(source_url)
            description = describe(image, mime_type)
            parsed.elements.append(
                Element(
                    "image",
                    text=f"图片描述：{description}",
                    page=element.page,
                    extra={"source": "vision", **({"region": element.extra["region"]} if element.extra.get("region") else {})},
                )
            )
        except KNOWN_ERRORS as exc:
            warnings.append(f"第 {index} 张内嵌图片描述失败：{exc}")


def _metadata_target(db: Session, services: PipelineServices) -> ProbeTarget | None:
    default = db.get(ModelDefault, "routing_llm")
    model = db.get(ModelDefinition, default.model_id) if default and default.model_id else None
    if model and model.enabled and model.model_type == ModelType.LLM.value:
        return target_for(model, services.secret_box)
    return None


def _metadata_source(parsed: ParsedDocument) -> str:
    parts: list[str] = []
    for element in parsed.elements:
        if element.text.strip():
            parts.append(element.text.strip())
        if element.kind == "table":
            parts.extend([" | ".join(element.header), *(" | ".join(row) for row in element.rows)])
    return "\n".join(parts)


def _build_metadata(
    db: Session,
    services: PipelineServices,
    document: Document,
    parsed: ParsedDocument,
    warnings: list[str],
    trace: CallTrace,
) -> None:
    if document.metadata_status == "ready" and document.metadata_json:
        return
    if services.extract_metadata is None:
        document.metadata_status = "skipped"
        db.commit()
        return
    target = _metadata_target(db, services)
    if target is None:
        document.metadata_status = "skipped"
        document.metadata_error = "未配置路由 LLM，未构建元数据"
        warnings.append(document.metadata_error)
        db.commit()
        return
    document.metadata_status = "extracting"
    document.metadata_error = None
    db.commit()
    try:
        source = _metadata_source(parsed)
        metadata = normalize_metadata(asyncio.run(trace_call(
            trace,
            target,
            "document_metadata",
            lambda: asyncio.to_thread(services.extract_metadata, target, source),
            input_text=source,
            output_text=lambda result: json.dumps(result, ensure_ascii=False),
            input_context={"document_id": document.id, "text": source},
        )))
    except KNOWN_ERRORS as exc:
        document.metadata_status = "failed"
        document.metadata_json = empty_metadata()
        document.metadata_error = f"元数据构建失败：{exc}"[:500]
        warnings.append(document.metadata_error)
        db.commit()
        return
    document.metadata_json = metadata
    document.metadata_status = "ready"
    db.commit()


def _store_chunks(db: Session, kb: KnowledgeBase, document: Document, drafts: list[ChunkDraft]) -> list[Chunk]:
    chunks = [
        Chunk(
            id=str(uuid4()),
            knowledge_base_id=kb.id,
            document_id=document.id,
            position=position,
            kind=draft.kind,
            content=draft.content,
            content_hash=draft.content_hash,
            token_count=draft.token_count,
            location=draft.location,
        )
        for position, draft in enumerate(drafts)
    ]
    db.add_all(chunks)
    document.chunk_count = len(chunks)
    db.commit()
    return chunks


def _pipeline(db: Session, services: PipelineServices, job: IngestionJob, document: Document, kb: KnowledgeBase, trace: CallTrace) -> None:
    warnings: list[str] = []
    _purge_chunks(db, services, kb, document)

    _set_stage(db, job, document, DocumentStatus.PARSING, 5)
    parsed, data, mime_type = _parse(db, services, job, document)

    _set_stage(db, job, document, DocumentStatus.ENHANCING, 30)
    _enhance_images(db, services, document, parsed, data, mime_type, warnings, trace)

    _set_stage(db, job, document, DocumentStatus.METADATA, 35)
    _build_metadata(db, services, document, parsed, warnings, trace)

    _set_stage(db, job, document, DocumentStatus.CHUNKING, 40)
    semantic_embed = None
    if document.chunk_method == "semantic":
        target = target_for(kb.embedding_model, services.secret_box)
        def semantic_embed(texts: list[str]) -> list[list[float]]:
            return asyncio.run(trace_call(
                trace,
                target,
                "semantic_chunk_embedding",
                lambda: asyncio.to_thread(services.embed, target, texts, kb.vector_dimension),
                input_text="\n".join(texts),
                input_context={"texts": texts},
                output_text=lambda result: json.dumps({"vector_count": len(result.vectors), "usage": result.usage}, ensure_ascii=False),
            )).vectors
    drafts = chunk_document(
        parsed,
        document.chunk_size,
        document.chunk_overlap,
        document.chunk_method,
        document.heading_level,
        separators=document.separators or None,
        semantic_threshold=document.semantic_threshold,
        semantic_embed=semantic_embed,
    )
    if metadata_draft := metadata_chunk(document.metadata_json):
        drafts.append(metadata_draft)
    if not drafts:
        raise ParseError("未能从文件中切分出有效内容")
    chunks = _store_chunks(db, kb, document, drafts)

    _set_stage(db, job, document, DocumentStatus.EMBEDDING, 50)
    services.vector_store.ensure_collection(kb.collection_name, kb.vector_dimension)
    batch_size = EMBEDDING_BATCH_SIZES.get(kb.embedding_model.protocol, DEFAULT_EMBEDDING_BATCH)
    failures: list[str] = []
    for start in range(0, len(chunks), batch_size):
        batch = chunks[start : start + batch_size]
        try:
            _embed_chunks(services, kb.embedding_model, kb.vector_dimension, batch, kb.collection_name, trace)
            status = VectorStatus.INDEXED
        except KNOWN_ERRORS as exc:
            failures.append(str(exc))
            status = VectorStatus.FAILED
        for chunk in batch:
            chunk.vector_status = status.value
        db.commit()
        job.progress = 50 + int(45 * min(start + batch_size, len(chunks)) / len(chunks))
        db.commit()
        _check_cancel(db, job)

    failed = sum(1 for chunk in chunks if chunk.vector_status != VectorStatus.INDEXED.value)
    messages = [*warnings, *([f"{failed} 个分段向量化失败：{failures[0]}"] if failed else [])]
    job.progress = 100
    job.finished_at = utc_now()
    document.error_message = "；".join(messages)[:500] or None
    if failed == len(chunks):
        document.status, job.status = DocumentStatus.FAILED.value, JobStatus.FAILED.value
        job.error_message = document.error_message
    else:
        document.status = DocumentStatus.PARTIAL_FAILED.value if messages else DocumentStatus.READY.value
        job.status = JobStatus.SUCCEEDED.value
    job.stage = document.status
    db.commit()


def run_ingestion(job_id: str, session_factory: sessionmaker[Session], services: PipelineServices) -> None:
    with session_factory() as db:
        claimed = db.execute(
            update(IngestionJob)
            .where(IngestionJob.id == job_id, IngestionJob.status == JobStatus.QUEUED.value)
            .values(status=JobStatus.RUNNING.value, started_at=utc_now(), attempts=IngestionJob.attempts + 1)
        )
        db.commit()
        if claimed.rowcount != 1:
            return  # 任务不存在、已在运行或已结束
        job = db.get(IngestionJob, job_id)
        document = job.document
        kb = document.knowledge_base
        trace = CallTrace()
        error_type = None
        try:
            _pipeline(db, services, job, document, kb, trace)
        except JobCancelled as exc:
            error_type = type(exc).__name__
            _finish_cancelled(db, services, job, document, kb)
        except KNOWN_ERRORS as exc:
            error_type = type(exc).__name__
            _finish_failed(db, job, document, str(exc))
        except Exception as exc:
            error_type = type(exc).__name__
            logger.exception("导入任务 %s 发生未预期错误", job_id)
            _finish_failed(db, job, document, "处理过程中发生内部错误，请重试；若持续失败请查看服务日志")
        record_operation(
            db,
            ingestion_job_id=job.id,
            kind="harness",
            operation=job.stage,
            status=job.status,
            output_json={"progress": job.progress, "attempts": job.attempts},
            context_json={"document_id": document.id, "filename": document.filename},
            error_type=error_type,
            error_message=job.error_message,
        )
        persist_model_calls(db, None, trace, ingestion_job_id=job.id)
        db.commit()


def _finish_failed(db: Session, job: IngestionJob, document: Document, message: str) -> None:
    db.rollback()
    job.status, job.error_message, job.finished_at = JobStatus.FAILED.value, message[:500], utc_now()
    document.status, document.error_message = DocumentStatus.FAILED.value, message[:500]
    db.commit()


def _finish_cancelled(db: Session, services: PipelineServices, job: IngestionJob, document: Document, kb: KnowledgeBase) -> None:
    db.rollback()
    try:
        _purge_chunks(db, services, kb, document)
    except KNOWN_ERRORS:
        logger.warning("取消导入 %s 后清理向量失败", job.id)
        db.rollback()
    job.status, job.finished_at = JobStatus.CANCELLED.value, utc_now()
    document.status, document.error_message = DocumentStatus.CANCELLED.value, None
    db.commit()


def reindex_chunk(chunk_id: str, session_factory: sessionmaker[Session], services: PipelineServices) -> None:
    """分段内容被编辑后，仅重新向量化该分段。"""
    with session_factory() as db:
        chunk = db.get(Chunk, chunk_id)
        if chunk is None:
            return
        kb = db.get(KnowledgeBase, chunk.knowledge_base_id)
        trace = CallTrace()
        try:
            services.vector_store.ensure_collection(kb.collection_name, kb.vector_dimension)
            _embed_chunks(services, kb.embedding_model, kb.vector_dimension, [chunk], kb.collection_name, trace)
        except KNOWN_ERRORS:
            chunk.vector_status = VectorStatus.FAILED.value
            persist_model_calls(db, None, trace)
            db.commit()
            raise
        chunk.vector_status = VectorStatus.INDEXED.value
        persist_model_calls(db, None, trace)
        db.commit()


def rebuild_knowledge_base(
    knowledge_base_id: str, new_embedding_model_id: str, session_factory: sessionmaker[Session], services: PipelineServices
) -> None:
    """更换 embedding 模型：写入新 collection，全部成功后才切换并删除旧集合；失败时旧索引保持不变。"""
    with session_factory() as db:
        kb = db.get(KnowledgeBase, knowledge_base_id)
        model = db.get(ModelDefinition, new_embedding_model_id)
        if kb is None or model is None:
            return
        old_collection = kb.collection_name
        generation = int(old_collection.rsplit("_g", 1)[1]) + 1 if "_g" in old_collection else 2
        new_collection = collection_name(kb.id, generation)
        kb.status = KnowledgeBaseStatus.REBUILDING.value
        trace = CallTrace()
        db.commit()
        try:
            if not model.vector_dimension:
                raise ParseError("新的 embedding 模型未配置向量维度")
            services.vector_store.ensure_collection(new_collection, model.vector_dimension)
            batch_size = EMBEDDING_BATCH_SIZES.get(model.protocol, DEFAULT_EMBEDDING_BATCH)
            last_id = ""
            while True:  # 以 id 为游标分批，避免一次性载入整库
                batch = list(
                    db.scalars(
                        select(Chunk)
                        .where(Chunk.knowledge_base_id == kb.id, Chunk.id > last_id)
                        .order_by(Chunk.id)
                        .limit(batch_size)
                    )
                )
                if not batch:
                    break
                _embed_chunks(services, model, model.vector_dimension, batch, new_collection, trace)
                last_id = batch[-1].id
            db.execute(update(Chunk).where(Chunk.knowledge_base_id == kb.id).values(vector_status=VectorStatus.INDEXED.value))
        except Exception as exc:
            db.rollback()
            try:
                services.vector_store.delete_collection(new_collection)
            except KNOWN_ERRORS:
                logger.warning("重建失败后清理集合 %s 失败", new_collection)
            kb.status = KnowledgeBaseStatus.REBUILD_FAILED.value
            kb.rebuild_error = (str(exc) if isinstance(exc, KNOWN_ERRORS) else "重建过程中发生内部错误，请查看服务日志")[:500]
            persist_model_calls(db, None, trace)
            db.commit()
            if isinstance(exc, KNOWN_ERRORS):
                raise
            logger.exception("知识库 %s 重建失败", kb.id)
            raise
        kb.embedding_model_id, kb.vector_dimension = model.id, model.vector_dimension
        kb.collection_name, kb.status, kb.rebuild_error = new_collection, KnowledgeBaseStatus.READY.value, None
        persist_model_calls(db, None, trace)
        db.commit()
        try:
            services.vector_store.delete_collection(old_collection)
        except KNOWN_ERRORS:
            logger.warning("重建完成但旧集合 %s 删除失败，需手动清理", old_collection)


def purge_document(db: Session, services: PipelineServices, document: Document) -> None:
    services.vector_store.delete_document(document.knowledge_base.collection_name, document.id)
    services.storage.delete_prefix(f"knowledge-bases/{document.knowledge_base_id}/documents/{document.id}/")
    db.delete(document)
    db.commit()


def purge_knowledge_base(db: Session, services: PipelineServices, kb: KnowledgeBase) -> None:
    services.vector_store.delete_collection(kb.collection_name)
    services.storage.delete_prefix(f"knowledge-bases/{kb.id}/")
    db.delete(kb)
    db.commit()


def recover_stale_jobs(
    session_factory: sessionmaker[Session], dispatch: Callable[[str], Any], stale_after: timedelta
) -> list[str]:
    """重启或 worker 崩溃后，把长时间无进展的任务重新排队；已请求取消的直接结束。"""
    recovered: list[str] = []
    with session_factory() as db:
        stale = db.scalars(
            select(IngestionJob).where(
                IngestionJob.status.in_([JobStatus.QUEUED.value, JobStatus.RUNNING.value]),
                IngestionJob.updated_at < utc_now() - stale_after,
            )
        ).all()
        for job in stale:
            if job.cancel_requested:
                job.status, job.finished_at = JobStatus.CANCELLED.value, utc_now()
                job.document.status = DocumentStatus.CANCELLED.value
            else:
                job.status, job.stage = JobStatus.QUEUED.value, DocumentStatus.UPLOADED.value
                recovered.append(job.id)
        db.commit()
    for job_id in recovered:
        dispatch(job_id)
    return recovered
