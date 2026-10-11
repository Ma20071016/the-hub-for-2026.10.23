"""导入原始资料、生成证据草稿，或按编号人工审核片段；不复制图片。"""

import argparse
import json
import re
import sqlite3
from pathlib import Path

from backend.init_db import DB_PATH


COLUMNS = "case_id, title, publisher, source_url, archive_path, original_text, retrieved_at"
PARAGRAPH_END = re.compile(r'''[。！？.!?][”’"'）)\]】]*$''')

# 第一批人工整理建议：只选具体馆藏的连续原文，不从测试集导入事实。
# 使用 case_id 和精确原文定位，不依赖数据库中自增编号。
STARTER_SOURCES = (
    ("import:bift:08382a052b16b1c2", "新疆喀什维吾尔族绿棉袍",
     "新疆喀什维吾尔族棉袍 喀什棉袍 维吾尔族棉袍 棉袍 MFB002865", (
        ("此件棉袍质地为棉质色织布，衣身蓝绿色兼织黄、紫、红色。衣里为木戳印花工艺印制的碎花棉布，里子衣襟贴边为黄绿色艾德莱斯绸面料。",
         "材质 颜色 工艺", "棉袍 棉质 色织布 蓝绿色 黄 紫 红 衣里 木戳 印花 碎花棉布 衣襟 贴边 黄绿色 艾德莱斯绸"),
        ("衣身宽大、造型简洁，对襟，两侧缝开短衩，衣身可见明显绗缝线迹，门襟处由于线迹紧密而出轻微褶皱。袖口、门襟、底摆均装饰有黄、白、黑色毛线编结的窄线条装饰。",
         "形制 装饰 工艺", "棉袍 宽大 对襟 短衩 绗缝 袖口 门襟 底摆 毛线 编结 黄 白 黑"),
    )),
    ("import:bift:7ba9c89ca1dbdeb8", "新疆喀什维吾尔族花帽",
     "喀什花帽 维吾尔族花帽 花帽 奇曼塔什干朵帕 朵帕 MFB007301", (
        ("此件花帽以米字为骨架，花枝叶交错，花纹以枝杆连结或线条分隔，成多个正反三角、菱形格局，帽面图案似地毯排列，也称奇曼塔什干朵帕。",
         "纹样 名称", "花帽 米字 枝叶 枝杆 三角 菱形 地毯 奇曼塔什干朵帕"),
        ("此件花帽分为四瓣，以手工平绣纹样装饰，装饰繁盛，底纹为黄色几何网状结构，帽身有红褐色装饰线分成菱形或三角形区域，各区域内填充有黑色植物枝叶纹饰，帽檐镶有黑色绒布边。",
         "形制 纹样 颜色 工艺", "花帽 四瓣 手工 平绣 黄色 几何 网状 红褐色 菱形 三角形 黑色 植物 枝叶 帽檐 绒布"),
    )),
    ("import:bift:a14632b9ad5f86c7", "新疆维吾尔族艾德莱斯绸头巾",
     "艾德莱斯绸头巾 艾得莱丝绸头巾 艾德莱丝绸头巾 维吾尔族头巾 新疆头巾 头巾 MFB007315", (
        ("纹样有带把的木梳纹、石榴纹、龛座纹，成条状有规则地重复排列，形成一种有间隔的多色组合彩条式样、呈现出跳荡韵律，宛如熊熊燃烧的火焰。",
         "纹样", "头巾 木梳纹 石榴纹 龛座纹 条状 重复 排列 多色 彩条"),
        ("此件艾得莱丝绸头巾工艺采用古老的扎经染色法，即在经纱上扎结染色，先按图案要求，于经纱上加以布局、配色、扎结，然后分层染色、整经、织绸。",
         "工艺", "头巾 扎经 染色 经纱 扎结 布局 配色 分层染色 整经 织绸"),
    )),
    ("import:bift:ba1005cc4ae78e12", "新疆维吾尔族黑羔皮帽",
     "维吾尔族皮帽 新疆皮帽 羔皮帽 皮帽 MFB007307", (
        ("帽顶为黑丝绒，分里外两层，羊毛皮为里子，黑色卷毛羔皮作面。",
         "材质 结构 颜色", "皮帽 帽顶 黑丝绒 里外 两层 羊毛皮 里子 黑色 卷毛 羔皮"),
    )),
    ("import:bift:c1d29fe49bd76655", "新疆喀什牛皮女靴",
     "喀什女靴 新疆女靴 维吾尔族女靴 喀什靴 女靴 靴子 MFB006819", (
        ("此件维族女靴收购于新疆喀什，圆头方跟，靴面与靴筒有一明显接缝，两部分呈现出不同光泽；整体造型轻巧、工艺精致、皮质细软，从中可以窥出维吾尔族制靴工艺的水平之高。",
         "采集地点 形制 工艺", "女靴 喀什 收购 圆头 方跟 靴面 靴筒 接缝 光泽 皮质"),
    )),
)


