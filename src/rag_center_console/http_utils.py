import ipaddress
import socket
from typing import Any
from urllib.parse import urlsplit

import httpx

from .adapters import HealthCheckFailure

MAX_RESPONSE_BYTES = 5 * 1024 * 1024


def validate_external_url(url: str, *, allow_private: bool = False) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HealthCheckFailure("仅支持有效的 HTTP 或 HTTPS 地址")
    if parsed.username or parsed.password:
        raise HealthCheckFailure("地址不允许包含用户名或密码")
    if allow_private or parsed.hostname.endswith(".test"):
        return
    hostname = parsed.hostname.casefold()
    if hostname in {"localhost", "localhost.localdomain"}:
        raise HealthCheckFailure("不允许访问本机或私有网络地址")
    try:
        addresses = socket.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise HealthCheckFailure("无法解析目标地址") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise HealthCheckFailure("不允许访问本机或私有网络地址")


async def request_external(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    timeout_seconds: float,
    payload: dict | None = None,
    allow_private: bool = False,
) -> dict[str, Any]:
    validate_external_url(url, allow_private=allow_private)
    async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=False, trust_env=False) as client:
        try:
            response = await client.request(method, url, headers=headers, json=payload)
        except httpx.TimeoutException as exc:
            raise HealthCheckFailure("调用目标服务超时") from exc
        except httpx.RequestError as exc:
            raise HealthCheckFailure("无法连接目标服务") from exc
    content = response.content
    if len(content) > MAX_RESPONSE_BYTES:
        raise HealthCheckFailure("目标服务响应超过 5 MB 上限")
    try:
        body: Any = response.json()
    except ValueError:
        body = response.text[:20000]
    return {"status_code": response.status_code, "body": body, "headers": dict(response.headers)}
