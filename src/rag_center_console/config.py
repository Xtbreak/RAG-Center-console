from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "RAG Center API"
    app_env: str = "development"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./data/rag_center.db"
    encryption_key: str = ""
    cors_origins: str = "http://localhost:3000"
    provider_timeout_seconds: float = 30.0
    auto_create_schema: bool = True

    s3_endpoint_url: str = "http://localhost:9000"
    s3_access_key: str = "rag_center"
    s3_secret_key: str = "rag-center-dev-secret"
    s3_bucket: str = "rag-center"
    s3_region: str = "us-east-1"

    redis_url: str = "redis://localhost:6379/0"
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str = ""

    aliyun_docmind_access_key_id: str = ""
    aliyun_docmind_access_key_secret: str = ""
    aliyun_docmind_endpoint: str = "docmind-api.cn-hangzhou.aliyuncs.com"

    max_upload_bytes: int = 100 * 1024 * 1024

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_prefix="RAG_",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def ensure_local_data_directory(self) -> None:
        if self.database_url.startswith("sqlite"):
            Path("data").mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
