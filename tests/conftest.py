import os
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient


TEST_DATABASE = Path("/private/tmp/rag_center_console_tests.db")
os.environ["RAG_DATABASE_URL"] = f"sqlite:///{TEST_DATABASE}"
os.environ["RAG_ENCRYPTION_KEY"] = Fernet.generate_key().decode("ascii")
os.environ["RAG_AUTO_CREATE_SCHEMA"] = "false"
# 测试不得读取开发者本地 .env 中的真实云端凭证
os.environ["RAG_ALIYUN_DOCMIND_ACCESS_KEY_ID"] = ""
os.environ["RAG_ALIYUN_DOCMIND_ACCESS_KEY_SECRET"] = ""

from rag_center_console.database import Base, engine  # noqa: E402
from rag_center_console.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def reset_database():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client
