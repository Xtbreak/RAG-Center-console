"""本地切分：按标题切分与递归切分，均不依赖云端或大模型。"""

import bisect
import hashlib
import math
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from .parsing import Element, ParsedDocument

ChunkMethod = Literal["heading", "recursive"]
CHUNK_METHODS: tuple[str, ...] = ("heading", "recursive")

# 中日韩文字及全角标点各按约 1 Token 计
_CJK = re.compile(r"[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]")
# 递归切分的分隔符优先级：段落 → 换行 → 句末标点 → 句内标点 → 空格 → 单字符
DEFAULT_SEPARATORS: tuple[str, ...] = ("\n\n", "\n", "。", "！", "？", "!", "?", "；", ";", ". ", "，", ",", "、", " ", "")


def estimate_tokens(text: str) -> int:
    """无需下载分词表的近似估算：中日韩字符约 1 Token，其余约 4 字符 1 Token。"""
    cjk = len(_CJK.findall(text))
    return cjk + math.ceil((len(text) - cjk) / 4)


def _token_weight(text: str) -> float:
    # 合并片段时按小数累加，避免单字符片段各自向上取整导致高估
    cjk = len(_CJK.findall(text))
    return cjk + (len(text) - cjk) / 4


@dataclass
class ChunkDraft:
    kind: str
    content: str
    token_count: int
    location: dict[str, Any] = field(default_factory=dict)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.content.encode()).hexdigest()


def _atomic_spans(text: str, start: int, end: int, size: int, separators: tuple[str, ...]) -> list[tuple[int, int]]:
    """把 text[start:end] 拆成不超过 size 的最小片段；分隔符保留在片段末尾，片段首尾相接覆盖原文。"""
    if _token_weight(text[start:end]) <= size:
        return [(start, end)]
    for index, separator in enumerate(separators):
        if separator == "":
            return [(position, position + 1) for position in range(start, end)]
        if text.find(separator, start, end) == -1:
            continue
        spans: list[tuple[int, int]] = []
        cursor = start
        while cursor < end:
            found = text.find(separator, cursor, end)
            piece_end = end if found == -1 else found + len(separator)
            spans.extend(_atomic_spans(text, cursor, piece_end, size, separators[index + 1 :]))
            cursor = piece_end
        return spans
    return [(start, end)]


def recursive_split(
    text: str, size: int, overlap: int, separators: tuple[str, ...] = DEFAULT_SEPARATORS
) -> list[tuple[int, int]]:
    """递归切分：按分隔符优先级拆成小片段，再贪心合并到 size 以内，相邻分段保留约 overlap 的重叠。

    返回分段在原文中的 (起点, 终点)，便于定位标题和页码。
    """
    pieces = _atomic_spans(text, 0, len(text), size, separators)
    weights = [_token_weight(text[a:b]) for a, b in pieces]
    chunks: list[tuple[int, int]] = []
    window: list[int] = []
    total = 0.0
    for index, weight in enumerate(weights):
        if window and total + weight > size:
            chunks.append((pieces[window[0]][0], pieces[window[-1]][1]))
            # 从窗口头部移除片段，直到剩余部分不超过重叠量且能容纳新片段
            while window and (total > overlap or total + weight > size):
                total -= weights[window.pop(0)]
        window.append(index)
        total += weight
    if window:
        chunks.append((pieces[window[0]][0], pieces[window[-1]][1]))
    trimmed: list[tuple[int, int]] = []
    for start, end in chunks:
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end and (not trimmed or trimmed[-1] != (start, end)):
            trimmed.append((start, end))
    return trimmed


_CN_NUM = "一二三四五六七八九十百千零〇两"
# 中文编号标题，按层级从高到低排列；最终层级按文档中实际出现的种类重新编号
_NUMBERED_HEADINGS: tuple[tuple[re.Pattern[str], int], ...] = (
    (re.compile(rf"^第[{_CN_NUM}\d]+[编篇](?:\s|$)"), 0),
    (re.compile(rf"^第[{_CN_NUM}\d]+部分(?:\s|$)"), 0),
    (re.compile(rf"^第[{_CN_NUM}\d]+章(?:\s|$)"), 1),
    (re.compile(rf"^第[{_CN_NUM}\d]+节(?:\s|$)"), 2),
    (re.compile(rf"^第[{_CN_NUM}\d]+条(?:\s|$)"), 3),
    (re.compile(rf"^[{_CN_NUM}]+、"), 4),
    (re.compile(rf"^[（(][{_CN_NUM}]+[）)]"), 5),
)
_DOTTED_HEADING = re.compile(r"^(\d+(?:\.\d+)+)\.?\s+\S")
_HEADING_MAX_CHARS = 40
_SENTENCE_PUNCTUATION = tuple("。；;，,：:！!？?")


