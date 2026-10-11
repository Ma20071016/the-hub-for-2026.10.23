"""创建服饰核验 SQLite 数据库；重复运行不会清空已有数据。"""

import sqlite3
from pathlib import Path


# 按脚本的位置定位项目，不随终端所在目录改变。
PROJECT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_DIR / "data" / "costume.db"
TABLE_NAMES = ("sources", "evidence_chunks", "verifications", "verification_items")

SCHEMA = """
-- 1. 资料来源：一条记录对应一份采集资料，原图仍保留在资料目录中。
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    case_id TEXT NOT NULL UNIQUE CHECK (length(trim(case_id)) > 0),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    publisher TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    archive_path TEXT NOT NULL DEFAULT '',
    original_text TEXT NOT NULL CHECK (length(trim(original_text)) > 0),
    retrieved_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. 证据片段：从原文提取，保留出处定位和服饰对象，审核后才能检索。
CREATE TABLE IF NOT EXISTS evidence_chunks (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    object_name TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    attribute TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '',
    evidence_text TEXT NOT NULL CHECK (length(trim(evidence_text)) > 0),
    locator TEXT NOT NULL CHECK (length(trim(locator)) > 0),
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_id, locator)
);

-- 3. 核验记录：一次用户提交；没有检索到证据与模型判断信息不足分开记录。
CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY,
    claim TEXT NOT NULL CHECK (length(trim(claim)) > 0),
    input_mode TEXT NOT NULL CHECK (input_mode IN ('manual', 'retrieval')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'no_evidence', 'failed')),
    model_version TEXT,
    preprocessing_config TEXT NOT NULL DEFAULT '{}',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

-- 4. 判断明细：一段证据对应一个预测，保存当时的原文、出处及实际输入。
-- 手动粘贴的证据不自动进入正式资料库，evidence_id 可以为空。
CREATE TABLE IF NOT EXISTS verification_items (
    id INTEGER PRIMARY KEY,
    verification_id INTEGER NOT NULL REFERENCES verifications(id),
    evidence_id INTEGER REFERENCES evidence_chunks(id),
    evidence_snapshot TEXT NOT NULL CHECK (length(trim(evidence_snapshot)) > 0),
    source_snapshot TEXT NOT NULL DEFAULT '',
    claim_input TEXT NOT NULL CHECK (length(trim(claim_input)) > 0),
    evidence_input TEXT NOT NULL CHECK (length(trim(evidence_input)) > 0),
    was_truncated INTEGER NOT NULL DEFAULT 0 CHECK (was_truncated IN (0, 1)),
    label TEXT NOT NULL CHECK (label IN ('supports', 'refutes', 'insufficient')),
    score_supports REAL NOT NULL CHECK (score_supports BETWEEN 0 AND 1),
    score_refutes REAL NOT NULL CHECK (score_refutes BETWEEN 0 AND 1),
    score_insufficient REAL NOT NULL CHECK (score_insufficient BETWEEN 0 AND 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (abs(score_supports + score_refutes + score_insufficient - 1) <= 0.02)
);

CREATE INDEX IF NOT EXISTS idx_evidence_object ON evidence_chunks(object_name);
CREATE INDEX IF NOT EXISTS idx_items_verification ON verification_items(verification_id);
CREATE INDEX IF NOT EXISTS idx_items_evidence ON verification_items(evidence_id);
"""


def initialize_database(connection):
    """在给定连接中建表，便于在内存中检查，也便于重复执行。"""
    # 外键开关只对本次连接有效，后续后端的每个连接也必须开启。
    if connection.in_transaction:
        raise ValueError("请在没有未提交事务的连接中初始化数据库。")
    connection.execute("PRAGMA foreign_keys = ON")
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1):
        raise ValueError(f"不支持数据库版本 {version}，请使用匹配版本的程序。")
    existing_tables = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    if version == 0 and existing_tables:
        raise ValueError("目标数据库已有其他表，未修改；请先确认文件是否正确。")

    # 四张表和索引一起提交；失败时回滚，不留下半套表。
    try:
        connection.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nPRAGMA user_version = 1;\nCOMMIT;")
    except sqlite3.Error:
        connection.rollback()
        raise


def main():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    try:
        initialize_database(connection)
        print(f"数据库已就绪：{DB_PATH}")
        for table in TABLE_NAMES:
            # 表名来自上面的固定清单，不使用用户输入拼接 SQL。
            count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"  {table}: {count} 条记录")
        print("初始化完成。已有数据保留，未导入资料或运行模型。")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