def starter_spans(case_id, title, original_text):
    """校验首批精选原文；返回精确定位及建议标签。"""
    for expected_case, expected_title, aliases, excerpts in STARTER_SOURCES:
        if case_id != expected_case:
            continue
        if title != expected_title:
            raise ValueError(f"首批资料标题发生变化，请核对：{title}")
        results = []
        for text, attribute, keywords in excerpts:
            if original_text.count(text) != 1:
                raise ValueError(f"精选片段无法唯一定位到原文，请核对：{title}")
            start = original_text.index(text)
            results.append({
                "locator": f"chars:{start}:{start + len(text)}", "evidence_text": text,
                "object_name": title, "aliases": aliases, "attribute": attribute, "keywords": keywords,
            })
        return results
    return []


def load_sources(archive_root):
    """完整检查资料后返回待导入记录，检查期间不修改数据库。"""
    root = Path(archive_root).resolve()
    manifest = root / "资料清单.jsonl"
    records = []
    seen = set()
    for line_number, line in enumerate(manifest.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"清单第 {line_number} 行不是有效 JSON。") from error
        if not isinstance(item, dict) or item.get("path_base") != "bundle_root":
            raise ValueError(f"清单第 {line_number} 行的结构或路径基准不正确。")
        for name in ("case_id", "title", "text_path"):
            if not isinstance(item.get(name), str) or not item[name].strip():
                raise ValueError(f"清单第 {line_number} 行缺少有效的 {name}。")
        case_id = item["case_id"]
        if case_id in seen:
            raise ValueError(f"清单中的资料编号重复：{case_id}")
        seen.add(case_id)

        relative_path = Path(item["text_path"])
        text_path = (root / relative_path).resolve()
        if relative_path.is_absolute() or not text_path.is_relative_to(root):
            raise ValueError(f"正文路径超出资料目录：{item['title']}")
        original_text = text_path.read_text(encoding="utf-8-sig")
        if not original_text.strip():
            raise ValueError(f"正文为空：{item['title']}")
        # 清单也有正文副本；核对一致性，避免无意导入不同版本。
        if "text" in item and (
            not isinstance(item["text"], str)
            or item["text"].replace("\r\n", "\n").strip() != original_text.strip()
        ):
            raise ValueError(f"清单正文与正文文件不一致：{item['title']}")
        publisher = item.get("publisher") or ""
        source_url = item.get("source_url") or item.get("url") or ""
        retrieved_at = item.get("retrieved_at")
        if not isinstance(publisher, str) or not isinstance(source_url, str):
            raise ValueError(f"来源字段格式不正确：{item['title']}")
        if retrieved_at is not None and not isinstance(retrieved_at, str):
            raise ValueError(f"采集时间格式不正确：{item['title']}")
        records.append((
            case_id, item["title"], publisher, source_url,
            str(text_path.parent), original_text, retrieved_at,
        ))
    if not records:
        raise ValueError("资料清单为空，未导入任何内容。")
    return records


