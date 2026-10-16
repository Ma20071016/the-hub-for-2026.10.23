"""PDF / DOCX 上传与文字提取。"""

from io import BytesIO
from threading import Lock
from zipfile import ZipFile

from docx import Document
from docx.text.paragraph import Paragraph
from pypdf import PdfReader

from backend.text_prepare import clean_text

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 50000
UPLOAD_LOCK = Lock()


class DocumentError(ValueError):
    pass


def extract_document(raw, kind):
    parts = []
    total = 0
    warning = ""
    normalized_total = 0

    def append(text):
        nonlocal total, normalized_total
        text = text.replace("\x00", "").strip()
        if not text:
            return

        # 先清洗再计数，保证返回的正文与送去核验的正文一致。
        text, stats = clean_text(text)
        text = text.strip()
        if not text:
            return

        # 统计归一改动了多少个字符。PDF 提取常把「文」写成康熙部首「⽂」，
        # 这些字符不在模型词表里，归一掉多少个直接反映提取质量。
        changes = stats["nfkc_replaced"]
        if "_length_changed" in changes:
            normalized_total += abs(changes["_length_changed"])
        else:
            normalized_total += sum(changes.values())

        total += len(text) + (2 if parts else 0)
        if total > MAX_TEXT_CHARS:
            raise DocumentError(
                "提取文字超过 50000 字符，请拆分文档后上传。"
            )
        parts.append(text)

    if kind == "pdf":
        if not raw.startswith(b"%PDF-"):
            raise DocumentError("文件内容不是有效 PDF。")

        reader = PdfReader(BytesIO(raw))

        if reader.is_encrypted:
            raise DocumentError(
                "暂不支持加密 PDF，请先解除密码保护。"
            )

        if len(reader.pages) > 100:
            raise DocumentError(
                "PDF 超过 100 页，请拆分后上传。"
            )

        empty_pages = 0

        for page in reader.pages:
            content = page.get_contents()
            if (
                content is not None
                and len(content.get_data()) > 8 * 1024 * 1024
            ):
                raise DocumentError(
                    "PDF 单页内容过于复杂，请拆分或简化后上传。"
                )

            text = page.extract_text() or ""
            if not text.strip():
                empty_pages += 1
            append(text)

        if empty_pages:
            warning = (
                f"有 {empty_pages} 页未提取到文字；"
                "扫描图片需要 OCR。"
            )

    elif kind == "docx":
        with ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()

            if "word/document.xml" not in archive.namelist():
                raise DocumentError(
                    "文件不是有效的 Word .docx 文档。"
                )

            if (
                len(entries) > 2000
                or sum(item.file_size for item in entries)
                > 40 * 1024 * 1024
            ):
                raise DocumentError(
                    "Word 解压后内容过大，请拆分后上传。"
                )

        document = Document(BytesIO(raw))

        # 按正文顺序读取段落与普通表格。
        for block in document.iter_inner_content():
            if isinstance(block, Paragraph):
                append(block.text)
            else:
                for row in block.rows:
                    append(
                        " | ".join(cell.text for cell in row.cells)
                    )

    else:
        raise DocumentError("仅支持 PDF 和 Word .docx。")

    text = "\n\n".join(parts)
    if not text:
        raise DocumentError(
            "未提取到正文文字；扫描件或图片需要先进行 OCR。"
        )

    # 归一掉大量字符说明这份文件的文字需要还原（PDF 常见），
    # 提示用户结果可能仍有残留差异。
    if normalized_total:
        note = f"已纠正 {normalized_total} 个变体字符（如 PDF 乱码字形）。"
        warning = f"{warning} {note}".strip()

    return {"text": text, "warning": warning}


def handle_upload(handler):
    if handler.headers.get("Transfer-Encoding"):
        handler.respond(400, {"error": "不支持分块上传。"})
        return

    if (
        handler.headers.get_content_type()
        != "application/octet-stream"
    ):
        handler.respond(415, {"error": "请以二进制文件上传。"})
        return

    kind = handler.headers.get("X-Document-Type", "").lower()
    if kind not in ("pdf", "docx"):
        handler.respond(415, {
            "error": "仅支持 .pdf 和 .docx；.doc 请先另存为 .docx。"
        })
        return

    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        length = 0

    if length <= 0:
        handler.respond(400, {
            "error": "文件为空或上传长度无效。"
        })
        return

    if length > MAX_FILE_BYTES:
        handler.respond(413, {"error": "文件不能超过 10 MB。"})
        return

    if not UPLOAD_LOCK.acquire(blocking=False):
        handler.respond(429, {
            "error": "正在读取另一份文档，请稍后重试。"
        })
        return

    try:
        raw = handler.rfile.read(length)

        if len(raw) != length:
            handler.respond(400, {
                "error": "文件上传不完整，请重新选择。"
            })
            return

        result = extract_document(raw, kind)

    except TimeoutError:
        handler.respond(408, {
            "error": "上传超时，请重新选择文件。"
        })
        return

    except DocumentError as error:
        handler.respond(422, {"error": str(error)})
        return

    except Exception as error:
        handler.log_error(
            "Document extraction failed: %s", error
        )
        handler.respond(422, {
            "error": "读取失败，请检查文件是否损坏、加密或格式不符。"
        })
        return

    finally:
        UPLOAD_LOCK.release()

    handler.respond(200, result)