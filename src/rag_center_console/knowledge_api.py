import hashlib
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import tasks
from .auth import get_current_role, require_knowledge_manager
from .chunking import estimate_tokens
from .config import get_settings
from .database import get_db
from .ingestion import KNOWN_ERRORS, PipelineServices, default_services, purge_document, purge_knowledge_base
from .models import (
    Chunk,
    Document,
    DocumentStatus,
    IngestionJob,
    JobStatus,
    KnowledgeBase,
    KnowledgeBaseStatus,
    ModelDefinition,
    ModelType,
    VectorStatus,
)
from .parsing import CLOUD_EXTENSIONS
from .schemas import (
    ChunkPage,
    ChunkRead,
    ChunkUpdate,
    DocumentRead,
    KnowledgeBaseCreate,
    KnowledgeBaseRead,
    KnowledgeBaseUpdate,
)
from .security import SecretConfigurationError
from .storage import StorageError, document_storage_key, get_storage
from .uploads import UploadRejected, find_duplicate_documents, spool_upload
from .vectorstore import VectorStoreError, collection_name

router = APIRouter()
ACTIVE_JOB_STATUSES = (JobStatus.QUEUED.value, JobStatus.RUNNING.value)
QUEUE_UNAVAILABLE = "任务队列不可用，请确认 Redis 和 Worker 已启动后重试"


def get_pipeline_services() -> PipelineServices:
    try:
        return default_services()
    except SecretConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _knowledge_base_or_404(db: Session, knowledge_base_id: str) -> KnowledgeBase:
    kb = db.get(KnowledgeBase, knowledge_base_id)
    if kb is None:
        raise HTTPException(status_code=404, detail="知识库不存在")
    return kb


def _document_or_404(db: Session, document_id: str) -> Document:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="文档不存在")
    return document