def plan_import(connection, records):
    """相同编号和内容跳过；相同编号但内容改变时停止，不覆盖旧资料。"""
    pending = []
    skipped = 0
    for record in records:
        existing = connection.execute(
            f"SELECT {COLUMNS} FROM sources WHERE case_id = ?", (record[0],)
        ).fetchone()
        if existing is None:
            pending.append(record)
        elif tuple(existing) == record:
            skipped += 1
        else:
            raise ValueError(f"资料已存在但内容不同，请先核对：{record[1]}（{record[0]}）")
    return pending, skipped


def import_sources(connection, records):
    """整批导入作为一个事务提交，出错时回滚。"""
    if connection.in_transaction:
        raise ValueError("请使用没有未提交事务的连接导入资料。")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        pending, skipped = plan_import(connection, records)
        connection.executemany(
            f"INSERT INTO sources ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)", pending
        )
    return len(pending), skipped


def paragraph_spans(text):
    """按原文行边界分段；连续无句末标点的行与后续段落合并，不改写原文。"""
    start = None
    end = 0
    offset = 0
    for line in text.splitlines(keepends=True):
        content = line.strip()
        if content:
            if start is None:
                start = offset + len(line) - len(line.lstrip())
            end = offset + len(line.rstrip())
        if not content or PARAGRAPH_END.search(content):
            if start is not None:
                yield start, end
                start = None
        offset += len(line)
    if start is not None:
        yield start, end


def plan_chunks(connection):
    """对比完整分段集合；已有分段冲突时停止，避免与人工修订混在一起。"""
    sources = connection.execute("SELECT id, case_id, title, original_text FROM sources ORDER BY id").fetchall()
    if not sources:
        raise ValueError("sources 表为空，请先导入原始资料。")
    pending = []
    skipped = 0
    total = 0
    long_count = 0
    samples = []
    for source_id, case_id, title, text in sources:
        chunks = {f"chars:{start}:{end}": text[start:end] for start, end in paragraph_spans(text)}
        if not chunks:
            raise ValueError(f"资料没有可分段的正文：{title}")
        existing = dict(connection.execute(
            "SELECT locator, evidence_text FROM evidence_chunks WHERE source_id = ?", (source_id,)
        ).fetchall())
        if existing:
            # 批量审核会另存更精确的子串；允许已知精选范围共存，原草稿集合仍须完整。
            extra = {key: value for key, value in existing.items() if key not in chunks}
            allowed = {item["locator"]: item["evidence_text"] for item in starter_spans(case_id, title, text)} if extra else {}
            if any(existing.get(key) != value for key, value in chunks.items()) or any(
                allowed.get(key) != value for key, value in extra.items()
            ):
                raise ValueError(f"已有片段与当前原文或分段规则不同，请先核对：{title}")
            skipped += len(chunks)
        else:
            pending.extend((source_id, content, locator) for locator, content in chunks.items())
        total += len(chunks)
        long_count += sum(len(content) > 300 for content in chunks.values())
        if len(samples) < 3:
            locator, content = next(iter(chunks.items()))
            samples.append((title, locator, content))
    return pending, skipped, len(sources), total, long_count, samples


def build_chunks(connection, *, check=False):
    """只插入待审核草稿，保留已有审核状态、对象、别名和关键词。"""
    if connection.in_transaction:
        raise ValueError("请使用没有未提交事务的连接生成片段。")
    # 预览使用只读事务；写入时先锁定，再读取同一版本原文并整批提交。
    with connection:
        connection.execute("BEGIN" if check else "BEGIN IMMEDIATE")
        plan = plan_chunks(connection)
        if not check:
            connection.executemany(
                "INSERT INTO evidence_chunks (source_id, evidence_text, locator) VALUES (?, ?, ?)",
                plan[0],
            )
    return plan