def _numbered_heading_rank(line: str) -> int | None:
    if len(line) > _HEADING_MAX_CHARS or line.endswith(_SENTENCE_PUNCTUATION):
        return None
    for pattern, rank in _NUMBERED_HEADINGS:
        if pattern.match(line):
            return rank
    dotted = _DOTTED_HEADING.match(line)
    if dotted:
        return 5 + dotted.group(1).count(".")
    return None


def detect_numbered_headings(elements: list[Element]) -> list[Element]:
    """文档没有 Markdown 标题时，把“第一章 / 一、/（一）/ 1.1”这类短标题行识别为标题。

    只看段落的首行，避免把正文误判为标题；层级按文档中出现的编号种类依次编为 1、2、3……
    """
    if any(element.kind == "heading" and element.sheet is None for element in elements):
        return elements
    candidates: list[tuple[Element, int | None, str, str]] = []
    for element in elements:
        if element.kind != "paragraph":
            candidates.append((element, None, "", ""))
            continue
        first, _, rest = element.text.strip().partition("\n")
        candidates.append((element, _numbered_heading_rank(first.strip()), first.strip(), rest.strip()))
    ranks = sorted({rank for _, rank, _, _ in candidates if rank is not None})
    if not ranks:
        return elements
    level_of = {rank: index + 1 for index, rank in enumerate(ranks)}
    result: list[Element] = []
    for element, rank, first, rest in candidates:
        if rank is None:
            result.append(element)
            continue
        result.append(Element("heading", text=first, level=level_of[rank], page=element.page))
        if rest:
            result.append(Element("paragraph", text=rest, page=element.page))
    return result


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


def _location(path: list[str], page: int | None) -> dict[str, Any]:
    location: dict[str, Any] = {"heading_path": list(path)}
    if page is not None:
        location["page"] = page
    return location


class _TextStream:
    """累积一段连续文本，并记录每个片段起点对应的标题路径和页码。"""

    def __init__(self) -> None:
        self.parts: list[str] = []
        self.length = 0
        self.starts: list[int] = []
        self.locations: list[tuple[list[str], int | None]] = []

    def add(self, text: str, path: list[str], page: int | None) -> None:
        if self.parts:
            self.parts.append("\n\n")
            self.length += 2
        self.starts.append(self.length)
        self.locations.append((list(path), page))
        self.parts.append(text)
        self.length += len(text)

    def location_at(self, offset: int) -> tuple[list[str], int | None]:
        return self.locations[max(bisect.bisect_right(self.starts, offset) - 1, 0)]

    def text(self) -> str:
        return "".join(self.parts)


def _split_stream(stream: _TextStream, size: int, overlap: int, kind: str = "text") -> list[ChunkDraft]:
    text = stream.text()
    drafts = []
    for start, end in recursive_split(text, size, overlap):
        content = text[start:end]
        path, page = stream.location_at(start)
        drafts.append(ChunkDraft(kind, content, estimate_tokens(content), _location(path, page)))
    return drafts


def chunk_document(
    parsed: ParsedDocument,
    chunk_size: int,
    chunk_overlap: int,
    method: ChunkMethod = "heading",
    heading_level: int = 6,
) -> list[ChunkDraft]:
    """把解析结果切成分段。

    - heading：按标题划分章节（第 1 至 heading_level 级标题为边界，更深的标题并入所属章节），
      每节独立成段，超长章节再递归切分；无 Markdown 标题时自动识别中文编号标题。
    - recursive：忽略标题边界，按段落、换行、句子、标点逐级递归切分并合并到目标长度。

    两种方式下表格都按表头分组数据行，图片描述单独成段。
    """
    overlap = min(max(chunk_overlap, 0), max(chunk_size - 1, 0))
    elements = detect_numbered_headings(parsed.elements) if method == "heading" else parsed.elements
    drafts: list[ChunkDraft] = []
    headings: list[tuple[int, str]] = []
    stream = _TextStream()

    def path() -> list[str]:
        return [title for _, title in headings]

    def flush() -> None:
        nonlocal stream
        if stream.parts:
            drafts.extend(_split_stream(stream, chunk_size, overlap))
        stream = _TextStream()

    for element in elements:
        if element.kind == "heading":
            if method == "heading" and element.level > heading_level:
                # 低于切分层级的标题作为正文的一行保留在当前章节
                stream.add(element.text, path(), element.page)
                continue
            if method == "heading":
                flush()
            while headings and headings[-1][0] >= element.level:
                headings.pop()
            headings.append((element.level, element.text))
            if method == "recursive":
                stream.add(element.text, path(), element.page)
        elif element.kind == "table":
            flush()
            drafts.extend(_table_chunks(element, chunk_size, _location(path(), element.page)))
        elif element.kind == "image":
            flush()
            location = {**_location(path(), element.page), **element.extra}
            drafts.append(ChunkDraft("image", element.text, estimate_tokens(element.text), location))
        elif element.text.strip():
            stream.add(element.text.strip(), path(), element.page)
    flush()
    return drafts
