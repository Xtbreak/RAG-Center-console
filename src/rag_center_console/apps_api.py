import hashlib
from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .adapters import HealthCheckFailure
from .app_schemas import (
    AgentCreate,
    AgentRead,
    AgentUpdate,
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyRead,
    InsightSummary,
    ToolCreate,
    ToolInvokeRequest,
    ToolRead,
    ToolUpdate,
)
from .auth import get_current_role, require_knowledge_manager
from .database import get_db
from .http_utils import request_external
from .models import (
    AgentApp,
    ApiKey,
    Chunk,
    Conversation,
    Document,
    KnowledgeBase,
    ModelCallLog,
    QueryLog,
    Role,
    ToolDefinition,
)
from .observability import record_operation, safe_external_url
from .security import SecretConfigurationError, get_secret_box

router = APIRouter()


def _agent_or_404(db: Session, agent_id: str) -> AgentApp:
    agent = db.get(AgentApp, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="应用不存在")
    return agent


def _tool_or_404(db: Session, tool_id: str) -> ToolDefinition:
    tool = db.get(ToolDefinition, tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail="工具不存在")
    return tool


def _tool_read(tool: ToolDefinition) -> ToolRead:
    return ToolRead(
        id=tool.id,
        name=tool.name,
        kind=tool.kind,
        description=tool.description,
        url=tool.url,
        method=tool.method,
        has_credentials=bool(tool.headers_encrypted),
        timeout_seconds=tool.timeout_seconds,
        enabled=tool.enabled,
        created_at=tool.created_at,
        updated_at=tool.updated_at,
    )


def _validate_references(db: Session, knowledge_base_ids: list[str], tool_ids: list[str]) -> None:
    for kb_id in knowledge_base_ids:
        if db.get(KnowledgeBase, kb_id) is None:
            raise HTTPException(status_code=422, detail="绑定的知识库不存在")
    for tool_id in tool_ids:
        if db.get(ToolDefinition, tool_id) is None:
            raise HTTPException(status_code=422, detail="绑定的工具不存在")


def _validate_flow(flow: dict) -> None:
    if not flow:
        return
    nodes = flow.get("nodes", [])
    edges = flow.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise HTTPException(status_code=422, detail="Chat Flow 格式无效")
    supported = {"start", "knowledge", "http", "llm", "export"}
    if any(not isinstance(node, dict) for node in nodes):
        raise HTTPException(status_code=422, detail="每个节点都必须是 JSON 对象")
    ids = [node.get("id") for node in nodes]
    if len(ids) != len(set(ids)) or any(not item for item in ids):
        raise HTTPException(status_code=422, detail="节点 ID 缺失或重复")
    for node in nodes:
        if node.get("type") not in supported:
            raise HTTPException(status_code=422, detail=f"暂不支持的节点类型：{node.get('type')}")
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("source") not in ids or edge.get("target") not in ids:
            raise HTTPException(status_code=422, detail="存在指向未知节点的连接")
    graph = {node_id: [] for node_id in ids}
    for edge in edges:
        graph[edge["source"]].append(edge["target"])
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visiting:
            raise HTTPException(status_code=422, detail="Chat Flow 不允许循环连接")
        if node_id in visited:
            return
        visiting.add(node_id)
        for target in graph[node_id]:
            visit(target)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in ids:
        visit(node_id)


@router.get("/agents", response_model=list[AgentRead])
def list_agents(role=Depends(get_current_role), db: Session = Depends(get_db)) -> list[AgentApp]:
    statement = select(AgentApp).order_by(AgentApp.updated_at.desc())
    if role == Role.USER:
        statement = statement.where(AgentApp.published.is_(True))
    return list(db.scalars(statement).all())


