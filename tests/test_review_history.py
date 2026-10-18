"""Persistent workflow checks using only stdlib and disposable SQLite files.

Run: python -B -m unittest discover -s tests -p test_review_history.py -v
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from html.parser import HTMLParser
from pathlib import Path
import json
import sqlite3
import tempfile
from threading import Barrier
import unittest

from backend.review_history import (
    ConflictError, NotFoundError, get_review, initialize_history, list_reviews,
    render_report, save_review, update_decisions,
)


def snapshot():
    sentences = ["这件棉袍采用对襟设计。", "这件棉袍采用套头设计。", "这件棉袍的主人喜欢听音乐。",
                 "这件服饰的材料存在分歧。", "未知藏品的形制尚无记载。"]
    statuses = ["supported", "refute", "insufficient", "conflicting", "uncovered"]
    rows = []
    text = "\n".join(sentences)
    cursor = 0
    for index, (sentence, status) in enumerate(zip(sentences, statuses)):
        evidence = [] if status == "uncovered" else [{
            "evidence_id": index + 1, "source_id": 7,
            "evidence": "棉袍采用对襟结构，面料为棉布。", "object_name": "棉袍",
            "source_title": "馆藏棉袍介绍", "source_url": "https://example.invalid/source?item=7&lang=zh",
            "locator": "chars:0:18", "stance": "supports" if index == 0 else "insufficient",
            "scores": {"supports": 0.8, "refutes": 0.1, "insufficient": 0.1}, "relevance": 4,
        }]
        rows.append({
            "index": index, "sentence": sentence, "sentence_start": cursor,
            "sentence_end": cursor + len(sentence), "status": status,
            "reason": "no_evidence" if status == "uncovered" else "test_reason",
            "message": "保留模型判断及待人工复核的证据。", "evidence": evidence,
        })
        cursor += len(sentence) + 1
    return {
        "schema_version": 2, "normalized_text": text,
        "offset_basis": "normalized_text_python_chars", "results": rows, "problems": [],
        "stats": {
            "total_sentences": 5, "checked_sentences": 4, "problems_found": 1,
            "supported_sentences": 1, "refuted_sentences": 1, "insufficient_sentences": 1,
            "conflicting_sentences": 1, "uncovered_sentences": 1,
            "no_evidence_sentences": 1, "low_relevance_sentences": 0,
            "noise_sentences": 0, "coverage_ratio": 0.8,
        },
    }


class Tags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


class ReviewHistoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="costume-review-history-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "history" / "review_history.db"

    def save(self, result=None, **kwargs):
        return save_review(self.path, snapshot() if result is None else result,
                           title=kwargs.pop("title", "棉袍文稿"),
                           source_id=kwargs.pop("source_id", 7), **kwargs)

    def create_legacy_history(self, path):
        """Create the pre-account schema with real snapshots and a parent link."""
        path.parent.mkdir(parents=True, exist_ok=True)
        decisions = [{"index": index, "state": "pending", "note": "迁移前的人工备注"}
                     for index in range(5)]
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.row_factory = sqlite3.Row
            connection.execute("""CREATE TABLE review_runs (
                review_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                parent_id TEXT REFERENCES review_runs(review_id),
                created_at TEXT NOT NULL,
                model_version TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                decisions_revision INTEGER NOT NULL DEFAULT 0,
                decisions_json TEXT NOT NULL,
                decisions_updated_at TEXT NOT NULL
            )""")
            for identifier, parent in (("1" * 32, None), ("2" * 32, "1" * 32)):
                connection.execute(
                    "INSERT INTO review_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (identifier, "原有审阅记录", 7, parent, "2026-10-17T02:00:00.000000Z",
                     "legacy-model", json.dumps(snapshot(), ensure_ascii=False), 3,
                     json.dumps(decisions, ensure_ascii=False), "2026-10-17T03:00:00.000000Z"),
                )
            return [dict(row) for row in connection.execute(
                "SELECT * FROM review_runs ORDER BY review_id")]

    def test_history_reads_and_lists_are_scoped_to_exact_owner(self):
        owners = [None, "a" * 32, "b" * 32]
        saved = {owner: self.save(owner_id=owner) for owner in owners}
        newest = self.save(owner_id=owners[1])
        for owner in owners:
            expected = [saved[owner]["review_id"]]
            if owner == owners[1]:
                expected.insert(0, newest["review_id"])
            reviews = list_reviews(self.path, owner_id=owner)["reviews"]
            self.assertEqual([row["review_id"] for row in reviews], expected)
            self.assertEqual(list_reviews(self.path, limit=1, owner_id=owner)["reviews"], reviews[:1])
            self.assertNotIn("owner_id", reviews[0])
            self.assertEqual(get_review(self.path, saved[owner]["review_id"], owner_id=owner), saved[owner])
            for other in owners:
                if other != owner:
                    with self.subTest(owner=owner, other=other), self.assertRaises(NotFoundError):
                        get_review(self.path, saved[other]["review_id"], owner_id=owner)
        self.assertEqual(list_reviews(self.path, owner_id="c" * 32), {"reviews": []})
        self.assertEqual(list_reviews(self.path), list_reviews(self.path, owner_id=None))
        with self.assertRaises(NotFoundError):
            get_review(self.path, newest["review_id"])

    def test_owners_cannot_update_each_others_or_unowned_decisions(self):
        owners = [None, "a" * 32, "b" * 32]
        saved = {owner: self.save(owner_id=owner) for owner in owners}
        for owner in owners:
            for other in owners:
                if other == owner:
                    continue
                record = saved[other]
                decisions = deepcopy(record["decisions"])
                decisions[0].update(state="confirmed", note="不得越权写入")
                with self.subTest(owner=owner, other=other), self.assertRaises(NotFoundError):
                    update_decisions(self.path, record["review_id"], 0, decisions, owner_id=owner)
                self.assertEqual(get_review(self.path, record["review_id"], owner_id=other), record)
        record = saved["a" * 32]
        updated = update_decisions(self.path, record["review_id"], 0,
                                   record["decisions"], owner_id="a" * 32)
        self.assertEqual(updated["decisions_revision"], 1)
        with self.assertRaises(ConflictError):
            update_decisions(self.path, record["review_id"], 0,
                             record["decisions"], owner_id="a" * 32)
        # A caller from another scope cannot learn the current revision either.
        with self.assertRaises(NotFoundError):
            update_decisions(self.path, record["review_id"], 0, [], owner_id="b" * 32)

    def test_parent_must_belong_to_same_owner_including_unowned_scope(self):
        owners = [None, "a" * 32, "b" * 32]
        parents = {owner: self.save(owner_id=owner) for owner in owners}
        for owner in owners:
            for other in owners:
                parent_id = parents[other]["review_id"]
                if other == owner:
                    child = self.save(owner_id=owner, parent_id=parent_id)
                    self.assertEqual(child["parent_id"], parent_id)
                else:
                    with self.subTest(owner=owner, other=other), self.assertRaises(NotFoundError):
                        self.save(owner_id=owner, parent_id=parent_id)
            self.assertEqual(len(list_reviews(self.path, owner_id=owner)["reviews"]), 2)

    def test_invalid_owner_identifiers_are_rejected_by_all_history_operations(self):
        record = self.save()
        for owner in (True, 4, "", "A" * 32, "a" * 31, "a" * 33, "a" * 32 + "\n", "../user"):
            operations = (
                lambda: self.save(owner_id=owner),
                lambda: get_review(self.path, record["review_id"], owner_id=owner),
                lambda: list_reviews(self.path, owner_id=owner),
                lambda: update_decisions(self.path, record["review_id"], 0,
                                         record["decisions"], owner_id=owner),
            )
            for index, operation in enumerate(operations):
                with self.subTest(owner=owner, operation=index), self.assertRaises(ValueError):
                    operation()
        self.assertEqual(get_review(self.path, record["review_id"]), record)
        self.assertEqual(len(list_reviews(self.path)["reviews"]), 1)

    def test_legacy_migration_preserves_every_value_and_keeps_records_unowned(self):
        before = self.create_legacy_history(self.path)
        initialize_history(self.path)
        initialize_history(self.path)
        with closing(sqlite3.connect(self.path)) as connection:
            connection.row_factory = sqlite3.Row
            migrated = [dict(row) for row in connection.execute(
                "SELECT * FROM review_runs ORDER BY review_id")]
        self.assertEqual(migrated, [{**row, "owner_id": None} for row in before])
        owner = "a" * 32
        self.assertEqual(list_reviews(self.path, owner_id=owner), {"reviews": []})
        self.assertEqual(len(list_reviews(self.path)["reviews"]), 2)
        parent = get_review(self.path, "1" * 32)
        self.assertEqual(parent["decisions_revision"], 3)
        self.assertEqual(parent["decisions"][0]["note"], "迁移前的人工备注")
        self.assertEqual(get_review(self.path, "2" * 32)["parent_id"], parent["review_id"])
        self.save(owner_id=owner)
        with self.assertRaises(NotFoundError):
            get_review(self.path, parent["review_id"], owner_id=owner)
        with self.assertRaises(NotFoundError):
            self.save(owner_id=owner, parent_id=parent["review_id"])
        self.assertEqual(len(list_reviews(self.path)["reviews"]), 2)

    def test_concurrent_initialization_is_idempotent_for_new_and_legacy_databases(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                path = Path(self.directory.name) / f"concurrent-{legacy}.db"
                before = self.create_legacy_history(path) if legacy else []
                barrier = Barrier(4)

                def initialize(_):
                    barrier.wait(timeout=5)
                    initialize_history(path)

                with ThreadPoolExecutor(max_workers=4) as executor:
                    list(executor.map(initialize, range(4)))
                with closing(sqlite3.connect(path)) as connection:
                    connection.row_factory = sqlite3.Row
                    columns = [row["name"] for row in connection.execute("PRAGMA table_info(review_runs)")]
                    rows = [dict(row) for row in connection.execute(
                        "SELECT * FROM review_runs ORDER BY review_id")]
                self.assertEqual(columns.count("owner_id"), 1)
                self.assertEqual(rows, [{**row, "owner_id": None} for row in before])

    def test_round_trip_is_persistent_and_isolated_from_mutable_inputs(self):
        original = snapshot()
        expected = deepcopy(original)
        saved = self.save(original)
        self.assertRegex(saved["review_id"], r"^[0-9a-f]{32}$")
        self.assertTrue(saved["created_at"].endswith("Z"))
        self.assertEqual(saved["decisions_revision"], 0)
        self.assertEqual(saved["decisions_updated_at"], saved["created_at"])
        self.assertEqual(saved["decisions"], [
            {"index": index, "state": "unreviewed", "note": ""} for index in range(5)])
        original["results"][0]["sentence"] = "调用者后来修改了内存对象。"
        saved["stats"]["supported_sentences"] = 999
        saved["decisions"][0]["state"] = "confirmed"
        initialize_history(self.path)
        loaded = get_review(self.path, saved["review_id"])
        for key, value in expected.items():
            self.assertEqual(loaded[key], value)
        self.assertEqual(loaded["decisions"][0]["state"], "unreviewed")
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM review_runs").fetchone()[0], 1)

    def test_new_version_keeps_parent_snapshot_and_resets_decisions(self):
        parent = self.save()
        decisions = deepcopy(parent["decisions"])
        decisions[0].update(state="dismissed", note="已核对原文。")
        updated_parent = update_decisions(self.path, parent["review_id"], 0, decisions)
        child = self.save(parent_id=parent["review_id"], title="棉袍文稿（二审）")
        self.assertNotEqual(child["review_id"], parent["review_id"])
        self.assertEqual(child["parent_id"], parent["review_id"])
        self.assertEqual(child["decisions_revision"], 0)
        self.assertTrue(all(item["state"] == "unreviewed" for item in child["decisions"]))
        self.assertEqual(get_review(self.path, parent["review_id"]), updated_parent)

    def test_parent_must_exist_in_same_history_database(self):
        parent = self.save()
        other = Path(self.directory.name) / "other.db"
        with self.assertRaises(NotFoundError):
            save_review(other, snapshot(), title="复核", source_id=7, parent_id=parent["review_id"])
        self.assertEqual(list_reviews(other), {"reviews": []})

    def test_metadata_validation_does_not_create_bad_records(self):
        for field, invalid_values in {
            "title": [None, 7, "", "   ", "a" * 121],
            "source_id": [None, True, 0, -1, 7.0, "7", 2**63],
            "parent_id": [7, "", "../review", "A" * 32],
            "model_version": [None, "", "   ", "a" * 201],
        }.items():
            for value in invalid_values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.save(**{field: value})
        self.assertEqual(list_reviews(self.path)["reviews"], [])
        valid = self.save(title="  文稿名称  ", model_version="  自定义模型 v2  ")
        self.assertEqual(valid["title"], "文稿名称")
        self.assertEqual(valid["model_version"], "自定义模型 v2")

    def test_missing_and_invalid_identifiers_have_distinct_errors(self):
        with self.assertRaises(NotFoundError):
            get_review(self.path, "0" * 32)
        with self.assertRaises(NotFoundError):
            update_decisions(self.path, "0" * 32, 0, [])
        for identifier in (None, True, 42, "", "bad/id", "a" * 33):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                get_review(self.path, identifier)

    def test_complete_decisions_update_without_changing_model_snapshot(self):
        initial = self.save()
        decisions = [
            {"index": 4, "state": "pending", "note": "补充藏品材料后再审。"},
            {"index": 3, "state": "unreviewed", "note": ""},
            {"index": 2, "state": "pending", "note": "没有主人喜好的证据。"},
            {"index": 1, "state": "confirmed", "note": "应改为对襟。"},
            {"index": 0, "state": "dismissed", "note": "原句符合原文。"},
        ]
        updated = update_decisions(self.path, initial["review_id"], 0, decisions)
        self.assertEqual(updated["decisions_revision"], 1)
        self.assertEqual([item["index"] for item in updated["decisions"]], list(range(5)))
        self.assertEqual(updated["created_at"], initial["created_at"])
        for key in snapshot():
            self.assertEqual(updated[key], initial[key])
        decisions[0]["note"] = "内存改变不得写回数据库"
        self.assertEqual(get_review(self.path, initial["review_id"]), updated)

    def test_invalid_decisions_roll_back_entire_update(self):
        initial = self.save()
        valid = initial["decisions"]
        invalid = [None, {}, [], valid[:-1], valid + [valid[0]]]
        for field, value in (("index", True), ("index", -1), ("index", 5), ("index", 1),
                             ("state", "supported"), ("state", []), ("note", None),
                             ("note", "字" * 2001)):
            altered = deepcopy(valid)
            altered[0][field] = value
            invalid.append(altered)
        extra = deepcopy(valid)
        extra[0]["status"] = "supported"
        invalid.append(extra)
        missing = deepcopy(valid)
        del missing[0]["note"]
        invalid.append(missing)
        for payload in invalid:
            with self.subTest(payload=str(payload)[:90]), self.assertRaises(ValueError):
                update_decisions(self.path, initial["review_id"], 0, payload)
            self.assertEqual(get_review(self.path, initial["review_id"]), initial)
        valid = deepcopy(valid)
        valid[0]["note"] = "字" * 2000
        self.assertEqual(update_decisions(self.path, initial["review_id"], 0, valid)["decisions_revision"], 1)

    def test_compare_and_swap_rejects_stale_page_without_losing_notes(self):
        initial = self.save()
        first = deepcopy(initial["decisions"])
        first[0].update(state="dismissed", note="页面 A 已核对")
        updated = update_decisions(self.path, initial["review_id"], 0, first)
        stale = deepcopy(initial["decisions"])
        stale[1].update(state="confirmed", note="页面 B 的过期修改")
        with self.assertRaises(ConflictError):
            update_decisions(self.path, initial["review_id"], 0, stale)
        self.assertEqual(get_review(self.path, initial["review_id"]), updated)
        for revision in (None, True, -1, "1", 1.5, 2**63 - 1):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                update_decisions(self.path, initial["review_id"], revision, stale)

    def test_concurrent_clients_have_one_winner_and_one_conflict(self):
        initial = self.save()
        barrier = Barrier(2)

        def write(note):
            decisions = deepcopy(initial["decisions"])
            decisions[0]["note"] = note
            barrier.wait(timeout=5)
            try:
                return update_decisions(self.path, initial["review_id"], 0, decisions)
            except ConflictError:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(write, ["页面 A", "页面 B"]))
        self.assertEqual(results.count("conflict"), 1)
        winner = next(item for item in results if isinstance(item, dict))
        self.assertEqual(get_review(self.path, initial["review_id"]), winner)
        self.assertEqual(winner["decisions_revision"], 1)

    def test_summaries_show_counts_order_and_do_not_leak_body(self):
        first = self.save(title="一稿")
        second = self.save(title="二稿", parent_id=first["review_id"])
        decisions = deepcopy(second["decisions"])
        decisions[0]["state"] = "confirmed"
        decisions[1]["state"] = "dismissed"
        decisions[2]["state"] = "pending"
        update_decisions(self.path, second["review_id"], 0, decisions)
        reviews = list_reviews(self.path)["reviews"]
        self.assertEqual([row["review_id"] for row in reviews], [second["review_id"], first["review_id"]])
        self.assertEqual(reviews[0]["decision_counts"], {
            "unreviewed": 2, "confirmed": 1, "dismissed": 1, "pending": 1})
        self.assertEqual(reviews[0]["stats"], snapshot()["stats"])
        self.assertEqual(reviews[0]["decisions_revision"], 1)
        self.assertNotIn("results", reviews[0])
        self.assertNotIn("normalized_text", reviews[0])
        self.assertEqual(len(list_reviews(self.path, limit=1)["reviews"]), 1)
        for limit in (0, -1, 201, True, "5"):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                list_reviews(self.path, limit=limit)

    def test_records_and_database_files_are_isolated(self):
        first = self.save()
        second = self.save()
        decisions = deepcopy(first["decisions"])
        decisions[0]["state"] = "confirmed"
        update_decisions(self.path, first["review_id"], 0, decisions)
        self.assertEqual(get_review(self.path, second["review_id"]), second)
        other_path = Path(self.directory.name) / "another.db"
        self.assertEqual(list_reviews(other_path)["reviews"], [])
        with self.assertRaises(NotFoundError):
            get_review(other_path, first["review_id"])

    def test_invalid_model_snapshots_are_not_saved(self):
        changes = [
            lambda value: value.update(schema_version=1),
            lambda value: value.update(offset_basis="other"),
            lambda value: value["results"][0].update(index=1),
            lambda value: value["results"][0].update(sentence_start=True),
            lambda value: value["results"][0].update(sentence="不属于正文的句子。"),
            lambda value: value["results"][0].update(status="pass"),
            lambda value: value["stats"].update(checked_sentences=5),
            lambda value: value["stats"].update(coverage_ratio=1),
            lambda value: value["results"][0]["evidence"][0]["scores"].update(supports=float("nan")),
        ]
        for change in changes:
            result = snapshot()
            change(result)
            with self.assertRaises(ValueError):
                self.save(result)
        self.assertEqual(list_reviews(self.path)["reviews"], [])

    def test_report_retains_all_states_evidence_metadata_and_decisions(self):
        parent = self.save()
        record = self.save(parent_id=parent["review_id"], model_version="test-checkpoint-v3")
        decisions = deepcopy(record["decisions"])
        decisions[0].update(state="dismissed", note="人工核对后保留。")
        decisions[1].update(state="confirmed", note="改为对襟。")
        decisions[4].update(state="pending", note="等待补证。")
        record = update_decisions(self.path, record["review_id"], 0, decisions)
        report = render_report(record)
        for expected in ["模型判为支持", "疑似矛盾", "证据不足", "判定分歧", "未覆盖",
                         "人工核对后保留。", "改为对襟。", "等待补证。", "80.0%", "不是准确率",
                         parent["review_id"], record["review_id"], record["created_at"],
                         "test-checkpoint-v3", "chars:0:18", "棉袍采用对襟结构，面料为棉布。",
                         "支持 0.8", "反驳 0.1", "信息不足 0.1", "UTC", "归一化正文",
                         "无候选证据 1 句", "候选相关性不足 0 句", "过滤片段 0 个"]:
            with self.subTest(expected=expected):
                self.assertIn(expected, report)
        for row in record["results"]:
            self.assertIn(row["sentence"], report)
        parser = Tags()
        parser.feed(report)
        self.assertFalse(any(tag in {"script", "img", "iframe", "link"} for tag, _ in parser.tags))
        self.assertTrue(any(tag == "style" for tag, _ in parser.tags))

    def test_report_escapes_html_and_only_links_absolute_http_urls(self):
        result = snapshot()
        attack = '<script>alert("x")</script><img src=x onerror=alert(1)>'
        result["results"][0]["evidence"][0].update(
            evidence=attack, source_title=attack, locator=attack, source_url="javascript:alert(1)")
        result["results"][1]["evidence"][0]["source_url"] = "data:text/html,<script>alert(1)</script>"
        result["results"][2]["evidence"][0]["source_url"] = "http://["
        result["results"][3]["evidence"][0]["source_url"] = 'https://example.invalid/?q="<test>&x=1'
        record = self.save(result, title=attack)
        decisions = deepcopy(record["decisions"])
        decisions[0]["note"] = attack
        record = update_decisions(self.path, record["review_id"], 0, decisions)
        report = render_report(record)
        self.assertNotIn(attack, report)
        self.assertIn("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;", report)
        parser = Tags()
        parser.feed(report)
        links = [attrs["href"] for tag, attrs in parser.tags if tag == "a"]
        self.assertEqual(links, ['https://example.invalid/?q="<test>&x=1'])
        self.assertFalse(any(tag in {"script", "img"} for tag, _ in parser.tags))
        self.assertFalse(any(key.startswith("on") for _, attrs in parser.tags for key in attrs))

    def test_empty_review_is_storable_and_report_has_no_success_claim(self):
        result = snapshot()
        result.update(normalized_text="标题", results=[])
        result["stats"] = {key: 0 for key in result["stats"]}
        result["stats"].update(coverage_ratio=None, noise_sentences=1)
        record = self.save(result)
        self.assertEqual(record["decisions"], [])
        updated = update_decisions(self.path, record["review_id"], 0, [])
        self.assertEqual(updated["decisions_revision"], 1)
        report = render_report(updated)
        self.assertIn("不适用（无正文句子）", report)
        self.assertIn("没有形成模型核验结论", report)


if __name__ == "__main__":
    unittest.main()
