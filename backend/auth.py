"""Password accounts and revocable sessions in a separate SQLite database."""

from collections import deque
from contextlib import closing
import hashlib
import hmac
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
import re
import secrets
import sqlite3
from threading import Lock
import time
import unicodedata
from urllib.parse import urlsplit
from uuid import uuid4


COOKIE_NAME = "costume_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff]{3,24}\Z")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}\Z")
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
"""


class UsernameTaken(ValueError):
    """This normalized username already exists."""


class InvalidCredentials(ValueError):
    """An account or password does not match."""


def normalize_username(value):
    if not isinstance(value, str) or len(value) > 128:
        raise ValueError("用户名须为 3 至 24 个汉字、英文字母、数字、下划线或短横线。")
    username = unicodedata.normalize("NFKC", value).strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise ValueError("用户名须为 3 至 24 个汉字、英文字母、数字、下划线或短横线。")
    return username, username.casefold()


def validate_password(password):
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ValueError("密码须为 8 至 128 个字符。")
    # Do not strip, normalize, or silently truncate passwords.
    try:
        password.encode("utf-8")
    except UnicodeError as error:
        raise ValueError("密码包含无效字符。") from error
    return password


def hash_password(password):
    validate_password(password)
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$")
        if algorithm != "pbkdf2_sha256" or int(iterations) != PASSWORD_ITERATIONS:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, UnicodeError, AttributeError):
        return False


# Unknown users still incur a full password derivation.
_DUMMY_PASSWORD = f"pbkdf2_sha256${PASSWORD_ITERATIONS}${'00' * 32}${'00' * 32}"


def session_token(cookie_header):
    if not cookie_header or len(cookie_header) > 8192:
        return None
    try:
        cookies = SimpleCookie()
        cookies.load(cookie_header)
        token = cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else ""
    except CookieError:
        return None
    return token if TOKEN_PATTERN.fullmatch(token) else None


def session_cookie(token="", *, secure=False, clear=False):
    cookie = SimpleCookie()
    cookie[COOKIE_NAME] = token
    item = cookie[COOKIE_NAME]
    item["path"] = "/"
    item["httponly"] = True
    item["samesite"] = "Lax"
    item["max-age"] = 0 if clear else SESSION_SECONDS
    if clear:
        item["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
    if secure:
        item["secure"] = True
    return item.OutputString()


def normalized_origin(value):
    """Accept an HTTP(S) origin, never a URL with credentials or a path."""
    if not isinstance(value, str) or not value or any(char.isspace() for char in value):
        raise ValueError("公网来源须是完整的 http:// 或 https:// 域名及可选端口。")
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError
        port = parsed.port
        host = parsed.hostname.lower()
        if any(char in host for char in "\\%"):
            raise ValueError
        if ":" in host:
            host = f"[{host}]"
        suffix = f":{port}" if port and port != (443 if parsed.scheme == "https" else 80) else ""
        return f"{parsed.scheme}://{host}{suffix}"
    except ValueError as error:
        raise ValueError("公网来源须是完整的 http:// 或 https:// 域名及可选端口。") from error


class AuthStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as connection:
            connection.executescript(SCHEMA)
            connection.commit()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @staticmethod
    def _new_session(connection, user, previous_token=None):
        token, csrf_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = int(time.time())
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        if previous_token:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(previous_token),))
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
            (_token_hash(token), user["id"], csrf_token, now + SESSION_SECONDS),
        )
        return {"user": {"id": user["id"], "username": user["username"]}, "csrf_token": csrf_token}, token

    def register(self, username, password, previous_token=None):
        username, key = normalize_username(username)
        password_hash = hash_password(password)
        user = {"id": uuid4().hex, "username": username}
        with closing(self.connect()) as connection, connection:
            try:
                connection.execute(
                    "INSERT INTO users (id, username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user["id"], username, key, password_hash, int(time.time())),
                )
            except sqlite3.IntegrityError as error:
                raise UsernameTaken("这个用户名已被使用，请换一个。") from error
            return self._new_session(connection, user, previous_token)

    def login(self, username, password, previous_token=None):
        _, key = normalize_username(username)
        validate_password(password)
        with closing(self.connect()) as connection, connection:
            user = connection.execute("SELECT * FROM users WHERE username_key = ?", (key,)).fetchone()
            valid = verify_password(password, user["password_hash"] if user else _DUMMY_PASSWORD)
            if not user or not valid:
                raise InvalidCredentials("用户名或密码不正确。")
            return self._new_session(connection, user, previous_token)

    def session(self, token):
        if not token or not TOKEN_PATTERN.fullmatch(token):
            return None
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT users.id, users.username, sessions.csrf_token FROM sessions "
                "JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?",
                (_token_hash(token), int(time.time())),
            ).fetchone()
        if row is None:
            return None
        return {"user": {"id": row["id"], "username": row["username"]}, "csrf_token": row["csrf_token"]}

    def logout(self, token):
        if token:
            with closing(self.connect()) as connection, connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


def _token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


class AuthRateLimiter:
    """Bound password hashing work and guessing per peer and username."""
    def __init__(self, *, window=300, ip_limit=30, account_limit=10):
        self.window, self.ip_limit, self.account_limit = window, ip_limit, account_limit
        self._attempts = {}
        self._lock = Lock()

    def allow(self, peer, username):
        now = time.monotonic()
        try:
            key = normalize_username(username)[1]
        except ValueError:
            key = ""
        keys = [(f"ip:{peer}", self.ip_limit)]
        if key:
            keys.append((f"user:{key}", self.account_limit))
        with self._lock:
            expired = [key for key, values in self._attempts.items() if not values or values[-1] <= now - self.window]
            for key in expired:
                del self._attempts[key]
            # Refuse new buckets under unusual pressure; do not grow without bound.
            if len(self._attempts) >= 10000 and any(key not in self._attempts for key, _ in keys):
                return False
            for key, limit in keys:
                values = self._attempts.setdefault(key, deque())
                while values and values[0] <= now - self.window:
                    values.popleft()
                if len(values) >= limit:
                    return False
            for key, _ in keys:
                self._attempts[key].append(now)
            return True
