import csv
import json
from datetime import datetime
from io import StringIO
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .auth import require_roles
from .database import get_db
from .models import AgentApp, EvaluationCase, QueryLog, Role

router = APIRouter()
require_admin = require_roles(Role.ADMIN)


class EvaluationInput(BaseModel):
    kind: Literal["good", "bad"]
    question: str = Field(min_length=1, max_length=10000)
    expected_answer: str = Field(default="", max_length=20000)
    actual_answer: str = Field(default="", max_length=20000)
    notes: str = Field(default="", max_length=4000)
    agent_id: str | None = None
    source_query_id: str | None = None


class EvaluationUpdate(BaseModel):
    kind: Literal["good", "bad"] | None = None
    question: str | None = Field(default=None, min_length=1, max_length=10000)
    expected_answer: str | None = Field(default=None, max_length=20000)
    actual_answer: str | None = Field(default=None, max_length=20000)
    notes: str | None = Field(default=None, max_length=4000)


def _case_or_404(db: Session, case_id: str) -> EvaluationCase:
    case = db.get(EvaluationCase, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="评测样例不存在")
    return case


def _read(case: EvaluationCase, db: Session) -> dict:
    agent = db.get(AgentApp, case.agent_id) if case.agent_id else None
    return {
        "id": case.id,
        "kind": case.kind,
        "question": case.question,
        "actual_answer": case.actual_answer,
        "notes": case.notes,
        "agent_id": case.agent_id,
        "agent_name": agent.name if agent else "全库知识问答",
        "source_query_id": case.source_query_id,
        "created_at": case.created_at,
        "updated_at": case.updated_at,
    }


def _validate_references(db: Session, agent_id: str | None, source_query_id: str | None) -> None:
    if agent_id and db.get(AgentApp, agent_id) is None:
        raise HTTPException(status_code=422, detail="关联应用不存在")
    if source_query_id and db.get(QueryLog, source_query_id) is None:
        raise HTTPException(status_code=422, detail="来源对话不存在")


def _filters(
    kind: str | None,
    agent_id: str | None,
    q: str | None,
    start: datetime | None,
    end: datetime | None,
) -> list:
    filters = []
    if kind:
        filters.append(EvaluationCase.kind == kind)
    if agent_id:
        filters.append(EvaluationCase.agent_id == agent_id)
    if q and q.strip():
        term = f"%{q.strip()}%"
        filters.append(or_(
            EvaluationCase.question.ilike(term),
            EvaluationCase.expected_answer.ilike(term),
            EvaluationCase.actual_answer.ilike(term),
            EvaluationCase.notes.ilike(term),
        ))
    if start:
        filters.append(EvaluationCase.created_at >= start)
    if end:
        filters.append(EvaluationCase.created_at <= end)
    return filters


@router.get("/evaluations", status_code=status.HTTP_200_OK)
def list_evaluations(
    kind: Literal["good", "bad"] | None = None,
    agent_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    start: datetime | None = None,
    end: datetime | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    statement = select(EvaluationCase).where(*_filters(kind, agent_id, q, start, end))
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    cases = list(db.scalars(statement.order_by(EvaluationCase.created_at.desc()).offset(offset).limit(limit)).all())
    return {"items": [_read(case, db) for case in cases], "total": total}


@router.post("/evaluations", status_code=status.HTTP_201_CREATED)
def create_evaluation(payload: EvaluationInput, _=Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    _validate_references(db, payload.agent_id, payload.source_query_id)
    case = EvaluationCase(**payload.model_dump())
    case.question = case.question.strip()
    db.add(case)
    db.commit()
    db.refresh(case)
    return _read(case, db)


@router.patch("/evaluations/{case_id}")
def update_evaluation(case_id: str, payload: EvaluationUpdate, _=Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    case = _case_or_404(db, case_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(case, key, value.strip() if isinstance(value, str) else value)
    if not case.question.strip():
        raise HTTPException(status_code=422, detail="问题不能为空")
    db.commit()
    db.refresh(case)
    return _read(case, db)


@router.delete("/evaluations/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_evaluation(case_id: str, _=Depends(require_admin), db: Session = Depends(get_db)) -> Response:
    db.delete(_case_or_404(db, case_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/evaluations/export")
def export_evaluations(
    format: Literal["csv", "jsonl"] = "jsonl",
    kind: Literal["good", "bad"] | None = None,
    agent_id: str | None = None,
    q: str | None = Query(default=None, max_length=200),
    start: datetime | None = None,
    end: datetime | None = None,
    _=Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    cases = list(db.scalars(select(EvaluationCase).where(*_filters(kind, agent_id, q, start, end)).order_by(EvaluationCase.created_at)).all())
    rows = [_read(case, db) for case in cases]
    suffix = f"-{kind}" if kind else ""
    filename = f"evaluation-cases{suffix}.{format}"
    if format == "jsonl":
        content = "\n".join(json.dumps(row, ensure_ascii=False, default=str) for row in rows)
        if rows:
            content += "\n"
        media_type = "application/jsonl; charset=utf-8"
    else:
        output = StringIO()
        writer = csv.DictWriter(output, fieldnames=list(rows[0].keys()) if rows else ["id", "kind", "question", "actual_answer", "notes", "agent_id", "agent_name", "source_query_id", "created_at", "updated_at"])
        writer.writeheader()
        writer.writerows(rows)
        content = "﻿" + output.getvalue()
        media_type = "text/csv; charset=utf-8"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})
