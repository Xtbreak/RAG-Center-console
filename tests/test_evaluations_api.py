import json

from rag_center_console.database import SessionLocal
from rag_center_console.models import QueryLog


def test_evaluation_crud_filters_permissions_and_exports(client):
    agent = client.post("/api/v1/agents", json={"name": "评测应用"}).json()
    with SessionLocal() as db:
        query = QueryLog(question="年假多少天", answer="五天", agent_id=agent["id"], agent_name=agent["name"], status="completed")
        db.add(query)
        db.commit()
        query_id = query.id

    created = client.post("/api/v1/evaluations", json={
        "kind": "good", "question": "年假多少天",
        "actual_answer": "五天", "notes": "回答正确", "agent_id": agent["id"], "source_query_id": query_id,
    })
    assert created.status_code == 201, created.text
    case = created.json()
    assert case["agent_name"] == "评测应用" and case["source_query_id"] == query_id
    assert "expected_answer" not in case
    assert client.get("/api/v1/evaluations", params={"kind": "good", "q": "年假"}).json()["total"] == 1
    assert client.get("/api/v1/evaluations", params={"kind": "bad"}).json()["total"] == 0
    assert client.post("/api/v1/evaluations", json={"kind": "bad", "question": "无效", "agent_id": "missing"}).status_code == 422

    updated = client.patch(f"/api/v1/evaluations/{case['id']}", json={"kind": "bad", "notes": "需要补充引用"})
    assert updated.status_code == 200 and updated.json()["kind"] == "bad"
    csv_response = client.get("/api/v1/evaluations/export", params={"format": "csv", "kind": "bad"})
    assert csv_response.status_code == 200
    assert csv_response.content.startswith("﻿".encode())
    assert "需要补充引用" in csv_response.text and "attachment" in csv_response.headers["content-disposition"]
    assert "expected_answer" not in csv_response.text.splitlines()[0]
    jsonl_response = client.get("/api/v1/evaluations/export", params={"format": "jsonl", "kind": "bad"})
    row = json.loads(jsonl_response.text.strip())
    assert row["question"] == "年假多少天" and row["kind"] == "bad" and row["agent_name"] == "评测应用"
    assert "expected_answer" not in row

    client.put("/api/v1/session", json={"role": "manager"})
    assert client.get("/api/v1/evaluations").status_code == 403
    assert client.get("/api/v1/evaluations/export").status_code == 403
    client.put("/api/v1/session", json={"role": "admin"})
    assert client.delete(f"/api/v1/evaluations/{case['id']}").status_code == 204
    assert client.get("/api/v1/evaluations").json()["total"] == 0
