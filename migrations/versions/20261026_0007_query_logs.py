"""Create query logs, model call details, and system settings."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261026_0007"
down_revision: str | None = "20261026_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "query_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("anonymous_session_id", sa.String(36), sa.ForeignKey("anonymous_sessions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("citations", sa.JSON(), nullable=False),
        sa.Column("route_candidates", sa.JSON(), nullable=False),
        sa.Column("route", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("grounded", sa.Boolean(), nullable=False),
        sa.Column("route_ms", sa.Float(), nullable=False),
        sa.Column("retrieval_ms", sa.Float(), nullable=False),
        sa.Column("rerank_ms", sa.Float(), nullable=False),
        sa.Column("first_token_ms", sa.Float(), nullable=True),
        sa.Column("total_ms", sa.Float(), nullable=True),
        sa.Column("retry_count", sa.Integer(), nullable=False),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_query_logs_anonymous_session_id", "query_logs", ["anonymous_session_id"])
    op.create_index("ix_query_logs_conversation_id", "query_logs", ["conversation_id"])
    op.create_index("ix_query_logs_status", "query_logs", ["status"])
    op.create_index("ix_query_logs_created_at", "query_logs", ["created_at"])
    op.create_table(
        "model_call_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("query_log_id", sa.String(36), sa.ForeignKey("query_logs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("provider_id", sa.String(36), nullable=False),
        sa.Column("provider", sa.String(120), nullable=False),
        sa.Column("model_id", sa.String(200), nullable=False),
        sa.Column("protocol", sa.String(60), nullable=False),
        sa.Column("purpose", sa.String(40), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("estimated", sa.Boolean(), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=False),
        sa.Column("retry_count", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_model_call_logs_query_log_id", "model_call_logs", ["query_log_id"])
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(80), primary_key=True),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("system_settings")
    op.drop_index("ix_model_call_logs_query_log_id", table_name="model_call_logs")
    op.drop_table("model_call_logs")
    op.drop_index("ix_query_logs_created_at", table_name="query_logs")
    op.drop_index("ix_query_logs_status", table_name="query_logs")
    op.drop_index("ix_query_logs_conversation_id", table_name="query_logs")
    op.drop_index("ix_query_logs_anonymous_session_id", table_name="query_logs")
    op.drop_table("query_logs")
