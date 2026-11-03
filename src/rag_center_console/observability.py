import json
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.orm import Session

from .models import OperationLog

MAX_CONTEXT_CHARS = 64000
SENSITIVE_KEYS = {
    "authorization", "proxy-authorization", "x-api-key", "api_key", "apikey",
    "access_key", "accesskey", "access_key_secret", "secret", "password", "cookie",
}


def safe_context(value: Any, *, max_chars: int = MAX_CONTEXT_CHARS) -> Any:
    if isinstance(value, dict):
        cleaned = {
            str(key): "[已脱敏]" if str(key).casefold() in SENSITIVE_KEYS else safe_context(item, max_chars=max_chars)
            for key, item in value.items()
        }
    elif isinstance(value, (list, tuple)):
        cleaned = [safe_context(item, max_chars=max_chars) for item in value]
    elif isinstance(value, (str, int, float, bool)) or value is None:
        cleaned = value
    else:
        cleaned = str(value)
    try:
        serialized = json.dumps(cleaned, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(cleaned)[:max_chars]
    if len(serialized) > max_chars:
        return {"truncated": True, "text": serialized[:max_chars]}
    return cleaned


def safe_output_text(value: str) -> str:
    return value if len(value) <= MAX_CONTEXT_CHARS else value[:MAX_CONTEXT_CHARS] + "\n[内容已截断]"


def safe_external_url(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def record_operation(db: Session, **values: Any) -> OperationLog:
    for key in ("input_json", "output_json", "context_json"):
        if key in values:
            values[key] = safe_context(values[key])
    operation = OperationLog(**values)
    db.add(operation)
    return operation
