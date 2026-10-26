"""Add routing metadata and the independent knowledge base route index."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261026_0005"
down_revision: str | None = "20261026_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("knowledge_bases", sa.Column("tags", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column(
        "knowledge_bases", sa.Column("sample_questions", sa.JSON(), nullable=False, server_default="[]")
    )
    op.create_table(
        "knowledge_base_route_indexes",
        sa.Column(
            "knowledge_base_id",
            sa.String(36),
            sa.ForeignKey("knowledge_bases.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "model_id",
            sa.String(36),
            sa.ForeignKey("model_definitions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("profile_hash", sa.String(64), nullable=False),
        sa.Column("profile_text", sa.Text(), nullable=False),
        sa.Column("vector", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_knowledge_base_route_indexes_model_id", "knowledge_base_route_indexes", ["model_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_knowledge_base_route_indexes_model_id", table_name="knowledge_base_route_indexes")
    op.drop_table("knowledge_base_route_indexes")
    with op.batch_alter_table("knowledge_bases") as batch:
        batch.drop_column("sample_questions")
        batch.drop_column("tags")
