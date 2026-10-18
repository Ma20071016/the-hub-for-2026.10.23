"""Review workflow checks through the real loopback HTTP API.

Every test owns temporary evidence and history databases. Inference is fake;
HTTP transport, retrieval, review aggregation, snapshots, decisions, and reports
exercise production code without loading Torch or touching project data.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Condition, Lock, Thread
import unittest
from unittest.mock import patch
from uuid import uuid4

from backend.init_db import initialize_database
from backend.review_history import render_report
from backend.serve import WebsiteHandler


class FakeVerifier:
    def __init__(self):
        self.calls = []

    def predict(self, sentence, evidence):
        self.calls.append((sentence, evidence))
        return {
            "label": "insufficient",
            "scores": {"supports": 0.05, "refutes": 0.05, "insufficient": 0.9},
        }


class QuietWebsiteHandler(WebsiteHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        request_id = self.headers.get("X-Test-Request-ID")
        try:
            super().do_POST()
        finally:
            if request_id:
                with self.server.request_lifecycle:
                    self.server.finished_requests.add(request_id)
                    self.server.request_lifecycle.notify_all()


class WorkflowApiTests(unittest.TestCase):
    sentence = "这件棉袍采用绿色棉布。"

    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory(prefix="costume-workflow-api-")
        self.addCleanup(self.temp_directory.cleanup)
        self.db_path = Path(self.temp_directory.name) / "evidence.sqlite3"
        with closing(sqlite3.connect(self.db_path)) as connection:
            initialize_database(connection)
            connection.executemany(
                "INSERT INTO sources (id, case_id, title, original_text, source_url) "
                "VALUES (?, ?, ?, ?, ?)",
                [(1, "workflow-test-1", "演示绿棉袍资料", "棉袍采用绿色棉布。",
                  "https://example.invalid/collection/1"),
                 (2, "workflow-test-2", "待审核资料", "待审核资料。",
                  "https://example.invalid/collection/2")],
            )
            connection.execute(
                "INSERT INTO evidence_chunks "
                "(id, source_id, object_name, attribute, evidence_text, locator, review_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (1, 1, "演示绿棉袍", "材质", "棉袍采用绿色棉布。", "chars:0-10", "approved"),
            )
            connection.commit()
        self.verifier = FakeVerifier()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietWebsiteHandler)
        self.server.auth_required = False  # Isolated legacy workflow fixture; auth has separate API tests.
        self.server.daemon_threads = False
        self.server.db_path = self.db_path
        self.server.history_path = Path(self.temp_directory.name) / "history.sqlite3"
        self.server.verifier = self.verifier
        self.server.model_version = "test-model"
        self.server.model_lock = Lock()
        self.server.request_lifecycle = Condition()
        self.server.finished_requests = set()
        self.server_thread = Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True,
        )
        self.server_thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        self.assertFalse(self.server_thread.is_alive())

    def request(self, method, route, payload=None, *, streaming=False, raw=None, wait_for_finish=False):
        body = raw
        if raw is None and method == "POST":
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        connection = HTTPConnection(*self.server.server_address, timeout=5)
        request_id = uuid4().hex if wait_for_finish else None
        try:
            connection.request(
                method, route, body=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/x-ndjson" if streaming else "application/json",
                    "Connection": "close",
                    **({"X-Test-Request-ID": request_id} if request_id else {}),
                },
            )
            response = connection.getresponse()
            content = response.read().decode("utf-8")
            if request_id:
                # A Content-Length response can arrive before do_POST releases
                # its model lock. Wait for that request's finally blocks, then
                # assert the lock state; an actual leaked lock still fails.
                with self.server.request_lifecycle:
                    self.assertTrue(self.server.request_lifecycle.wait_for(
                        lambda: request_id in self.server.finished_requests, timeout=2,
                    ), "POST request did not finish after its response was read")
                    self.server.finished_requests.remove(request_id)
            headers = dict(response.getheaders())
            content_type = response.getheader("Content-Type", "")
            if content_type.startswith("application/x-ndjson"):
                parsed = [json.loads(line) for line in content.splitlines() if line]
            elif content_type.startswith("application/json"):
                parsed = json.loads(content)
            else:
                parsed = content
            return response.status, headers, parsed
        finally:
            connection.close()

    def create_review(self, *, streaming=False, **overrides):
        payload = {"text": self.sentence, "source_id": 1, "title": "绿棉袍展签初稿"}
        payload.update(overrides)
        status, _, result = self.request("POST", "/api/review", payload, streaming=streaming)
        self.assertEqual(status, 200, result)
        if streaming:
            self.assertEqual(result[-1]["type"], "done", result)
            result = result[-1]
        return result

    def list_reviews(self):
        status, _, result = self.request("GET", "/api/reviews")
        self.assertEqual(status, 200, result)
        self.assertIsInstance(result["reviews"], list)
        return result["reviews"]

    def get_review(self, review_id):
        status, _, result = self.request("GET", f"/api/reviews/{review_id}")
        self.assertEqual(status, 200, result)
        return result

    def save_decisions(self, review_id, revision, decisions):
        return self.request("POST", f"/api/reviews/{review_id}/decisions", {
            "expected_revision": revision, "decisions": decisions,
        })

    def assert_snapshot(self, result):
        self.assertRegex(result["review_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["title"], "绿棉袍展签初稿")
        self.assertEqual(result["source_id"], 1)
        self.assertIsNone(result["parent_id"])
        self.assertIsInstance(result["created_at"], str)
        self.assertTrue(result["created_at"])
        self.assertEqual(result["model_version"], "test-model")
        self.assertEqual(result["decisions_revision"], 0)
        self.assertEqual(result["decisions"], [{"index": 0, "state": "unreviewed", "note": ""}])
        self.assertEqual(result["results"][0]["status"], "insufficient")
        self.assertEqual(result["normalized_text"], self.sentence)

    def test_json_and_ndjson_reviews_are_saved_and_reopen_without_inference(self):
        self.assertEqual(self.list_reviews(), [])
        reviews = [self.create_review(streaming=streaming) for streaming in (False, True)]
        for result in reviews:
            self.assert_snapshot(result)
            saved = self.get_review(result["review_id"])
            for key in ("review_id", "title", "source_id", "parent_id", "created_at",
                        "model_version", "normalized_text", "results", "stats",
                        "decisions_revision", "decisions"):
                self.assertEqual(saved[key], result[key], key)
        summaries = self.list_reviews()
        self.assertEqual({item["review_id"] for item in summaries},
                         {item["review_id"] for item in reviews})
        self.assertEqual(len(summaries), 2)
        self.assertEqual(len(self.verifier.calls), 2, "Reopening history must not rerun inference")
        self.assertTrue(self.server.history_path.exists())
        self.assertNotEqual(self.server.history_path, self.server.db_path)

    def test_decisions_reload_without_overwriting_model_predictions(self):
        review = self.create_review()
        decisions = [{"index": 0, "state": "dismissed", "note": "核对原始展签后保留原句。"}]
        status, _, updated = self.save_decisions(review["review_id"], 0, decisions)
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["decisions_revision"], 1)
        self.assertEqual(updated["decisions"], decisions)
        reopened = self.get_review(review["review_id"])
        self.assertEqual(reopened["decisions"], decisions)
        self.assertEqual(reopened["decisions_revision"], 1)
        self.assertEqual(reopened["results"], review["results"])
        self.assertEqual(reopened["stats"], review["stats"])
        self.assertEqual(len(self.verifier.calls), 1)

    def test_stale_decisions_return_409_and_preserve_latest_revision(self):
        review = self.create_review()
        first = [{"index": 0, "state": "confirmed", "note": "第一位审核者的结论"}]
        self.assertEqual(self.save_decisions(review["review_id"], 0, first)[0], 200)
        stale = [{"index": 0, "state": "pending", "note": "过时页面的结论"}]
        status, _, result = self.save_decisions(review["review_id"], 0, stale)
        self.assertEqual(status, 409, result)
        self.assertIsInstance(result["error"], str)
        saved = self.get_review(review["review_id"])
        self.assertEqual(saved["decisions_revision"], 1)
        self.assertEqual(saved["decisions"], first)

    def test_report_revision_rejects_stale_page_and_exports_current_saved_decisions(self):
        review = self.create_review()
        decisions = [{"index": 0, "state": "confirmed", "note": "SECOND_TAB_ONLY"}]
        self.assertEqual(self.save_decisions(review["review_id"], 0, decisions)[0], 200)
        route = f"/api/reviews/{review['review_id']}/report"
        status, headers, result = self.request("GET", route + "?revision=0")
        self.assertEqual(status, 409, result)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertIsInstance(result["error"], str)
        for query in ("?revision=1", ""):
            with self.subTest(query=query):
                status, headers, report = self.request("GET", route + query)
                self.assertEqual(status, 200, report)
                self.assertTrue(headers["Content-Type"].startswith("text/html"))
                self.assertIn("SECOND_TAB_ONLY", report)
                self.assertIn("确认有误", report)

    def test_report_renders_the_same_snapshot_that_passed_revision_validation(self):
        review = self.create_review()
        later_decisions = [{"index": 0, "state": "confirmed", "note": "SAVED_DURING_RENDER"}]
        observed = []

        def save_during_render(record):
            observed.append({"revision": record["decisions_revision"],
                             "save_status": self.save_decisions(review["review_id"], 0, later_decisions)[0]})
            return render_report(record)

        with patch("backend.serve.render_report", side_effect=save_during_render):
            status, _, report = self.request(
                "GET", f"/api/reviews/{review['review_id']}/report?revision=0",
            )
        self.assertEqual(status, 200, report)
        self.assertEqual(observed, [{"revision": 0, "save_status": 200}])
        self.assertNotIn("SAVED_DURING_RENDER", report)
        saved = self.get_review(review["review_id"])
        self.assertEqual(saved["decisions_revision"], 1)
        self.assertEqual(saved["decisions"], later_decisions)

    def test_concurrent_decisions_allow_only_one_writer_for_a_revision(self):
        review = self.create_review()
        choices = [[{"index": 0, "state": state, "note": note}] for state, note in (
            ("confirmed", "甲的结论"), ("dismissed", "乙的结论"),
        )]
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(
                lambda decisions: self.save_decisions(review["review_id"], 0, decisions), choices,
            ))
        self.assertEqual(sorted(reply[0] for reply in replies), [200, 409], replies)
        winner = choices[next(index for index, reply in enumerate(replies) if reply[0] == 200)]
        saved = self.get_review(review["review_id"])
        self.assertEqual(saved["decisions_revision"], 1)
        self.assertEqual(saved["decisions"], winner)

    def test_edited_recheck_creates_a_child_and_keeps_parent_snapshot(self):
        parent = self.create_review()
        decisions = [{"index": 0, "state": "pending", "note": "补查材质后复核"}]
        self.assertEqual(self.save_decisions(parent["review_id"], 0, decisions)[0], 200)
        parent_before = self.get_review(parent["review_id"])
        edited = "这件宽大的棉袍采用绿色棉布。"
        child = self.create_review(title="绿棉袍展签修订稿", text=edited, parent_id=parent["review_id"])
        self.assertNotEqual(child["review_id"], parent["review_id"])
        self.assertEqual(child["parent_id"], parent["review_id"])
        self.assertEqual(child["normalized_text"], edited)
        self.assertEqual(child["title"], "绿棉袍展签修订稿")
        self.assertEqual(child["decisions_revision"], 0)
        self.assertEqual(child["decisions"], [{"index": 0, "state": "unreviewed", "note": ""}])
        self.assertEqual(self.get_review(parent["review_id"]), parent_before)
        self.assertEqual(len(self.list_reviews()), 2)

    def test_detail_and_report_keep_original_evidence_after_source_changes(self):
        review = self.create_review()
        with closing(sqlite3.connect(self.db_path)) as connection:
            connection.execute("UPDATE sources SET title = '后来改名的资料' WHERE id = 1")
            connection.execute("UPDATE evidence_chunks SET evidence_text = '后来修改的证据' WHERE id = 1")
            connection.commit()
        saved = self.get_review(review["review_id"])
        self.assertEqual(saved["results"], review["results"])
        status, _, report = self.request("GET", f"/api/reviews/{review['review_id']}/report")
        self.assertEqual(status, 200, report)
        self.assertIn("棉袍采用绿色棉布。", report)
        self.assertIn("演示绿棉袍资料", report)
        self.assertNotIn("后来修改的证据", report)
        self.assertNotIn("后来改名的资料", report)

    def test_report_escapes_user_content_and_keeps_model_and_human_results(self):
        with closing(sqlite3.connect(self.db_path)) as connection:
            connection.execute("UPDATE sources SET source_url = ? WHERE id = 1",
                               ('javascript:alert("证据")',))
            connection.commit()
        review = self.create_review(title='<script>alert("标题")</script>')
        note = '<img src=x onerror=alert("备注")>'
        decisions = [{"index": 0, "state": "dismissed", "note": note}]
        self.assertEqual(self.save_decisions(review["review_id"], 0, decisions)[0], 200)
        status, headers, report = self.request("GET", f"/api/reviews/{review['review_id']}/report")
        self.assertEqual(status, 200, report)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertNotIn('<script>alert("标题")</script>', report)
        self.assertNotIn(note, report)
        self.assertIn("&lt;script&gt;", report)
        self.assertIn("&lt;img", report)
        self.assertIn("证据不足", report, "Model result must remain visible after a human decision")
        self.assertIn("保留原句", report)
        self.assertIn("test-model", report)
        self.assertNotIn('href="javascript:', report)
        self.assertIn("javascript:alert", report, "Unsafe source URLs remain visible as plain text")
        self.assertIn("chars:0-10", report)
        self.assertIn(self.sentence, report)

    def test_uncovered_and_noise_only_reviews_reopen_and_export_without_inference(self):
        uncovered = self.create_review(source_id=2)
        self.assertEqual(uncovered["results"][0]["status"], "uncovered")
        self.assertEqual(uncovered["stats"]["coverage_ratio"], 0)
        empty = self.create_review(text="内部测试文稿")
        self.assertEqual(empty["results"], [])
        self.assertEqual(empty["decisions"], [])
        self.assertIsNone(empty["stats"]["coverage_ratio"])
        for review in (uncovered, empty):
            saved = self.get_review(review["review_id"])
            self.assertEqual(saved["results"], review["results"])
            status, _, report = self.request("GET", f"/api/reviews/{review['review_id']}/report")
            self.assertEqual(status, 200, report)
            self.assertNotIn("100.0%", report)
        self.assertEqual(self.verifier.calls, [])

    def test_invalid_review_metadata_is_rejected_before_inference_or_save(self):
        cases = [
            {"title": 7}, {"title": "题" * 121}, {"parent_id": []},
            {"parent_id": "not-an-id"}, {"source_id": 999},
        ]
        for streaming in (False, True):
            for overrides in cases:
                payload = {"text": self.sentence, "source_id": 1, **overrides}
                with self.subTest(streaming=streaming, overrides=overrides):
                    status, headers, result = self.request("POST", "/api/review", payload, streaming=streaming)
                    self.assertIn(status, (400, 404), result)
                    self.assertTrue(headers["Content-Type"].startswith("application/json"))
                    self.assertIsInstance(result["error"], str)
        self.assertEqual(self.list_reviews(), [])
        self.assertEqual(self.verifier.calls, [])
        self.assertFalse(self.server.model_lock.locked())

    def test_invalid_decisions_are_rejected_without_partial_update(self):
        review = self.create_review(text=self.sentence + "这件棉袍衣身宽大。")
        self.assertEqual(len(review["results"]), 2)
        valid = [{"index": index, "state": "unreviewed", "note": ""} for index in range(2)]
        invalid_payloads = [
            [], None,
            {"expected_revision": True, "decisions": valid},
            {"expected_revision": -1, "decisions": valid},
            {"expected_revision": 0, "decisions": valid[:1]},
            {"expected_revision": 0, "decisions": [valid[0], valid[0]]},
            {"expected_revision": 0, "decisions": [valid[0], {"index": 1, "state": "pass", "note": ""}]},
            {"expected_revision": 0, "decisions": [valid[0], {"index": 1, "state": "pending", "note": 1}]},
            {"expected_revision": 0, "decisions": [valid[0], {"index": 1, "state": "pending", "note": "字" * 2001}]},
            {"expected_revision": 0, "decisions": [valid[0], {"index": True, "state": "pending", "note": ""}]},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                status, _, result = self.request(
                    "POST", f"/api/reviews/{review['review_id']}/decisions", payload,
                )
                self.assertEqual(status, 400, result)
                saved = self.get_review(review["review_id"])
                self.assertEqual(saved["decisions_revision"], 0)
                self.assertEqual(saved["decisions"], valid)

    def test_unknown_review_parent_and_report_are_404_without_creating_history(self):
        unknown = "0" * 32
        routes = [f"/api/reviews/{unknown}", f"/api/reviews/{unknown}/report"]
        for route in routes:
            with self.subTest(route=route):
                status, _, result = self.request("GET", route)
                self.assertEqual(status, 404, result)
                self.assertIsInstance(result["error"], str)
        status, _, result = self.save_decisions(unknown, 0, [])
        self.assertEqual(status, 404, result)
        status, _, result = self.request("POST", "/api/review", {
            "text": self.sentence, "source_id": 1, "parent_id": unknown,
        })
        self.assertEqual(status, 404, result)
        self.assertEqual(self.list_reviews(), [])
        self.assertEqual(self.verifier.calls, [])

    def test_failed_inference_does_not_save_a_successful_review(self):
        with patch.object(self.verifier, "predict", side_effect=RuntimeError("test inference failure")):
            for streaming in (False, True):
                with self.subTest(streaming=streaming):
                    status, _, result = self.request("POST", "/api/review", {
                        "text": self.sentence, "source_id": 1,
                    }, streaming=streaming, wait_for_finish=True)
                    if streaming:
                        self.assertEqual(status, 200)
                        self.assertEqual(result[-1]["type"], "error")
                        self.assertNotIn("done", [event["type"] for event in result])
                    else:
                        self.assertEqual(status, 500)
                        self.assertIsInstance(result["error"], str)
                    self.assertFalse(self.server.model_lock.locked())
        self.assertEqual(self.list_reviews(), [])

    def test_failed_snapshot_save_does_not_report_success_or_leak_model_lock(self):
        with patch("backend.serve.save_review", side_effect=sqlite3.OperationalError("database is read-only")):
            for streaming in (False, True):
                with self.subTest(streaming=streaming):
                    status, _, result = self.request("POST", "/api/review", {
                        "text": self.sentence, "source_id": 1,
                    }, streaming=streaming, wait_for_finish=True)
                    if streaming:
                        self.assertEqual(status, 200)
                        self.assertEqual(result[-1]["type"], "error")
                        self.assertNotIn("done", [event["type"] for event in result])
                    else:
                        self.assertEqual(status, 503, result)
                        self.assertIsInstance(result["error"], str)
                    self.assertFalse(self.server.model_lock.locked())
        self.assertEqual(self.list_reviews(), [])
        successful = self.create_review()
        self.assertEqual(successful["results"][0]["status"], "insufficient")
        self.assertEqual(len(self.list_reviews()), 1)


if __name__ == "__main__":
    unittest.main()
