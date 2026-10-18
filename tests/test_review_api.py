"""HTTP integration checks using a disposable database and fake inference.

Run: python -B -m unittest discover -s tests -p test_review_api.py -v

The real HTTP handler, JSON/NDJSON transport, SQLite retrieval, text processing,
relevance filter, and review aggregation run end to end on a loopback port.
"""

from contextlib import closing
from http.client import HTTPConnection, HTTPException
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Event, Lock, Thread
import unittest
from unittest.mock import patch

from backend.init_db import initialize_database
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


class ReviewApiTests(unittest.TestCase):
    sentence = "这件棉袍采用绿色棉布。"

    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory(prefix="costume-review-api-")
        self.addCleanup(self.temp_directory.cleanup)
        db_path = Path(self.temp_directory.name) / "review.sqlite3"
        with closing(sqlite3.connect(db_path)) as connection:
            initialize_database(connection)
            connection.executemany(
                "INSERT INTO sources (id, case_id, title, original_text, source_url) "
                "VALUES (?, ?, ?, ?, ?)",
                [(1, "api-test-1", "演示绿棉袍资料", "棉袍采用绿色棉布。",
                  "https://example.invalid/collection/1"),
                 (2, "api-test-2", "无审核证据资料", "待审核资料。",
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
        self.server.db_path = db_path
        self.server.verifier = self.verifier
        self.server.model_lock = Lock()
        self.server_thread = Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.server_thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        self.assertFalse(self.server_thread.is_alive())

    def post(self, payload, streaming=False, raw=None):
        body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        connection = HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(
                "POST", "/api/review", body=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/x-ndjson" if streaming else "application/json",
                    "Connection": "close",
                },
            )
            response = connection.getresponse()
            content = response.read().decode("utf-8")
            headers = dict(response.getheaders())
            if response.getheader("Content-Type", "").startswith("application/x-ndjson"):
                parsed = [json.loads(line) for line in content.splitlines() if line]
            else:
                parsed = json.loads(content)
            return response.status, headers, parsed
        finally:
            connection.close()

    def assert_result_contract(self, result, status):
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["results"][0]["status"], status)
        self.assertEqual(result["results"][0]["sentence"], self.sentence)
        self.assertEqual(result["stats"]["total_sentences"], 1)
        self.assertEqual(result["stats"]["problems_found"], 0)
        self.assertEqual(result["problems"], [])
        self.assertEqual(result["normalized_text"], self.sentence)
        self.assertEqual(result["offset_basis"], "normalized_text_python_chars")

    def test_json_review_returns_v2_result_and_real_sqlite_evidence(self):
        status, headers, result = self.post({"text": self.sentence, "source_id": 1})
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(result["status"], "completed")
        self.assert_result_contract(result, "insufficient")
        self.assertEqual(result["stats"]["checked_sentences"], 1)
        self.assertEqual(result["stats"]["insufficient_sentences"], 1)
        self.assertEqual(result["stats"]["supported_sentences"], 0)
        self.assertEqual(result["stats"]["coverage_ratio"], 1)
        evidence = result["results"][0]["evidence"][0]
        self.assertEqual(evidence["source_id"], 1)
        self.assertEqual(evidence["source_url"], "https://example.invalid/collection/1")
        self.assertEqual(evidence["locator"], "chars:0-10")
        self.assertEqual(evidence["stance"], "insufficient")
        self.assertEqual(len(self.verifier.calls), 1)
        # Content-Length lets the client finish reading just before the handler's
        # finally block runs. Wait for release, but still fail on a leaked lock.
        released = self.server.model_lock.acquire(timeout=2)
        self.assertTrue(released, "Completed JSON request leaked the model lock")
        if released:
            self.server.model_lock.release()

    def test_ndjson_sentence_status_matches_final_result_and_never_reports_pass(self):
        status, headers, events = self.post(
            {"text": self.sentence, "source_id": 1}, streaming=True)
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("application/x-ndjson"))
        self.assertEqual(headers["Transfer-Encoding"], "chunked")
        self.assertEqual([event["type"] for event in events], ["start", "sentence", "done"])
        self.assertEqual(events[0], {"type": "start", "total": 1, "schema_version": 2})
        self.assertEqual(events[1]["index"], 0)
        self.assertEqual(events[1]["status"], "insufficient")
        self.assertEqual(events[1]["sentence"], self.sentence)
        self.assert_result_contract(events[-1], "insufficient")
        self.assertEqual(events[1]["status"], events[-1]["results"][0]["status"])
        self.assertNotIn("pass", [event.get("status") for event in events])
        self.assertEqual(len(self.verifier.calls), 1)
        self.assertFalse(self.server.model_lock.locked())

    def test_no_evidence_counts_are_correct_for_both_transports_without_inference(self):
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                status, _, payload = self.post(
                    {"text": self.sentence, "source_id": 2}, streaming=streaming)
                self.assertEqual(status, 200)
                result = payload[-1] if streaming else payload
                self.assert_result_contract(result, "uncovered")
                self.assertEqual(result["results"][0]["reason"], "no_evidence")
                self.assertEqual(result["results"][0]["evidence"], [])
                self.assertEqual(result["stats"]["uncovered_sentences"], 1)
                self.assertEqual(result["stats"]["no_evidence_sentences"], 1)
                self.assertEqual(result["stats"]["low_relevance_sentences"], 0)
                self.assertEqual(result["stats"]["checked_sentences"], 0)
                self.assertEqual(result["stats"]["coverage_ratio"], 0)
                if streaming:
                    self.assertEqual(payload[1]["status"], "uncovered")
        self.assertEqual(self.verifier.calls, [])

    def test_disconnect_while_sending_stream_headers_releases_model_for_next_request(self):
        handler_finished = Event()
        lock_states_at_disconnect = []
        original_post = WebsiteHandler.do_POST

        def fail_stream_headers(handler):
            # A client can disappear after the lock is acquired but before
            # the streaming response headers reach the socket.
            lock_states_at_disconnect.append(handler.server.model_lock.locked())
            raise BrokenPipeError("Client disconnected while sending response headers")

        def observe_handler_exit(handler):
            try:
                return original_post(handler)
            finally:
                handler_finished.set()

        with patch.object(QuietWebsiteHandler, "end_headers", fail_stream_headers), \
                patch.object(QuietWebsiteHandler, "do_POST", observe_handler_exit), \
                patch.object(self.server, "handle_error"):
            with self.assertRaises((HTTPException, ConnectionError)):
                self.post({"text": self.sentence, "source_id": 1}, streaming=True)
            self.assertTrue(handler_finished.wait(timeout=2), "Request handler did not exit")
        self.assertEqual(lock_states_at_disconnect, [True])
        self.assertFalse(self.server.model_lock.locked(), "Disconnected client leaked the model lock")
        self.assertEqual(self.verifier.calls, [])

        status, _, result = self.post({"text": self.sentence, "source_id": 1}, streaming=True)
        self.assertEqual(status, 200, "A later request must not be stuck with HTTP 429")
        self.assert_result_contract(result[-1], "insufficient")
        self.assertEqual(len(self.verifier.calls), 1)
        self.assertFalse(self.server.model_lock.locked())

    def test_invalid_body_types_and_boolean_source_are_rejected_before_streaming(self):
        invalid_payloads = [[], None, {"text": 123, "source_id": 1},
                            {"text": self.sentence, "source_id": True},
                            {"text": self.sentence, "source_id": False}]
        for payload in invalid_payloads:
            for streaming in (False, True):
                with self.subTest(payload=payload, streaming=streaming):
                    status, headers, result = self.post(payload, streaming=streaming)
                    self.assertEqual(status, 400)
                    self.assertTrue(headers["Content-Type"].startswith("application/json"))
                    self.assertIsInstance(result["error"], str)
                    self.assertNotIn("results", result)
        self.assertEqual(self.verifier.calls, [])
        self.assertFalse(self.server.model_lock.locked())

    def test_oversized_text_returns_413_before_streaming_or_inference(self):
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                status, headers, result = self.post(
                    {"text": "衣" * 50001, "source_id": 1}, streaming=streaming)
                self.assertEqual(status, 413)
                self.assertTrue(headers["Content-Type"].startswith("application/json"))
                self.assertIn("50000", result["error"])
                self.assertNotIn("results", result)
        self.assertEqual(self.verifier.calls, [])
        self.assertFalse(self.server.model_lock.locked())


if __name__ == "__main__":
    unittest.main()
