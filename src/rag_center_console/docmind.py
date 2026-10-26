"""阿里云文档智能（文档解析·大模型版）适配器：提交 → 轮询 → 分页取回 layouts → 转为结构化片段。

结果中 layouts 的字段按官方常见返回格式（type、subType、level、pageNum、text、markdownContent、pos）容错解析，
在配置真实 AccessKey 完成验证前视为“未验证”。
"""

import io
import time
from collections.abc import Callable
from typing import Any

from .parsing import Element, ParsedDocument, ParseError, parse_markdown

_SUCCESS = {"success", "succeed", "succeeded", "finished"}
_FAILED = {"fail", "failed", "error"}
_SKIPPED_TYPES = {"head", "header", "foot", "footer", "page_number", "pagenumber"}
_IMAGE_TYPES = {"figure", "image", "picture", "pic"}
PAGE_SIZE = 100


class ParseCancelled(RuntimeError):
    pass


def _explain(code: str, message: str) -> str:
    """把阿里云错误码翻译成可操作的提示。"""
    if code == "NoPermission" or code.startswith("Forbidden"):
        return f"阿里云拒绝访问（{code}）：请确认已开通“文档解析（大模型版）”，并为 RAM 用户授予 AliyunDocmindFullAccess 权限"
    if code.startswith("InvalidAccessKeyId") or code in {"SignatureDoesNotMatch", "IncompleteSignature"}:
        return f"阿里云 AccessKey 无效或已禁用（{code}），请检查配置"
    if code.startswith("Throttling"):
        return f"阿里云调用过于频繁（{code}），请稍后重试"
    return f"阿里云返回错误 {code}：{message}"[:200]


def _page_of(layout: dict[str, Any]) -> int | None:
    page = layout.get("pageNum")
    if isinstance(page, list):
        page = page[0] if page else None
    return page + 1 if isinstance(page, int) and page >= 0 else None


def layouts_to_elements(layouts: list[dict[str, Any]]) -> list[Element]:
    elements: list[Element] = []
    for layout in layouts:
        kind = str(layout.get("type") or "").lower()
        sub_kind = str(layout.get("subType") or "").lower()
        if kind in _SKIPPED_TYPES or sub_kind in _SKIPPED_TYPES:
            continue
        text = str(layout.get("text") or "").strip()
        markdown = str(layout.get("markdownContent") or "").strip()
        page = _page_of(layout)
        extra = {"region": layout["pos"]} if layout.get("pos") else {}
        if kind == "table":
            table = next(
                (item for item in _safe_markdown(markdown) if item.kind == "table"),
                None,
            )
            if table is not None:
                table.page = page
                elements.append(table)
            elif text or markdown:
                elements.append(Element("paragraph", text=text or markdown, page=page))
        elif kind in _IMAGE_TYPES:
            elements.append(Element("image", text=text, page=page, extra=extra))
        elif kind == "title" or "title" in sub_kind:
            if text:
                level = layout.get("level")
                elements.append(Element("heading", text=text, level=level if isinstance(level, int) and level > 0 else 1, page=page))
        elif text:
            elements.append(Element("paragraph", text=text, page=page))
    return elements


def _safe_markdown(markdown: str) -> list[Element]:
    try:
        return parse_markdown(markdown.encode()).elements if markdown else []
    except ParseError:
        return []


class DocmindParser:
    def __init__(
        self,
        access_key_id: str,
        access_key_secret: str,
        endpoint: str,
        *,
        sdk_client: Any | None = None,
        poll_interval: float = 2.0,
        timeout: float = 900.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if sdk_client is None and not (access_key_id and access_key_secret):
            raise ParseError("未配置阿里云文档智能 AccessKey，无法解析 PDF、Word 和图片")
        self._access_key_secret = access_key_secret
        self._poll_interval = poll_interval
        self._timeout = timeout
        self._sleep = sleep
        self._client = sdk_client or self._build_client(access_key_id, access_key_secret, endpoint)

    @staticmethod
    def _build_client(access_key_id: str, access_key_secret: str, endpoint: str) -> Any:
        from alibabacloud_docmind_api20220711.client import Client
        from alibabacloud_tea_openapi.utils_models import Config

        return Client(Config(access_key_id=access_key_id, access_key_secret=access_key_secret, endpoint=endpoint))

    def _fail(self, exc: Exception) -> ParseError:
        message = str(exc).replace(self._access_key_secret, "***") if self._access_key_secret else str(exc)
        code = getattr(exc, "code", None)
        if isinstance(code, str) and code:
            return ParseError(_explain(code, message))
        return ParseError(f"阿里云文档解析失败：{message[:200]}")

    @staticmethod
    def _data(response: Any) -> Any:
        # 业务错误（如未授权）不抛异常，而是返回 Code/Message 且 Data 为空
        body = response.body
        code = getattr(body, "code", None)
        if getattr(body, "data", None) is None or (code and str(code) not in {"200", "Success", "success"}):
            raise ParseError(_explain(str(code or "Unknown"), str(getattr(body, "message", "") or "")))
        return body.data

    def parse(
        self,
        data: bytes,
        filename: str,
        extension: str,
        should_cancel: Callable[[], bool] = lambda: False,
        llm_enhancement: bool = True,
    ) -> ParsedDocument:
        from alibabacloud_docmind_api20220711 import models
        from darabonba.runtime import RuntimeOptions

        try:
            submitted = self._client.submit_doc_parser_job_advance(
                models.SubmitDocParserJobAdvanceRequest(
                    file_url_object=io.BytesIO(data),
                    file_name=filename,
                    file_name_extension=extension,
                    llm_enhancement=llm_enhancement,
                ),
                RuntimeOptions(),
            )
            job_id = self._data(submitted).id
            expected = self._wait(models, job_id, should_cancel)
            layouts = self._fetch_layouts(models, job_id, expected)
        except (ParseError, ParseCancelled):
            raise
        except Exception as exc:  # SDK 与网络层异常类型繁多，统一转为可展示错误
            raise self._fail(exc) from exc
        elements = layouts_to_elements(layouts)
        if not elements:
            raise ParseError("云端解析未返回可用内容")
        return ParsedDocument(elements)

    def _wait(self, models: Any, job_id: str, should_cancel: Callable[[], bool]) -> int | None:
        deadline = time.monotonic() + self._timeout
        while True:
            if should_cancel():
                raise ParseCancelled()
            status = self._data(self._client.query_doc_parser_status(models.QueryDocParserStatusRequest(id=job_id)))
            state = str(getattr(status, "status", "") or "").lower()
            if state in _SUCCESS:
                return getattr(status, "number_of_successful_parsing", None)
            if state in _FAILED:
                raise ParseError("阿里云文档解析任务失败，请检查文件是否损坏、加密或超出页数限制")
            if time.monotonic() > deadline:
                raise ParseError("阿里云文档解析超时")
            self._sleep(self._poll_interval)

    def _fetch_layouts(self, models: Any, job_id: str, expected: int | None) -> list[dict[str, Any]]:
        layouts: list[dict[str, Any]] = []
        while True:
            result = self._data(
                self._client.get_doc_parser_result(
                    models.GetDocParserResultRequest(id=job_id, layout_num=len(layouts), layout_step_size=PAGE_SIZE)
                )
            )
            page = (result or {}).get("layouts") or []
            if not page:
                break
            layouts.extend(page)
            if expected is not None and len(layouts) >= expected:
                break
        return layouts
