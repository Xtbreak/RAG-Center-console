"""Add goodcase and badcase evaluation datasets."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261029_0012"
down_revision: str | None = "20261028_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "evaluation_cases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(10), nullable=False, index=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("expected_answer", sa.Text(), nullable=False),
        sa.Column("actual_answer", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agent_apps.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("source_query_id", sa.String(36), sa.ForeignKey("query_logs.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("evaluation_cases")
