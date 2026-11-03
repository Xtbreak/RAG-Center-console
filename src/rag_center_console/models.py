from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .chunking import DEFAULT_SEPARATORS
from .database import Base


def utc_now() -> datetime:
    return datetime.now(UTC)


class Role(StrEnum):
    ADMIN = "admin"
    MANAGER = "manager"
    USER = "user"


class ProviderHealth(StrEnum):
    UNTESTED = "untested"
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    ERROR = "error"


class ModelType(StrEnum):
    LLM = "llm"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    VISION = "vision"


class DocumentStatus(StrEnum):
    UPLOADED = "uploaded"
    PARSING = "parsing"
    ENHANCING = "enhancing"
    METADATA = "metadata"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    READY = "ready"
    PARTIAL_FAILED = "partial_failed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class VectorStatus(StrEnum):
    PENDING = "pending"
    INDEXED = "indexed"
    FAILED = "failed"


class KnowledgeBaseStatus(StrEnum):
    READY = "ready"
    REBUILDING = "rebuilding"
    REBUILD_FAILED = "rebuild_failed"


class AnonymousSession(Base):
    __tablename__ = "anonymous_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    role: Mapped[str] = mapped_column(String(20), default=Role.ADMIN.value)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    conversations: Mapped[list["Conversation"]] = relationship(
        back_populates="anonymous_session", cascade="all, delete-orphan"
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    anonymous_session_id: Mapped[str] = mapped_column(
        ForeignKey("anonymous_sessions.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(120), default="新对话")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    anonymous_session: Mapped[AnonymousSession] = relationship(back_populates="conversations")
    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="ChatMessage.created_at"
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    citations: Mapped[list[dict]] = mapped_column(JSON, default=list)
    route: Mapped[list[dict]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="completed")
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class Provider(Base):
    __tablename__ = "providers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    preset_id: Mapped[str] = mapped_column(String(50), index=True)
    name: Mapped[str] = mapped_column(String(120))
    base_url: Mapped[str] = mapped_column(String(500))
    api_key_encrypted: Mapped[str] = mapped_column(Text)
    api_key_last4: Mapped[str] = mapped_column(String(4))
    default_protocol: Mapped[str] = mapped_column(String(60))
    health: Mapped[str] = mapped_column(String(20), default=ProviderHealth.UNTESTED.value)
    last_latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    models: Mapped[list["ModelDefinition"]] = relationship(
        back_populates="provider", cascade="all, delete-orphan"
    )


class ModelDefinition(Base):
    __tablename__ = "model_definitions"
    __table_args__ = (UniqueConstraint("provider_id", "model_id", "model_type"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    provider_id: Mapped[str] = mapped_column(ForeignKey("providers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    model_id: Mapped[str] = mapped_column(String(200))
    model_type: Mapped[str] = mapped_column(String(20))
    protocol: Mapped[str] = mapped_column(String(60))
    context_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    vector_dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timeout_seconds: Mapped[float] = mapped_column(Float, default=30.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    provider: Mapped[Provider] = relationship(back_populates="models")


class ModelDefault(Base):
    __tablename__ = "model_defaults"

    purpose: Mapped[str] = mapped_column(String(40), primary_key=True)
    model_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_definitions.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    sample_questions: Mapped[list[str]] = mapped_column(JSON, default=list)
    embedding_model_id: Mapped[str] = mapped_column(
        ForeignKey("model_definitions.id", ondelete="RESTRICT"), index=True
    )
    vector_dimension: Mapped[int] = mapped_column(Integer)
    collection_name: Mapped[str] = mapped_column(String(80), unique=True)
    chunk_size: Mapped[int] = mapped_column(Integer, default=800)
    chunk_overlap: Mapped[int] = mapped_column(Integer, default=120)
    chunk_method: Mapped[str] = mapped_column(String(20), default="heading")
    heading_level: Mapped[int] = mapped_column(Integer, default=6)
    separators: Mapped[list[str]] = mapped_column(JSON, default=lambda: list(DEFAULT_SEPARATORS[:-1]))
    semantic_threshold: Mapped[float] = mapped_column(Float, default=0.75)
    status: Mapped[str] = mapped_column(String(20), default=KnowledgeBaseStatus.READY.value)
    rebuild_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    embedding_model: Mapped[ModelDefinition] = relationship()
    documents: Mapped[list["Document"]] = relationship(
        back_populates="knowledge_base", cascade="all, delete-orphan"
    )
    route_index: Mapped["KnowledgeBaseRouteIndex | None"] = relationship(
        back_populates="knowledge_base", cascade="all, delete-orphan", uselist=False
    )


class KnowledgeBaseRouteIndex(Base):
    """独立于文档向量集合的知识库路由索引。"""

    __tablename__ = "knowledge_base_route_indexes"

    knowledge_base_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), primary_key=True
    )
    model_id: Mapped[str] = mapped_column(ForeignKey("model_definitions.id", ondelete="CASCADE"), index=True)
    profile_hash: Mapped[str] = mapped_column(String(64))
    profile_text: Mapped[str] = mapped_column(Text)
    vector: Mapped[list[float]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    knowledge_base: Mapped[KnowledgeBase] = relationship(back_populates="route_index")
    model: Mapped[ModelDefinition] = relationship()


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (Index("ix_documents_knowledge_base_id_sha256", "knowledge_base_id", "sha256"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    knowledge_base_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    extension: Mapped[str] = mapped_column(String(10))
    mime_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default=DocumentStatus.UPLOADED.value)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    parse_strategy: Mapped[str] = mapped_column(String(20), default="smart")
    enhance_images: Mapped[bool] = mapped_column(Boolean, default=True)
    # 导入时的切分设置快照；重新处理沿用这些设置，不受知识库默认值后续修改的影响
    chunk_method: Mapped[str] = mapped_column(String(20), default="heading")
    chunk_size: Mapped[int] = mapped_column(Integer, default=800)
    chunk_overlap: Mapped[int] = mapped_column(Integer, default=120)
    heading_level: Mapped[int] = mapped_column(Integer, default=6)
    separators: Mapped[list[str]] = mapped_column(JSON, default=lambda: list(DEFAULT_SEPARATORS[:-1]))
    semantic_threshold: Mapped[float] = mapped_column(Float, default=0.75)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    metadata_status: Mapped[str] = mapped_column(String(20), default="pending")
    metadata_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    knowledge_base: Mapped[KnowledgeBase] = relationship(back_populates="documents")
    jobs: Mapped[list["IngestionJob"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="IngestionJob.created_at"
    )
    chunks: Mapped[list["Chunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="Chunk.position"
    )


class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default=JobStatus.QUEUED.value)
    stage: Mapped[str] = mapped_column(String(20), default=DocumentStatus.UPLOADED.value)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    celery_task_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    document: Mapped[Document] = relationship(back_populates="jobs")


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (UniqueConstraint("document_id", "position"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    knowledge_base_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20), default="text")
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    location: Mapped[dict] = mapped_column(JSON, default=dict)
    vector_status: Mapped[str] = mapped_column(String(20), default=VectorStatus.PENDING.value)
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    document: Mapped[Document] = relationship(back_populates="chunks")


class QueryLog(Base):
    __tablename__ = "query_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    anonymous_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("anonymous_sessions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agent_apps.id", ondelete="SET NULL"), nullable=True, index=True)
    agent_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text, default="")
    citations: Mapped[list[dict]] = mapped_column(JSON, default=list)
    route_candidates: Mapped[list[dict]] = mapped_column(JSON, default=list)
    route: Mapped[list[dict]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="running", index=True)
    grounded: Mapped[bool] = mapped_column(Boolean, default=False)
    route_ms: Mapped[float] = mapped_column(Float, default=0.0)
    retrieval_ms: Mapped[float] = mapped_column(Float, default=0.0)
    rerank_ms: Mapped[float] = mapped_column(Float, default=0.0)
    first_token_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    error_type: Mapped[str | None] = mapped_column(String(60), nullable=True)
    failed_stage: Mapped[str | None] = mapped_column(String(40), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    model_calls: Mapped[list["ModelCallLog"]] = relationship(
        back_populates="query_log", cascade="all, delete-orphan", order_by="ModelCallLog.created_at"
    )


class ModelCallLog(Base):
    __tablename__ = "model_call_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    query_log_id: Mapped[str | None] = mapped_column(ForeignKey("query_logs.id", ondelete="CASCADE"), nullable=True, index=True)
    ingestion_job_id: Mapped[str | None] = mapped_column(ForeignKey("ingestion_jobs.id", ondelete="SET NULL"), nullable=True, index=True)
    provider_id: Mapped[str] = mapped_column(String(36))
    provider: Mapped[str] = mapped_column(String(120))
    model_id: Mapped[str] = mapped_column(String(200))
    protocol: Mapped[str] = mapped_column(String(60))
    purpose: Mapped[str] = mapped_column(String(40))
    input_context: Mapped[object] = mapped_column(JSON, nullable=True)
    output_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    estimated: Mapped[bool] = mapped_column(Boolean, default=False)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    input_price_per_million: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    output_price_per_million: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="completed")
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    query_log: Mapped[QueryLog | None] = relationship(back_populates="model_calls")


class OperationLog(Base):
    __tablename__ = "operation_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    query_log_id: Mapped[str | None] = mapped_column(ForeignKey("query_logs.id", ondelete="CASCADE"), nullable=True, index=True)
    ingestion_job_id: Mapped[str | None] = mapped_column(ForeignKey("ingestion_jobs.id", ondelete="SET NULL"), nullable=True, index=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agent_apps.id", ondelete="SET NULL"), nullable=True, index=True)
    tool_id: Mapped[str | None] = mapped_column(ForeignKey("tool_definitions.id", ondelete="SET NULL"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    operation: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), index=True)
    input_json: Mapped[object] = mapped_column(JSON, nullable=True)
    output_json: Mapped[object] = mapped_column(JSON, nullable=True)
    context_json: Mapped[object] = mapped_column(JSON, nullable=True)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    unit_count: Mapped[float] = mapped_column(Float, default=0.0)
    unit_name: Mapped[str | None] = mapped_column(String(30), nullable=True)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 8), nullable=True)
    error_type: Mapped[str | None] = mapped_column(String(60), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)


class ModelPrice(Base):
    __tablename__ = "model_prices"

    model_id: Mapped[str] = mapped_column(ForeignKey("model_definitions.id", ondelete="CASCADE"), primary_key=True)
    input_price_per_million: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    output_price_per_million: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict | int | str | bool] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class AgentApp(Base):
    __tablename__ = "agent_apps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(20), default="simple")
    prompt: Mapped[str] = mapped_column(Text, default="")
    opening: Mapped[str] = mapped_column(Text, default="")
    suggestions: Mapped[list[str]] = mapped_column(JSON, default=list)
    knowledge_base_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    tool_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    flow: Mapped[dict] = mapped_column(JSON, default=dict)
    published: Mapped[bool] = mapped_column(Boolean, default=False)
    theme_color: Mapped[str] = mapped_column(String(20), default="#3370ff")
    show_citations: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_images: Mapped[bool] = mapped_column(Boolean, default=False)
    access_limit_per_minute: Mapped[int] = mapped_column(Integer, default=20)
    allowed_domains: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class ToolDefinition(Base):
    __tablename__ = "tool_definitions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120), unique=True)
    kind: Mapped[str] = mapped_column(String(20), default="http")
    description: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(1000))
    method: Mapped[str] = mapped_column(String(10), default="GET")
    headers_encrypted: Mapped[str] = mapped_column(Text, default="")
    timeout_seconds: Mapped[float] = mapped_column(Float, default=10.0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(120))
    prefix: Mapped[str] = mapped_column(String(20), unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64))
    quota_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class EvaluationCase(Base):
    __tablename__ = "evaluation_cases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    kind: Mapped[str] = mapped_column(String(10), index=True)
    question: Mapped[str] = mapped_column(Text)
    expected_answer: Mapped[str] = mapped_column(Text, default="")
    actual_answer: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agent_apps.id", ondelete="SET NULL"), nullable=True, index=True)
    source_query_id: Mapped[str | None] = mapped_column(ForeignKey("query_logs.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
