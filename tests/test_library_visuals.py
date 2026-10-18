"""Photo bindings and safe local image routing, using only disposable fixtures."""

from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from backend.init_db import initialize_database
from backend.library import get_library_source, list_library
from backend.library_visuals import load_visual_manifest, read_library_image


class LibraryVisualTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="costume-library-visuals-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.images = self.directory / "images"
        self.images.mkdir()
        self.manifest_path = self.directory / "visuals.json"
        self.image_bytes = b"\x89PNG\r\n\x1a\nfixture"
        (self.images / "robe.png").write_bytes(self.image_bytes)
        for name, value in (("MANIFEST_PATH", self.manifest_path), ("IMAGE_DIR", self.images)):
            context = patch("backend.library_visuals." + name, value)
            context.start()
            self.addCleanup(context.stop)
        self.connection = sqlite3.connect(":memory:")
        self.addCleanup(self.connection.close)
        initialize_database(self.connection)
        self.connection.execute(
            "INSERT INTO sources (id,case_id,title,source_url,original_text,archive_path) VALUES (?,?,?,?,?,?)",
            (17, "robe-case", "馆藏棉袍", "https://museum.example/robe", "棉袍为对襟。", "D:/private/source.txt"),
        )
        self.connection.execute(
            "INSERT INTO evidence_chunks (id,source_id,object_name,evidence_text,locator,review_status) "
            "VALUES (?,?,?,?,?,?)", (123, 17, "棉袍", "棉袍为对襟。", "chars:0:6", "approved"),
        )
        self.data = {"schema_version": 1, "sources": [{
            "case_id": "robe-case", "title": "馆藏棉袍", "source_url": "https://museum.example/robe",
            "object_name": "棉袍", "images": [{
                "id": "robe-front", "file": "robe.png", "original_url": "https://museum.example/img/robe.png",
                "caption": "棉袍正面", "alt": "棉袍正面照片", "width": 800, "height": 1000,
                "credit": "示例博物馆", "hotspots": [{
                    "id": "front", "label": "对襟", "x": 50, "y": 40,
                    "evidence_quote": "棉袍为对襟。",
                }],
            }],
        }]}
        self.write_manifest()

    @property
    def entry(self):
        return self.data["sources"][0]

    @property
    def image(self):
        return self.entry["images"][0]

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")

    def detail(self):
        return get_library_source(self.connection, 17)

    def test_bound_photo_and_current_evidence_id_are_public_without_private_paths(self):
        before = self.connection.total_changes
        detail = self.detail()
        visual = detail["visuals"][0]
        self.assertEqual(visual["url"], "/img/library/robe.png")
        self.assertEqual(visual["hotspots"], [{"id": "front", "label": "对襟", "x": 50, "y": 40, "evidence_id": 123}])
        self.assertEqual(set(visual), {"id", "url", "original_url", "caption", "alt", "width", "height", "credit", "hotspots"})
        card = list_library(self.connection)["sources"][0]
        self.assertEqual(card["visual_count"], 1)
        self.assertEqual(card["cover"], {"url": "/img/library/robe.png", "alt": "棉袍正面照片", "width": 800, "height": 1000})
        self.assertEqual(list_library(self.connection)["stats"], {"available_sources": 1, "approved_evidence": 1})
        for private in ("archive_path", "D:/private", "case_id", "evidence_quote", '"file"'):
            self.assertNotIn(private, json.dumps(detail))
        self.assertEqual(before, self.connection.total_changes)
        self.connection.execute("UPDATE evidence_chunks SET id=987 WHERE id=123")
        self.assertEqual(self.detail()["visuals"][0]["hotspots"][0]["evidence_id"], 987)

    def test_source_binding_requires_all_three_identity_fields(self):
        for key in ("case_id", "title", "source_url"):
            with self.subTest(key=key):
                original = self.entry[key]
                self.entry[key] = "https://other.example/" if key == "source_url" else original + "其他"
                self.write_manifest()
                self.assertEqual(self.detail()["visuals"], [])
                self.assertEqual(list_library(self.connection)["sources"][0]["visual_count"], 0)
                self.entry[key] = original

    def test_object_name_must_have_current_approved_evidence(self):
        self.connection.execute(
            "INSERT INTO evidence_chunks (source_id,object_name,evidence_text,locator,review_status) VALUES (?,?,?,?,?)",
            (17, "未审核对象", "棉袍为对襟。", "page:2", "pending"),
        )
        self.entry["object_name"] = "未审核对象"
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])
        self.entry["object_name"] = "棉袍"
        self.write_manifest()
        for status in ("pending", "rejected"):
            self.connection.execute("UPDATE evidence_chunks SET review_status=? WHERE id=123", (status,))
            self.assertIsNone(self.detail())
            self.assertEqual(list_library(self.connection)["sources"], [])

    def test_hotspots_require_exact_unique_approved_quote_for_that_object(self):
        self.connection.execute("UPDATE evidence_chunks SET evidence_text='棉袍为对襟。更新' WHERE id=123")
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])
        self.connection.execute(
            "INSERT INTO evidence_chunks (source_id,object_name,evidence_text,locator,review_status) VALUES (?,?,?,?,?)",
            (17, "另一件", "棉袍为对襟。", "page:2", "approved"),
        )
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])
        self.connection.execute("UPDATE evidence_chunks SET object_name='棉袍', review_status='pending' WHERE locator='page:2'")
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])
        self.connection.execute("UPDATE evidence_chunks SET evidence_text='棉袍为对襟。' WHERE id=123")
        self.connection.execute("UPDATE evidence_chunks SET review_status='approved' WHERE locator='page:2'")
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])

    def test_no_images_and_missing_files_leave_text_and_counts_available(self):
        self.entry["images"] = []
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])
        card = list_library(self.connection)["sources"][0]
        self.assertEqual((card["visual_count"], card["cover"], card["evidence_count"]), (0, None, 1))
        self.assertIsNone(read_library_image("robe.png"))

    def test_missing_image_is_omitted_and_not_served(self):
        (self.images / "robe.png").unlink()
        self.assertEqual(self.detail()["visuals"], [])
        self.assertIsNone(read_library_image("robe.png"))

    def test_broken_missing_or_unsupported_manifests_fail_closed(self):
        bad_contents = ["{", "null", "[]", '{"schema_version":true,"sources":[]}',
                        '{"schema_version":2,"sources":[]}', '{"schema_version":1,"sources":{}}',
                        '{"schema_version":1,"sources":[null,1,"bad",{}]}', "\ufeff{}", "[" * 2000]
        for contents in bad_contents:
            with self.subTest(contents=contents[:50]):
                self.manifest_path.write_text(contents, encoding="utf-8")
                self.assertEqual(self.detail()["visuals"], [])
                self.assertIsNone(read_library_image("robe.png"))
        self.manifest_path.write_bytes(b"\xff")
        self.assertEqual(load_visual_manifest(), [])
        self.manifest_path.write_bytes(b" " * (2 * 1024 * 1024 + 1))
        self.assertEqual(load_visual_manifest(), [])
        self.manifest_path.unlink()
        self.assertEqual(self.detail()["visuals"], [])

    def test_only_http_https_urls_are_allowed(self):
        for key, target in (("source_url", self.entry), ("original_url", self.image)):
            original = target[key]
            for value in ("javascript:alert(1)", "data:image/png;base64,abc", "file:///secret", "//museum.example/x",
                          "https://", "https://user:pass@museum.example/x", "https://museum.example:99999/x",
                          "https://museum.example/\nimage", "https://museum.example\\image", "https://[invalid/"):
                with self.subTest(key=key, value=value):
                    target[key] = value
                    self.write_manifest()
                    self.assertEqual(self.detail()["visuals"], [])
            target[key] = original

    def test_coordinate_edges_are_valid_and_invalid_points_are_removed(self):
        original = deepcopy(self.image["hotspots"][0])
        for x, y in ((0, 100), (100, 0), (12.5, 45.25)):
            self.image["hotspots"] = [{**original, "x": x, "y": y}]
            self.write_manifest()
            self.assertEqual(len(self.detail()["visuals"][0]["hotspots"]), 1)
        for value in (-1, 101, float("nan"), float("inf"), True, "10", None, 10**400):
            for axis in ("x", "y"):
                with self.subTest(value=str(value)[:20], axis=axis):
                    self.image["hotspots"] = [{**original, axis: value}]
                    self.write_manifest()
                    self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])

    def test_duplicate_image_hotspot_and_binding_ids_are_not_guessed(self):
        original = deepcopy(self.data)
        self.image["hotspots"].append(deepcopy(self.image["hotspots"][0]))
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])
        self.data = deepcopy(original)
        self.entry["images"].append(deepcopy(self.image))
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])
        self.data = deepcopy(original)
        self.data["sources"].append(deepcopy(self.entry))
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])

    def test_invalid_images_do_not_break_valid_siblings(self):
        good = deepcopy(self.image)
        for field, value in (("width", 0), ("height", True), ("height", "1000"), ("id", "<script>"),
                             ("alt", None), ("credit", ""), ("file", 1)):
            with self.subTest(field=field, value=value):
                self.entry["images"] = [{**good, "id": "invalid", field: value}, good]
                self.write_manifest()
                self.assertEqual([item["id"] for item in self.detail()["visuals"]], ["robe-front"])

    def test_only_allowlisted_safe_basenames_are_served(self):
        self.assertEqual(read_library_image("robe.png"), (self.image_bytes, "image/png"))
        (self.images / "private.png").write_bytes(b"private")
        self.assertIsNone(read_library_image("private.png"))
        for filename in ("../robe.png", "..\\robe.png", "%2e%2e%2frobe.png", "dir/robe.png",
                         "/robe.png", "C:/robe.png", "robe.png/extra", "robe.svg", "robe.png\x00", "robe.png\n"):
            with self.subTest(filename=filename):
                self.assertIsNone(read_library_image(filename))
                self.image["file"] = filename
                self.write_manifest()
                self.assertEqual(self.detail()["visuals"], [])

    def test_symlink_outside_fixed_folder_is_not_served(self):
        outside = self.directory / "outside.png"
        outside.write_bytes(b"private")
        link = self.images / "outside.png"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("Platform does not allow creating symlinks")
        self.image["file"] = "outside.png"
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])
        self.assertIsNone(read_library_image("outside.png"))

    def test_same_folder_symlink_cannot_disguise_nonimage_files(self):
        private = self.images / "private.txt"
        private.write_bytes(b"private")
        link = self.images / "alias.png"
        try:
            link.symlink_to(private)
        except (OSError, NotImplementedError):
            self.skipTest("Platform does not allow creating symlinks")
        self.image["file"] = "alias.png"
        self.write_manifest()
        self.assertEqual(self.detail()["visuals"], [])
        self.assertIsNone(read_library_image("alias.png"))

    def test_jpg_and_webp_have_image_mime_types(self):
        for extension, mime in (("jpg", "image/jpeg"), ("webp", "image/webp")):
            with self.subTest(extension=extension):
                filename = "robe." + extension
                (self.images / filename).write_bytes(b"fixture")
                self.image["file"] = filename
                self.write_manifest()
                self.assertEqual(read_library_image(filename), (b"fixture", mime))

    def test_frontend_dimension_and_text_limits_are_enforced(self):
        good = deepcopy(self.image)
        for field, valid, invalid in (("width", 20000, 20001), ("height", 20000, 20001),
                                      ("alt", "图" * 1000, "图" * 1001),
                                      ("credit", "馆" * 1000, "馆" * 1001),
                                      ("caption", "说明" * 1000, "图" * 2001)):
            with self.subTest(field=field):
                self.entry["images"] = [{**good, field: valid}]
                self.write_manifest()
                self.assertEqual(len(self.detail()["visuals"]), 1)
                self.entry["images"] = [{**good, field: invalid}]
                self.write_manifest()
                self.assertEqual(self.detail()["visuals"], [])

    def test_hotspot_and_combined_multiobject_photo_limits(self):
        good = deepcopy(self.image)
        hotspot = good["hotspots"][0]
        self.image["hotspots"] = [{**hotspot, "id": f"point-{index}"} for index in range(26)]
        self.write_manifest()
        self.assertEqual(len(self.detail()["visuals"][0]["hotspots"]), 25)
        self.connection.execute(
            "INSERT INTO evidence_chunks (source_id,object_name,evidence_text,locator,review_status) VALUES (?,?,?,?,?)",
            (17, "另一件", "棉袍为对襟。", "page:2", "approved"),
        )
        self.entry["images"] = [{**good, "id": f"first-{index}"} for index in range(30)]
        other = {**self.entry, "object_name": "另一件", "images": [
            {**good, "id": f"second-{index}"} for index in range(30)
        ]}
        self.data["sources"].append(other)
        self.write_manifest()
        self.assertEqual(len(self.detail()["visuals"]), 50)
        self.assertEqual(list_library(self.connection)["sources"][0]["visual_count"], 50)
        # IDs must remain unique even when different objects share one source.
        other["images"][0]["id"] = "first-0"
        self.write_manifest()
        ids = [item["id"] for item in self.detail()["visuals"]]
        self.assertNotIn("first-0", ids)
        self.assertEqual(len(ids), len(set(ids)))

    def test_unsafe_javascript_integer_ids_do_not_become_hotspot_links(self):
        self.connection.execute("UPDATE evidence_chunks SET id=? WHERE id=123", (2**53,))
        self.assertEqual(self.detail()["visuals"][0]["hotspots"], [])


if __name__ == "__main__":
    unittest.main()
