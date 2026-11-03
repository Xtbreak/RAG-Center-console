import io

import fitz
import pytest
from docx import Document
from PIL import Image

from rag_center_console.local_documents import parse_docx, parse_pdf
from rag_center_console.parsing import ParseError


def test_native_pdf_extracts_headings_paragraphs_and_pages():
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "LOCAL PDF TITLE", fontsize=22)
    page.insert_text((72, 120), "NATIVE-PDF-20261027", fontsize=11)
    page.insert_text((72, 150), "This paragraph is extracted without cloud parsing.", fontsize=11)
    data = document.tobytes()
    document.close()
    parsed = parse_pdf(data)
    assert any(element.kind == "heading" and "LOCAL PDF TITLE" in element.text for element in parsed.elements)
    assert any("NATIVE-PDF-20261027" in element.text and element.page == 1 for element in parsed.elements)
    assert any("without cloud" in element.text for element in parsed.elements)


def test_scanned_pdf_has_an_explicit_local_failure():
    document = fitz.open()
    document.new_page()
    data = document.tobytes()
    document.close()
    with pytest.raises(ParseError, match="扫描件"):
        parse_pdf(data)


def test_docx_extracts_heading_table_and_image_bytes():
    document = Document()
    document.add_heading("本地文档", 0)
    document.add_paragraph("DOCX-LOCAL-20261027")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "项目"
    table.cell(0, 1).text = "值"
    table.cell(1, 0).text = "状态"
    table.cell(1, 1).text = "通过"
    image_buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "blue").save(image_buffer, format="PNG")
    document.add_picture(io.BytesIO(image_buffer.getvalue()))
    buffer = io.BytesIO()
    document.save(buffer)
    parsed = parse_docx(buffer.getvalue())
    assert [element.kind for element in parsed.elements] == ["heading", "paragraph", "table", "image"]
    assert parsed.elements[1].text == "DOCX-LOCAL-20261027"
    assert parsed.elements[2].rows == [["状态", "通过"]]
    assert parsed.elements[3].extra["image_data"].startswith(b"\x89PNG")
    assert parsed.elements[3].extra["mime_type"] == "image/png"
