import io
from types import SimpleNamespace as NS

import pytest
from openpyxl import Workbook

from rag_center_console.chunking import chunk_document, detect_numbered_headings, estimate_tokens, normalize_separators, recursive_split
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


def test_fixed_recursive_custom_and_semantic_chunking():
    fixed = chunk_document(ParsedDocument([Element("paragraph", "字" * 250)]), 100, 10, method="fixed")
    assert all(chunk.token_count <= 100 for chunk in fixed)
    assert fixed[0].content[-10:] == fixed[1].content[:10]

    custom = chunk_document(
        ParsedDocument([Element("paragraph", "甲||乙||丙")]),
        2,
        0,
        method="recursive",
        separators=["||"],
    )
    assert [chunk.content for chunk in custom] == ["甲||", "乙||", "丙"]
    assert normalize_separators(["\n\n", "\n"])[-1] == ""
    with pytest.raises(ValueError, match="不能为空"):
        normalize_separators([""])

    calls = []

    def embed(texts):
        calls.append(texts)
        return [[1.0, 0.0], [0.99, 0.01], [0.0, 1.0]]

    semantic = chunk_document(
        ParsedDocument([Element("paragraph", "第一段相同主题。\n\n第二段延续主题。\n\n第三段完全不同。")]),
        20,
        0,
        method="semantic",
        semantic_threshold=0.75,
        semantic_embed=embed,
    )
    assert len(calls) == 1 and len(calls[0]) == 3
    assert len(semantic) == 2 and "第一段" in semantic[0].content and "第二段" in semantic[0].content
    assert semantic[1].content == "第三段完全不同。"


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
    assert estimate_tokens("你好，世界。") == 6  # 全角标点按 1 Token 计
    empty = ParsedDocument([Element("paragraph", "前文"), Element("image", ""), Element("paragraph", "后文")])
    assert [chunk.content for chunk in chunk_document(empty, 800, 0)] == ["前文\n\n后文"]


def test_layouts_map_titles_tables_images_and_skip_headers():
    layouts = [
        {"type": "head", "text": "页眉"},
        {"type": "title", "text": "第一章", "level": 2, "pageNum": [0]},
        {"type": "text", "text": "正文", "pageNum": [0]},
        {"type": "table", "markdownContent": "| a | b |\n| - | - |\n| 1 | 2 |", "pageNum": [1]},
        {"type": "table", "text": "无法解析的表", "markdownContent": ""},
        {"type": "figure", "text": "图中文字", "pos": [{"x": 1}], "pageNum": [1]},
        {"type": "figure", "text": "[empty]", "markdownContent": "![图](https://bucket.oss-cn-hangzhou.aliyuncs.com/a.png?signature=secret)"},
    ]
    elements = layouts_to_elements(layouts)
    assert [e.kind for e in elements] == ["heading", "paragraph", "table", "paragraph", "image", "image"]
    assert (elements[0].level, elements[0].page, elements[2].page) == (2, 1, 2)
    assert elements[4].extra == {"region": [{"x": 1}]}
    assert elements[5].text == "" and elements[5].extra["source_url"].endswith("signature=secret")


class FakeSdk:
    def __init__(self, statuses, layouts):
        self.statuses, self.layouts, self.calls = list(statuses), layouts, []

    def submit_doc_parser_job_advance(self, request, runtime):
        self.calls.append(("submit", request.file_name, request.file_url_object.read(), request.llm_enhancement))
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
    assert sdk.calls[0] == ("submit", "a.pdf", b"%PDF", True)
    parser(FakeSdk(["success"], layouts)).parse(b"%PDF", "a.pdf", "pdf", llm_enhancement=False)
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



def test_recursive_split_prefers_paragraphs_then_sentences_and_covers_text():
    text = "第一段第一句。第一段第二句。\n\n第二段只有一句。\n\n" + "第三段很长，" * 30
    spans = recursive_split(text, 20, 0)
    pieces = [text[a:b] for a, b in spans]
    assert pieces[0] == "第一段第一句。第一段第二句。"  # 整段放得下时不拆句子
    assert pieces[1].startswith("第二段只有一句。")  # 小片段会与后续片段贪心合并
    assert all(estimate_tokens(piece) <= 20 for piece in pieces)
    assert "".join(pieces).replace("\n", "") == text.replace("\n", "")  # 无重叠时不丢字也不重复


def test_recursive_split_overlap_repeats_tail_of_previous_chunk():
    text = "".join(f"句子{i:02d}。" for i in range(40))
    spans = recursive_split(text, 30, 10)
    pieces = [text[a:b] for a, b in spans]
    assert len(pieces) > 3 and all(estimate_tokens(p) <= 30 for p in pieces)
    for previous, current in zip(pieces, pieces[1:]):
        shared = max((k for k in range(1, len(current)) if previous.endswith(current[:k])), default=0)
        assert shared and current[shared - 1] == "。"  # 重叠部分是上一段末尾的完整句子
        assert 0 < estimate_tokens(current[:shared]) <= 10


def test_recursive_split_hard_splits_unbroken_text_and_handles_english():
    assert [b - a for a, b in recursive_split("字" * 250, 100, 0)] == [100, 100, 50]
    english = "alpha beta gamma delta " * 20
    pieces = [english[a:b] for a, b in recursive_split(english, 10, 0)]
    assert all(not p.startswith(" ") and not p.endswith(" ") for p in pieces)
    assert " ".join(pieces).split() == english.split()


