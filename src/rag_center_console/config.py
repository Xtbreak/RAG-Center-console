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
