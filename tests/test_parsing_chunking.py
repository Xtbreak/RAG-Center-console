import io
from types import SimpleNamespace as NS

import pytest
from openpyxl import Workbook

from rag_center_console.chunking import chunk_document, estimate_tokens
from rag_center_console.docmind import DocmindParser, ParseCancelled, layouts_to_elements
from rag_center_console.parsing import Element, ParsedDocument, ParseError, parse_csv, parse_local, parse_markdown, parse_xlsx

MARKDOWN = """# 手册

## 安装

先下载安装包。

再运行安装程序。

```bash
echo hi

echo there
```

## 参数

| 名称 | 默认值 |
| --- | --- |
| a | 1 |
| b | 2 |
"""


def test_markdown_parses_headings_paragraphs_fences_and_tables():
    kinds = [(e.kind, e.text or e.header) for e in parse_markdown(MARKDOWN.encode()).elements]
    assert kinds[:3] == [("heading", "手册"), ("heading", "安装"), ("paragraph", "先下载安装包。")]
    assert [e.kind for e in parse_markdown(MARKDOWN.encode()).elements][-1] == "table"
    fence = next(e for e in parse_markdown(MARKDOWN.encode()).elements if "echo hi" in e.text)
    assert "echo there" in fence.text  # 代码块内的空行不会把它拆成两段


def test_markdown_rejects_empty_and_supports_gbk():
    with pytest.raises(ParseError):
        parse_markdown(b"  \n\n")
    assert parse_markdown("# 标题".encode("gb18030")).elements[0].text == "标题"


def test_csv_sniffs_delimiter_and_fills_blank_header():
    table = parse_csv("姓名;;年龄\n张三;a;3\n".encode()).elements[0]
    assert table.header == ["姓名", "列2", "年龄"]
    assert table.rows == [["张三", "a", "3"]]


def test_xlsx_yields_heading_and_table_per_sheet():
    workbook = Workbook()
    workbook.active.title = "销售"
    workbook.active.append(["产品", "数量"])
    workbook.active.append(["A", 2])
    workbook.create_sheet("空表")
    buffer = io.BytesIO()
    workbook.save(buffer)
    elements = parse_xlsx(buffer.getvalue()).elements
    assert [e.kind for e in elements] == ["heading", "table"]
    assert elements[1].sheet == "销售" and elements[1].rows == [["A", "2"]]
    with pytest.raises(ParseError):
        parse_local("xlsx", b"PK not really")


def test_chunks_follow_headings_and_keep_the_path():
    chunks = chunk_document(parse_markdown(MARKDOWN.encode()), 800, 100)
    install = next(c for c in chunks if "先下载" in c.content)
    assert install.location["heading_path"] == ["手册", "安装"]
    assert "再运行安装程序" in install.content  # 同一标题下的段落合并
    table = next(c for c in chunks if c.kind == "table")
    assert table.location["heading_path"] == ["手册", "参数"] and table.location["rows"] == [1, 2]


def test_long_paragraph_is_split_within_limit_with_overlap():
    text = "".join(f"这是第{i}句话，用来测试切分。" for i in range(200))
    chunks = chunk_document(ParsedDocument([Element("paragraph", text=text)]), 100, 20)
    assert len(chunks) > 3 and all(c.token_count <= 100 for c in chunks)
    unbroken = chunk_document(ParsedDocument([Element("paragraph", text="字" * 500)]), 100, 20)
    assert all(c.token_count <= 100 for c in unbroken)
    assert unbroken[0].content[-20:] == unbroken[1].content[:20]  # 硬切分保留重叠


def test_table_rows_are_grouped_and_repeat_the_header():
    rows = [[f"item{i}", "x" * 20] for i in range(30)]
    table = Element("table", header=["名称", "备注"], rows=rows, sheet="S1")
    chunks = chunk_document(ParsedDocument([table]), 120, 0)
    assert len(chunks) > 2
    assert all(c.content.startswith("| 名称 | 备注 |") and c.location["sheet"] == "S1" for c in chunks)
    assert chunks[0].location["rows"][0] == 1 and chunks[-1].location["rows"][1] == 30
    covered = [n for c in chunks for n in range(c.location["rows"][0], c.location["rows"][1] + 1)]
    assert covered == list(range(1, 31))


def test_image_elements_become_image_chunks_and_estimate_tokens():
    parsed = ParsedDocument([Element("heading", "图", 1), Element("image", "OCR 文本", page=2, extra={"region": [1, 2]})])
    chunk = chunk_document(parsed, 800, 100)[0]
    assert chunk.kind == "image" and chunk.location == {"heading_path": ["图"], "page": 2, "region": [1, 2]}
    assert estimate_tokens("你好world") == 2 + 2


