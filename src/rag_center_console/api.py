from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .adapters import HealthCheckFailure
from .database import get_db
from .models import AnonymousSession, ModelDefault, ModelDefinition, Provider, Role
from .schemas import (
    HealthCheckRead,
    ModelCreate,
    ModelDefaultsRead,
    ModelDefaultsUpdate,
    ModelRead,
    ModelUpdate,
    ProviderCreate,
    ProviderRead,
    ProviderUpdate,
    SessionRead,
    SessionRoleUpdate,
)
from .security import SecretConfigurationError, get_secret_box, mask_api_key
from .services import check_provider_health, first_enabled_model


router = APIRouter()
SESSION_COOKIE = "rag_session"
DEFAULT_PURPOSES = ("routing_embedding", "routing_llm", "default_rerank", "vision")


def _valid_uuid(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def _provider_read(provider: Provider) -> ProviderRead:
    return ProviderRead(
        id=provider.id,
        preset_id=provider.preset_id,
        name=provider.name,
        base_url=provider.base_url,
        api_key_masked=mask_api_key(provider.api_key_last4),
        default_protocol=provider.default_protocol,
        health=provider.health,
        model_count=len(provider.models),
        last_latency_ms=provider.last_latency_ms,
        last_error=provider.last_error,
        last_checked_at=provider.last_checked_at,
    )


@router.get("/session", response_model=SessionRead)
def get_or_create_session(
    response: Response,
    rag_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> SessionRead:
    session_id = _valid_uuid(rag_session)
    anonymous_session = db.get(AnonymousSession, session_id) if session_id else None
    if anonymous_session is None:
        anonymous_session = AnonymousSession(role=Role.ADMIN.value)
        db.add(anonymous_session)
        db.commit()
        db.refresh(anonymous_session)
        response.set_cookie(SESSION_COOKIE, anonymous_session.id, httponly=True, samesite="lax")
    return SessionRead(id=anonymous_session.id, role=anonymous_session.role)


@router.put("/session", response_model=SessionRead)
def update_session_role(
    payload: SessionRoleUpdate,
    response: Response,
    rag_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> SessionRead:
    session_id = _valid_uuid(rag_session)
    anonymous_session = db.get(AnonymousSession, session_id) if session_id else None
    if anonymous_session is None:
        anonymous_session = AnonymousSession(role=payload.role.value)
        db.add(anonymous_session)
    else:
        anonymous_session.role = payload.role.value
    db.commit()
    db.refresh(anonymous_session)
    response.set_cookie(SESSION_COOKIE, anonymous_session.id, httponly=True, samesite="lax")
    return SessionRead(id=anonymous_session.id, role=anonymous_session.role)


@router.get("/providers", response_model=list[ProviderRead])
def list_providers(db: Session = Depends(get_db)) -> list[ProviderRead]:
    providers = db.scalars(select(Provider).order_by(Provider.created_at)).all()
    return [_provider_read(provider) for provider in providers]


@router.post("/providers", response_model=ProviderRead, status_code=status.HTTP_201_CREATED)
def create_provider(payload: ProviderCreate, db: Session = Depends(get_db)) -> ProviderRead:
    try:
        secret_box = get_secret_box()
    except SecretConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    api_key = payload.api_key.get_secret_value()
    provider = Provider(
        preset_id=payload.preset_id,
        name=payload.name,
        base_url=str(payload.base_url).rstrip("/"),
        api_key_encrypted=secret_box.encrypt(api_key),
        api_key_last4=api_key[-4:].rjust(4, "•"),
        default_protocol=payload.default_protocol,
    )
    db.add(provider)
    db.commit()
    db.refresh(provider)
    return _provider_read(provider)


@router.patch("/providers/{provider_id}", response_model=ProviderRead)
def update_provider(provider_id: str, payload: ProviderUpdate, db: Session = Depends(get_db)) -> ProviderRead:
    provider = db.get(Provider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    changes = payload.model_dump(exclude_unset=True)
    if "api_key" in changes:
        try:
            secret_box = get_secret_box()
        except SecretConfigurationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        api_key = changes.pop("api_key").get_secret_value()
        provider.api_key_encrypted = secret_box.encrypt(api_key)
        provider.api_key_last4 = api_key[-4:].rjust(4, "•")
    if "base_url" in changes:
        changes["base_url"] = str(changes["base_url"]).rstrip("/")
    for key, value in changes.items():
        setattr(provider, key, value)
    provider.health = "untested"
    provider.last_error = None
    db.commit()
    db.refresh(provider)
    return _provider_read(provider)


@router.delete("/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(provider_id: str, db: Session = Depends(get_db)) -> Response:
    provider = db.get(Provider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    db.delete(provider)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/providers/{provider_id}/health-check", response_model=HealthCheckRead)
async def health_check_provider(
    provider_id: str,
    model_id: str | None = None,
    db: Session = Depends(get_db),
) -> HealthCheckRead:
    provider = db.get(Provider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    model = db.get(ModelDefinition, model_id) if model_id else first_enabled_model(db, provider_id)
    if model is None or model.provider_id != provider_id:
        raise HTTPException(status_code=409, detail="请先为供应商配置可用模型")
    try:
        return await check_provider_health(db, provider, model, get_secret_box())
    except SecretConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HealthCheckFailure as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/models", response_model=list[ModelRead])
def list_models(provider_id: str | None = None, db: Session = Depends(get_db)) -> list[ModelDefinition]:
    query = select(ModelDefinition).order_by(ModelDefinition.created_at)
    if provider_id:
        query = query.where(ModelDefinition.provider_id == provider_id)
    return list(db.scalars(query).all())


@router.post("/models", response_model=ModelRead, status_code=status.HTTP_201_CREATED)
def create_model(payload: ModelCreate, db: Session = Depends(get_db)) -> ModelDefinition:
    if db.get(Provider, payload.provider_id) is None:
        raise HTTPException(status_code=404, detail="供应商不存在")
    model = ModelDefinition(**payload.model_dump(mode="json"))
    db.add(model)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="同一供应商下已存在相同类型和 ID 的模型") from exc
    db.refresh(model)
    return model


@router.patch("/models/{model_id}", response_model=ModelRead)
def update_model(model_id: str, payload: ModelUpdate, db: Session = Depends(get_db)) -> ModelDefinition:
    model = db.get(ModelDefinition, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    changes = payload.model_dump(exclude_unset=True, mode="json")
    next_type = changes.get("model_type", model.model_type)
    next_dimension = changes.get("vector_dimension", model.vector_dimension)
    if next_type == "embedding" and next_dimension is None:
        raise HTTPException(status_code=422, detail="Embedding 模型必须填写向量维度")
    for key, value in changes.items():
        setattr(model, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="同一供应商下已存在相同类型和 ID 的模型") from exc
    db.refresh(model)
    return model


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(model_id: str, db: Session = Depends(get_db)) -> Response:
    model = db.get(ModelDefinition, model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="模型不存在")
    db.delete(model)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/model-defaults", response_model=ModelDefaultsRead)
def get_model_defaults(db: Session = Depends(get_db)) -> ModelDefaultsRead:
    values = {purpose: None for purpose in DEFAULT_PURPOSES}
    for item in db.scalars(select(ModelDefault)).all():
        values[item.purpose] = item.model_id
    return ModelDefaultsRead(**values)


@router.put("/model-defaults", response_model=ModelDefaultsRead)
def update_model_defaults(payload: ModelDefaultsUpdate, db: Session = Depends(get_db)) -> ModelDefaultsRead:
    for purpose, model_id in payload.model_dump().items():
        if model_id is not None and db.get(ModelDefinition, model_id) is None:
            raise HTTPException(status_code=404, detail=f"{purpose} 对应的模型不存在")
        item = db.get(ModelDefault, purpose)
        if item is None:
            db.add(ModelDefault(purpose=purpose, model_id=model_id))
        else:
            item.model_id = model_id
    db.commit()
    return get_model_defaults(db)
