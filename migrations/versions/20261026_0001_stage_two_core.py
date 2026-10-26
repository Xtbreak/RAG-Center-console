"""Create anonymous sessions and model configuration tables."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261026_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "anonymous_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "providers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("preset_id", sa.String(50), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("base_url", sa.String(500), nullable=False),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("api_key_last4", sa.String(4), nullable=False),
        sa.Column("default_protocol", sa.String(60), nullable=False),
        sa.Column("health", sa.String(20), nullable=False),
        sa.Column("last_latency_ms", sa.Float(), nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_providers_preset_id", "providers", ["preset_id"])
    op.create_table(
        "model_definitions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("provider_id", sa.String(36), sa.ForeignKey("providers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("model_type", sa.String(20), nullable=False),
        sa.Column("protocol", sa.String(60), nullable=False),
        sa.Column("context_length", sa.Integer(), nullable=True),
        sa.Column("vector_dimension", sa.Integer(), nullable=True),
        sa.Column("timeout_seconds", sa.Float(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("provider_id", "model_id", "model_type"),
    )
    op.create_index("ix_model_definitions_provider_id", "model_definitions", ["provider_id"])
    op.create_table(
        "model_defaults",
        sa.Column("purpose", sa.String(40), primary_key=True),
        sa.Column("model_id", sa.String(36), sa.ForeignKey("model_definitions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("model_defaults")
    op.drop_index("ix_model_definitions_provider_id", table_name="model_definitions")
    op.drop_table("model_definitions")
    op.drop_index("ix_providers_preset_id", table_name="providers")
    op.drop_table("providers")
    op.drop_table("anonymous_sessions")
