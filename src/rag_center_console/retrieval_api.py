from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .auth import require_knowledge_manager
from .database import get_db
from .retrieval import RetrievalError, RetrievalPipeline, RetrievalServices, default_retrieval_services
from .schemas import RetrievalTestRequest, RetrievalTestResponse
from .security import SecretConfigurationError


router = APIRouter()


def get_retrieval_services() -> RetrievalServices:
    try:
        return default_retrieval_services()
    except SecretConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/retrieval/test", response_model=RetrievalTestResponse)
async def test_retrieval(
    payload: RetrievalTestRequest,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
    services: RetrievalServices = Depends(get_retrieval_services),
) -> RetrievalTestResponse:
    """按正式链路执行自动选库、每库向量化、BM25、RRF 与可选 Rerank。"""
    try:
        result = await RetrievalPipeline(services).run(db, payload.query, top_k=payload.top_k)
    except RetrievalError as exc:
        status_code = 422 if str(exc).startswith("请先") else 502
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    return RetrievalTestResponse(**asdict(result))
