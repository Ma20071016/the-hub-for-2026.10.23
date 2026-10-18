"""Build the short DOCX used by the first-review tutorial.

Run with a Python environment containing python-docx. Tutorial copy belongs in
headers and footers so the upload parser extracts only the three practice claims.
"""

from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor


CLAIMS = (
    "这件新疆喀什维吾尔族绿棉袍采用对襟设计。",
    "这件棉袍通体为红色。",
    "这件棉袍的主人喜欢听音乐。",
)
OUTPUT = Path(__file__).resolve().parents[1] / "frontend/downloads/robe-review-practice.docx"


def set_font(style, size, *, bold=False):
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    fonts = style.element.get_or_add_rPr().get_or_add_rFonts()
    for name in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{name}"), "Microsoft YaHei")
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        fonts.attrib.pop(qn(f"w:{attr}"), None)
    complex_size = style.element.get_or_add_rPr().find(qn("w:szCs"))
    if complex_size is not None:
        complex_size.set(qn("w:val"), str(size * 2))


def build_document():
    document = Document()
    section = document.sections[0]
    section.page_width = Mm(148)
    section.page_height = Mm(210)
    section.left_margin = section.right_margin = Mm(18)
    section.top_margin = Mm(56)
    section.bottom_margin = Mm(45)
    section.header_distance = Mm(20)
    section.footer_distance = Mm(18)

    normal = document.styles["Normal"]
    set_font(normal, 12)
    normal.paragraph_format.line_spacing = Pt(22)
    normal.paragraph_format.space_after = Pt(16)
    normal.paragraph_format.widow_control = True

    title = document.styles["Title"]
    set_font(title, 20, bold=True)
    title.paragraph_format.line_spacing = Pt(28)
    title.paragraph_format.space_after = Pt(7)
    for border in list(title.element.iter(qn("w:pBdr"))):
        border.getparent().remove(border)

    header = document.styles["Header"]
    set_font(header, 9)
    header.paragraph_format.line_spacing = Pt(14)
    header.paragraph_format.space_after = Pt(0)
    footer = document.styles["Footer"]
    set_font(footer, 9)
    footer.paragraph_format.line_spacing = Pt(15)
    footer.paragraph_format.space_after = Pt(7)
    for style in document.styles:
        if style.style_id in ("TitleChar", "HeaderChar", "FooterChar"):
            set_font(style, 20 if style.style_id == "TitleChar" else 9,
                     bold=style.style_id == "TitleChar")

    heading = section.header.paragraphs[0]
    heading.style = title
    set_font(heading.add_run("绿棉袍审阅体验"), 20, bold=True)
    section.header.add_paragraph("练习用稿 含有意设置的疑点", style="Header")

    for claim in CLAIMS:
        paragraph = document.add_paragraph(claim)
        # Keep the intentionally short sample together on its one page.
        paragraph.paragraph_format.keep_with_next = True
    document.paragraphs[-1].paragraph_format.keep_with_next = False

    instruction = section.footer.paragraphs[0]
    instruction.text = "上传本文件 → 选择“新疆喀什维吾尔族绿棉袍”资料 → 整篇审阅。"
    section.footer.add_paragraph("请对照原文判断，模型结果可能有误。", style="Footer")

    # Make the language and provenance explicit without adding extracted text.
    language = OxmlElement("w:lang")
    language.set(qn("w:val"), "zh-CN")
    language.set(qn("w:eastAsia"), "zh-CN")
    normal.element.get_or_add_rPr().append(language)
    document.core_properties.title = "绿棉袍审阅体验"
    document.core_properties.subject = "上传文稿与整篇审阅的简短练习"
    document.core_properties.author = ""
    document.core_properties.last_modified_by = ""
    document.core_properties.comments = ""
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