HEADING_DOC = """# 员工手册

## 第一章 总则

适用于全体员工。

### 适用范围

包括正式员工和实习生。

## 第二章 考勤

上班时间为九点。
"""


def test_heading_method_respects_level_and_keeps_deeper_headings_inside():
    parsed = parse_markdown(HEADING_DOC.encode())
    deep = chunk_document(parsed, 800, 0, "heading", 6)
    assert [c.location["heading_path"] for c in deep] == [
        ["员工手册", "第一章 总则"], ["员工手册", "第一章 总则", "适用范围"], ["员工手册", "第二章 考勤"]]
    shallow = chunk_document(parsed, 800, 0, "heading", 2)
    assert [c.location["heading_path"] for c in shallow] == [["员工手册", "第一章 总则"], ["员工手册", "第二章 考勤"]]
    assert shallow[0].content == "适用于全体员工。\n\n适用范围\n\n包括正式员工和实习生。"


def test_heading_method_splits_oversized_sections_with_the_same_path():
    text = "# 长章节\n\n" + "\n\n".join("这一段用来测试超长章节的递归切分。" for _ in range(20))
    chunks = chunk_document(parse_markdown(text.encode()), 50, 10, "heading", 6)
    assert len(chunks) > 3 and all(c.token_count <= 50 for c in chunks)
    assert all(c.location["heading_path"] == ["长章节"] for c in chunks)


def test_recursive_method_ignores_heading_boundaries_but_records_start_location():
    chunks = chunk_document(parse_markdown(HEADING_DOC.encode()), 800, 0, "recursive")
    assert len(chunks) == 1
    assert chunks[0].content.startswith("员工手册\n\n第一章 总则\n\n适用于全体员工。")
    assert chunks[0].location["heading_path"] == ["员工手册"]
    small = chunk_document(parse_markdown(HEADING_DOC.encode()), 12, 0, "recursive")
    assert small[-1].location["heading_path"] == ["员工手册", "第二章 考勤"]
    assert any("第二章 考勤" in c.content for c in small)


def test_tables_and_images_stay_separate_in_recursive_method():
    parsed = ParsedDocument([
        Element("paragraph", "前文"), Element("table", header=["a"], rows=[["1"]]),
        Element("paragraph", "后文"), Element("image", "图片文字", page=3),
    ])
    chunks = chunk_document(parsed, 800, 0, "recursive")
    assert [(c.kind, c.content.split("\n")[0]) for c in chunks] == [
        ("text", "前文"), ("table", "| a |"), ("text", "后文"), ("image", "图片文字")]


def test_numbered_headings_are_detected_without_markdown_headings():
    parsed = ParsedDocument([
        Element("paragraph", "第一章 总则"),
        Element("paragraph", "一、目的\n为规范管理，制定本制度。"),
        Element("paragraph", "（一）适用对象"),
        Element("paragraph", "1.1 定义"),
        Element("paragraph", "第一条 本制度自发布之日起施行，由人事部负责解释。"),  # 过长且以句号结尾：正文
        Element("paragraph", "1. 打开设置"),  # 单级阿拉伯编号常是列表项：不识别
    ])
    elements = detect_numbered_headings(parsed.elements)
    headings = [(e.text, e.level) for e in elements if e.kind == "heading"]
    assert headings == [("第一章 总则", 1), ("一、目的", 2), ("（一）适用对象", 3), ("1.1 定义", 4)]
    assert any(e.kind == "paragraph" and e.text == "为规范管理，制定本制度。" for e in elements)
    chunks = chunk_document(parsed, 800, 0, "heading", 2)
    assert chunks[0].location["heading_path"] == ["第一章 总则", "一、目的"]
    assert "（一）适用对象" in chunks[0].content


def test_numbered_detection_is_skipped_when_markdown_headings_exist():
    parsed = ParsedDocument([Element("heading", "标题", level=1), Element("paragraph", "一、不是标题")])
    assert detect_numbered_headings(parsed.elements) is parsed.elements
    sheet = [Element("heading", "Sheet1", level=1, sheet="Sheet1"), Element("paragraph", "第一章 总则")]
    assert detect_numbered_headings(sheet)[1].kind == "heading"  # 工作表名不算 Markdown 标题



def test_docmind_business_errors_are_explained():
    class Denied(FakeSdk):
        def submit_doc_parser_job_advance(self, request, runtime):
            return NS(body=NS(data=None, code="NoPermission", message="You are not authorized to perform this operation."))

    with pytest.raises(ParseError, match="AliyunDocmindFullAccess"):
        parser(Denied([], [])).parse(b"x", "a.pdf", "pdf")

    class Throttled(FakeSdk):
        def query_doc_parser_status(self, request):
            return NS(body=NS(data=None, code="Throttling.User", message="slow down"))

    with pytest.raises(ParseError, match="过于频繁"):
        parser(Throttled([], [])).parse(b"x", "a.pdf", "pdf")

    class SdkError(FakeSdk):
        def submit_doc_parser_job_advance(self, request, runtime):
            error = RuntimeError("bad key")
            error.code = "InvalidAccessKeyId.NotFound"
            raise error

    with pytest.raises(ParseError, match="AccessKey 无效"):
        parser(SdkError([], [])).parse(b"x", "a.pdf", "pdf")
