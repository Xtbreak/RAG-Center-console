import hashlib
import math
import re
from dataclasses import dataclass, field
from typing import Any

from .parsing import Element, ParsedDocument

_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]")
# 零宽切分：分隔符（标点、空白、换行）都保留在片段里，拼接后与原文一致
_SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n])|(?<=[.])(?=\s)")


def estimate_tokens(text: str) -> int:
    """无需下载分词表的近似估算：中日韩字符约 1 Token，其余约 4 字符 1 Token。"""
    cjk = len(_CJK.findall(text))
    return cjk + math.ceil((len(text) - cjk) / 4)


@dataclass
class ChunkDraft:
    kind: str
    content: str
    token_count: int
    location: dict[str, Any] = field(default_factory=dict)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.content.encode()).hexdigest()


def _split_long_text(text: str, size: int, overlap: int) -> list[str]:
    """先按句子聚合；单句仍超长时按字符窗口硬切分，窗口之间保留重叠。"""
    sentences = [part for part in _SENTENCE_END.split(text) if part]
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if estimate_tokens(sentence) > size:
            if current:
                pieces.append(current)
                current = ""
            pieces.extend(_hard_split(sentence, size, overlap))
        elif estimate_tokens(current + sentence) > size and current:
            pieces.append(current)
            current = sentence
        else:
            current += sentence
    if current.strip():
        pieces.append(current)
    return [piece.strip() for piece in pieces if piece.strip()]


def _hard_split(text: str, size: int, overlap: int) -> list[str]:
    pieces: list[str] = []
    start = 0
    while start < len(text):
        end = start + 1
        while end < len(text) and estimate_tokens(text[start : end + 1]) <= size:
            end += 1
        pieces.append(text[start:end])
        if end >= len(text):
            break
        step = max(end - start - overlap, 1)
        start += step
    return pieces


def _markdown_table(header: list[str], rows: list[list[str]]) -> str:
    def row(cells: list[str]) -> str:
        return "| " + " | ".join(cell.replace("\n", " ").replace("|", "\\|") for cell in cells) + " |"

    return "\n".join([row(header), "| " + " | ".join("---" for _ in header) + " |", *(row(r) for r in rows)])


def _table_chunks(element: Element, size: int, base: dict[str, Any]) -> list[ChunkDraft]:
    """按表头分组数据行：每个分段都带完整表头，并记录行号范围。"""
    drafts: list[ChunkDraft] = []
    batch: list[list[str]] = []
    first = 1

    def emit(last: int) -> None:
        if not batch:
            return
        content = _markdown_table(element.header, batch)
        location = {**base, "rows": [first, last]}
        if element.sheet:
            location["sheet"] = element.sheet
        drafts.append(ChunkDraft("table", content, estimate_tokens(content), location))

    for number, row in enumerate(element.rows, start=1):
        candidate = _markdown_table(element.header, [*batch, row])
        if batch and estimate_tokens(candidate) > size:
            emit(number - 1)
            batch = []
            first = number
        batch.append(row)
    emit(len(element.rows))
    if not drafts and element.header:
        content = _markdown_table(element.header, [])
        location = {**base, **({"sheet": element.sheet} if element.sheet else {})}
        drafts.append(ChunkDraft("table", content, estimate_tokens(content), location))
    return drafts


def chunk_document(parsed: ParsedDocument, chunk_size: int, chunk_overlap: int) -> list[ChunkDraft]:
    """标题与段落优先：同一标题下的段落合并到 chunk_size 内，超长段落再按句子和 Token 切分。"""
    overlap = min(chunk_overlap, max(chunk_size - 1, 0))
    drafts: list[ChunkDraft] = []
    headings: list[tuple[int, str]] = []
    buffer: list[str] = []
    buffer_page: int | None = None

    def path() -> list[str]:
        return [title for _, title in headings]

    def base(page: int | None) -> dict[str, Any]:
        location: dict[str, Any] = {"heading_path": path()}
        if page is not None:
            location["page"] = page
        return location

    def flush() -> None:
        nonlocal buffer_page
        text = "\n\n".join(buffer).strip()
        buffer.clear()
        if text:
            for piece in _split_long_text(text, chunk_size, overlap):
                drafts.append(ChunkDraft("text", piece, estimate_tokens(piece), base(buffer_page)))
        buffer_page = None

    for element in parsed.elements:
        if element.kind == "heading":
            flush()
            while headings and headings[-1][0] >= element.level:
                headings.pop()
            headings.append((element.level, element.text))
        elif element.kind == "table":
            flush()
            drafts.extend(_table_chunks(element, chunk_size, base(element.page)))
        elif element.kind == "image":
            flush()
            location = {**base(element.page), **element.extra}
            drafts.append(ChunkDraft("image", element.text, estimate_tokens(element.text), location))
        else:
            if buffer and estimate_tokens("\n\n".join([*buffer, element.text])) > chunk_size:
                flush()
            if not buffer:
                buffer_page = element.page
            buffer.append(element.text)
    flush()
    return drafts