def _embedding_model(db: Session, model_id: str) -> ModelDefinition:
    model = db.get(ModelDefinition, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Embedding 模型不存在")
    if model.model_type != ModelType.EMBEDDING.value:
        raise HTTPException(status_code=422, detail="所选模型不是 Embedding 模型")
    if not model.enabled:
        raise HTTPException(status_code=422, detail="所选 Embedding 模型已停用")
    if not model.vector_dimension:
        raise HTTPException(status_code=422, detail="所选 Embedding 模型未配置向量维度")
    return model


def _latest_job(document: Document) -> IngestionJob | None:
    return document.jobs[-1] if document.jobs else None


def _is_processing(document: Document) -> bool:
    job = _latest_job(document)
    return job is not None and job.status in ACTIVE_JOB_STATUSES


def _ensure_not_rebuilding(kb: KnowledgeBase) -> None:
    if kb.status == KnowledgeBaseStatus.REBUILDING.value:
        raise HTTPException(status_code=409, detail="知识库正在重建向量索引，请稍后再试")


def _has_processing_documents(db: Session, knowledge_base_id: str) -> bool:
    return bool(
        db.scalar(
            select(func.count(IngestionJob.id))
            .join(Document, Document.id == IngestionJob.document_id)
            .where(Document.knowledge_base_id == knowledge_base_id, IngestionJob.status.in_(ACTIVE_JOB_STATUSES))
        )
    )


def _knowledge_base_reads(db: Session, bases: list[KnowledgeBase]) -> list[KnowledgeBaseRead]:
    ids = [kb.id for kb in bases]
    documents = dict(
        db.execute(
            select(Document.knowledge_base_id, func.count(Document.id))
            .where(Document.knowledge_base_id.in_(ids))
            .group_by(Document.knowledge_base_id)
        ).all()
    )
    ready = dict(
        db.execute(
            select(Document.knowledge_base_id, func.count(Document.id))
            .where(
                Document.knowledge_base_id.in_(ids),
                Document.status.in_([DocumentStatus.READY.value, DocumentStatus.PARTIAL_FAILED.value]),
            )
            .group_by(Document.knowledge_base_id)
        ).all()
    )
    chunks = dict(
        db.execute(
            select(Chunk.knowledge_base_id, func.count(Chunk.id))
            .where(Chunk.knowledge_base_id.in_(ids))
            .group_by(Chunk.knowledge_base_id)
        ).all()
    )
    return [
        KnowledgeBaseRead(
            id=kb.id,
            name=kb.name,
            description=kb.description,
            embedding_model_id=kb.embedding_model_id,
            embedding_model_name=kb.embedding_model.name,
            vector_dimension=kb.vector_dimension,
            chunk_size=kb.chunk_size,
            chunk_overlap=kb.chunk_overlap,
            status=kb.status,
            document_count=documents.get(kb.id, 0),
            ready_document_count=ready.get(kb.id, 0),
            chunk_count=chunks.get(kb.id, 0),
            created_at=kb.created_at,
            updated_at=kb.updated_at,
        )
        for kb in bases
    ]


def _document_read(document: Document) -> DocumentRead:
    job = _latest_job(document)
    return DocumentRead(
        id=document.id,
        knowledge_base_id=document.knowledge_base_id,
        filename=document.filename,
        extension=document.extension,
        mime_type=document.mime_type,
        size_bytes=document.size_bytes,
        sha256=document.sha256,
        status=document.status,
        error_message=document.error_message,
        parse_strategy=document.parse_strategy,
        enhance_images=document.enhance_images,
        chunk_count=document.chunk_count,
        job_id=job.id if job else None,
        job_status=job.status if job else None,
        job_stage=job.stage if job else None,
        job_progress=job.progress if job else 0,
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


def _dispatch(db: Session, job: IngestionJob, document: Document) -> None:
    """投递导入任务；队列不可用时把文档标记为失败，保留重试入口而不是丢失上传结果。"""
    try:
        job.celery_task_id = tasks.enqueue_ingestion(job.id)
    except Exception:
        job.status, job.error_message = JobStatus.FAILED.value, QUEUE_UNAVAILABLE
        document.status, document.error_message = DocumentStatus.FAILED.value, QUEUE_UNAVAILABLE
    db.commit()


@router.get("/knowledge-bases", response_model=list[KnowledgeBaseRead])
def list_knowledge_bases(_=Depends(get_current_role), db: Session = Depends(get_db)) -> list[KnowledgeBaseRead]:
    bases = list(db.scalars(select(KnowledgeBase).order_by(KnowledgeBase.created_at)).all())
    return _knowledge_base_reads(db, bases)


@router.post("/knowledge-bases", response_model=KnowledgeBaseRead, status_code=status.HTTP_201_CREATED)
def create_knowledge_base(
    payload: KnowledgeBaseCreate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)
) -> KnowledgeBaseRead:
    model = _embedding_model(db, payload.embedding_model_id)
    knowledge_base_id = str(uuid4())
    kb = KnowledgeBase(
        id=knowledge_base_id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        embedding_model_id=model.id,
        vector_dimension=model.vector_dimension,
        collection_name=collection_name(knowledge_base_id),
        chunk_size=payload.chunk_size,
        chunk_overlap=payload.chunk_overlap,
    )
    db.add(kb)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名知识库") from exc
    db.refresh(kb)
    return _knowledge_base_reads(db, [kb])[0]


@router.get("/knowledge-bases/{knowledge_base_id}", response_model=KnowledgeBaseRead)
def get_knowledge_base(
    knowledge_base_id: str, _=Depends(get_current_role), db: Session = Depends(get_db)
) -> KnowledgeBaseRead:
    return _knowledge_base_reads(db, [_knowledge_base_or_404(db, knowledge_base_id)])[0]


@router.patch("/knowledge-bases/{knowledge_base_id}", response_model=KnowledgeBaseRead)
def update_knowledge_base(
    knowledge_base_id: str,
    payload: KnowledgeBaseUpdate,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
    services: PipelineServices = Depends(get_pipeline_services),
) -> KnowledgeBaseRead:
    kb = _knowledge_base_or_404(db, knowledge_base_id)
    _ensure_not_rebuilding(kb)
    changes = payload.model_dump(exclude_unset=True)
    size = changes.get("chunk_size", kb.chunk_size)
    overlap = changes.get("chunk_overlap", kb.chunk_overlap)
    if overlap >= size:
        raise HTTPException(status_code=422, detail="分段重叠必须小于分段长度")
    new_model_id = changes.pop("embedding_model_id", None)
    for key, value in changes.items():
        setattr(kb, key, value.strip() if isinstance(value, str) else value)

    rebuild_to: str | None = None
    if new_model_id and new_model_id != kb.embedding_model_id:
        model = _embedding_model(db, new_model_id)
        if _has_processing_documents(db, kb.id):
            raise HTTPException(status_code=409, detail="仍有文档在处理中，请等待完成或取消后再更换 Embedding 模型")
        has_chunks = bool(db.scalar(select(func.count(Chunk.id)).where(Chunk.knowledge_base_id == kb.id)))
        if has_chunks:
            kb.status = KnowledgeBaseStatus.REBUILDING.value
            rebuild_to = model.id
        else:
            # 空知识库无需重建：删除旧集合，下一次导入按新维度创建
            try:
                services.vector_store.delete_collection(kb.collection_name)
            except VectorStoreError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            kb.embedding_model_id, kb.vector_dimension = model.id, model.vector_dimension
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名知识库") from exc
    if rebuild_to:
        try:
            tasks.enqueue_rebuild(kb.id, rebuild_to)
        except Exception as exc:
            kb.status = KnowledgeBaseStatus.READY.value
            db.commit()
            raise HTTPException(status_code=503, detail=QUEUE_UNAVAILABLE) from exc
    db.refresh(kb)
    return _knowledge_base_reads(db, [kb])[0]


@router.delete("/knowledge-bases/{knowledge_base_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_knowledge_base(
    knowledge_base_id: str,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
    services: PipelineServices = Depends(get_pipeline_services),
) -> Response:
    kb = _knowledge_base_or_404(db, knowledge_base_id)
    _ensure_not_rebuilding(kb)
    if _has_processing_documents(db, kb.id):
        raise HTTPException(status_code=409, detail="仍有文档在处理中，请等待完成或取消后再删除")
    try:
        purge_knowledge_base(db, services, kb)
    except KNOWN_ERRORS as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/knowledge-bases/{knowledge_base_id}/documents", response_model=list[DocumentRead])
def list_documents(
    knowledge_base_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)
) -> list[DocumentRead]:
    _knowledge_base_or_404(db, knowledge_base_id)
    documents = db.scalars(
        select(Document).where(Document.knowledge_base_id == knowledge_base_id).order_by(Document.created_at.desc())
    ).all()
    return [_document_read(document) for document in documents]


