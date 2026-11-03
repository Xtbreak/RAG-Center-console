from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


class AgentBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    mode: Literal["simple", "chatflow"] = "simple"
    prompt: str = Field(default="", max_length=20000)
    opening: str = Field(default="", max_length=4000)
    suggestions: list[str] = Field(default_factory=list, max_length=8)
    knowledge_base_ids: list[str] = Field(default_factory=list, max_length=20)
    tool_ids: list[str] = Field(default_factory=list, max_length=20)
    flow: dict = Field(default_factory=dict)
    published: bool = False
    theme_color: str = Field(default="#3370ff", pattern="^#[0-9a-fA-F]{6}$")
    show_citations: bool = True
    allow_images: bool = False
    access_limit_per_minute: int = Field(default=20, ge=1, le=1000)
    allowed_domains: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("suggestions")
    @classmethod
    def clean_suggestions(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item.strip() and len(item.strip()) <= 300]


class AgentCreate(AgentBase):
    pass


class AgentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    mode: Literal["simple", "chatflow"] | None = None
    prompt: str | None = Field(default=None, max_length=20000)
    opening: str | None = Field(default=None, max_length=4000)
    suggestions: list[str] | None = Field(default=None, max_length=8)
    knowledge_base_ids: list[str] | None = Field(default=None, max_length=20)
    tool_ids: list[str] | None = Field(default=None, max_length=20)
    flow: dict | None = None
    published: bool | None = None
    theme_color: str | None = Field(default=None, pattern="^#[0-9a-fA-F]{6}$")
    show_citations: bool | None = None
    allow_images: bool | None = None
    access_limit_per_minute: int | None = Field(default=None, ge=1, le=1000)
    allowed_domains: list[str] | None = Field(default=None, max_length=20)

    @field_validator("suggestions")
    @classmethod
    def clean_suggestions(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [item.strip() for item in value if item.strip() and len(item.strip()) <= 300]


class AgentRead(AgentBase):
    id: str
    created_at: datetime
    updated_at: datetime


class ToolCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["http", "mcp"] = "http"
    description: str = Field(default="", max_length=2000)
    url: HttpUrl
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = Field(default=10, gt=0, le=60)
    enabled: bool = True


class ToolUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: Literal["http", "mcp"] | None = None
    description: str | None = Field(default=None, max_length=2000)
    url: HttpUrl | None = None
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] | None = None
    headers: dict[str, str] | None = None
    timeout_seconds: float | None = Field(default=None, gt=0, le=60)
    enabled: bool | None = None


class ToolRead(BaseModel):
    id: str
    name: str
    kind: str
    description: str
    url: str
    method: str
    has_credentials: bool
    timeout_seconds: float
    enabled: bool
    created_at: datetime
    updated_at: datetime


class ToolInvokeRequest(BaseModel):
    input: dict = Field(default_factory=dict)


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    quota_per_day: int | None = Field(default=None, ge=1, le=100000000)


class ApiKeyRead(BaseModel):
    id: str
    name: str
    prefix: str
    quota_per_day: int | None
    last_used_at: datetime | None
    revoked: bool
    created_at: datetime


class ApiKeyCreated(ApiKeyRead):
    secret: str


class KnowledgeSourceRequest(BaseModel):
    source: Literal["text", "qa", "web"]
    title: str = Field(default="", max_length=200)
    content: str = Field(default="", max_length=1000000)
    url: HttpUrl | None = None
    qa_pairs: list[dict[str, str]] = Field(default_factory=list, max_length=5000)
    allow_duplicate: bool = False


class InsightSummary(BaseModel):
    knowledge_base_count: int
    document_count: int
    chunk_count: int
    conversation_count: int
    query_count: int
    failed_query_count: int
    total_tokens: int
    estimated_tokens: int
    average_total_ms: float | None
    p95_total_ms: float | None
    model_usage: list[dict]
