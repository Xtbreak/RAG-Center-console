# 部署、运维与恢复手册

## 1. 部署组成

系统由 Web、API、Celery Worker、Celery Beat、PostgreSQL、Qdrant、Redis 和 S3 兼容对象存储组成。测试环境使用 RustFS；正式对象存储只需兼容 S3 协议。

前置要求：Python 3.15、uv、Node.js 20.9+、Docker 与 Docker Compose。Worker 在 Python 3.15 下必须使用 `--pool=threads`，不能使用默认 prefork。

1. 从 `.env.example` 创建 `.env`，生成独立的 `RAG_ENCRYPTION_KEY`。
2. 修改 PostgreSQL、RustFS 和供应商密钥，不要沿用示例密码。
3. 设置阿里云 DocMind AccessKey，以及需要使用的模型供应商配置。
4. 执行 `docker compose up --build`。API 启动命令会先执行 Alembic 迁移。
5. 打开 `http://localhost:3000`，API 文档位于 `http://localhost:8000/docs`。

生产环境应在 Web/API 前部署 HTTPS 反向代理，限制管理网段，并为 PostgreSQL、Qdrant、Redis 和对象存储设置持久卷与访问控制。1.0 的角色选择不是身份认证，不能直接作为多用户安全权限系统使用。

## 2. 本地进程与配置

本地开发分别启动：

```bash
uv run alembic upgrade head
uv run uvicorn rag_center_console.main:app --host 127.0.0.1 --port 8000
uv run celery -A rag_center_console.worker worker --pool=threads --concurrency=2 --loglevel=info
uv run celery -A rag_center_console.worker beat --loglevel=info
cd apps/web && npm run dev
```

关键配置：

- `RAG_DATABASE_URL`：正式环境使用 PostgreSQL；仅本地轻量开发使用 SQLite。
- `RAG_ENCRYPTION_KEY`：模型密钥加密主密钥。丢失后已保存的供应商密钥无法解密，必须重新配置。
- `RAG_AUTO_CREATE_SCHEMA`：正式环境保持 `false`，通过 Alembic 管理结构。
- `RAG_S3_*`、`RAG_QDRANT_URL`、`RAG_REDIS_URL`：基础设施连接。
- `API_INTERNAL_URL`：Web 到 API 的内部地址。
- `RAG_ALIYUN_DOCMIND_*`：扫描件回退、图片 OCR 及智能/快速云端解析配置。

默认本地优先：文字型 PDF 使用 PyMuPDF，DOCX 使用 python-docx，DOC 使用 LibreOffice 无头转换（macOS 可使用 `textutil`）。Docker API 镜像已包含 LibreOffice Writer；其他部署方式需自行安装。无法可靠提取时回退快速云端。图片 OCR、视觉描述、元数据、语义 Embedding、Rerank 和回答模型仍按模型配置调用。

如果本机代理不可用，清除 `HTTP_PROXY`/`HTTPS_PROXY` 或为阿里云及内部服务配置 `NO_PROXY`。SDK/HTTP 调用不应把签名图片地址、API Key 或 Authorization 写入日志。

## 3. 日常检查

```bash
curl http://localhost:8000/health
uv run alembic check
uv run pytest -q
cd apps/web && npm run typecheck && npm run build
```

检查事项：

- API、Worker、Beat 是否运行，Worker 启动参数是否包含线程池。
- 文档是否长期停留在上传、解析或向量化阶段；失败文档可在界面查看原因并重试。
- Qdrant collection 的向量维度是否与知识库一致，向量点数是否与有效分段数一致。
- 模型服务的健康状态与真实错误；健康检测成功不代表检索质量达标。
- 运行日志中的失败、重试、估算 Token、首 Token 和总耗时。

## 4. 导入任务恢复与日志清理

Worker 使用 late ack；导入任务通过条件更新防止重复执行。Beat 每 5 分钟恢复超过 20 分钟无进展的任务。重启后检查运行中任务是否被重新排队，以及分段数与向量数是否一致。

