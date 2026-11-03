"""Add agent, context, operation and pricing observability."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261028_0011"
down_revision: str | None = "20261028_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("query_logs") as batch:
        batch.add_column(sa.Column("agent_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("agent_name", sa.String(120), nullable=True))
        batch.add_column(sa.Column("error_type", sa.String(60), nullable=True))
        batch.add_column(sa.Column("failed_stage", sa.String(40), nullable=True))
        batch.create_foreign_key("fk_query_logs_agent_id", "agent_apps", ["agent_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_query_logs_agent_id", ["agent_id"])
    with op.batch_alter_table("model_call_logs") as batch:
        batch.alter_column("query_log_id", existing_type=sa.String(36), nullable=True)
        batch.add_column(sa.Column("ingestion_job_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("input_context", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("output_content", sa.Text(), nullable=True))
        batch.add_column(sa.Column("input_price_per_million", sa.Numeric(18, 8), nullable=True))
        batch.add_column(sa.Column("output_price_per_million", sa.Numeric(18, 8), nullable=True))
        batch.add_column(sa.Column("currency", sa.String(8), nullable=True))
        batch.add_column(sa.Column("estimated_cost", sa.Numeric(18, 8), nullable=True))
        batch.create_foreign_key("fk_model_call_logs_ingestion_job_id", "ingestion_jobs", ["ingestion_job_id"], ["id"], ondelete="SET NULL")
        batch.create_index("ix_model_call_logs_ingestion_job_id", ["ingestion_job_id"])
    op.create_table(
        "operation_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("query_log_id", sa.String(36), sa.ForeignKey("query_logs.id", ondelete="CASCADE"), nullable=True, index=True),
        sa.Column("ingestion_job_id", sa.String(36), sa.ForeignKey("ingestion_jobs.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agent_apps.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("tool_id", sa.String(36), sa.ForeignKey("tool_definitions.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("kind", sa.String(20), nullable=False, index=True),
        sa.Column("operation", sa.String(120), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, index=True),
        sa.Column("input_json", sa.JSON(), nullable=True),
        sa.Column("output_json", sa.JSON(), nullable=True),
        sa.Column("context_json", sa.JSON(), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=False),
        sa.Column("unit_count", sa.Float(), nullable=False),
        sa.Column("unit_name", sa.String(30), nullable=True),
        sa.Column("estimated_cost", sa.Numeric(18, 8), nullable=True),
        sa.Column("error_type", sa.String(60), nullable=True),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, index=True),
    )
    op.create_table(
        "model_prices",
        sa.Column("model_id", sa.String(36), sa.ForeignKey("model_definitions.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("input_price_per_million", sa.Numeric(18, 8), nullable=False),
        sa.Column("output_price_per_million", sa.Numeric(18, 8), nullable=False),
        sa.Column("currency", sa.String(8), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("model_prices")
    op.drop_table("operation_logs")
    with op.batch_alter_table("model_call_logs") as batch:
        batch.drop_index("ix_model_call_logs_ingestion_job_id")
        batch.drop_constraint("fk_model_call_logs_ingestion_job_id", type_="foreignkey")
        batch.drop_column("estimated_cost")
        batch.drop_column("currency")
        batch.drop_column("output_price_per_million")
        batch.drop_column("input_price_per_million")
        batch.drop_column("output_content")
        batch.drop_column("input_context")
        batch.drop_column("ingestion_job_id")
    op.execute(sa.text("DELETE FROM model_call_logs WHERE query_log_id IS NULL"))
    with op.batch_alter_table("model_call_logs") as batch:
        batch.alter_column("query_log_id", existing_type=sa.String(36), nullable=False)
    with op.batch_alter_table("query_logs") as batch:
        batch.drop_index("ix_query_logs_agent_id")
        batch.drop_constraint("fk_query_logs_agent_id", type_="foreignkey")
        batch.drop_column("failed_stage")
        batch.drop_column("error_type")
        batch.drop_column("agent_name")
        batch.drop_column("agent_id")
