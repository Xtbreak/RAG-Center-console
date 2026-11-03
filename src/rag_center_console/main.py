from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models  # noqa: F401
from .api import admin_router, router
from .apps_api import router as apps_router
from .chat_api import router as chat_router
from .config import get_settings
from .database import Base, engine
from .evaluations_api import router as evaluations_router
from .knowledge_api import router as knowledge_router
from .knowledge_sources_api import router as knowledge_sources_router
from .logs_api import router as logs_router
from .observability_api import router as observability_router
from .retrieval_api import router as retrieval_router


settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.auto_create_schema:
        Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix=settings.api_prefix)
app.include_router(admin_router, prefix=settings.api_prefix)
app.include_router(knowledge_router, prefix=settings.api_prefix)
app.include_router(knowledge_sources_router, prefix=settings.api_prefix)
app.include_router(retrieval_router, prefix=settings.api_prefix)
app.include_router(chat_router, prefix=settings.api_prefix)
app.include_router(logs_router, prefix=settings.api_prefix)
app.include_router(apps_router, prefix=settings.api_prefix)
app.include_router(observability_router, prefix=settings.api_prefix)
app.include_router(evaluations_router, prefix=settings.api_prefix)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
