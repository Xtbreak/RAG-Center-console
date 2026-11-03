"""Add extracted document metadata and build status."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261027_0009"
down_revision: str | None = "20261027_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("metadata_json", sa.JSON(), nullable=False, server_default="{}"))
    op.add_column("documents", sa.Column("metadata_status", sa.String(20), nullable=False, server_default="pending"))
    op.add_column("documents", sa.Column("metadata_error", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("documents", "metadata_error")
    op.drop_column("documents", "metadata_status")
    op.drop_column("documents", "metadata_json")
