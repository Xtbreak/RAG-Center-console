import re
from html.parser import HTMLParser
from io import BytesIO
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from .adapters import HealthCheckFailure
from .app_schemas import KnowledgeSourceRequest
from .auth import require_knowledge_manager
from .database import get_db
from .http_utils import request_external
from .knowledge_api import upload_document
from .schemas import DocumentRead

router = APIRouter()


class _WebTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg", "noscript"}:
            self.ignored_depth += 1
        elif not self.ignored_depth and tag in {"p", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg", "noscript"} and self.ignored_depth:
            self.ignored_depth -= 1
        elif not self.ignored_depth and tag in {"p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.ignored_depth:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", "".join(self.parts))).strip()


def _markdown_source(payload: KnowledgeSourceRequest) -> tuple[str, str]:
    title = payload.title.strip() or "自定义文本"
    if payload.source == "text":
        content = payload.content.strip()
        if not content:
            raise HTTPException(status_code=422, detail="请输入需要导入的文本")
        return title, f"# {title}\n\n{content}\n"
    pairs: list[tuple[str, str]] = []
    for pair in payload.qa_pairs:
        question = pair.get("question", "").strip()
        answer = pair.get("answer", "").strip()
        if not question or not answer:
            raise HTTPException(status_code=422, detail="每个问答对都必须填写问题和答案")
        pairs.append((question, answer))
    if not pairs:
        raise HTTPException(status_code=422, detail="请至少填写一个完整的问答对")
    body = "\n\n".join(f"## {question}\n\n{answer}" for question, answer in pairs)
    return title, f"# {title}\n\n{body}\n"


@router.post(
    "/knowledge-bases/{knowledge_base_id}/documents/from-source",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
)
async def import_knowledge_source(
    knowledge_base_id: str,
    payload: KnowledgeSourceRequest,
    _=Depends(require_knowledge_manager),
    db: Session = Depends(get_db),
) -> DocumentRead:
    if payload.source == "web":
        if not payload.url:
            raise HTTPException(status_code=422, detail="请输入需要抓取的网页链接")
        url = str(payload.url)
        try:
            result = await request_external("GET", url, headers={"Accept": "text/html"}, timeout_seconds=20)
        except HealthCheckFailure as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if result["status_code"] >= 400:
            raise HTTPException(status_code=422, detail=f"网页返回 HTTP {result['status_code']}，无法导入")
        content_type = result["headers"].get("content-type", "")
        if content_type and not any(value in content_type.lower() for value in ("text/html", "application/xhtml", "text/plain")):
            raise HTTPException(status_code=422, detail="链接不是可导入的网页或纯文本")
        parser = _WebTextParser()
        parser.feed(result["body"] if isinstance(result["body"], str) else "")
        text = parser.text()
        if not text:
            raise HTTPException(status_code=422, detail="网页中没有可导入的正文")
        title = payload.title.strip() or urlsplit(url).hostname or "网页资料"
        markdown = f"# {title}\n\n来源：{url}\n\n{text}\n"
    else:
        title, markdown = _markdown_source(payload)
    filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", title).strip()[:180] or "导入资料"
    upload = UploadFile(file=BytesIO(markdown.encode("utf-8")), filename=f"{filename}.md", headers={"content-type": "text/markdown"})
    return upload_document(
        knowledge_base_id,
        file=upload,
        parse_strategy="local",
        enhance_images=False,
        allow_duplicate=payload.allow_duplicate,
        chunk_method=None,
        chunk_size=None,
        chunk_overlap=None,
        heading_level=None,
        separators=None,
        semantic_threshold=None,
        db=db,
    )
