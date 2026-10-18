"""Persist review snapshots and separate, revisioned human decisions.

This database is deliberately separate from the approved evidence database.
Every call owns and closes its SQLite connection; model output is immutable.
"""

from contextlib import closing, contextmanager
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4


DEFAULT_MODEL_VERSION = "ocnli_50k_20261007_01/best.pt"
STATUS_LABELS = {
    "supported": "模型判为支持",
    "refute": "疑似矛盾",
    "insufficient": "证据不足",
    "conflicting": "判定分歧",
    "uncovered": "未覆盖",
}
DECISION_LABELS = {
    "unreviewed": "未处理",
    "confirmed": "确认有误",
    "dismissed": "保留原句",
    "pending": "待补证",
}
STANCE_LABELS = {"supports": "支持", "refutes": "反驳", "insufficient": "信息不足"}
_ID_PATTERN = re.compile(r"[0-9a-f]{32}\Z")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS review_runs (
    review_id TEXT PRIMARY KEY,
    owner_id TEXT,
    title TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    parent_id TEXT REFERENCES review_runs(review_id),
    created_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    decisions_revision INTEGER NOT NULL DEFAULT 0,
    decisions_json TEXT NOT NULL,
    decisions_updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_runs_created_at
    ON review_runs(created_at DESC, review_id DESC);
CREATE INDEX IF NOT EXISTS review_runs_parent_id ON review_runs(parent_id);
"""


class NotFoundError(LookupError):
    """The requested review (or parent review) does not exist."""


class ConflictError(RuntimeError):
    """Human decisions changed since the client last loaded this review."""


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


@contextmanager
def _connect(path):
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path, timeout=5)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        yield connection


def initialize_history(path):
    """Create the separate history schema without changing existing records."""
    with _connect(path) as connection, connection:
        # Hold the write lock through the column check and migration so two
        # concurrent first requests cannot both try to add the same column.
        connection.executescript("BEGIN IMMEDIATE;\n" + _SCHEMA)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(review_runs)")}
        if "owner_id" not in columns:
            # Existing records remain unowned; registration must never grant a
            # new account access to somebody else's pre-login review history.
            connection.execute("ALTER TABLE review_runs ADD COLUMN owner_id TEXT")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS review_runs_owner_created_at "
            "ON review_runs(owner_id, created_at DESC, review_id DESC)"
        )


def _json(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("审阅记录必须是有效的 JSON 数据。") from error


def _validate_id(value, name="review_id"):
    if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
        raise ValueError(f"{name} 必须是有效的审阅记录编号。")
    return value


def _validate_owner_id(value):
    if value is not None:
        _validate_id(value, "owner_id")
    return value


def _validate_text(value, name, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} 必须为 1–{maximum} 个字符的非空文本。")
    return value.strip()


def _validate_snapshot(result):
    if not isinstance(result, dict) or result.get("schema_version") != 2:
        raise ValueError("只能保存 schema_version 为 2 的完整审阅结果。")
    rows = result.get("results")
    text = result.get("normalized_text")
    stats = result.get("stats")
    if not isinstance(rows, list) or not isinstance(text, str) or not isinstance(stats, dict):
        raise ValueError("审阅结果缺少正文、逐句结果或统计。")
    if len(text) > 50000:
        raise ValueError("审阅正文不能超过 50000 个字符。")
    counts = dict.fromkeys(STATUS_LABELS, 0)
    previous_end = 0
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or type(row.get("index")) is not int or row["index"] != index:
            raise ValueError("逐句结果必须按连续 index 排序。")
        status = row.get("status")
        if not isinstance(status, str) or status not in STATUS_LABELS:
            raise ValueError("逐句结果包含未知模型状态。")
        sentence = row.get("sentence")
        start, end = row.get("sentence_start"), row.get("sentence_end")
        if (not isinstance(sentence, str) or type(start) is not int or type(end) is not int
                or not previous_end <= start < end <= len(text) or text[start:end] != sentence):
            raise ValueError("逐句结果的位置与保存的正文不一致。")
        if not isinstance(row.get("evidence"), list) or any(
                not isinstance(item, dict) for item in row["evidence"]):
            raise ValueError("逐句结果必须包含证据列表。")
        previous_end = end
        counts[status] += 1
    count_fields = {
        "supported_sentences": counts["supported"],
        "refuted_sentences": counts["refute"],
        "insufficient_sentences": counts["insufficient"],
        "conflicting_sentences": counts["conflicting"],
        "uncovered_sentences": counts["uncovered"],
        "total_sentences": len(rows),
        "checked_sentences": len(rows) - counts["uncovered"],
        "problems_found": counts["refute"],
    }
    if any(type(stats.get(key)) is not int or stats[key] != value
           for key, value in count_fields.items()):
        raise ValueError("审阅统计与逐句结果不一致。")
    expected_coverage = count_fields["checked_sentences"] / len(rows) if rows else None
    coverage = stats.get("coverage_ratio")
    if (expected_coverage is None and coverage is not None) or (
            expected_coverage is not None and (
                type(coverage) not in (int, float) or abs(coverage - expected_coverage) > 1e-9)):
        raise ValueError("审阅覆盖率与逐句结果不一致。")
    if result.get("offset_basis") != "normalized_text_python_chars":
        raise ValueError("审阅结果的正文位置基准不受支持。")
    return _json(result)


def _validate_decisions(decisions, count):
    if not isinstance(decisions, list) or len(decisions) != count:
        raise ValueError("人工决定必须完整覆盖每一句审阅结果。")
    by_index = {}
    for item in decisions:
        if not isinstance(item, dict) or set(item) != {"index", "state", "note"}:
            raise ValueError("人工决定必须且只能包含 index、state 和 note。")
        index, state, note = item["index"], item["state"], item["note"]
        if type(index) is not int or not 0 <= index < count or index in by_index:
            raise ValueError("人工决定的 index 必须唯一且对应正文句子。")
        if not isinstance(state, str) or state not in DECISION_LABELS:
            raise ValueError("人工决定包含未知状态。")
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError("每句人工备注必须是最多 2000 个字符的文本。")
        by_index[index] = {"index": index, "state": state, "note": note}
    return [by_index[index] for index in range(count)]


def _metadata(row):
    return {key: row[key] for key in (
        "review_id", "title", "source_id", "parent_id", "created_at", "model_version",
        "decisions_revision", "decisions_updated_at",
    )}


def _record(row):
    return {
        **json.loads(row["snapshot_json"]),
        **_metadata(row),
        "decisions": json.loads(row["decisions_json"]),
    }


def _find(connection, review_id, owner_id):
    row = connection.execute(
        "SELECT * FROM review_runs WHERE review_id = ? AND owner_id IS ?",
        (review_id, owner_id),
    ).fetchone()
    if row is None:
        raise NotFoundError("未找到这份审阅记录。")
    return row


def save_review(path, result, *, title, source_id, parent_id=None,
                model_version=DEFAULT_MODEL_VERSION, owner_id=None):
    """Save one immutable model snapshot and initialize all decisions unreviewed.

    ``result`` must come from server-side review_document, never a client payload.
    The returned record has a fresh UUID; a child never overwrites its parent.
    ``owner_id=None`` addresses only unowned records, never all accounts.
    """
    _validate_owner_id(owner_id)
    title = _validate_text(title, "文稿标题", 120)
    model_version = _validate_text(model_version, "模型版本", 200)
    if type(source_id) is not int or not 0 < source_id <= 2**63 - 1:
        raise ValueError("source_id 必须是正整数资料编号。")
    if parent_id is not None:
        _validate_id(parent_id, "parent_id")
    snapshot = _validate_snapshot(result)
    decisions = [{"index": row["index"], "state": "unreviewed", "note": ""}
                 for row in result["results"]]
    review_id, now = uuid4().hex, _now()
    initialize_history(path)
    with _connect(path) as connection, connection:
        if parent_id is not None:
            _find(connection, parent_id, owner_id)
        connection.execute(
            "INSERT INTO review_runs (review_id, owner_id, title, source_id, parent_id, created_at, "
            "model_version, snapshot_json, decisions_json, decisions_updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (review_id, owner_id, title, source_id, parent_id, now,
             model_version, snapshot, _json(decisions), now),
        )
        return _record(_find(connection, review_id, owner_id))


def get_review(path, review_id, *, owner_id=None):
    """Load a fresh copy of the snapshot and current human decisions."""
    _validate_id(review_id)
    _validate_owner_id(owner_id)
    initialize_history(path)
    with _connect(path) as connection:
        return _record(_find(connection, review_id, owner_id))


def list_reviews(path, limit=50, *, owner_id=None):
    """Return newest-first summaries without full text or evidence payloads."""
    if type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError("limit 必须为 1–200 的整数。")
    _validate_owner_id(owner_id)
    initialize_history(path)
    with _connect(path) as connection:
        rows = connection.execute(
            "SELECT * FROM review_runs WHERE owner_id IS ? "
            "ORDER BY created_at DESC, review_id DESC LIMIT ?", (owner_id, limit)
        ).fetchall()
    summaries = []
    for row in rows:
        counts = dict.fromkeys(DECISION_LABELS, 0)
        for decision in json.loads(row["decisions_json"]):
            counts[decision["state"]] += 1
        summaries.append({
            **_metadata(row), "stats": json.loads(row["snapshot_json"])["stats"],
            "decision_counts": counts,
        })
    return {"reviews": summaries}


def update_decisions(path, review_id, expected_revision, decisions, *, owner_id=None):
    """Replace human decisions only, using optimistic compare-and-swap.

    A stale revision raises ConflictError and cannot overwrite newer decisions.
    Each successful save advances the revision, including an unchanged list.
    """
    _validate_id(review_id)
    _validate_owner_id(owner_id)
    if type(expected_revision) is not int or not 0 <= expected_revision < 2**63 - 1:
        raise ValueError("expected_revision 必须是非负整数版本号。")
    initialize_history(path)
    with _connect(path) as connection, connection:
        # Acquire a short write transaction before reading the current revision.
        # This also makes revision conflicts deterministic across connections.
        connection.execute("BEGIN IMMEDIATE")
        row = _find(connection, review_id, owner_id)
        if row["decisions_revision"] != expected_revision:
            raise ConflictError("人工复核已在其他页面更新，请重新打开记录后再保存。")
        count = len(json.loads(row["snapshot_json"])["results"])
        validated = _validate_decisions(decisions, count)
        updated = connection.execute(
            "UPDATE review_runs SET decisions_json = ?, decisions_revision = decisions_revision + 1, "
            "decisions_updated_at = ? WHERE review_id = ? AND owner_id IS ? AND decisions_revision = ?",
            (_json(validated), _now(), review_id, owner_id, expected_revision),
        )
        if updated.rowcount != 1:
            raise ConflictError("人工复核版本已变化，请重新打开记录后再保存。")
        return _record(_find(connection, review_id, owner_id))


def _html(value):
    return escape(str(value if value is not None else ""), quote=True)


def _source_link(value):
    """Only absolute HTTP(S) URLs become clickable; every value stays visible."""
    if not isinstance(value, str) or not value:
        return "未提供来源链接"
    try:
        parsed = urlsplit(value)
        safe = (parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)
                and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    except ValueError:
        safe = False
    if safe:
        return f'<a href="{_html(value)}" rel="noopener noreferrer">{_html(value)}</a>'
    return _html(value)


def render_report(record):
    """Return a self-contained, escaped HTML report, suitable for browser printing."""
    _validate_snapshot(record)
    decisions = _validate_decisions(record.get("decisions"), len(record["results"]))
    stats = record["stats"]
    total = stats["total_sentences"]
    coverage = f'{stats["coverage_ratio"]:.1%}' if total else "不适用（无正文句子）"
    decision_counts = dict.fromkeys(DECISION_LABELS, 0)
    for decision in decisions:
        decision_counts[decision["state"]] += 1
    model_summary = " · ".join(
        f"{label} {sum(row['status'] == status for row in record['results'])} 句"
        for status, label in STATUS_LABELS.items())
    human_summary = " · ".join(f"{label} {decision_counts[state]} 句"
                               for state, label in DECISION_LABELS.items())
    pieces = ["""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>""", _html(record.get("title")), """ · 审阅报告</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f1eb;color:#292d2d;font:15px/1.75 system-ui,sans-serif}
main{max-width:1000px;margin:36px auto;padding:40px;background:#fff;border:1px solid #dedbd4}
h1{font-size:28px;line-height:1.4;margin:0 0 12px}h2{font-size:21px;margin:32px 0 14px}
h3{font-size:17px;margin:0 0 10px}h4{font-size:15px;margin:16px 0 8px}p{margin:8px 0}
.muted{color:#606867}.notice{padding:12px 16px;border-left:4px solid #8f693a;background:#faf7ef}
.metadata{display:grid;grid-template-columns:160px 1fr;gap:5px 12px}.metadata dt{color:#606867}
.metadata dd{margin:0;overflow-wrap:anywhere}.summary{padding:16px;background:#f1f6f4}
.sentence{border:1px solid #dce2de;padding:20px;margin:18px 0;break-inside:avoid}
.tag{display:inline-block;border:1px solid #c6d6ce;border-radius:4px;padding:1px 8px;margin:0 6px 6px 0}
.refute,.conflicting{background:#fff1e9;border-color:#e5bba1}.insufficient,.uncovered{background:#fcf8e9}
.human{padding:12px;background:#f5f5f3;margin-top:14px}.prewrap{white-space:pre-wrap;overflow-wrap:anywhere}
blockquote{margin:10px 0;padding:12px 16px;border-left:3px solid #b8ccc1;background:#f7faf8;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#24614a;overflow-wrap:anywhere}.source{font-size:13px;overflow-wrap:anywhere}.original{padding:18px;border:1px solid #dedbd4}
footer{margin-top:30px;border-top:1px solid #ddd;padding-top:14px;color:#606867;font-size:13px}
@media(max-width:600px){main{margin:0;padding:22px 16px}.metadata{grid-template-columns:1fr;gap:2px}.metadata dd{margin-bottom:8px}}
@media print{body{background:#fff;font-size:11pt}main{margin:0;border:0;padding:0;max-width:none}.print-hint{display:none}.sentence{break-inside:auto}h2,h3,h4{break-after:avoid}a{color:inherit}a[href]::after{content:none}@page{margin:18mm}}
</style></head><body><main><header><p class="muted">传统服饰文稿辅助核验 · 审阅报告</p><h1>""",
        _html(record.get("title")), "</h1></header><div class=\"notice\">",
        "本报告保留模型判断与人工复核记录。模型判为支持不代表事实已获确认；覆盖率表示送入模型比对的正文比例，不是准确率或稿件合格率。",
        "</div><p class=\"print-hint muted\">可使用浏览器“打印”功能另存为 PDF。本文件不依赖网络资源。</p>",
        '<h2>审阅信息</h2><dl class="metadata">']
    metadata = [
        ("记录编号", record.get("review_id")),
        ("创建时间（UTC）", record.get("created_at")),
        ("所选资料编号", record.get("source_id")),
        ("父版本记录", record.get("parent_id") or "首版（无父版本）"),
        ("模型版本", record.get("model_version")),
        ("人工决定修订号", record.get("decisions_revision")),
        ("人工决定保存时间（UTC）", record.get("decisions_updated_at")),
    ]
    for label, value in metadata:
        pieces.extend(["<dt>", _html(label), "</dt><dd>", _html(value), "</dd>"])
    pieces.extend([
        '</dl><h2>审阅概况</h2><div class="summary"><p>',
        f"正文 {total} 句 · 实际送入模型 {stats['checked_sentences']} 句 · 覆盖率 {_html(coverage)}",
        "</p><p>", _html(model_summary), "</p><p>未覆盖原因：无候选证据 ",
        _html(stats.get("no_evidence_sentences", 0)), " 句 · 候选相关性不足 ",
        _html(stats.get("low_relevance_sentences", 0)), " 句</p><p>过滤片段 ",
        _html(stats.get("noise_sentences", 0)),
        " 个（标题、短片段等，不计入正文分母）</p><p>人工复核：", _html(human_summary), "</p></div>",
        '<h2>保存的审阅全文</h2><p class="muted">以下为本次核验实际使用的归一化正文；原上传文件的排版、图片、页码不包含在此快照中。</p>',
        '<div class="original prewrap">', _html(record["normalized_text"]), "</div><h2>逐句判断与证据</h2>",
    ])
    if not total:
        pieces.append('<p class="notice">本次没有可审阅的正文句子，没有形成模型核验结论。</p>')
    for row, decision in zip(record["results"], decisions):
        status = row["status"]
        pieces.extend([
            '<section class="sentence"><h3>', f"第 {row['index'] + 1} 句", "</h3>",
            f'<span class="tag {status}">{STATUS_LABELS[status]}</span>',
            '<p class="prewrap">', _html(row["sentence"]), "</p><p class=\"muted\">",
            _html(row.get("message")), "</p><p class=\"source muted\">正文字符位置：",
            f"{row['sentence_start']}–{row['sentence_end']}（从 0 开始，含起点不含终点）；原因：",
            _html(row.get("reason")), "</p><div class=\"human\"><strong>人工复核：",
            DECISION_LABELS[decision["state"]], "</strong><p class=\"prewrap\">备注：",
            _html(decision["note"] or "未填写"), "</p></div>",
        ])
        if not row["evidence"]:
            pieces.append('<p class="muted">无送入模型的证据，本句不能据此判为正确。</p>')
        for index, evidence in enumerate(row["evidence"], 1):
            pieces.extend([
                "<h4>", f"证据 {index} · ", _html(STANCE_LABELS.get(evidence.get("stance"), evidence.get("stance"))),
                "</h4><blockquote>", _html(evidence.get("evidence")), "</blockquote><p class=\"source\">来源：",
                _html(evidence.get("source_title")), "（资料 ", _html(evidence.get("source_id")),
                "；证据 ", _html(evidence.get("evidence_id")), "）<br>对象：", _html(evidence.get("object_name")),
                "<br>定位：", _html(evidence.get("locator")), "<br>", _source_link(evidence.get("source_url")), "</p>",
            ])
            scores = evidence.get("scores") or {}
            score_text = " · ".join(f"{label} {_html(scores.get(stance, '未记录'))}"
                                    for stance, label in STANCE_LABELS.items())
            pieces.extend(['<p class="source muted">模型分数：', score_text,
                           "；字面相关性：", _html(evidence.get("relevance")), "</p>"])
        pieces.append("</section>")
    pieces.extend([
        "<footer>该报告为保存时点的记录。再次审阅会生成关联的新版本；人工复核不会改写原模型判断。",
        "所有时间以 UTC 记录；字符位置以归一化全文的 Python 字符下标为准。</footer></main></body></html>",
    ])
    return "".join(pieces)
