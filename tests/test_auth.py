"""Account and HTTP authorization checks, isolated from project databases/model."""

from contextlib import closing
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Lock, Thread
import time
import unittest
from unittest.mock import patch

from backend.auth import (
    AuthRateLimiter, AuthStore, InvalidCredentials, UsernameTaken,
    normalized_origin, session_cookie, session_token,
)
from backend.init_db import initialize_database
from backend.review_history import get_review, save_review
from backend.serve import WebsiteHandler


class AuthStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="costume-auth-unit-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "accounts.db"
        self.store = AuthStore(self.path)

    def test_password_hashing_session_storage_and_restart(self):
        session, token = self.store.register("TestUser", "a secret password")
        with closing(sqlite3.connect(self.path)) as connection:
            stored_hash = connection.execute("SELECT password_hash FROM users").fetchone()[0]
            stored_token = connection.execute("SELECT token_hash FROM sessions").fetchone()[0]
        self.assertTrue(stored_hash.startswith("pbkdf2_sha256$600000$"))
        self.assertNotIn("a secret password", stored_hash)
        self.assertNotEqual(token, stored_token)
        self.assertEqual(hashlib.sha256(token.encode()).hexdigest(), stored_token)
        self.assertEqual(AuthStore(self.path).session(token), session)
        self.assertEqual(len(session["user"]["id"]), 32)
        self.assertNotIn("password_hash", session["user"])

    def test_unique_normalized_name_and_password_failure(self):
        session, _ = self.store.register("  TestUser  ", "correct-password")
        with self.assertRaises(UsernameTaken):
            self.store.register("ＴＥＳＴＵＳＥＲ", "another-password")
        actual, _ = self.store.login("testuser", "correct-password")
        self.assertEqual(actual["user"], session["user"])
        for username in ("testuser", "unknown_user"):
            with self.subTest(username=username), self.assertRaises(InvalidCredentials):
                self.store.login(username, "wrong-password")

    def test_passwords_are_not_trimmed_or_truncated(self):
        self.store.register("space_user", " password ")
        with self.assertRaises(InvalidCredentials):
            self.store.login("space_user", "password")
        for password in ("short", "p" * 129, None, "\ud800" * 8):
            with self.subTest(password=repr(password)), self.assertRaises(ValueError):
                self.store.register("test_user", password)
        for username in ("ab", "a" * 25, "<script>", "user name", None):
            with self.subTest(username=username), self.assertRaises(ValueError):
                self.store.register(username, "safe-password")

    def test_login_rotates_session_logout_revokes_and_expiry_is_enforced(self):
        old_session, old_token = self.store.register("session_user", "safe-password")
        new_session, new_token = self.store.login("session_user", "safe-password", old_token)
        self.assertIsNone(self.store.session(old_token))
        self.assertNotEqual(old_session["csrf_token"], new_session["csrf_token"])
        self.store.logout(new_token)
        self.assertIsNone(self.store.session(new_token))
        _, expiry_token = self.store.login("session_user", "safe-password")
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) - 1,))
        self.assertIsNone(self.store.session(expiry_token))
        self.assertIsNone(self.store.session("invalid"))

    def test_cookie_flags_and_malformed_cookie(self):
        _, token = self.store.register("cookie_user", "safe-password")
        cookie = session_cookie(token, secure=True)
        for value in ("HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"):
            self.assertIn(value, cookie)
        self.assertEqual(session_token(cookie), token)
        self.assertIsNone(session_token("costume_session=../../accounts.db"))
        self.assertIsNone(session_token("x" * 9000))
        self.assertIn("Max-Age=0", session_cookie(clear=True))

    def test_rate_limit_has_bounded_window_and_separate_account_limit(self):
        limiter = AuthRateLimiter(window=300, ip_limit=4, account_limit=2)
        with patch("backend.auth.time.monotonic", return_value=10):
            self.assertTrue(limiter.allow("ip-a", "account_a"))
            self.assertTrue(limiter.allow("ip-b", "ACCOUNT_A"))
            self.assertFalse(limiter.allow("ip-c", "account_a"))
            self.assertTrue(limiter.allow("ip-a", "account_b"))
        with patch("backend.auth.time.monotonic", return_value=311):
            self.assertTrue(limiter.allow("ip-c", "account_a"))

    def test_origin_normalization_rejects_non_origins(self):
        self.assertEqual(normalized_origin("https://EXAMPLE.com:443/"), "https://example.com")
        self.assertEqual(normalized_origin("http://[::1]:5173"), "http://[::1]:5173")
        for value in ("null", "https://example.com/path", "https://user@example.com",
                      "https://example.com?foo=bar", "https://example.com\\evil", "file:///tmp"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalized_origin(value)


class QuietHandler(WebsiteHandler):
    def log_message(self, format, *args):
        pass


class FakeVerifier:
    def predict(self, sentence, evidence):
        return {"label": "insufficient", "scores": {"supports": 0.1, "refutes": 0.1, "insufficient": 0.8}}


class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="costume-auth-api-")
        self.addCleanup(self.directory.cleanup)
        path = Path(self.directory.name)
        self.db_path = path / "evidence.db"
        with closing(sqlite3.connect(self.db_path)) as connection, connection:
            initialize_database(connection)
            connection.execute("INSERT INTO sources (id, case_id, title, original_text) VALUES (1, 'auth-test', '棉袍资料', '这件棉袍采用绿色棉布。')")
            connection.execute("INSERT INTO evidence_chunks (id, source_id, object_name, attribute, evidence_text, locator, review_status) VALUES (1, 1, '棉袍', '材质', '这件棉袍采用绿色棉布。', 'chars:0:12', 'approved')")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        # Deliberately omit auth_required: production handler fails closed.
        self.server.db_path = self.db_path
        self.server.history_path = path / "history.db"
        self.server.auth_store = AuthStore(path / "accounts.db")
        self.server.auth_limiter = AuthRateLimiter()
        self.server.secure_cookies = False
        self.server.public_origin = None
        self.server.verifier = FakeVerifier()
        self.server.model_lock = Lock()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, route, payload=None, *, account=None, headers=None, raw=None):
        request_headers = {"Connection": "close"}
        if method == "POST":
            request_headers.update({"Origin": self.origin, "Content-Type": "application/json"})
        if account:
            request_headers["Cookie"] = account["cookie"]
            request_headers["X-CSRF-Token"] = account["csrf_token"]
            request_headers["X-Account-ID"] = account["user"]["id"]
        for key, value in (headers or {}).items():
            if value is None:
                request_headers.pop(key, None)
            else:
                request_headers[key] = value
        body = raw if raw is not None else (json.dumps(payload, ensure_ascii=True).encode() if payload is not None else None)
        connection = HTTPConnection(*self.server.server_address, timeout=10)
        try:
            connection.request(method, route, body=body, headers=request_headers)
            response = connection.getresponse()
            content = response.read().decode("utf-8")
            parsed = json.loads(content) if content and response.getheader("Content-Type", "").startswith("application/json") else content
            return response.status, dict(response.getheaders()), parsed
        finally:
            connection.close()

    def register(self, username="test_user"):
        status, headers, account = self.request("POST", "/api/auth/register", {"username": username, "password": "correct-password"})
        self.assertEqual(status, 201, account)
        return {**account, "cookie": headers["Set-Cookie"].split(";", 1)[0]}

    def create_review(self, account, **fields):
        status, _, result = self.request("POST", "/api/review", {"text": "这件棉袍采用绿色棉布。", "source_id": 1, "title": "账户私有文稿", **fields}, account=account)
        self.assertEqual(status, 200, result)
        return result

    def test_anonymous_private_routes_redirect_and_apis_fail_closed(self):
        for route in ("/", "/index.html", "/archive.html?draft=1"):
            with self.subTest(route=route):
                status, headers, _ = self.request("GET", route)
                self.assertEqual(status, 302)
                self.assertTrue(headers["Location"].startswith("/login.html?next=%2F"))
        for route in ("/api/auth/session", "/api/reviews", "/api/reviews/" + "a" * 32):
            self.assertEqual(self.request("GET", route)[0], 401)
        for route in ("/api/review", "/api/search", "/api/verify", "/api/extract"):
            self.assertEqual(self.request("POST", route, {})[0], 401)
        for route in ("/api/sources", "/api/library", "/library.html", "/guide.html"):
            self.assertEqual(self.request("GET", route)[0], 200)
        self.assertEqual(self.request("GET", "/data/accounts.db")[0], 404)

    def test_register_login_session_logout_and_password_error(self):
        account = self.register()
        status, headers, session = self.request("GET", "/api/auth/session", account=account)
        self.assertEqual(status, 200)
        self.assertEqual(session["user"], account["user"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("POST", "/api/auth/login", {"username": "test_user", "password": "wrong-password"})[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/register", {"username": "TEST_USER", "password": "correct-password"})[0], 409)
        # The browser's logout request intentionally has no request body.
        status, headers, result = self.request("POST", "/api/auth/logout", account=account)
        self.assertEqual((status, result), (200, {"ok": True}))
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/api/auth/session", account=account)[0], 401)
        status, headers, session = self.request("POST", "/api/auth/login", {"username": "test_user", "password": "correct-password"})
        self.assertEqual(status, 200)
        self.assertEqual(session["user"], account["user"])
        self.assertNotEqual(headers["Set-Cookie"].split(";")[0], account["cookie"])

    def test_origin_csrf_and_account_switch_guard(self):
        account = self.register()
        for headers in ({"Origin": None}, {"Origin": "https://evil.example"},
                        {"Sec-Fetch-Site": "cross-site"}, {"X-CSRF-Token": None},
                        {"X-CSRF-Token": "incorrect"}, {"X-CSRF-Token": "é"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/search", {"claim": "棉袍", "source_id": 1}, account=account, headers=headers)[0], 403)
        status, _, _ = self.request("POST", "/api/search", {"claim": "棉袍", "source_id": 1}, account=account)
        self.assertEqual(status, 200)
        self.assertEqual(self.request("GET", "/api/reviews", account=account, headers={"X-Account-ID": "0" * 32})[0], 401)
        for route in ("/api/auth/register", "/api/auth/login"):
            self.assertEqual(self.request("POST", route, {"username": "new_user", "password": "safe-password"}, headers={"Origin": "https://evil.example"})[0], 403)

    def test_session_expiry_and_html_account_identity(self):
        account = self.register("中文用户名")
        status, _, content = self.request("GET", "/index.html", account=account)
        self.assertEqual(status, 200)
        self.assertIn('data-account-id="' + account["user"]["id"] + '"', content)
        self.assertIn('data-account-name="中文用户名"', content)
        with closing(self.server.auth_store.connect()) as connection, connection:
            connection.execute("UPDATE sessions SET expires_at = ?", (int(time.time()) - 1,))
        self.assertEqual(self.request("GET", "/api/auth/session", account=account)[0], 401)
        self.assertEqual(self.request("POST", "/api/review", {}, account=account)[0], 401)

    def test_all_history_endpoints_and_parent_links_are_private(self):
        first, second = self.register("first_user"), self.register("second_user")
        record = self.create_review(first)
        record_id = record["review_id"]
        self.assertEqual(get_review(self.server.history_path, record_id, owner_id=first["user"]["id"])["review_id"], record_id)
        # Pre-login legacy records remain unclaimed and inaccessible to users.
        legacy = save_review(self.server.history_path, record, title="旧记录", source_id=1)
        status, _, listing = self.request("GET", "/api/reviews", account=first)
        self.assertEqual(status, 200)
        self.assertEqual([item["review_id"] for item in listing["reviews"]], [record_id])
        self.assertEqual(self.request("GET", "/api/reviews", account=second)[2]["reviews"], [])
        for target in (record_id, legacy["review_id"]):
            for suffix in ("", "/report"):
                self.assertEqual(self.request("GET", f"/api/reviews/{target}{suffix}", account=second)[0], 404)
            self.assertEqual(self.request("POST", f"/api/reviews/{target}/decisions", {"expected_revision": 0, "decisions": record["decisions"]}, account=second)[0], 404)
            self.assertEqual(self.request("POST", "/api/review", {"text": "这件棉袍采用绿色棉布。", "source_id": 1, "parent_id": target}, account=second)[0], 404)
        self.assertEqual(self.request("GET", f"/api/reviews/{record_id}/report", account=first)[0], 200)
        decisions = [{**item, "state": "pending", "note": "私有备注"} for item in record["decisions"]]
        self.assertEqual(self.request("POST", f"/api/reviews/{record_id}/decisions", {"expected_revision": 0, "decisions": decisions}, account=first)[0], 200)
        self.assertEqual(self.create_review(first, parent_id=record_id)["parent_id"], record_id)

    def test_auth_rejects_bad_payloads_and_limits_attempts(self):
        for payload in ([], {}, {"username": "test_user"}, {"username": "test_user", "password": "short"}, {"username": "test_user", "password": "\ud800" * 8}):
            self.assertEqual(self.request("POST", "/api/auth/register", payload)[0], 400)
        self.assertEqual(self.request("POST", "/api/auth/register", raw=b"{")[0], 400)
        self.server.auth_limiter = AuthRateLimiter(ip_limit=1, account_limit=1)
        self.register("rate_user")
        status, headers, _ = self.request("POST", "/api/auth/login", {"username": "rate_user", "password": "correct-password"})
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "300")

    def test_https_proxy_origin_and_secure_cookie(self):
        self.server.public_origin = "https://verifier.example"
        self.server.secure_cookies = True
        self.assertEqual(self.request("POST", "/api/auth/register", {"username": "proxy_user", "password": "correct-password"})[0], 403)
        status, headers, _ = self.request("POST", "/api/auth/register", {"username": "proxy_user", "password": "correct-password"}, headers={"Origin": "https://verifier.example"})
        self.assertEqual(status, 201)
        self.assertIn("Secure", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])


if __name__ == "__main__":
    unittest.main()
