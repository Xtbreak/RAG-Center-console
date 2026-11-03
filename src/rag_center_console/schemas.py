from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, model_validator

from .chunking import DEFAULT_SEPARATORS, normalize_separators
from .models import ModelType, ProviderHealth, Role


ProtocolName = Literal[
    "OpenAI Chat Completions",
    "OpenAI Responses",
    "OpenAI Embeddings",
    "DashScope Text Embeddings",
    "DashScope Multimodal Embeddings",
    "Anthropic Messages",
    "Cohere Rerank",
    "DashScope Rerank",
]


class SessionRoleUpdate(BaseModel):
    role: Role


class SessionRead(BaseModel):
    id: str
    role: Role


class ProviderCreate(BaseModel):
    preset_id: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=120)
    base_url: HttpUrl
    api_key: SecretStr
    default_protocol: ProtocolName


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    base_url: HttpUrl | None = None
    api_key: SecretStr | None = None
    default_protocol: ProtocolName | None = None


class ProviderRead(BaseModel):
    id: str
    preset_id: str
    name: str
    base_url: str
    api_key_masked: str
    default_protocol: str
    health: ProviderHealth
    model_count: int
    last_latency_ms: float | None
    last_error: str | None
    last_checked_at: datetime | None


class ModelDiscoveryRequest(BaseModel):
    provider_id: str | None = None
    preset_id: str | None = Field(default=None, min_length=1, max_length=50)
    base_url: HttpUrl | None = None
    api_key: SecretStr | None = None
    protocol: ProtocolName | None = None

    @model_validator(mode="after")
    def validate_discovery_source(self) -> "ModelDiscoveryRequest":
        if self.provider_id:
            return self
        api_key = self.api_key.get_secret_value().strip() if self.api_key else ""
        if self.base_url is None or self.protocol is None or not api_key:
            raise ValueError("新供应商获取模型时必须填写 Base URL、API Key 和协议")
        return self


class DiscoveredModel(BaseModel):
    id: str
    name: str
    model_type: ModelType
    type_confidence: Literal["high", "medium", "low"]
    vector_dimension: int | None = None


class ModelDiscoveryResponse(BaseModel):
    models: list[DiscoveredModel]
    truncated: bool = False


class ModelCreate(BaseModel):
    provider_id: str
    name: str = Field(min_length=1, max_length=120)
    model_id: str = Field(min_length=1, max_length=200)
    model_type: ModelType
    protocol: ProtocolName
    context_length: int | None = Field(default=None, gt=0)
    vector_dimension: int | None = Field(default=None, gt=0)
    timeout_seconds: float = Field(default=30.0, gt=0, le=300)
    enabled: bool = True

    @model_validator(mode="after")
    def validate_vector_dimension(self) -> "ModelCreate":
        if self.model_type == ModelType.EMBEDDING and self.vector_dimension is None:
            raise ValueError("Embedding 模型必须填写向量维度")
        return self


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    model_id: str | None = Field(default=None, min_length=1, max_length=200)
    model_type: ModelType | None = None
    protocol: ProtocolName | None = None
    context_length: int | None = Field(default=None, gt=0)
    vector_dimension: int | None = Field(default=None, gt=0)
    timeout_seconds: float | None = Field(default=None, gt=0, le=300)
    enabled: bool | None = None


class ModelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider_id: str
    name: str
    model_id: str
    model_type: ModelType
    protocol: str
    context_length: int | None
    vector_dimension: int | None
    timeout_seconds: float
    enabled: bool


class HealthCheckRead(BaseModel):
    provider_id: str
    model_id: str
    status: ProviderHealth
    latency_ms: float
    protocol: str
    checks: dict[str, bool]
    usage: dict[str, int | float] | None = None
    message: str


class ModelDefaultsUpdate(BaseModel):
    routing_embedding: str | None = None
    routing_llm: str | None = None
    default_rerank: str | None = None
    vision: str | None = None


class ModelDefaultsRead(ModelDefaultsUpdate):
    pass


ChunkMethodName = Literal["heading", "fixed", "recursive", "semantic"]


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    sample_questions: list[str] = Field(default_factory=list, max_length=20)
    embedding_model_id: str
    chunk_size: int = Field(default=800, ge=100, le=4000)
    chunk_overlap: int = Field(default=120, ge=0, le=1000)
    chunk_method: ChunkMethodName = "heading"
    heading_level: int = Field(default=6, ge=1, le=6)
    separators: list[str] = Field(default_factory=lambda: list(DEFAULT_SEPARATORS[:-1]), max_length=20)
    semantic_threshold: float = Field(default=0.75, gt=0, lt=1)

    @model_validator(mode="after")
    def overlap_smaller_than_size(self):
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("分段重叠必须小于分段长度")
        if not self.separators:
            raise ValueError("递归切分至少需要一个分隔符")
        self.separators = list(normalize_separators(self.separators)[:-1])
        self.tags = _clean_route_texts(self.tags, 50, "标签")
        self.sample_questions = _clean_route_texts(self.sample_questions, 300, "示例问题")
        return self


class KnowledgeBaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    tags: list[str] | None = Field(default=None, max_length=20)
    sample_questions: list[str] | None = Field(default=None, max_length=20)
    embedding_model_id: str | None = None
    chunk_size: int | None = Field(default=None, ge=100, le=4000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=1000)
    chunk_method: ChunkMethodName | None = None
    heading_level: int | None = Field(default=None, ge=1, le=6)
    separators: list[str] | None = Field(default=None, max_length=20)
    semantic_threshold: float | None = Field(default=None, gt=0, lt=1)

    @model_validator(mode="after")
    def clean_route_fields(self):
        if self.separators is not None:
            if not self.separators:
                raise ValueError("递归切分至少需要一个分隔符")
            self.separators = list(normalize_separators(self.separators)[:-1])
        if self.tags is not None:
            self.tags = _clean_route_texts(self.tags, 50, "标签")
        if self.sample_questions is not None:
            self.sample_questions = _clean_route_texts(self.sample_questions, 300, "示例问题")
        return self


class KnowledgeBaseRead(BaseModel):
    id: str
    name: str
    description: str
    tags: list[str]
    sample_questions: list[str]
    embedding_model_id: str
    embedding_model_name: str
    vector_dimension: int
    chunk_size: int
    chunk_overlap: int
    chunk_method: str
    heading_level: int
    separators: list[str]
    semantic_threshold: float
    status: str
    rebuild_error: str | None
    document_count: int
    ready_document_count: int
    processing_document_count: int
    chunk_count: int
    created_at: datetime
    updated_at: datetime


class DocumentRead(BaseModel):
    id: str
    knowledge_base_id: str
    filename: str
    extension: str
    mime_type: str
    size_bytes: int
    sha256: str
    status: str
    error_message: str | None
    parse_strategy: str
    enhance_images: bool
    chunk_method: str
    chunk_size: int
    chunk_overlap: int
    heading_level: int
    separators: list[str]
    semantic_threshold: float
    metadata: dict[str, list[str]]
    metadata_status: str
    metadata_error: str | None
    chunk_count: int
    job_id: str | None
    job_status: str | None
    job_stage: str | None
    job_progress: int
    cancel_requested: bool
    created_at: datetime
    updated_at: datetime


class DuplicateDocument(BaseModel):
    id: str
    filename: str
    created_at: datetime


class ChunkRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    document_id: str
    position: int
    kind: str
    content: str
    token_count: int
    location: dict
    vector_status: str
    edited: bool
    updated_at: datetime


class ChunkPage(BaseModel):
    items: list[ChunkRead]
    total: int


class ChunkUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=20000)


class RetrievalTestRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=8, ge=1, le=20)


class RouteSelectionRead(BaseModel):
    knowledge_base_id: str
    name: str
    score: float
    reason: str


class RetrievalHitRead(BaseModel):
    chunk_id: str
    knowledge_base_id: str
    knowledge_base_name: str
    document_id: str
    filename: str
    position: int
    kind: str
    content: str
    location: dict
    dense_score: float
    bm25_score: float
    rrf_score: float
    rerank_score: float | None


class RetrievalTestResponse(BaseModel):
    query: str
    selected_knowledge_bases: list[RouteSelectionRead]
    hits: list[RetrievalHitRead]
    insufficient: bool
    rerank_applied: bool
    warnings: list[str]


class ChatStreamRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = None
    agent_id: str | None = None


class ChatCitationRead(BaseModel):
    index: int
    chunk_id: str
    knowledge_base_id: str
    knowledge_base_name: str
    document_id: str
    filename: str
    content: str
    location: dict


class ChatMessageRead(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    citations: list[dict]
    route: list[dict]
    status: str
    error_message: str | None
    created_at: datetime


class ConversationRead(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime


class ConversationDetail(ConversationRead):
    messages: list[ChatMessageRead]


class ModelCallLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    model_id: str
    protocol: str
    purpose: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated: bool
    latency_ms: float
    retry_count: int
    status: str
    error_message: str | None
    created_at: datetime


class QueryLogSummaryRead(BaseModel):
    id: str
    conversation_id: str | None
    question: str
    status: str
    grounded: bool
    route: list[dict]
    first_token_ms: float | None
    total_ms: float | None
    retry_count: int
    total_tokens: int
    estimated: bool
    error_message: str | None
    created_at: datetime


class QueryLogDetailRead(QueryLogSummaryRead):
    answer: str
    citations: list[dict]
    route_candidates: list[dict]
    route_ms: float
    retrieval_ms: float
    rerank_ms: float
    completed_at: datetime | None
    model_calls: list[ModelCallLogRead]


class QueryLogPage(BaseModel):
    items: list[QueryLogSummaryRead]
    total: int


class QueryLogStats(BaseModel):
    today_count: int
    average_total_ms: float | None


class LogRetentionRead(BaseModel):
    days: int


class LogRetentionUpdate(BaseModel):
    days: int = Field(ge=1, le=3650)


def _clean_route_texts(values: list[str], max_length: int, label: str) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = value.strip()
        if not item:
            continue
        if len(item) > max_length:
            raise ValueError(f"{label}单项不能超过 {max_length} 个字符")
        key = item.casefold()
        if key not in seen:
            seen.add(key)
            cleaned.append(item)
    return cleaned
