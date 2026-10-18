"""Library HTTP contracts against disposable databases and the real handler."""

from contextlib import closing
import hashlib
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Thread
import unittest
from unittest.mock import Mock, patch
from urllib.parse import quote

from backend.init_db import initialize_database
from backend.serve import WebsiteHandler


class QuietLibraryHandler(WebsiteHandler):
    def log_message(self, format, *args):
        pass


class LibraryApiTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="costume-library-api-")
        self.addCleanup(directory.cleanup)
        self.db_path = Path(directory.name) / "evidence.sqlite3"
        with closing(sqlite3.connect(self.db_path)) as connection:
            initialize_database(connection)
            connection.executemany(
                "INSERT INTO sources (id,case_id,title,publisher,source_url,original_text,archive_path) "
                "VALUES (?,?,?,?,?,?,?)",
                [(1, "library-1", "示例棉袍", "示例馆", "https://example.invalid/1",
                  "棉袍使用棉布。", "D:/secret/source.txt"),
                 (2, "library-2", "待审核来源", "示例馆", "", "待审核内容。", "D:/secret/pending.txt"),
                 (3, "library-3", "空来源", "示例馆", "", "暂无片段。", "D:/secret/empty.txt")],
            )
            connection.executemany(
                "INSERT INTO evidence_chunks "
                "(id,source_id,object_name,aliases,attribute,keywords,evidence_text,locator,review_status) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                [(1, 1, "棉袍", "长袍 MFB001", "材质", "棉布", "棉袍使用棉布。", "chars:0:7", "approved"),
                 (2, 1, "未审核对象", "MFB999", "年代", "秘密草稿", "待审核内容。", "page:2", "pending"),
                 (3, 2, "待审核对象", "", "年代", "草稿", "待审核内容。", "page:1", "pending")],
            )
            connection.commit()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietLibraryHandler)
        self.server.auth_required = False  # Isolated legacy workflow fixture; auth has separate API tests.
        self.server.daemon_threads = False
        self.server.db_path = self.db_path
        self.server.history_path = Path(directory.name) / "history.sqlite3"
        self.server.verifier = Mock()
        self.server.verifier.predict.side_effect = AssertionError("Library GET must not invoke inference")
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def get(self, route):
        connection = HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request("GET", route, headers={"Connection": "close"})
            response = connection.getresponse()
            content = response.read().decode("utf-8")
            mime = response.getheader("Content-Type", "")
            if mime.startswith("application/json"):
                content = json.loads(content)
            return response.status, mime, content
        finally:
            connection.close()

    def test_list_and_detail_only_expose_approved_evidence(self):
        status, mime, catalog = self.get("/api/library")
        self.assertEqual(status, 200)
        self.assertTrue(mime.startswith("application/json"))
        self.assertEqual(catalog["stats"], {"available_sources": 1, "approved_evidence": 1})
        self.assertEqual([source["id"] for source in catalog["sources"]], [1])
        self.assertEqual(catalog["sources"][0]["catalog_numbers"], ["MFB001"])
        status, _, detail = self.get("/api/library/1")
        self.assertEqual(status, 200)
        self.assertEqual(detail["source"]["original_text"], "棉袍使用棉布。")
        self.assertEqual(detail["evidence_count"], 1)
        self.assertEqual([item["id"] for item in detail["evidence"]], [1])
        self.assertEqual(detail["objects"][0]["evidence_ids"], [1])
        self.assertTrue(detail["evidence"][0]["locator_verified"])
        self.assertEqual((detail["evidence"][0]["start"], detail["evidence"][0]["end"]), (0, 7))

    def test_missing_empty_and_unapproved_sources_return_404(self):
        for identifier in (2, 3, 4):
            with self.subTest(identifier=identifier):
                status, _, result = self.get(f"/api/library/{identifier}")
                self.assertEqual(status, 404)
                self.assertIn("error", result)

    def test_invalid_or_out_of_range_ids_return_404_without_database_access(self):
        ids = ("0", "-1", "01", "1.0", "one", "1/extra", "1%20OR%201=1",
               "9223372036854775808", "9" * 5000)
        with patch("backend.serve.open_database", side_effect=AssertionError("Invalid ID reached database")):
            for identifier in ids:
                with self.subTest(identifier=identifier[:30]):
                    status, _, result = self.get(f"/api/library/{identifier}")
                    self.assertEqual(status, 404)
                    self.assertIn("error", result)

    def test_database_failures_return_recoverable_503_without_internal_details(self):
        for failure in (sqlite3.OperationalError("D:/secret/source.sqlite3"), ValueError("internal schema detail")):
            with patch("backend.serve.open_database", side_effect=failure):
                for route in ("/api/library", "/api/library/1"):
                    with self.subTest(route=route, failure=type(failure).__name__):
                        status, _, result = self.get(route)
                        self.assertEqual(status, 503)
                        self.assertIn("error", result)
                        self.assertNotIn(str(failure), result["error"])

    def test_library_and_source_static_assets_are_served(self):
        assets = {
            "/library.html": "text/html", "/library.js": "text/javascript",
            "/museum-entry.js": "text/javascript",
            "/museum-backdrop.js": "text/javascript",
            "/library.css": "text/css", "/source.html": "text/html", "/source.js": "text/javascript",
            "/guide.html": "text/html", "/guide.css": "text/css",
            "/guide-feedback.js": "text/javascript", "/workspace-guide.js": "text/javascript",
            "/source-picker.js": "text/javascript", "/source-picker.css": "text/css",
        }
        for route, expected_mime in assets.items():
            with self.subTest(route=route):
                status, mime, content = self.get(route)
                self.assertEqual(status, 200)
                self.assertTrue(mime.startswith(expected_mime))
                self.assertTrue(content.strip())

    def test_get_is_read_only_does_not_infer_and_never_exposes_archive_paths(self):
        before = hashlib.sha256(self.db_path.read_bytes()).digest()
        for route in ("/api/library", "/api/library/1"):
            status, _, result = self.get(route)
            self.assertEqual(status, 200)
            serialized = json.dumps(result)
            self.assertNotIn("archive_path", serialized)
            self.assertNotIn("D:/secret", serialized)
        for route in ("/data/evidence.sqlite3", "/backend/library.py", "/secret/source.txt"):
            self.assertEqual(self.get(route)[0], 404)
        self.server.verifier.predict.assert_not_called()
        self.assertFalse(self.server.history_path.exists())
        self.assertEqual(hashlib.sha256(self.db_path.read_bytes()).digest(), before)

    def test_museum_backgrounds_are_binary_allowlisted_assets(self):
        frontend = Path(__file__).resolve().parents[1] / "frontend"
        routes = ("/img/museum/gallery-background.webp",
                  "/img/museum/gallery-background-mobile.webp")
        before = hashlib.sha256(self.db_path.read_bytes()).digest()
        for route in routes:
            expected = (frontend / route.lstrip("/")).read_bytes()
            self.assertEqual(expected[:4], b"RIFF")
            self.assertEqual(expected[8:12], b"WEBP")
            for suffix in ("", "?v=museum"):
                with self.subTest(route=route + suffix):
                    connection = HTTPConnection(*self.server.server_address, timeout=5)
                    try:
                        connection.request("GET", route + suffix, headers={"Connection": "close"})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("Content-Type"), "image/webp")
                        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
                        self.assertEqual(response.getheader("Cache-Control"), "no-store")
                        self.assertEqual(int(response.getheader("Content-Length")), len(expected))
                        self.assertEqual(response.read(), expected)
                    finally:
                        connection.close()
        for route in ("/img/museum/", "/img/museum/unlisted.webp",
                      "/img/museum/gallery-background.webp/extra",
                      "/img/museum/../gallery-background.webp",
                      "/img/museum/..%2Fgallery-background.webp",
                      "/img/museum/%2e%2e/library.html",
                      "/img/museum/../../../data/evidence.sqlite3"):
            with self.subTest(route=route):
                self.assertEqual(self.get(route)[0], 404)
        with patch("backend.serve.FRONTEND", self.db_path.parent / "missing-frontend"):
            for route in routes:
                self.assertEqual(self.get(route)[0], 404)
        self.server.verifier.predict.assert_not_called()
        self.assertFalse(self.server.history_path.exists())
        self.assertEqual(hashlib.sha256(self.db_path.read_bytes()).digest(), before)

    def test_practice_word_download_is_public_binary_and_read_only(self):
        self.server.auth_required = True
        route = "/downloads/robe-review-practice.docx"
        frontend = Path(__file__).resolve().parents[1] / "frontend"
        expected = (frontend / route.lstrip("/")).read_bytes()
        self.assertTrue(expected.startswith(b"PK\x03\x04"))
        disposition = (
            'attachment; filename="robe-review-practice.docx"; '
            "filename*=UTF-8''" + quote("【教学示例】绿棉袍审阅体验.docx", safe="")
        )
        before = hashlib.sha256(self.db_path.read_bytes()).digest()
        with patch("backend.serve.open_database", side_effect=AssertionError("Download reached database")), \
                patch.object(WebsiteHandler, "load_session", side_effect=AssertionError("Download requires session")):
            for suffix in ("", "?v=practice"):
                with self.subTest(route=route + suffix):
                    connection = HTTPConnection(*self.server.server_address, timeout=5)
                    try:
                        connection.request("GET", route + suffix, headers={"Connection": "close"})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.getheader("Content-Type"),
                                         "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                        self.assertEqual(response.getheader("Content-Disposition"), disposition)
                        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
                        self.assertEqual(int(response.getheader("Content-Length")), len(expected))
                        self.assertEqual(response.read(), expected)
                    finally:
                        connection.close()
        self.server.verifier.predict.assert_not_called()
        self.assertFalse(self.server.history_path.exists())
        self.assertEqual(hashlib.sha256(self.db_path.read_bytes()).digest(), before)

    def test_practice_word_download_only_serves_allowlisted_existing_file(self):
        self.server.auth_required = True
        for route in ("/downloads/", "/downloads/unlisted.docx",
                      "/downloads/robe-review-practice.docx/extra",
                      "/downloads/../index.html", "/downloads/..%2Findex.html",
                      "/downloads/%2e%2e/index.html",
                      "/downloads/../../data/evidence.sqlite3"):
            with self.subTest(route=route):
                self.assertEqual(self.get(route)[0], 404)
        with patch("backend.serve.FRONTEND", self.db_path.parent / "missing-frontend"):
            self.assertEqual(self.get("/downloads/robe-review-practice.docx")[0], 404)
        self.server.verifier.predict.assert_not_called()

    def visual_fixture(self):
        directory = self.db_path.parent / "photos"
        directory.mkdir()
        manifest = self.db_path.parent / "photos.json"
        image_bytes = b"\x89PNG\r\n\x1a\nfixture"
        (directory / "robe.png").write_bytes(image_bytes)
        (directory / "unlisted.png").write_bytes(image_bytes)
        manifest.write_text(json.dumps({"schema_version": 1, "sources": [{
            "case_id": "library-1", "title": "示例棉袍", "source_url": "https://example.invalid/1",
            "object_name": "棉袍", "images": [{
                "id": "robe", "file": "robe.png", "original_url": "https://example.invalid/photo.png",
                "caption": "棉袍照片", "alt": "棉袍正面", "width": 800, "height": 1000, "credit": "示例馆",
                "hotspots": [{"id": "cotton", "label": "棉布", "x": 30, "y": 40, "evidence_quote": "棉袍使用棉布。"}],
            }],
        }]}), encoding="utf-8")
        for name, value in (("MANIFEST_PATH", manifest), ("IMAGE_DIR", directory)):
            context = patch("backend.library_visuals." + name, value)
            context.start()
            self.addCleanup(context.stop)
        return directory, image_bytes

    def test_photo_metadata_and_linked_evidence_are_returned_by_api(self):
        self.visual_fixture()
        before = hashlib.sha256(self.db_path.read_bytes()).digest()
        status, _, catalog = self.get("/api/library")
        self.assertEqual(status, 200)
        card = catalog["sources"][0]
        self.assertEqual(card["visual_count"], 1)
        self.assertEqual(card["cover"]["url"], "/img/library/robe.png")
        status, _, detail = self.get("/api/library/1")
        self.assertEqual(status, 200)
        self.assertEqual(detail["visuals"][0]["hotspots"][0]["evidence_id"], 1)
        self.assertNotIn("evidence_quote", json.dumps(detail))
        self.assertEqual(hashlib.sha256(self.db_path.read_bytes()).digest(), before)
        self.server.verifier.predict.assert_not_called()

    def test_image_route_serves_only_listed_files_with_safe_headers(self):
        directory, image_bytes = self.visual_fixture()
        connection = HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request("GET", "/img/library/robe.png?cache=1", headers={"Connection": "close"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "image/png")
            self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(response.read(), image_bytes)
        finally:
            connection.close()
        for route in ("/img/library/unlisted.png", "/img/library/../photos.json", "/img/library/..%2Fphotos.json",
                      "/img/library/%2e%2e/robe.png", "/img/library/robe.png/extra", "/img/library/robe.svg",
                      "/img/library/..\\photos.json", "/img/library/C:/photos.json", "/img/library/"):
            with self.subTest(route=route):
                self.assertEqual(self.get(route)[0], 404)
        (directory / "robe.png").unlink()
        self.assertEqual(self.get("/img/library/robe.png")[0], 404)
        self.assertEqual(self.get("/api/library/1")[2]["visuals"], [])


if __name__ == "__main__":
    unittest.main()
