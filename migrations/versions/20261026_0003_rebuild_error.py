"""Record why the last knowledge base rebuild failed."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261026_0003"
down_revision: str | None = "20261026_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("knowledge_bases", sa.Column("rebuild_error", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("knowledge_bases", "rebuild_error")