def get_review_chunk(connection, chunk_id):
    """连同来源上下文读取片段，不修改任何数据。"""
    cursor = connection.execute(
        "SELECT e.*, s.title, s.publisher, s.source_url, s.original_text "
        "FROM evidence_chunks e JOIN sources s ON s.id = e.source_id WHERE e.id = ?",
        (chunk_id,),
    )
    row = cursor.fetchone()
    if row is None:
        raise ValueError(f"没有编号为 {chunk_id} 的证据片段。")
    return dict(zip((column[0] for column in cursor.description), row))


def save_review(connection, original, annotations, status):
    """仅更新人工标签和审核状态；原文或记录已变化时停止，避免覆盖。"""
    if connection.in_transaction:
        raise ValueError("请使用没有未提交事务的连接保存审核结果。")
    if status not in ("approved", "rejected"):
        raise ValueError("审核结果必须为 approved 或 rejected。")
    fields = ("object_name", "aliases", "attribute", "keywords")
    if set(annotations) != set(fields) or any(not isinstance(annotations[key], str) for key in fields):
        raise ValueError("审核标签必须包含对象、别名、属性和关键词四个文本字段。")
    annotations = {key: annotations[key].strip() for key in fields}
    if status == "approved" and any(not annotations[key] for key in ("object_name", "attribute", "keywords")):
        raise ValueError("通过审核前，请填写对象、属性和关键词；别名可以留空。")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        if get_review_chunk(connection, original["id"]) != original:
            raise ValueError("片段或来源在查看后发生变化，请重新运行审核命令。")
        match = re.fullmatch(r"chars:(\d+):(\d+)", original["locator"])
        if match is None:
            raise ValueError("片段定位格式不正确，未保存审核结果。")
        start, end = map(int, match.groups())
        if not (0 <= start < end <= len(original["original_text"])) or (
            original["original_text"][start:end] != original["evidence_text"]
        ):
            raise ValueError("片段与原文位置不一致，未保存审核结果。")
        connection.execute(
            "UPDATE evidence_chunks SET object_name = ?, aliases = ?, attribute = ?, "
            "keywords = ?, review_status = ? WHERE id = ?",
            (*(annotations[key] for key in fields), status, original["id"]),
        )


def review_chunk(connection, chunk_id, *, check=False):
    """一次查看并审核一条；输入过程中不持有数据库写锁。"""
    chunk = get_review_chunk(connection, chunk_id)
    print(f"片段编号：{chunk['id']}；状态：{chunk['review_status']}")
    print(f"来源：{chunk['title']}（{chunk['publisher']}）")
    print(f"链接：{chunk['source_url']}")
    print(f"原文位置：{chunk['locator']}\n\n{chunk['evidence_text']}")
    fields = (("object_name", "对象名称"), ("aliases", "别名"), ("attribute", "属性"), ("keywords", "关键词"))
    for key, label in fields:
        print(f"{label}：{chunk[key] or '（未填写）'}")
    if check:
        print("仅查看，未修改数据库。")
        return
    print("审核通过表示该片段可用于后续检索；具体藏品的描述不能泛化为整类服饰。")
    while True:
        action = input("操作 [a=填写标签并通过 / r=拒绝 / c=查看完整原文 / q=退出]：").strip().lower()
        if action == "c":
            print(f"\n完整原文：\n{chunk['original_text']}\n")
        elif action == "q":
            print("已退出，未修改数据库。")
            return
        elif action in ("a", "r"):
            break
        else:
            print("请输入 a、r、c 或 q。")
    annotations = {key: chunk[key] for key, _ in fields}
    if action == "a":
        print("多项标签用空格分隔；回车保留已有值，输入 - 清空别名。Ctrl+C 可取消。")
        for key, label in fields:
            while True:
                value = input(f"{label} [{chunk[key] or '空'}]：").strip()
                value = "" if value == "-" else value or chunk[key]
                if value or key == "aliases":
                    annotations[key] = value
                    break
                print(f"{label}不能为空。")
    status = "approved" if action == "a" else "rejected"
    print(f"\n待保存状态：{status}")
    for key, label in fields:
        print(f"{label}：{annotations[key] or '（空）'}")
    if input("输入 y 保存，其他输入取消：").strip().lower() != "y":
        print("已取消，未修改数据库。")
        return
    save_review(connection, chunk, annotations, status)
    print(f"已保存片段 {chunk_id}：{status}。原文和定位保持不变。")
    try:
        counts = connection.execute(
            "SELECT review_status, COUNT(*) FROM evidence_chunks GROUP BY review_status ORDER BY review_status"
        ).fetchall()
    except sqlite3.Error as error:
        print(f"审核结果已保存，但当前统计读取失败：{error}")
        return
    print("当前片段统计：" + "；".join(f"{state}={count}" for state, count in counts))