def test_layouts_map_titles_tables_images_and_skip_headers():
    layouts = [
        {"type": "head", "text": "页眉"},
        {"type": "title", "text": "第一章", "level": 2, "pageNum": [0]},
        {"type": "text", "text": "正文", "pageNum": [0]},
        {"type": "table", "markdownContent": "| a | b |\n| - | - |\n| 1 | 2 |", "pageNum": [1]},
        {"type": "table", "text": "无法解析的表", "markdownContent": ""},
        {"type": "figure", "text": "图中文字", "pos": [{"x": 1}], "pageNum": [1]},
    ]
    elements = layouts_to_elements(layouts)
    assert [e.kind for e in elements] == ["heading", "paragraph", "table", "paragraph", "image"]
    assert (elements[0].level, elements[0].page, elements[2].page) == (2, 1, 2)
    assert elements[4].extra == {"region": [{"x": 1}]}


class FakeSdk:
    def __init__(self, statuses, layouts):
        self.statuses, self.layouts, self.calls = list(statuses), layouts, []

    def submit_doc_parser_job_advance(self, request, runtime):
        self.calls.append(("submit", request.file_name, request.file_url_object.read()))
        return NS(body=NS(data=NS(id="job-1")))

    def query_doc_parser_status(self, request):
        assert request.id == "job-1"
        return NS(body=NS(data=NS(status=self.statuses.pop(0), number_of_successful_parsing=len(self.layouts))))

    def get_doc_parser_result(self, request):
        self.calls.append(("result", request.layout_num))
        return NS(body=NS(data={"layouts": self.layouts[request.layout_num : request.layout_num + 2]}))


def parser(sdk, **kwargs):
    return DocmindParser("", "", "x", sdk_client=sdk, sleep=lambda _: None, **kwargs)


def test_docmind_polls_then_pages_through_layouts(monkeypatch):
    monkeypatch.setattr("rag_center_console.docmind.PAGE_SIZE", 2)
    layouts = [{"type": "text", "text": f"段{i}"} for i in range(5)]
    sdk = FakeSdk(["Processing", "Processing", "success"], layouts)
    parsed = parser(sdk).parse(b"%PDF", "a.pdf", "pdf")
    assert [e.text for e in parsed.elements] == [f"段{i}" for i in range(5)]
    assert sdk.calls[0] == ("submit", "a.pdf", b"%PDF")
    assert [c[1] for c in sdk.calls if c[0] == "result"] == [0, 2, 4]


def test_docmind_failure_cancel_and_missing_key():
    with pytest.raises(ParseError, match="任务失败"):
        parser(FakeSdk(["Fail"], [])).parse(b"x", "a.pdf", "pdf")
    with pytest.raises(ParseCancelled):
        parser(FakeSdk(["Processing"], [])).parse(b"x", "a.pdf", "pdf", should_cancel=lambda: True)
    with pytest.raises(ParseError, match="未返回可用内容"):
        parser(FakeSdk(["success"], [{"type": "head", "text": "x"}])).parse(b"x", "a.pdf", "pdf")
    with pytest.raises(ParseError, match="AccessKey"):
        DocmindParser("", "", "x")


def test_docmind_sdk_errors_are_redacted():
    class Broken(FakeSdk):
        def submit_doc_parser_job_advance(self, request, runtime):
            raise RuntimeError("denied for secret-123")

    with pytest.raises(ParseError) as error:
        DocmindParser("id", "secret-123", "x", sdk_client=Broken([], []), sleep=lambda _: None).parse(b"x", "a.pdf", "pdf")
    assert "secret-123" not in str(error.value) and "***" in str(error.value)


def test_sentence_splitting_keeps_spaces_and_paragraph_breaks():
    english = chunk_document(ParsedDocument([Element("paragraph", "Hello world. Second sentence here.")]), 800, 0)
    assert english[0].content == "Hello world. Second sentence here."
    paragraphs = chunk_document(ParsedDocument([Element("paragraph", "第一段。"), Element("paragraph", "第二段。")]), 800, 0)
    assert paragraphs[0].content == "第一段。\n\n第二段。"
    long_english = " ".join(f"Sentence number {i} is here." for i in range(40))
    pieces = chunk_document(ParsedDocument([Element("paragraph", long_english)]), 30, 0)
    assert len(pieces) > 3 and " ".join(p.content for p in pieces) == long_english
