"""Add chunk method settings to knowledge bases and documents."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261026_0004"
down_revision: str | None = "20261026_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("knowledge_bases", sa.Column("chunk_method", sa.String(20), nullable=False, server_default="heading"))
    op.add_column("knowledge_bases", sa.Column("heading_level", sa.Integer(), nullable=False, server_default="6"))
    op.add_column("documents", sa.Column("chunk_method", sa.String(20), nullable=False, server_default="heading"))
    op.add_column("documents", sa.Column("chunk_size", sa.Integer(), nullable=False, server_default="800"))
    op.add_column("documents", sa.Column("chunk_overlap", sa.Integer(), nullable=False, server_default="120"))
    op.add_column("documents", sa.Column("heading_level", sa.Integer(), nullable=False, server_default="6"))
    # 已有文档沿用所属知识库当时的分段参数
    op.execute(
        "UPDATE documents SET "
        "chunk_size = (SELECT chunk_size FROM knowledge_bases WHERE knowledge_bases.id = documents.knowledge_base_id), "
        "chunk_overlap = (SELECT chunk_overlap FROM knowledge_bases WHERE knowledge_bases.id = documents.knowledge_base_id)"
    )


def downgrade() -> None:
    with op.batch_alter_table("documents") as batch:
        for column in ("heading_level", "chunk_overlap", "chunk_size", "chunk_method"):
            batch.drop_column(column)
    with op.batch_alter_table("knowledge_bases") as batch:
        for column in ("heading_level", "chunk_method"):
            batch.drop_column(column)
