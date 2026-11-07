"""把转写结果排版成 Word 交付物。

排版原则（按公文阅读习惯定）：
    - 正文用宋体，标题用黑体；中西文分别设置字体，避免中文引号和中英文混排时错位
    - 时间戳用等宽感更强的浅灰小字，不干扰正文阅读
    - 说话人用加粗、独占一行，便于快速定位是谁在讲
    - 段落间距给足，会议文字稿是给人读的，不是打印密排文件
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Sequence

BODY_FONT = "宋体"
BODY_FONT_ASCII = "Times New Roman"
HEADING_FONT = "黑体"
MONO_FONT = "Consolas"

BODY_SIZE = 11
HEADING_SIZE = 16
SUBHEADING_SIZE = 13
META_SIZE = 9


def _apply_font(run: Any, name: str, ascii_name: str, size: int, bold: bool = False, color: str | None = None) -> None:
    """显式设置中西文字体。

    python-docx 只设 run.font.name 时，中文往往不生效（Word 用 eastAsia 槽位），
    所以必须手动写 w:eastAsia，否则打开会变成默认的等线体。
    """
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    run.font.name = ascii_name
    run.font.size = Pt(size)
    run.bold = bold

    if color:
        run.font.color.rgb = RGBColor.from_string(color)

    element = run._element
    properties = element.get_or_add_rPr()
    fonts = properties.find(qn("w:rFonts"))

    if fonts is None:
        fonts = properties.makeelement(qn("w:rFonts"), {})
        properties.append(fonts)

    fonts.set(qn("w:ascii"), ascii_name)
    fonts.set(qn("w:hAnsi"), ascii_name)
    fonts.set(qn("w:eastAsia"), name)


def _configure_document(document: Any) -> None:
    """统一页面与默认样式。A4 纸、常规页边距。"""
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt

    section = document.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(3.17)
    section.right_margin = Cm(3.17)

    normal = document.styles["Normal"]
    normal.font.name = BODY_FONT_ASCII
    normal.font.size = Pt(BODY_SIZE)

    properties = normal.element.get_or_add_rPr()
    fonts = properties.find(qn("w:rFonts"))
    if fonts is None:
        fonts = properties.makeelement(qn("w:rFonts"), {})
        properties.append(fonts)
    fonts.set(qn("w:ascii"), BODY_FONT_ASCII)
    fonts.set(qn("w:hAnsi"), BODY_FONT_ASCII)
    fonts.set(qn("w:eastAsia"), BODY_FONT)


def _add_title(document: Any, text: str) -> None:
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.space_after = Pt(6)

    run = paragraph.add_run(text)
    _apply_font(run, HEADING_FONT, HEADING_FONT, HEADING_SIZE, bold=True)


def _add_meta_table(document: Any, rows: Sequence[tuple[str, str]]) -> None:
    """会议元信息用两列表格，比一堆句子更好扫读。"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    table = document.add_table(rows=0, cols=2)
    table.style = "Table Grid"

    for label, value in rows:
        cells = table.add_row().cells

        label_paragraph = cells[0].paragraphs[0]
        label_paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
        label_run = label_paragraph.add_run(label)
        _apply_font(label_run, BODY_FONT, BODY_FONT_ASCII, META_SIZE, bold=True)

        value_paragraph = cells[1].paragraphs[0]
        value_run = value_paragraph.add_run(value)
        _apply_font(value_run, BODY_FONT, BODY_FONT_ASCII, META_SIZE)

    document.add_paragraph()


def _add_speaker_paragraph(document: Any, speaker: str, timestamp: str, text: str) -> None:
    from docx.shared import Pt

    header = document.add_paragraph()
    header.paragraph_format.space_before = Pt(10)
    header.paragraph_format.space_after = Pt(2)

    timestamp_run = header.add_run(f"[{timestamp}] ")
    _apply_font(timestamp_run, BODY_FONT, MONO_FONT, META_SIZE, color="808080")

    speaker_run = header.add_run(f"{speaker}：")
    _apply_font(speaker_run, HEADING_FONT, HEADING_FONT, BODY_SIZE, bold=True)

    body = document.add_paragraph()
    body.paragraph_format.space_after = Pt(6)
    body.paragraph_format.line_spacing = 1.5
    body.paragraph_format.first_line_indent = Pt(BODY_SIZE * 2)

    body_run = body.add_run(text)
    _apply_font(body_run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)


def _add_heading(document: Any, text: str, level: int = 1) -> None:
    from docx.shared import Pt

    paragraph = document.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(16 if level == 1 else 12)
    paragraph.paragraph_format.space_after = Pt(6)

    size = SUBHEADING_SIZE if level == 1 else BODY_SIZE
    run = paragraph.add_run(text)
    _apply_font(run, HEADING_FONT, HEADING_FONT, size, bold=(level == 1))


