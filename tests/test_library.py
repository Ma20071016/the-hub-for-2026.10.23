"""Read-only library contracts; no model or production database required."""

import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from backend.init_db import initialize_database
from backend.library import get_library_source, list_library


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.addCleanup(self.connection.close)
        initialize_database(self.connection)

    def source(self, identifier=1, text="棉袍使用棉布。\n帽子采用刺绣。", **fields):
        defaults = {
            "title": f"资料{identifier}", "publisher": "示例博物馆",
            "source_url": "https://example.invalid/source", "retrieved_at": "2026-10-17",
            "archive_path": "D:/private/archive/source.txt",
        }
        defaults.update(fields)
        self.connection.execute(
            "INSERT INTO sources (id,case_id,title,publisher,source_url,retrieved_at,archive_path,original_text) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (identifier, f"case-{identifier}", defaults["title"], defaults["publisher"],
             defaults["source_url"], defaults["retrieved_at"], defaults["archive_path"], text),
        )

    def evidence(self, identifier=1, source=1, **fields):
        values = {
            "object_name": "棉袍", "aliases": "长袍 MFB001", "attribute": "材质",
            "keywords": "棉布", "evidence_text": "棉袍使用棉布。", "locator": "chars:0:8",
            "review_status": "approved",
        }
        values.update(fields)
        self.connection.execute(
            "INSERT INTO evidence_chunks (id,source_id,object_name,aliases,attribute,keywords,"
            "evidence_text,locator,review_status) VALUES (?,?,?,?,?,?,?,?,?)",
            (identifier, source, *(values[key] for key in (
                "object_name", "aliases", "attribute", "keywords", "evidence_text", "locator", "review_status"))),
        )

    def test_empty_library(self):
        self.assertEqual(list_library(self.connection), {
            "sources": [], "stats": {"available_sources": 0, "approved_evidence": 0},
            "attributes": [], "publishers": [],
        })
        self.assertIsNone(get_library_source(self.connection, 1))

    def test_pending_and_rejected_sources_are_unavailable(self):
        for identifier, status in ((1, "pending"), (2, "rejected"), (3, None)):
            self.source(identifier)
            if status:
                self.evidence(identifier, identifier, review_status=status)
            self.assertIsNone(get_library_source(self.connection, identifier))
        self.assertEqual(list_library(self.connection)["sources"], [])

    def test_only_approved_evidence_contributes_to_every_summary_field(self):
        self.source()
        self.evidence()
        for identifier, status in ((2, "pending"), (3, "rejected")):
            self.evidence(identifier, object_name="不应出现", aliases="秘密 MFB999",
                          attribute="年代", keywords="未审核", evidence_text="不可用原文",
                          locator=f"draft:{identifier}", review_status=status)
        result = list_library(self.connection)
        card = result["sources"][0]
        self.assertEqual(result["stats"], {"available_sources": 1, "approved_evidence": 1})
        self.assertEqual(card["object_names"], ["棉袍"])
        self.assertEqual(card["attributes"], ["材质"])
        self.assertEqual(card["keywords"], ["棉布"])
        self.assertEqual(card["catalog_numbers"], ["MFB001"])
        detail = get_library_source(self.connection, 1)
        self.assertEqual(detail["evidence_count"], 1)
        self.assertEqual([item["id"] for item in detail["evidence"]], [1])

    def test_source_and_evidence_order_is_stable_and_counted(self):
        self.source(7)
        self.source(2)
        self.evidence(10, 7)
        self.evidence(9, 2, locator="page:2")
        self.evidence(3, 2, locator="page:1")
        result = list_library(self.connection)
        self.assertEqual([card["id"] for card in result["sources"]], [2, 7])
        self.assertEqual([card["evidence_count"] for card in result["sources"]], [2, 1])
        self.assertEqual(result["stats"], {"available_sources": 2, "approved_evidence": 3})
        self.assertEqual([item["id"] for item in get_library_source(self.connection, 2)["evidence"]], [3, 9])

    def test_whitespace_tags_and_publishers_are_deduplicated(self):
        self.source()
        self.source(2)
        self.source(3, publisher="")
        self.evidence(1, aliases="长袍\t棉衣\n长袍", attribute="材质 形制 材质", keywords="棉布\u3000对襟 棉布")
        self.evidence(2, locator="page:2", aliases="棉衣 大衣", attribute="工艺 形制", keywords="对襟 刺绣")
        self.evidence(3, 2)
        self.evidence(4, 3)
        result = list_library(self.connection)
        card = result["sources"][0]
        self.assertEqual(card["aliases"], ["长袍", "棉衣", "大衣"])
        self.assertEqual(card["attributes"], ["材质", "形制", "工艺"])
        self.assertEqual(card["keywords"], ["棉布", "对襟", "刺绣"])
        self.assertEqual(result["attributes"], ["材质", "形制", "工艺"])
        self.assertEqual(result["publishers"], ["示例博物馆"])

    def test_multiple_objects_are_grouped_without_cross_source_merging(self):
        self.source()
        self.source(2)
        self.evidence(1)
        self.evidence(2, locator="page:2", aliases="大衣 长袍", attribute="形制")
        self.evidence(3, object_name="帽子", aliases="小帽", attribute="工艺", locator="chars:9:16")
        self.evidence(4, 2, aliases="跨来源别名", attribute="尺寸")
        self.assertEqual(get_library_source(self.connection, 1)["objects"], [
            {"name": "棉袍", "aliases": ["长袍", "MFB001", "大衣"], "attributes": ["材质", "形制"], "evidence_ids": [1, 2]},
            {"name": "帽子", "aliases": ["小帽"], "attributes": ["工艺"], "evidence_ids": [3]},
        ])
        self.assertEqual(list_library(self.connection)["sources"][0]["object_names"], ["棉袍", "帽子"])

    def test_original_text_and_untrusted_strings_are_preserved_as_data(self):
        text = "\r\n<script>alert('source')</script>\n棉袍🧵\t原文  "
        attack = '<img src=x onerror="alert(1)">'
        self.source(text=text, title=attack, publisher=attack, source_url="javascript:alert(1)")
        self.evidence(object_name=attack, aliases="", attribute="", keywords="",
                      evidence_text=attack, locator="<script>alert(1)</script>")
        detail = get_library_source(self.connection, 1)
        self.assertEqual(detail["source"]["original_text"], text)
        self.assertEqual(detail["source"]["title"], attack)
        self.assertEqual(detail["source"]["source_url"], "javascript:alert(1)")
        self.assertEqual(detail["evidence"][0]["text"], attack)
        self.assertEqual(detail["objects"][0]["name"], attack)

    def test_local_paths_and_internal_fields_are_not_exposed(self):
        self.source()
        self.evidence()
        public = {"id", "title", "publisher", "source_url", "retrieved_at", "original_text"}
        self.assertEqual(set(get_library_source(self.connection, 1)["source"]), public)
        card = list_library(self.connection)["sources"][0]
        for key in ("archive_path", "case_id", "created_at", "original_text"):
            self.assertNotIn(key, card)

    def test_catalog_numbers_use_only_approved_content_and_complete_ids(self):
        self.source(text="来源另提到 MFB999，与审核对象无关。", title="来源MFB888")
        self.evidence(aliases="MFB001 MFB001 XMFB002 MFB003Z mfb004 MFB１２３",
                      keywords="MFB005", evidence_text="藏品MFB006。MFB001", object_name="MFB007棉袍")
        expected = ["MFB007", "MFB001", "MFB005", "MFB006"]
        self.assertEqual(list_library(self.connection)["sources"][0]["catalog_numbers"], expected)
        self.assertEqual(get_library_source(self.connection, 1)["catalog_numbers"], expected)

    def test_valid_locator_uses_python_characters_including_astral_unicode(self):
        original = "🧵\r\n棉袍使用棉布。\n"
        excerpt = "棉袍使用棉布。"
        start = original.index(excerpt)
        end = start + len(excerpt)
        self.source(text=original)
        self.evidence(locator=f"chars:{start}:{end}", evidence_text=excerpt)
        item = get_library_source(self.connection, 1)["evidence"][0]
        self.assertEqual((item["start"], item["end"], item["locator_verified"]), (3, 10, True))
        self.assertEqual(original[item["start"]:item["end"]], item["text"])

    def test_invalid_mismatched_and_overflowing_locators_remain_non_actionable(self):
        self.source(text="棉袍使用棉布。")
        locators = ["chars:0:6", "chars:0:99", "chars:7:7", "chars:8:1", "chars:-1:7",
                    "chars:0-7", "page:1", "chars:0:7\n", "chars:０:７", "chars:0:" + "9" * 5000]
        for identifier, locator in enumerate(locators, 1):
            self.evidence(identifier, locator=locator)
        for item in get_library_source(self.connection, 1)["evidence"]:
            self.assertFalse(item["locator_verified"], item["locator"])
            self.assertIsNone(item["start"])
            self.assertIsNone(item["end"])

    def test_zero_padded_locator_is_verified_without_integer_conversion_limit(self):
        self.source(text="棉袍使用棉布。")
        self.evidence(locator="chars:" + "0" * 5000 + ":" + "0" * 5000 + "7")
        item = get_library_source(self.connection, 1)["evidence"][0]
        self.assertEqual((item["start"], item["end"], item["locator_verified"]), (0, 7, True))

    def test_excerpt_is_short_and_comes_from_approved_evidence(self):
        self.source(text="不应作为预览的未审核段落")
        self.evidence(evidence_text="  衣\n" + "布" * 200)
        card = list_library(self.connection)["sources"][0]
        self.assertEqual(card["excerpt"], ("衣 " + "布" * 200)[:160] + "…")

    def test_unknown_and_injection_like_source_id_do_not_match(self):
        self.source()
        self.evidence()
        for identifier in (9, -1, None, "1 OR 1=1", "1; DELETE FROM sources"):
            self.assertIsNone(get_library_source(self.connection, identifier))
        self.assertEqual(self.connection.execute("SELECT count(*) FROM sources").fetchone()[0], 1)

    def test_reads_do_not_change_connection_state_or_pending_transaction(self):
        self.source()
        self.evidence()
        for factory in (None, sqlite3.Row):
            self.connection.row_factory = factory
            changes = self.connection.total_changes
            list_library(self.connection)
            get_library_source(self.connection, 1)
            self.assertIs(self.connection.row_factory, factory)
            self.assertTrue(self.connection.in_transaction)
            self.assertEqual(self.connection.total_changes, changes)

    def test_library_works_on_read_only_file_without_writing(self):
        self.source()
        self.evidence()
        self.connection.commit()
        with tempfile.TemporaryDirectory(prefix="costume-library-") as directory:
            path = Path(directory) / "evidence.db"
            with sqlite3.connect(path) as writable:
                self.connection.backup(writable)
            writable.close()
            before = hashlib.sha256(path.read_bytes()).digest()
            read_only = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
            try:
                read_only.execute("PRAGMA query_only = ON")
                self.assertEqual(list_library(read_only)["stats"]["approved_evidence"], 1)
                self.assertEqual(get_library_source(read_only, 1)["evidence_count"], 1)
                self.assertEqual(read_only.total_changes, 0)
            finally:
                read_only.close()
            self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), before)


if __name__ == "__main__":
    unittest.main()
