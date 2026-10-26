from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .adapters import HealthCheckFailure, ProbeTarget, probe_model
from .models import ModelDefinition, Provider, ProviderHealth
from .schemas import HealthCheckRead
from .security import SecretBox


async def check_provider_health(
    db: Session,
    provider: Provider,
    model: ModelDefinition,
    secret_box: SecretBox,
) -> HealthCheckRead:
    target = ProbeTarget(
        provider_id=provider.id,
        preset_id=provider.preset_id,
        base_url=provider.base_url,
        api_key=secret_box.decrypt(provider.api_key_encrypted),
        model_id=model.model_id,
        protocol=model.protocol,
        timeout_seconds=model.timeout_seconds,
    )
    try:
        result = await probe_model(target)
    except HealthCheckFailure as exc:
        provider.health = ProviderHealth.ERROR.value
        provider.last_error = str(exc)
        provider.last_checked_at = datetime.now(UTC)
        db.commit()
        raise

    provider.health = result.status.value
    provider.last_latency_ms = result.latency_ms
    provider.last_error = None if result.status == ProviderHealth.HEALTHY else result.message
    provider.last_checked_at = datetime.now(UTC)
    db.commit()
    return HealthCheckRead(
        provider_id=provider.id,
        model_id=model.id,
        status=result.status,
        latency_ms=result.latency_ms,
        protocol=model.protocol,
        checks=result.checks,
        usage=result.usage,
        message=result.message,
    )


def first_enabled_model(db: Session, provider_id: str) -> ModelDefinition | None:
    return db.scalar(
        select(ModelDefinition)
        .where(ModelDefinition.provider_id == provider_id, ModelDefinition.enabled.is_(True))
        .order_by(ModelDefinition.created_at)
    )
