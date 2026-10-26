import csv
import io
import re
from dataclasses import dataclass, field
from typing import Any


class ParseError(RuntimeError):
    """文件无法解析，消息可直接展示给用户。"""


@dataclass
class Element:
    """解析后的结构化片段。kind: heading | paragraph | table | image。"""

    kind: str
    text: str = ""
    level: int = 0
    page: int | None = None
    # 表格：header + rows（均为字符串）；sheet 为工作表名
    header: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    sheet: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedDocument:
    elements: list[Element]


LOCAL_EXTENSIONS = frozenset({"md", "csv", "xlsx", "xls"})
CLOUD_EXTENSIONS = frozenset({"pdf", "doc", "docx", "png", "jpg", "jpeg", "webp", "tiff"})


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ParseError("无法识别文件编码，请转换为 UTF-8 后重试")


_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]*)\)")


def _split_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_markdown(data: bytes) -> ParsedDocument:
    lines = decode_text(data).splitlines()
    elements: list[Element] = []
    paragraph: list[str] = []
    index = 0

    def flush() -> None:
        text = "\n".join(paragraph).strip()
        paragraph.clear()
        if text:
            elements.append(Element("paragraph", text=_IMAGE.sub(lambda m: m.group(1) or "", text).strip() or text))

    while index < len(lines):
        line = lines[index]
        if _FENCE.match(line):
            flush()
            fence = _FENCE.match(line).group(1)
            block = [line]
            index += 1
            while index < len(lines):
                block.append(lines[index])
                if lines[index].strip().startswith(fence):
                    break
                index += 1
            elements.append(Element("paragraph", text="\n".join(block)))
        elif heading := _HEADING.match(line):
            flush()
            elements.append(Element("heading", text=heading.group(2), level=len(heading.group(1))))
        elif (
            _TABLE_ROW.match(line)
            and index + 1 < len(lines)
            and _TABLE_SEPARATOR.match(lines[index + 1])
        ):
            flush()
            header = _split_table_row(line)
            rows: list[list[str]] = []
            index += 2
            while index < len(lines) and _TABLE_ROW.match(lines[index]):
                rows.append(_split_table_row(lines[index]))
                index += 1
            elements.append(Element("table", header=header, rows=rows))
            continue
        elif not line.strip():
            flush()
        else:
            paragraph.append(line)
        index += 1
    flush()
    if not elements:
        raise ParseError("Markdown 文件没有可解析的文本内容")
    return ParsedDocument(elements)


def _clean_rows(rows: list[list[Any]]) -> list[list[str]]:
    cleaned = [["" if cell is None else str(cell).strip() for cell in row] for row in rows]
    cleaned = [row for row in cleaned if any(row)]
    width = max((len(row) for row in cleaned), default=0)
    return [row + [""] * (width - len(row)) for row in cleaned]


def _table_element(rows: list[list[Any]], sheet: str | None = None) -> Element | None:
    cleaned = _clean_rows(rows)
    if not cleaned:
        return None
    header = [name or f"列{position + 1}" for position, name in enumerate(cleaned[0])]
    return Element("table", header=header, rows=cleaned[1:], sheet=sheet)


def parse_csv(data: bytes) -> ParsedDocument:
    text = decode_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    element = _table_element(list(csv.reader(io.StringIO(text), dialect)))
    if element is None:
        raise ParseError("CSV 文件没有可解析的内容")
    return ParsedDocument([element])


def parse_xlsx(data: bytes) -> ParsedDocument:
    from openpyxl import load_workbook

    try:
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # openpyxl 对损坏文件抛出多种异常
        raise ParseError("无法读取 XLSX 文件，文件可能已损坏或受密码保护") from exc
    elements = []
    for sheet in workbook.worksheets:
        element = _table_element([list(row) for row in sheet.iter_rows(values_only=True)], sheet.title)
        if element:
            elements.append(Element("heading", text=sheet.title, level=1, sheet=sheet.title))
            elements.append(element)
    workbook.close()
    if not elements:
        raise ParseError("XLSX 文件没有可解析的内容")
    return ParsedDocument(elements)


def parse_xls(data: bytes) -> ParsedDocument:
    import xlrd

    try:
        workbook = xlrd.open_workbook(file_contents=data)
    except Exception as exc:
        raise ParseError("无法读取 XLS 文件，文件可能已损坏或受密码保护") from exc
    elements = []
    for sheet in workbook.sheets():
        element = _table_element([sheet.row_values(row) for row in range(sheet.nrows)], sheet.name)
        if element:
            elements.append(Element("heading", text=sheet.name, level=1, sheet=sheet.name))
            elements.append(element)
    if not elements:
        raise ParseError("XLS 文件没有可解析的内容")
    return ParsedDocument(elements)


_LOCAL_PARSERS = {"md": parse_markdown, "csv": parse_csv, "xlsx": parse_xlsx, "xls": parse_xls}


def parse_local(extension: str, data: bytes) -> ParsedDocument:
    return _LOCAL_PARSERS[extension](data)