def _metadata_rows(
    result: dict[str, Any],
    meeting: dict[str, Any] | None,
    speaker_names: dict[str, str] | None,
) -> list[tuple[str, str]]:
    """组织会议元信息行。空缺的项不编造，明确写"待补充"。"""
    meeting = meeting or {}
    names = speaker_names or {}

    rows: list[tuple[str, str]] = []

    recorded_at = str(meeting.get("recordedAt") or "").strip()
    if recorded_at:
        rows.append(("录音时间", recorded_at))

    if meeting.get("location"):
        rows.append(("会议地点", str(meeting["location"])))

    if meeting.get("title"):
        rows.append(("会议名称", str(meeting["title"])))

    rows.append(("音频时长", _human_duration(float(result.get("audioSeconds", 0.0)))))

    speakers = [str(item) for item in result.get("speakers", [])]
    if speakers:
        display = [names.get(item, item) for item in speakers]
        rows.append(("识别说话人", "、".join(display)))

    if meeting.get("attendees"):
        rows.append(("参会人员", str(meeting["attendees"])))

    return rows


def _human_duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)

    if hours > 0:
        return f"{hours} 小时 {minutes} 分 {secs} 秒"
    if minutes > 0:
        return f"{minutes} 分 {secs} 秒"
    return f"{secs} 秒"