@router.post("/agents", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
def create_agent(payload: AgentCreate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> AgentApp:
    _validate_references(db, payload.knowledge_base_ids, payload.tool_ids)
    _validate_flow(payload.flow)
    agent = AgentApp(**payload.model_dump())
    db.add(agent)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名应用") from exc
    db.refresh(agent)
    return agent


@router.get("/agents/{agent_id}", response_model=AgentRead)
def get_agent(agent_id: str, role=Depends(get_current_role), db: Session = Depends(get_db)) -> AgentApp:
    agent = _agent_or_404(db, agent_id)
    if role == Role.USER and not agent.published:
        raise HTTPException(status_code=404, detail="应用不存在")
    return agent


@router.patch("/agents/{agent_id}", response_model=AgentRead)
def update_agent(agent_id: str, payload: AgentUpdate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> AgentApp:
    agent = _agent_or_404(db, agent_id)
    changes = payload.model_dump(exclude_unset=True)
    _validate_references(db, changes.get("knowledge_base_ids", agent.knowledge_base_ids), changes.get("tool_ids", agent.tool_ids))
    _validate_flow(changes.get("flow", agent.flow))
    for key, value in changes.items():
        setattr(agent, key, value.strip() if isinstance(value, str) else value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名应用") from exc
    db.refresh(agent)
    return agent


@router.post("/agents/{agent_id}/duplicate", response_model=AgentRead, status_code=status.HTTP_201_CREATED)
def duplicate_agent(agent_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> AgentApp:
    source = _agent_or_404(db, agent_id)
    values = {column.name: getattr(source, column.name) for column in AgentApp.__table__.columns if column.name != "id"}
    values["name"] = f"{source.name} 副本"
    values["published"] = False
    agent = AgentApp(**values)
    db.add(agent)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="副本名称已存在，请先修改原应用名称") from exc
    db.refresh(agent)
    return agent


@router.post("/agents/{agent_id}/publish", response_model=AgentRead)
def publish_agent(agent_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> AgentApp:
    agent = _agent_or_404(db, agent_id)
    agent.published = not agent.published
    db.commit()
    return agent


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_agent(agent_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> Response:
    db.delete(_agent_or_404(db, agent_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tools", response_model=list[ToolRead])
def list_tools(_=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> list[ToolDefinition]:
    return [_tool_read(tool) for tool in db.scalars(select(ToolDefinition).order_by(ToolDefinition.created_at)).all()]


@router.post("/tools", response_model=ToolRead, status_code=status.HTTP_201_CREATED)
def create_tool(payload: ToolCreate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> ToolRead:
    secret_box = get_secret_box()
    tool = ToolDefinition(
        **payload.model_dump(exclude={"headers"}, mode="json"),
        headers_encrypted=secret_box.encrypt(__import__("json").dumps(payload.headers, ensure_ascii=False)) if payload.headers else "",
    )
    db.add(tool)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名工具") from exc
    db.refresh(tool)
    return _tool_read(tool)


@router.patch("/tools/{tool_id}", response_model=ToolRead)
def update_tool(tool_id: str, payload: ToolUpdate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> ToolRead:
    tool = _tool_or_404(db, tool_id)
    changes = payload.model_dump(exclude_unset=True, mode="json")
    if "headers" in changes:
        headers = changes.pop("headers")
        tool.headers_encrypted = get_secret_box().encrypt(__import__("json").dumps(headers, ensure_ascii=False)) if headers else ""
    for key, value in changes.items():
        setattr(tool, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="已存在同名工具") from exc
    db.refresh(tool)
    return _tool_read(tool)


@router.delete("/tools/{tool_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tool(tool_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> Response:
    db.delete(_tool_or_404(db, tool_id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _headers(tool: ToolDefinition) -> dict[str, str]:
    if not tool.headers_encrypted:
        return {}
    import json
    try:
        return json.loads(get_secret_box().decrypt(tool.headers_encrypted))
    except (ValueError, SecretConfigurationError) as exc:
        raise HTTPException(status_code=503, detail="工具密钥配置不可用") from exc


async def _observed_tool_call(
    db: Session,
    tool: ToolDefinition,
    *,
    operation: str,
    payload: dict | None = None,
) -> dict:
    started = perf_counter()
    result: dict = {}
    error_message: str | None = None
    error_type: str | None = None
    status_code = 502
    try:
        if tool.kind == "mcp":
            raise HTTPException(status_code=422, detail="MCP 协议客户端尚未接入")
        result = await request_external(
            tool.method,
            tool.url,
            headers=_headers(tool),
            timeout_seconds=tool.timeout_seconds,
            payload=payload,
        )
        status_code = result["status_code"]
        if status_code >= 400:
            raise HTTPException(status_code=502, detail=f"目标服务返回 HTTP {status_code}")
        return result
    except (HealthCheckFailure, HTTPException) as exc:
        error_type = type(exc).__name__
        error_message = str(exc) if isinstance(exc, HealthCheckFailure) else str(exc.detail)
        raise
    finally:
        record_operation(
            db,
            tool_id=tool.id,
            kind="tool",
            operation=operation,
            status="failed" if error_message else "completed",
            input_json=payload,
            output_json=result,
            context_json={"tool_name": tool.name, "tool_kind": tool.kind, "method": tool.method, "url": safe_external_url(tool.url)},
            http_status=status_code if result else None,
            latency_ms=round((perf_counter() - started) * 1000, 3),
            error_type=error_type,
            error_message=error_message,
        )
        db.commit()


@router.post("/tools/{tool_id}/health-check")
async def health_check_tool(tool_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> dict:
    tool = _tool_or_404(db, tool_id)
    result = await _observed_tool_call(db, tool, operation="health_check")
    return {"status": "healthy", "status_code": result["status_code"]}


@router.post("/tools/{tool_id}/invoke")
async def invoke_tool(tool_id: str, payload: ToolInvokeRequest, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> dict:
    tool = _tool_or_404(db, tool_id)
    if not tool.enabled:
        raise HTTPException(status_code=409, detail="工具已停用")
    return await _observed_tool_call(db, tool, operation="invoke", payload=payload.input or None)


@router.get("/settings/api-keys", response_model=list[ApiKeyRead])
def list_api_keys(_=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> list[ApiKey]:
    return list(db.scalars(select(ApiKey).order_by(ApiKey.created_at.desc())).all())


@router.post("/settings/api-keys", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
def create_api_key(payload: ApiKeyCreate, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> ApiKey:
    secret = f"zs-app-{uuid4().hex}"
    api_key = ApiKey(
        name=payload.name.strip(),
        prefix=secret[:16],
        secret_hash=hashlib.sha256(secret.encode()).hexdigest(),
        quota_per_day=payload.quota_per_day,
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    api_key.secret = secret
    return api_key


@router.delete("/settings/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_api_key(key_id: str, _=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> Response:
    api_key = db.get(ApiKey, key_id)
    if api_key is None:
        raise HTTPException(status_code=404, detail="API 密钥不存在")
    api_key.revoked = True
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/insights/summary", response_model=InsightSummary)
def insight_summary(_=Depends(require_knowledge_manager), db: Session = Depends(get_db)) -> InsightSummary:
    total_ms = list(db.scalars(select(QueryLog.total_ms).where(QueryLog.total_ms.is_not(None)).order_by(QueryLog.total_ms)).all())
    p95 = total_ms[min(len(total_ms) - 1, int(len(total_ms) * 0.95))] if total_ms else None
    usage = db.execute(
        select(
            ModelCallLog.provider,
            ModelCallLog.model_id,
            func.sum(ModelCallLog.total_tokens),
            func.sum(ModelCallLog.input_tokens + ModelCallLog.output_tokens),
            func.count(ModelCallLog.id),
        ).group_by(ModelCallLog.provider, ModelCallLog.model_id)
    ).all()
    return InsightSummary(
        knowledge_base_count=db.scalar(select(func.count(KnowledgeBase.id))) or 0,
        document_count=db.scalar(select(func.count(Document.id))) or 0,
        chunk_count=db.scalar(select(func.count(Chunk.id))) or 0,
        conversation_count=db.scalar(select(func.count(Conversation.id))) or 0,
        query_count=db.scalar(select(func.count(QueryLog.id))) or 0,
        failed_query_count=db.scalar(select(func.count(QueryLog.id)).where(QueryLog.status == "failed")) or 0,
        total_tokens=db.scalar(select(func.coalesce(func.sum(ModelCallLog.total_tokens), 0))) or 0,
        estimated_tokens=db.scalar(select(func.coalesce(func.sum(ModelCallLog.total_tokens), 0)).where(ModelCallLog.estimated.is_(True))) or 0,
        average_total_ms=db.scalar(select(func.avg(QueryLog.total_ms))),
        p95_total_ms=p95,
        model_usage=[
            {"provider": provider, "model_id": model_id, "total_tokens": total, "call_count": count}
            for provider, model_id, total, _, count in usage
        ],
    )