查询日志默认保留 90 天。管理员可在“运行日志 → 调用详情 → 日志留存”调整为 1–3650 天；Beat 每小时清理过期日志及其模型调用明细。供应商未返回 usage 时，界面明确显示“估算”。

## 5. 备份

为保证一致性，备份窗口内暂停导入、分段编辑、重建和问答，或接受并记录跨存储的时间差。备份文件应加密并保存在另一故障域。

### PostgreSQL

```bash
docker compose exec -T postgres pg_dump -U rag_center -Fc rag_center > rag_center.dump
```

备份包含知识库、文档、分段、会话、查询日志和模型调用。对象文件与向量不包含在数据库转储中。

### Qdrant

对每个知识库 collection 创建并下载快照：

```bash
curl -X POST http://localhost:6333/collections/COLLECTION/snapshots
curl -OJ http://localhost:6333/collections/COLLECTION/snapshots/SNAPSHOT_NAME
```

### 对象存储

使用 S3 兼容工具同步整个 bucket，保留原对象键、Content-Type 和版本信息。例如配置好独立备份端点后：

```bash
aws s3 sync s3://rag-center s3://BACKUP_BUCKET/rag-center --endpoint-url BACKUP_ENDPOINT
```

## 6. 恢复与核对

先恢复 PostgreSQL，再恢复对象文件和 Qdrant，最后启动 Worker/API。恢复环境必须使用正确的 `RAG_ENCRYPTION_KEY`。

```bash
docker compose exec -T postgres psql -U rag_center -d postgres -c 'CREATE DATABASE rag_center_restore'
docker compose exec -T postgres pg_restore -U rag_center -d rag_center_restore --no-owner --no-privileges < rag_center.dump
```

将对象按原 key 恢复后，上传 Qdrant 快照：

```bash
curl -X POST 'http://localhost:6333/collections/RESTORED_COLLECTION/snapshots/upload?wait=true' \
  -H 'Content-Type: multipart/form-data' \
  -F 'snapshot=@SNAPSHOT_FILE'
```

恢复后至少核对：

- 知识库、文档、分段、会话、查询日志和模型调用数量。
- 每个 collection 的向量维度与点数，点数应与有效分段数一致。
- 原文件 SHA-256 与数据库记录一致，文件可读取。
- 检索测试、真实问答引用、分段编辑和失败重试可用。
- 验证完成后删除临时恢复库、恢复 collection 与测试对象，避免混淆生产数据。

## 7. 故障排查

- **模型 401/403**：检查密钥、Base URL、供应商权限和模型是否仍在线；不要在日志中输出密钥。
- **Kimi Code 报 temperature 错误**：部分 k3 模型只接受 `temperature=1`，适配器已强制处理该渠道。
- **阿里云 `NoPermission`**：开通文档解析大模型版并授予 RAM 用户 DocMind 权限；同时检查代理。
- **阿里云 `NotSupportFormat`**：WEBP/TIFF 会在本地转为 PNG 后解析，原文件不变；其他格式需查看官方限制。
- **图片没有视觉描述**：检查默认视觉模型；含图文档还需 DocMind 返回有效临时图片地址。OCR 会保留，失败原因显示为部分失败。
- **向量维度不一致**：不要直接改 collection，使用知识库整库重建；失败时旧索引保留。
- **任务不执行**：检查 Redis、Worker 线程池和队列数据库是否一致，再检查 Beat 的过期恢复。
- **SQLite 锁等待**：仅用于本地轻量开发；并行导入或并发问答使用 PostgreSQL。
- **Web 上传大文件失败**：检查反向代理请求体上限，必须大于 100 MB；Next.js 当前配置为 101 MB。
- **流式回答中断**：检查反向代理缓冲与超时，SSE 响应已设置 `X-Accel-Buffering: no`；客户端断开应记录为 `cancelled`。
