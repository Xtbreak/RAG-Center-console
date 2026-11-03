from unittest.mock import AsyncMock, patch

from test_knowledge_api import create_kb, env  # noqa: F401


def test_custom_text_and_qa_enter_real_import_pipeline(env):
    client, storage, _, queued = env
    kb = create_kb(client)
    text = client.post(f"/api/v1/knowledge-bases/{kb['id']}/documents/from-source", json={
        "source": "text", "title": "报销说明", "content": "差旅报销需要在月底之前提交。",
    })
    assert text.status_code == 201, text.text
    assert text.json()["filename"] == "报销说明.md"
    assert text.json()["job_id"] in queued["ingest"]
    stored = list(storage.objects.values())[-1].decode()
    assert "# 报销说明" in stored and "差旅报销" in stored

    qa = client.post(f"/api/v1/knowledge-bases/{kb['id']}/documents/from-source", json={
        "source": "qa", "title": "常见问答", "qa_pairs": [{"question": "如何请假？", "answer": "在人事系统申请。"}],
    })
    assert qa.status_code == 201, qa.text
    stored = list(storage.objects.values())[-1].decode()
    assert "## 如何请假？" in stored and "在人事系统申请。" in stored
    invalid = client.post(f"/api/v1/knowledge-bases/{kb['id']}/documents/from-source", json={
        "source": "qa", "qa_pairs": [{"question": "缺少答案", "answer": ""}],
    })
    assert invalid.status_code == 422


def test_web_import_strips_script_and_keeps_source(env):
    client, storage, _, _ = env
    kb = create_kb(client)
    response = {
        "status_code": 200,
        "headers": {"content-type": "text/html; charset=utf-8"},
        "body": "<html><script>bad()</script><h1>售后政策</h1><p>支持七天退货。</p></html>",
    }
    with patch("rag_center_console.knowledge_sources_api.request_external", new=AsyncMock(return_value=response)) as request:
        imported = client.post(f"/api/v1/knowledge-bases/{kb['id']}/documents/from-source", json={
            "source": "web", "url": "https://example.com/policy",
        })
    assert imported.status_code == 201, imported.text
    assert request.await_args.args[1] == "https://example.com/policy"
    stored = list(storage.objects.values())[-1].decode()
    assert "来源：https://example.com/policy" in stored
    assert "支持七天退货。" in stored and "bad()" not in stored


def test_web_import_reports_failures_and_rejects_unsupported_content(env):
    client, *_ = env
    kb = create_kb(client)
    with patch("rag_center_console.knowledge_sources_api.request_external", new=AsyncMock(return_value={
        "status_code": 200, "headers": {"content-type": "image/png"}, "body": "binary",
    })):
        response = client.post(f"/api/v1/knowledge-bases/{kb['id']}/documents/from-source", json={
            "source": "web", "url": "https://example.com/image.png",
        })
    assert response.status_code == 422
    assert "不是可导入" in response.json()["detail"]
