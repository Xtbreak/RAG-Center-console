# 企业知识库中台

企业内部使用的通用知识库中台 1.0，目标是完成模型配置、知识导入、知识库构建、自动选库、混合检索、在线对话、引用和运行日志的完整闭环。

## 当前阶段

阶段 2：基础设施、匿名角色会话与模型模块，正在开发。

阶段状态和验收记录以 `DEVELOPMENT_WORKFLOW.md` 为唯一依据。

## 开发文档

- [开发计划](./DEVELOPMENT_PLAN.md)
- [开发流程与进度](./DEVELOPMENT_WORKFLOW.md)

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

浏览器访问 `http://localhost:3000`，API 文档位于 `http://localhost:8000/docs`。当前版本默认以零数据空状态启动，不包含预置业务示例。

安装 Docker 后，可在填写 `.env` 后使用 `docker compose up --build` 启动 PostgreSQL、Qdrant、Redis、RustFS、API 和 Web。

质量检查：

```bash
cd apps/web
npm run typecheck
npm run build
```

```bash
uv run pytest -q
```