@router.post(
    "/knowledge-bases/{knowledge_base_id}/documents",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
)
def upload_document(
    knowledge_base_id: str,
    file: UploadFile = File(...),
    parse_strategy: Literal["smart", "fast"] = Form("smart"),
    enhance_images: bool = Form(True),
    allow_duplicate: bool = Form(False),
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
) -> DocumentRead:
    kb = _knowledge_base_or_404(db, knowledge_base_id)
    _ensure_not_rebuilding(kb)
    settings = get_settings()
    try:
        upload = spool_upload(file.filename, file.content_type, file.file, settings.max_upload_bytes)
    except UploadRejected as exc:
        code = 413 if "上限" in str(exc) else 422
        raise HTTPException(status_code=code, detail=str(exc)) from exc
    try:
        if upload.extension in CLOUD_EXTENSIONS and not (
            settings.aliyun_docmind_access_key_id and settings.aliyun_docmind_access_key_secret
        ):
            raise HTTPException(
                status_code=422,
                detail="尚未配置阿里云文档智能 AccessKey，暂不能导入 PDF、Word 和图片；Markdown、CSV、Excel 可正常导入",
            )
        duplicates = find_duplicate_documents(db, kb.id, upload.sha256)
        if duplicates and not allow_duplicate:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"知识库中已有相同内容的文件：{duplicates[0].filename}",
                    "duplicates": [
                        {"id": d.id, "filename": d.filename, "created_at": d.created_at.isoformat()} for d in duplicates
                    ],
                },
            )
        document_id = str(uuid4())
        storage_key = document_storage_key(kb.id, document_id, upload.extension)
        try:
            get_storage().put(storage_key, upload.file, upload.mime_type)
        except StorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        upload.close()

    document = Document(
        id=document_id,
        knowledge_base_id=kb.id,
        filename=upload.filename,
        extension=upload.extension,
        mime_type=upload.mime_type,
        size_bytes=upload.size_bytes,
        sha256=upload.sha256,
        storage_key=storage_key,
        parse_strategy=parse_strategy,
        enhance_images=enhance_images,
    )
    job = IngestionJob()
    document.jobs.append(job)
    db.add(document)
    db.commit()
    _dispatch(db, job, document)
    db.refresh(document)
    return _document_read(document)