def _clock(seconds: float) -> str:
    total = int(round(max(0.0, seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _mark_entries(marks: Sequence[dict[str, Any]] | None) -> list[tuple[str, str]]:
    """整理重点标记为 (时间戳, 文字) 行。

    标记的 label 和 note 都可能为空，展示优先级是 note 优于 label；
    两个都空时就只显示时间戳。只有连时间戳都没有的整条空标记才丢弃，
    免得在文档里留下一行空白。
    """
    entries: list[tuple[str, str]] = []

    for item in marks or []:
        if not isinstance(item, dict):
            continue

        at = str(item.get("at") or "").strip()
        note = str(item.get("note") or "").strip() or str(item.get("label") or "").strip()

        if not at and not note:
            continue

        entries.append((at, note))

    return entries


def _add_marks_section(document: Any, marks: Sequence[dict[str, Any]] | None) -> None:
    """重点标记：录音时按下的标记，放在正文之前，让人先看到关键结论。

    用两列表格对齐时间戳，和上面的会议元信息保持同一套版式；
    没有任何标记时一个字都不写，保证无标记的文档与改动前逐字节一致。
    """
    entries = _mark_entries(marks)

    if not entries:
        return

    _add_heading(document, "重点标记", level=1)

    table = document.add_table(rows=0, cols=2)
    table.style = "Table Grid"

    for at, note in entries:
        cells = table.add_row().cells

        time_paragraph = cells[0].paragraphs[0]
        time_run = time_paragraph.add_run(at)
        _apply_font(time_run, BODY_FONT, MONO_FONT, META_SIZE, color="808080")

        note_paragraph = cells[1].paragraphs[0]
        note_run = note_paragraph.add_run(note)
        _apply_font(note_run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)

    document.add_paragraph()


def write_timeline_docx(
    result: dict[str, Any],
    output_path: str | Path,
    meeting: dict[str, Any] | None = None,
    speaker_names: dict[str, str] | None = None,
    title: str = "会议讲话文字稿",
    marks: Sequence[dict[str, Any]] | None = None,
) -> str:
    """按时间顺序的文字稿：每段「[时间] 说话人：内容」。

    marks 是录音时按下的重点标记；为空时文档内容和以前完全一样。
    """
    from docx import Document

    names = speaker_names or {}
    document = Document()
    _configure_document(document)

    _add_title(document, title)
    _add_meta_table(document, _metadata_rows(result, meeting, speaker_names))
    _add_marks_section(document, marks)
    _add_heading(document, "正文", level=1)

    for segment in result.get("segments", []):
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = names.get(str(segment.get("speaker", "")), str(segment.get("speaker", "说话人1")))
        _add_speaker_paragraph(document, speaker, _clock(float(segment.get("start", 0.0))), text)

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(target))

    return str(target)


def write_per_speaker_docx(
    result: dict[str, Any],
    output_path: str | Path,
    meeting: dict[str, Any] | None = None,
    speaker_names: dict[str, str] | None = None,
    title: str = "会议讲话文字稿（按人合并）",
) -> str:
    """按人合并的文字稿：一人一节，节内按时间顺序，附个人发言时长统计。"""
    from docx import Document
    from docx.shared import Pt

    names = speaker_names or {}
    document = Document()
    _configure_document(document)

    _add_title(document, title)
    _add_meta_table(document, _metadata_rows(result, meeting, speaker_names))

    grouped: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []

    for segment in result.get("segments", []):
        text = str(segment.get("text", "")).strip()
        if not text:
            continue

        speaker = str(segment.get("speaker", "说话人1"))
        if speaker not in grouped:
            grouped[speaker] = []
            order.append(speaker)

        grouped[speaker].append(segment)

    def total_seconds(speaker: str) -> float:
        return sum(float(item.get("end", 0.0)) - float(item.get("start", 0.0)) for item in grouped[speaker])

    order.sort(key=total_seconds, reverse=True)

    for speaker in order:
        display = names.get(speaker, speaker)
        _add_heading(document, f"{display}（累计发言 {_human_duration(total_seconds(speaker))}）", level=1)

        for segment in grouped[speaker]:
            text = str(segment.get("text", "")).strip()

            paragraph = document.add_paragraph()
            paragraph.paragraph_format.space_after = Pt(6)
            paragraph.paragraph_format.line_spacing = 1.5
            paragraph.paragraph_format.first_line_indent = Pt(BODY_SIZE * 2)

            timestamp_run = paragraph.add_run(f"[{_clock(float(segment.get('start', 0.0)))}] ")
            _apply_font(timestamp_run, BODY_FONT, MONO_FONT, META_SIZE, color="808080")

            body_run = paragraph.add_run(text)
            _apply_font(body_run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(target))

    return str(target)


_HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(?=\S)")
_BULLET_PATTERN = re.compile(r"^[-*+]\s+(?=\S)")
_ORDERED_PATTERN = re.compile(r"^\d{1,3}[.、)]\s+(?=\S)")
_TABLE_ROW_PATTERN = re.compile(r"^\|.*\|$")
_TABLE_RULE_PATTERN = re.compile(r"^\|(?:\s*:?-{2,}:?\s*\|)+$")


def _is_section_heading(text: str) -> bool:
    """「一、」「二.」这类手写章节号。纪要正文的主体结构就是它。"""
    return len(text) > 2 and text[0] in "一二三四五六七八九十" and text[1] in "、."


def _collect_table(lines: Sequence[str], start: int) -> tuple[list[list[str]], int]:
    """从 start 起收集连续的表格行，返回（数据行, 下一行号）。

    分隔行（| --- | --- |）只是 Markdown 的表格语法，不是内容，丢掉。
    """
    rows: list[list[str]] = []
    index = start

    while index < len(lines):
        stripped = lines[index].strip()

        if not _TABLE_ROW_PATTERN.match(stripped):
            break

        if not _TABLE_RULE_PATTERN.match(stripped):
            rows.append([cell.strip() for cell in stripped.strip("|").split("|")])

        index += 1

    return rows, index


def _add_table(document: Any, rows: Sequence[Sequence[str]]) -> None:
    """把 Markdown 表格排成 Word 表格。

    列数取最宽的一行：Markdown 允许行尾省略空单元格，不补齐会让赋值错位。
    """
    columns = max(len(row) for row in rows)

    table = document.add_table(rows=0, cols=columns)
    table.style = "Table Grid"

    for row in rows:
        cells = table.add_row().cells

        for position in range(columns):
            text = _strip_inline_markdown(row[position] if position < len(row) else "")
            run = cells[position].paragraphs[0].add_run(text)
            _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE - 1)

    # 表格后留一个空段，否则下一段会紧贴在表格边框上
    document.add_paragraph()


def write_minutes_docx(
    minutes_markdown: str,
    output_path: str | Path,
    meeting: dict[str, Any] | None = None,
) -> str:
    """把纪要（或提纲）Markdown 渲染成 Word。

    只做格式转换，不改内容：井号、项目符号、表格竖线这些是排版记号，
    不能留给人看，所以要去掉；但作者写的序号、数字、人名一个字都不动。

    刻意不做完整的 Markdown 渲染——纪要格式是固定的，通用渲染器反而会引入
    不必要的样式（比如把「一、」变成项目符号）。
    """
    from docx import Document
    from docx.shared import Pt

    document = Document()
    _configure_document(document)

    lines = minutes_markdown.replace("\r\n", "\n").split("\n")
    index = 0
    pending_spacing = True

    while index < len(lines):
        raw_line = lines[index]
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            pending_spacing = True
            index += 1
            continue

        # 标题：一级当文档标题，二级及以下当章节标题。
        # 「## 一、xxx」去掉井号后就是标准章节样式，交给下面的章节分支统一排版，
        # 免得同一个文档里出现两套标题观感。
        heading = _HEADING_PATTERN.match(stripped)

        if heading:
            hashes = heading.group(1)
            heading_text = stripped[len(hashes) :].strip()

            if len(hashes) == 1:
                _add_title(document, heading_text)
                index += 1
                pending_spacing = False
                continue

            if not _is_section_heading(heading_text):
                paragraph = document.add_paragraph()
                paragraph.paragraph_format.line_spacing = 1.5
                paragraph.paragraph_format.space_before = Pt(12)
                paragraph.paragraph_format.space_after = Pt(6)

                run = paragraph.add_run(heading_text)
                _apply_font(run, HEADING_FONT, HEADING_FONT, BODY_SIZE, bold=False)

                index += 1
                pending_spacing = False
                continue

            stripped = heading_text

        if stripped in {"---", "***", "___"}:
            index += 1
            continue

        # 引用块：提纲里用它标注"这不是正式纪要"
        if stripped.startswith(">"):
            text = _strip_inline_markdown(stripped.lstrip(">").strip())

            if text:
                paragraph = document.add_paragraph()
                paragraph.paragraph_format.line_spacing = 1.5
                paragraph.paragraph_format.space_after = Pt(2)
                paragraph.paragraph_format.left_indent = Pt(BODY_SIZE * 2)

                run = paragraph.add_run(text)
                _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE - 1, color="808080")

            index += 1
            pending_spacing = False
            continue

        # 表格：一次吃掉连续的若干行，所以要在建段落之前处理
        if _TABLE_ROW_PATTERN.match(stripped):
            rows, index = _collect_table(lines, index)

            if rows:
                _add_table(document, rows)

            pending_spacing = True
            continue

        paragraph = document.add_paragraph()
        paragraph.paragraph_format.line_spacing = 1.5
        paragraph.paragraph_format.space_after = Pt(8 if pending_spacing else 4)

        if pending_spacing:
            paragraph.paragraph_format.space_before = Pt(4)

        if _is_section_heading(stripped):
            paragraph.paragraph_format.space_before = Pt(14)
            paragraph.paragraph_format.space_after = Pt(6)
            run = paragraph.add_run(stripped)
            _apply_font(run, HEADING_FONT, HEADING_FONT, SUBHEADING_SIZE, bold=False)
            index += 1
            pending_spacing = False
            continue

        if stripped.startswith("参会人员"):
            run = paragraph.add_run(stripped)
            _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)
            paragraph.paragraph_format.space_before = Pt(14)
            index += 1
            pending_spacing = False
            continue

        if stripped.startswith("（") and stripped.endswith("）"):
            run = paragraph.add_run(stripped)
            _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE - 1, color="808080")
            index += 1
            pending_spacing = False
            continue

        # 项目符号列表：符号交给 Word 的列表样式，正文一个字不改
        bullet = _BULLET_PATTERN.match(stripped)

        if bullet:
            text = _strip_inline_markdown(stripped[bullet.end() :].strip())

            try:
                item = document.add_paragraph(style="List Bullet")
            except KeyError:
                # 模板里没有列表样式时退回普通段落，前面补一个中点
                item = document.add_paragraph()
                text = f"· {text}"

            item.paragraph_format.line_spacing = 1.5
            item.paragraph_format.space_after = Pt(2)

            run = item.add_run(text)
            _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)

            index += 1
            pending_spacing = False
            continue

        # 有序列表：保留作者写的序号并做成悬挂缩进。
        # 不用 Word 自动编号，是因为它会按顺序重排——作者写「1. 3.」就被改成「1. 2.」，
        # 那已经是改内容了。
        ordered = _ORDERED_PATTERN.match(stripped)

        if ordered:
            paragraph.paragraph_format.space_after = Pt(2)
            paragraph.paragraph_format.left_indent = Pt(BODY_SIZE * 2)
            paragraph.paragraph_format.first_line_indent = Pt(-BODY_SIZE * 2)

            run = paragraph.add_run(_strip_inline_markdown(stripped))
            _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)

            index += 1
            pending_spacing = False
            continue

        text = _strip_inline_markdown(stripped)
        paragraph.paragraph_format.first_line_indent = Pt(BODY_SIZE * 2)
        run = paragraph.add_run(text)
        _apply_font(run, BODY_FONT, BODY_FONT_ASCII, BODY_SIZE)

        index += 1
        pending_spacing = False

    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(target))

    return str(target)


def _strip_inline_markdown(text: str) -> str:
    """去掉行内 Markdown 强调标记。

    注意：会议纪要要求标题不加粗，所以这里**只去标记、不加粗任何内容**，
    保持公文的中性观感。
    """
    cleaned = text

    for marker in ("**", "__", "*", "_", "`"):
        cleaned = cleaned.replace(marker, "")

    return cleaned
