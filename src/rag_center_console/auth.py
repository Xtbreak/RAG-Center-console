from collections.abc import Callable
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException
from sqlalchemy.orm import Session

from .database import get_db
from .models import AnonymousSession, Role

SESSION_COOKIE = "rag_session"


def get_current_role(rag_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> Role:
    """无登录演示模式：按匿名会话中的角色分流接口，不构成安全鉴权。"""
    try:
        session_id = str(UUID(rag_session)) if rag_session else None
    except ValueError:
        session_id = None
    anonymous_session = db.get(AnonymousSession, session_id) if session_id else None
    if anonymous_session is None:
        raise HTTPException(status_code=401, detail="请先选择角色")
    return Role(anonymous_session.role)


def require_roles(*roles: Role) -> Callable[..., Role]:
    def dependency(role: Role = Depends(get_current_role)) -> Role:
        if role not in roles:
            raise HTTPException(status_code=403, detail="当前角色无权执行此操作")
        return role

    return dependency


require_knowledge_manager = require_roles(Role.ADMIN, Role.MANAGER)