@router.get("/documents/{document_id}", response_model=DocumentRead)
def get_document(document_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> DocumentRead:
    return _document_read(_document_or_404(db, document_id))


@router.post("/documents/{document_id}/retry", response_model=DocumentRead)
def retry_document(document_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> DocumentRead:
    document = _document_or_404(db, document_id)
    _ensure_not_rebuilding(document.knowledge_base)
    if _is_processing(document):
        raise HTTPException(status_code=409, detail="文档正在处理中")
    job = IngestionJob()
    document.jobs.append(job)
    document.status, document.error_message = DocumentStatus.UPLOADED.value, None
    db.commit()
    _dispatch(db, job, document)
    db.refresh(document)
    return _document_read(document)


@router.post("/documents/{document_id}/cancel", response_model=DocumentRead)
def cancel_document(document_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> DocumentRead:
    document = _document_or_404(db, document_id)
    job = _latest_job(document)
    if job is None or job.status not in ACTIVE_JOB_STATUSES:
        raise HTTPException(status_code=409, detail="文档当前没有进行中的处理任务")
    # 尚未被 Worker 领取的任务直接结束；运行中的任务由 Worker 在阶段检查点响应取消
    cancelled_queued = db.execute(
        update(IngestionJob)
        .where(IngestionJob.id == job.id, IngestionJob.status == JobStatus.QUEUED.value)
        .values(status=JobStatus.CANCELLED.value, cancel_requested=True)
    ).rowcount
    if cancelled_queued:
        document.status = DocumentStatus.CANCELLED.value
    else:
        job.cancel_requested = True
    db.commit()
    db.refresh(document)
    db.refresh(job)
    return _document_read(document)


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: str,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
    services: PipelineServices = Depends(get_pipeline_services),
) -> Response:
    document = _document_or_404(db, document_id)
    _ensure_not_rebuilding(document.knowledge_base)
    if _is_processing(document):
        raise HTTPException(status_code=409, detail="文档正在处理中，请先取消")
    try:
        purge_document(db, services, document)
    except KNOWN_ERRORS as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/knowledge-bases/{knowledge_base_id}/chunks", response_model=ChunkPage)
def list_chunks(
    knowledge_base_id: str,
    document_id: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 20,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
) -> ChunkPage:
    _knowledge_base_or_404(db, knowledge_base_id)
    conditions = [Chunk.knowledge_base_id == knowledge_base_id]
    if document_id:
        conditions.append(Chunk.document_id == document_id)
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        conditions.append(Chunk.content.ilike(pattern))
    total = db.scalar(select(func.count(Chunk.id)).where(*conditions)) or 0
    items = db.scalars(
        select(Chunk)
        .where(*conditions)
        .order_by(Chunk.document_id, Chunk.position)
        .offset(max(offset, 0))
        .limit(min(max(limit, 1), 100))
    ).all()
    return ChunkPage(items=[ChunkRead.model_validate(item) for item in items], total=total)


@router.patch("/chunks/{chunk_id}", response_model=ChunkRead)
def update_chunk(
    chunk_id: str, payload: ChunkUpdate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)
) -> ChunkRead:
    chunk = db.get(Chunk, chunk_id)
    if chunk is None:
        raise HTTPException(status_code=404, detail="分段不存在")
    _ensure_not_rebuilding(db.get(KnowledgeBase, chunk.knowledge_base_id))
    if _is_processing(chunk.document):
        raise HTTPException(status_code=409, detail="文档正在处理中，暂不能编辑分段")
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="分段内容不能为空")
    chunk.content = content
    chunk.content_hash = hashlib.sha256(content.encode()).hexdigest()
    chunk.token_count = estimate_tokens(content)
    chunk.edited = True
    chunk.vector_status = VectorStatus.PENDING.value
    db.commit()
    try:
        tasks.enqueue_chunk_reindex(chunk.id)
    except Exception:
        chunk.vector_status = VectorStatus.FAILED.value
        db.commit()
    db.refresh(chunk)
    return ChunkRead.model_validate(chunk)