def plan_starter(connection):
    plan = []
    for case_id, expected_title, _, _ in STARTER_SOURCES:
        row = connection.execute(
            "SELECT id, title, original_text, publisher, source_url FROM sources WHERE case_id = ?", (case_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"缺少首批资料，请先导入来源：{expected_title}")
        source_id, title, original_text, publisher, source_url = row
        for item in starter_spans(case_id, title, original_text):
            existing = connection.execute(
                "SELECT id FROM evidence_chunks WHERE source_id = ? AND locator = ?",
                (source_id, item["locator"]),
            ).fetchone()
            snapshot = get_review_chunk(connection, existing[0]) if existing else None
            if snapshot and snapshot["evidence_text"] != item["evidence_text"]:
                raise ValueError(f"相同位置已有不同正文，请核对：{title}")
            # 人工改过标签或状态的记录始终保留，包括已拒绝的记录。
            untouched = snapshot is not None and snapshot["review_status"] == "pending" and not any(
                snapshot[key] for key in ("object_name", "aliases", "attribute", "keywords")
            )
            action = "insert" if snapshot is None else "update" if untouched else "keep"
            plan.append({**item, "source_id": source_id, "source_text": original_text,
                         "publisher": publisher, "source_url": source_url, "snapshot": snapshot, "action": action})
    return plan


def apply_starter(connection, plan):
    """用户确认后整批保存；预览后任何相关变化都会使本批回滚。"""
    if connection.in_transaction:
        raise ValueError("请使用没有未提交事务的连接保存首批证据。")
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        if plan_starter(connection) != plan:
            raise ValueError("预览后资料或片段有变化，请重新预览首批证据。")
        for item in plan:
            values = tuple(item[key] for key in ("object_name", "aliases", "attribute", "keywords"))
            if item["action"] == "insert":
                connection.execute(
                    "INSERT INTO evidence_chunks (source_id, object_name, aliases, attribute, keywords, "
                    "evidence_text, locator, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')",
                    (item["source_id"], *values, item["evidence_text"], item["locator"]),
                )
            elif item["action"] == "update":
                connection.execute(
                    "UPDATE evidence_chunks SET object_name=?, aliases=?, attribute=?, keywords=?, "
                    "review_status='approved' WHERE id=?", (*values, item["snapshot"]["id"]),
                )
    return {action: sum(item["action"] == action for item in plan) for action in ("insert", "update", "keep")}


def review_starter(connection, *, check=False):
    plan = plan_starter(connection)
    print(f"首批建议：{len(STARTER_SOURCES)} 份馆藏资料、{len(plan)} 条精选证据。")
    print("以下仅描述具体藏品。请核对原文与标签；女靴的收购地点不等于制作地点。")
    for index, item in enumerate(plan, 1):
        action = {"insert": "新增并通过", "update": "标注并通过", "keep": "保留已有人工审核或标签"}[item["action"]]
        print(f"\n{index}. {item['object_name']} [{item['locator']}] · {action}")
        print(f"来源：{item['publisher']} {item['source_url']}")
        print(item["evidence_text"])
        for key, name in (("aliases", "别名"), ("attribute", "属性"), ("keywords", "关键词")):
            value = item["snapshot"][key] if item["action"] == "keep" else item[key]
            print(f"{name}：{value or '（空）'}")
        if item["action"] == "keep":
            print(f"保留状态：{item['snapshot']['review_status']}；编号：{item['snapshot']['id']}")
    if check:
        print("\n仅预览，未修改数据库。")
        return
    if all(item["action"] == "keep" for item in plan):
        print("\n首批片段均已有人工记录，本次不修改。")
        return
    if input("\n确认本批原文与标签可用于检索后，输入 y 统一保存；其他输入取消：").strip().lower() != "y":
        print("已取消，未修改数据库。")
        return
    counts = apply_starter(connection, plan)
    print(f"已保存：新增 {counts['insert']} 条，标注已有草稿 {counts['update']} 条，保留人工记录 {counts['keep']} 条。")
    print("本批新增/标注的证据为 approved；其他草稿保留原状。模型尚未接入。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive_root", type=Path, nargs="?", help="包含资料清单.jsonl 的精选资料目录")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--split", action="store_true", help="从已入库原文生成待审核证据片段")
    actions.add_argument("--review", type=int, metavar="ID", help="按片段编号人工审核；加 --check 仅查看")
    actions.add_argument("--starter", action="store_true", help="预览并统一确认首批 5 份资料的 8 条精选证据")
    parser.add_argument("--check", action="store_true", help="只检查资料及重复情况，不写入数据库")
    args = parser.parse_args()
    database_action = args.split or args.review is not None or args.starter
    if database_action and args.archive_root is not None:
        parser.error("--split / --review / --starter 从数据库读取原文，请不要同时指定资料目录。")
    if args.review is not None and args.review <= 0:
        parser.error("片段编号必须是正整数。")
    if not database_action and args.archive_root is None:
        parser.error("请指定资料目录，或使用 --split / --review / --starter。")
    records = None if database_action else load_sources(args.archive_root)
    # mode=rw/ro 要求数据库已存在，路径错误时不会悄悄新建数据库。
    mode = "ro" if args.check else "rw"
    connection = sqlite3.connect(DB_PATH.as_uri() + f"?mode={mode}", uri=True)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        if connection.execute("PRAGMA user_version").fetchone()[0] != 1:
            raise ValueError("数据库版本不匹配，请先确认已运行 backend.init_db。")
        if args.starter:
            review_starter(connection, check=args.check)
        elif args.review is not None:
            review_chunk(connection, args.review, check=args.check)
        elif args.split:
            pending, skipped, source_count, total, long_count, samples = build_chunks(connection, check=args.check)
            print(f"原始资料：{source_count} 份；候选片段：{total} 条")
            print(f"{'待新增' if args.check else '新增'}：{len(pending)} 条；相同片段跳过：{skipped} 条")
            print(f"超过 300 字符的完整片段：{long_count} 条（保留原文，审核时再处理）")
            print("仅检查，未修改数据库。" if args.check else "新增片段全部为 pending（待审核），尚未启用检索或运行模型。")
            if args.check:
                for title, locator, content in samples:
                    print(f"\n示例：{title} [{locator}]\n{content}")
        elif args.check:
            pending, skipped = plan_import(connection, records)
            print(f"检查通过：读取 {len(records)} 份资料，待新增 {len(pending)} 条，相同记录 {skipped} 条。")
            print("仅检查，未修改数据库。")
        else:
            added, skipped = import_sources(connection, records)
            total = connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
            print(f"读取资料：{len(records)} 份")
            print(f"新增：{added} 条；相同记录跳过：{skipped} 条")
            print(f"sources 总记录数：{total}")
            print("导入完成。尚未生成证据片段，也未运行模型。")
        print(f"数据库：{DB_PATH}")
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        raise SystemExit("\n操作已中断；请用 --review ID --check 核对片段状态。")
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(f"本次操作未执行或已回滚：{error}") from error
