from datetime import timedelta

from sqlalchemy import select

from rag_center_console.database import SessionLocal
from rag_center_console.logs import cleanup_expired_logs, get_log_retention_days
from rag_center_console.models import ModelCallLog, QueryLog, utc_now
from rag_center_console.telemetry import usage_counts
from rag_center_console.worker import celery_app


def seed_log(*, question="差旅如何报销", answer="凭发票报销", days_old=0, status="completed"):
    with SessionLocal() as db:
        log = QueryLog(
            question=question,
            answer=answer,
            status=status,
            grounded=True,
            total_ms=125.0,
            created_at=utc_now() - timedelta(days=days_old),
        )
        db.add(log)
        db.flush()
        db.add(ModelCallLog(query_log_id=log.id, provider_id="p", provider="custom", model_id="model", protocol="OpenAI Responses", purpose="answer_llm", input_tokens=8, output_tokens=4, total_tokens=12, estimated=True))
        db.commit()
        return log.id


def test_log_filters_detail_stats_and_admin_role(client):
    first = seed_log()
    seed_log(question="模型调用超时", answer="回答失败", status="failed")
    client.put("/api/v1/session", json={"role": "manager"})
    assert client.get("/api/v1/logs").status_code == 403
    client.put("/api/v1/session", json={"role": "admin"})
    page = client.get("/api/v1/logs", params={"q": "差旅", "status": "completed"}).json()
    assert page["total"] == 1 and page["items"][0]["id"] == first
    assert page["items"][0]["total_tokens"] == 12 and page["items"][0]["estimated"] is True
    detail = client.get(f"/api/v1/logs/{first}").json()
    assert detail["answer"] == "凭发票报销" and detail["model_calls"][0]["estimated"] is True
    assert client.get("/api/v1/logs/stats").json()["today_count"] == 2
    assert client.get("/api/v1/logs", params={"start": "2030-01-01T00:00:00Z"}).json()["total"] == 0
    assert client.get("/api/v1/logs/not-a-log").status_code == 404


def test_retention_update_and_cleanup_removes_calls(client):
    log_id = seed_log(days_old=31)
    recent_id = seed_log(question="保留的问题")
    client.put("/api/v1/session", json={"role": "admin"})
    assert client.get("/api/v1/logs/retention").json() == {"days": 90}
    assert client.put("/api/v1/logs/retention", json={"days": 30}).json() == {"days": 30}
    assert client.put("/api/v1/logs/retention", json={"days": 0}).status_code == 422
    with SessionLocal() as db:
        assert get_log_retention_days(db) == 30
        assert cleanup_expired_logs(db) == 1
        assert db.get(QueryLog, log_id) is None and db.get(QueryLog, recent_id) is not None
        assert db.scalars(select(ModelCallLog).where(ModelCallLog.query_log_id == log_id)).all() == []
    assert "cleanup-expired-query-logs" in celery_app.conf.beat_schedule


def test_usage_estimation_is_explicit():
    assert usage_counts(None, "你好世界", "回答") == (4, 2, 6, True)
    assert usage_counts({"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12}, "ignored") == (8, 4, 12, False)
    assert usage_counts({"total_tokens": 7}, "ignored") == (7, 0, 7, False)
