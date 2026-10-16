"""
文本预处理：清洗和分句

这个模块提供两个函数，供文档审阅和证据导入使用。

清洗的目标只有一个：让正文成为 BERT 能正确读懂的文本。
不追求保留下标位置——上传的正文不会写入数据库，
库内证据的 `chars:` 定位来自人工整理的原文，不经过这里。
"""

import re
import unicodedata


def _nfkc_replacements(before, after):
    """统计 NFKC 归一具体改动了哪些字符。

    长度不变不代表没改动——康熙部首还原后长度一样，
    所以逐对比较，而不是比长度。
    """
    if len(before) != len(after):
        # 长度变化时（少数兼容字符会展开），只报总数，不逐字符配对。
        return {"_length_changed": len(after) - len(before)}

    counts = {}
    for old, new in zip(before, after):
        if old != new:
            key = f"{old}(U+{ord(old):04X})->{new}"
            counts[key] = counts.get(key, 0) + 1
    return counts


def clean_text(text):
    """
    归一文档正文，返回 (cleaned_text, stats)。

    处理四类问题：
    1. Unicode 归一（NFKC）：把康熙部首、全角字母数字等还原成常规字符。
       这是最重要的一步——PDF 提取常把「文」写成 U+2F42「⽂」，
       视觉相同但码位不同，BERT 词表里没有，模型会读成未知字符。
    2. 空白归一：换行符、全域空格、不间断空格、零宽字符。
    3. 控制字符：PDF 常见的空字节。
    4. 标点归一：词表缺失的中文引号与破折号。

    参数:
        text: 原始正文（字符串）

    返回:
        (cleaned_text, stats)
        - cleaned_text: 清洗后的正文
        - stats: 统计信息字典，记录各步骤改动了多少
    """
    if not isinstance(text, str):
        raise TypeError("待清洗内容必须是字符串")

    original_length = len(text)

    # --- 1. NFKC 归一 ---------------------------------------------------
    # 康熙部首（U+2F00–U+2FDF）与 CJK 部首补充（U+2E80–U+2EFF）都在此还原。
    # 注意：NFKC 还会把全角标点折成半角（，→,　：→:），这是标准行为。
    # 长度不变不代表没改动，所以逐字符比对来统计。
    before_nfkc = text
    text = unicodedata.normalize("NFKC", text)
    nfkc_replaced = _nfkc_replacements(before_nfkc, text)

    # --- 2. 空白归一 ----------------------------------------------------
    # \r\n 压成单个 \n；各类空格统一成半角空格。
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("　", " ")   # 全角空格
    text = text.replace("\xa0", " ")     # 不间断空格
    text = text.replace("​", "")    # 零宽空格
    text = text.replace("‌", "")    # 零宽非连接符
    text = text.replace("‍", "")    # 零宽连接符
    text = text.replace("﻿", "")    # BOM / 零宽不换行空格

    # 行尾空白删掉；行内连续空格压成一个。
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # --- 3. 控制字符 ----------------------------------------------------
    text = text.replace("\x00", "")

    # --- 4. 标点归一 ----------------------------------------------------
    # bert-base-chinese 词表没有中文引号和破折号，会全部变成 [UNK]。
    # 换成词表内的等价字符，让「并非"圆领"」这类否定写法可被区分。
    punctuation_fixes = {
        "“": '"',   # 左双引号
        "”": '"',   # 右双引号
        "‘": "'",   # 左单引号
        "’": "'",   # 右单引号
        "—": "-",   # 破折号
        "–": "-",   # 短破折号
        "…": "。",  # 省略号，同时提供句末边界
    }
    replaced = {}
    for source, target in punctuation_fixes.items():
        count = text.count(source)
        if count:
            replaced[source] = count
            text = text.replace(source, target)

    return text, {
        "original_length": original_length,
        "cleaned_length": len(text),
        "nfkc_replaced": nfkc_replaced,
        "replaced_punctuation": replaced,
    }


# 句末标点：中文全角 + 英文半角。分号也算，因为切出的单元要单独送模型。
SENTENCE_END = "。！？；!?;"
# 句末标点后允许尾随的收尾符号。
CLOSING_MARKS = "”’\"')]》」】）〕"
# 至少要有一个汉字或字母数字，才算能送模型核验的句子。
_HAS_CONTENT = re.compile(r"[0-9A-Za-z㐀-䶿一-鿿]")


def split_sentences(text):
    """
    按句末标点拆分正文，跨行句子自动合并。

    PDF 按行提取，一句话常被切成两三行，所以换行不作为句末处理，
    除非遇到空行（视为段落边界）。

    参数:
        text: 已清洗的正文

    返回:
        [(句子文本, 起点, 终点), ...]
        起点/终点是 text 的字符下标，满足 text[起点:终点] == 句子文本。
        纯标点、纯空白的片段不返回。
    """
    if not isinstance(text, str):
        raise TypeError("待拆分内容必须是字符串")

    sentences = []
    start = None
    index = 0
    length = len(text)

    while index < length:
        char = text[index]

        if start is None:
            # 跳过前导空白与空行，句子从第一个有形字符开始。
            if char.isspace():
                index += 1
                continue
            start = index

        # 段落边界：连续两个换行。在边界处收束。
        if char == "\n" and index + 1 < length and text[index + 1] == "\n":
            end = index
            while end > start and text[end - 1].isspace():
                end -= 1
            if end > start and _HAS_CONTENT.search(text[start:end]):
                sentences.append((text[start:end], start, end))
            start = None
            index += 1
            continue

        if char in SENTENCE_END:
            end = index + 1
            while end < length and text[end] in CLOSING_MARKS:
                end += 1
            if _HAS_CONTENT.search(text[start:end]):
                sentences.append((text[start:end], start, end))
            start = None
            index = end
            continue

        index += 1

    # 收尾：最后一段没有句末标点。
    if start is not None:
        end = length
        while end > start and text[end - 1].isspace():
            end -= 1
        if end > start and _HAS_CONTENT.search(text[start:end]):
            sentences.append((text[start:end], start, end))

    return sentences
