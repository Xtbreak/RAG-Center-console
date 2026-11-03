# 企业知识库中台

企业内部使用的通用知识库中台 1.0，目标是完成模型配置、知识导入、知识库构建、自动选库、混合检索、在线对话、引用和运行日志的完整闭环。

## 当前阶段

阶段 0–5 均已完成并通过验收：模型配置、全格式导入、视觉描述、自动选库、混合检索、流式问答、运行日志、并发、任务恢复和备份恢复均已验证。

阶段状态和验收记录以 `DEVELOPMENT_WORKFLOW.md` 为唯一依据。

## 开发文档

- [开发计划](./DEVELOPMENT_PLAN.md)
- [开发流程与进度](./DEVELOPMENT_WORKFLOW.md)
- [部署、运维与恢复手册](./docs/OPERATIONS.md)

## 当前工程

- Python 包：`src/rag_center_console`
- FastAPI 后端：`src/rag_center_console/main.py`
- 前端：`apps/web`
- 基础设施：`docker-compose.yml`

## 本地启动

前置要求：Python 3.15、uv、Node.js 20.9 或更高版本。完整基础设施还需要 Docker。

首次运行先从 `.env.example` 创建 `.env`，并生成独立的 `RAG_ENCRYPTION_KEY`。本机不使用 Docker 时，可将 `RAG_DATABASE_URL` 改为 `sqlite:///./data/rag_center.db`。

启动后端：

```bash
uv sync
uv run alembic upgrade head
uv run uvicorn rag_center_console.main:app --host 127.0.0.1 --port 8000
```

启动前端：

```bash
cd apps/web
npm install
npm run dev
```

文档导入由 Celery Worker 异步处理，需要 Redis、Qdrant 和 S3 兼容对象存储（可用 `docker compose up -d postgres qdrant redis rustfs` 启动），再另开终端运行：

```bash
uv run celery -A rag_center_console.worker worker --pool=threads --loglevel=info
uv run celery -A rag_center_console.worker beat --loglevel=info
```

Worker 必须使用 `--pool=threads`：Python 3.15 下 Celery 默认的 prefork 进程池无法执行任务。Beat 每 5 分钟把长时间无进展的导入任务重新排队，并每小时清理过期查询日志。默认本地优先解析文字型 PDF、DOCX 和 DOC；DOC 本地转换需要 LibreOffice（macOS 可使用 `textutil`）。扫描件回退、图片 OCR 及智能/快速云端解析需在 `.env` 中配置 `RAG_ALIYUN_DOCMIND_ACCESS_KEY_ID` 和 `RAG_ALIYUN_DOCMIND_ACCESS_KEY_SECRET`。

浏览器访问 `http://localhost:3000`，API 文档位于 `http://localhost:8000/docs`。当前版本默认以零数据空状态启动，不包含预置业务示例。

安装 Docker 后，可在填写 `.env` 后使用 `docker compose up --build` 启动 PostgreSQL、Qdrant、Redis、RustFS、API、Worker、Beat 和 Web。

质量检查：

```bash
cd apps/web
npm run typecheck
npm run build
```

```bash
uv run pytest -q
```
