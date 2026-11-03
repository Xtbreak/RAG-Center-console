"""Add recursive separators and semantic chunking options."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261027_0008"
down_revision: str | None = "20261026_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table in ("knowledge_bases", "documents"):
        op.add_column(table, sa.Column("separators", sa.JSON(), nullable=False, server_default="[]"))
        op.add_column(table, sa.Column("semantic_threshold", sa.Float(), nullable=False, server_default="0.75"))


def downgrade() -> None:
    for table in ("documents", "knowledge_bases"):
        op.drop_column(table, "semantic_threshold")
        op.drop_column(table, "separators")
