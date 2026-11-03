import io
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import fitz
from docx import Document
from docx.oxml.ns import qn
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph

from .parsing import Element, ParsedDocument, ParseError, _table_element


def _intersects(left: Any, right: Any) -> bool:
    return fitz.Rect(left).intersects(fitz.Rect(right))


def parse_pdf(data: bytes) -> ParsedDocument:
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ParseError("无法读取 PDF，文件可能已损坏或受密码保护") from exc
    elements: list[Element] = []
    try:
        for page in document:
            page_number = page.number + 1
            table_regions: list[Any] = []
            try:
                tables = page.find_tables().tables
            except Exception:
                tables = []
            for table in tables:
                element = _table_element(table.extract())
                if element:
                    element.page = page_number
                    element.extra["region"] = list(table.bbox)
                    elements.append(element)
                    table_regions.append(table.bbox)
            page_dict = page.get_text("dict", sort=True)
            sizes = [
                span["size"]
                for block in page_dict["blocks"]
                if block.get("type") == 0
                for line in block.get("lines", [])
                for span in line.get("spans", [])
                if span.get("text", "").strip()
            ]
            body_size = sorted(sizes)[len(sizes) // 2] if sizes else 11.0
            for block in page_dict["blocks"]:
                if block.get("type") != 0 or any(_intersects(block["bbox"], region) for region in table_regions):
                    continue
                lines = block.get("lines", [])
                text = "\n".join(
                    "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                    for line in lines
                ).strip()
                if not text:
                    continue
                block_sizes = [span["size"] for line in lines for span in line.get("spans", []) if span.get("text", "").strip()]
                bold = any(span.get("flags", 0) & 16 for line in lines for span in line.get("spans", []))
                max_size = max(block_sizes, default=body_size)
                is_heading = len(text) <= 160 and (max_size >= body_size * 1.2 or (bold and max_size >= body_size))
                if is_heading:
                    elements.append(Element("heading", text=text, level=1 if max_size >= body_size * 1.4 else 2, page=page_number))
                else:
                    elements.append(Element("paragraph", text=text, page=page_number))
    finally:
        document.close()
    if not any(element.text.strip() or element.header for element in elements):
        raise ParseError("本地 PDF 未提取到文字，可能是扫描件，请使用云端 OCR")
    return ParsedDocument(elements)


def _docx_images(paragraph: Paragraph) -> list[Element]:
    images: list[Element] = []
    for blip in paragraph._p.xpath(".//a:blip"):
        relationship_id = blip.get(qn("r:embed"))
        if not relationship_id:
            continue
        part = paragraph.part.related_parts.get(relationship_id)
        if part is None:
            continue
        images.append(Element("image", extra={"image_data": part.blob, "mime_type": part.content_type}))
    return images


def _heading_level(paragraph: Paragraph) -> int | None:
    style = paragraph.style.name.casefold() if paragraph.style else ""
    if style in {"title", "标题"}:
        return 1
    for prefix in ("heading", "标题"):
        if style.startswith(prefix):
            suffix = style[len(prefix):].strip()
            if suffix.isdigit() and 1 <= int(suffix) <= 6:
                return int(suffix)
    return None


def parse_docx(data: bytes) -> ParsedDocument:
    try:
        document = Document(io.BytesIO(data))
    except Exception as exc:
        raise ParseError("无法读取 DOCX，文件可能已损坏或受密码保护") from exc
    elements: list[Element] = []
    for child in document.element.body.iterchildren():
        if isinstance(child, CT_P):
            paragraph = Paragraph(child, document)
            text = paragraph.text.strip()
            if text:
                level = _heading_level(paragraph)
                if level is not None:
                    elements.append(Element("heading", text=text, level=level))
                else:
                    elements.append(Element("paragraph", text=text))
            elements.extend(_docx_images(paragraph))
        elif isinstance(child, CT_Tbl):
            table = Table(child, document)
            rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
            element = _table_element(rows)
            if element:
                elements.append(element)
    if not elements:
        raise ParseError("DOCX 没有可解析的文字、表格或图片")
    return ParsedDocument(elements)


def _convert_doc(data: bytes) -> bytes:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    textutil = shutil.which("textutil")
    if not soffice and not textutil:
        raise ParseError("本地 DOC 解析需要 LibreOffice，请安装后重试或切换云端")
    with TemporaryDirectory() as directory:
        source = Path(directory, "source.doc")
        output = Path(directory, "source.docx")
        source.write_bytes(data)
        if soffice:
            command = [soffice, "--headless", "--convert-to", "docx", "--outdir", directory, str(source)]
        else:
            command = [textutil, "-convert", "docx", str(source), "-output", str(output)]
        try:
            result = subprocess.run(command, capture_output=True, timeout=120, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ParseError("本地 DOC 转换失败，请检查 LibreOffice 或切换云端") from exc
        if result.returncode != 0 or not output.exists():
            raise ParseError("本地 DOC 转换失败，文件可能已损坏或受密码保护")
        return output.read_bytes()


def parse_local_document(extension: str, data: bytes) -> ParsedDocument:
    if extension == "pdf":
        return parse_pdf(data)
    if extension == "docx":
        return parse_docx(data)
    if extension == "doc":
        return parse_docx(_convert_doc(data))
    raise ParseError(f"扩展名 .{extension} 不支持本地文档解析")
