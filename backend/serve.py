"""本地网站,提供证据检索和模型核验。"""

import argparse
from contextlib import closing
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import unicodedata
from urllib.parse import parse_qs, quote, urlsplit

from backend.auth import (
    AuthRateLimiter, AuthStore, InvalidCredentials, UsernameTaken,
    normalized_origin, session_cookie, session_token,
)
from backend.init_db import DB_PATH, PROJECT_DIR
from backend.text_prepare import clean_text, split_sentences
from backend.library import get_library_source, list_library
from backend.library_visuals import read_library_image
from backend.review_history import (
    ConflictError, NotFoundError, get_review, initialize_history, list_reviews,
    render_report, save_review, update_decisions,
)

from threading import Lock



FRONTEND = PROJECT_DIR / "frontend"
STATIC_FILES = {
    "/login.html": ("login.html", "text/html; charset=utf-8"),
    "/login.js": ("login.js", "text/javascript; charset=utf-8"),
    "/login.css": ("login.css", "text/css; charset=utf-8"),
    "/account.js": ("account.js", "text/javascript; charset=utf-8"),
    "/account.css": ("account.css", "text/css; charset=utf-8"),
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/sentence-map.js": ("sentence-map.js", "text/javascript; charset=utf-8"),
    "/draft-store.js": ("draft-store.js", "text/javascript; charset=utf-8"),
    "/workspace-drafts.js": ("workspace-drafts.js", "text/javascript; charset=utf-8"),
    "/workspace-guide.js": ("workspace-guide.js", "text/javascript; charset=utf-8"),
    "/source-picker.js": ("source-picker.js", "text/javascript; charset=utf-8"),
    "/source-picker.css": ("source-picker.css", "text/css; charset=utf-8"),
    "/guide.html": ("guide.html", "text/html; charset=utf-8"),
    "/guide.css": ("guide.css", "text/css; charset=utf-8"),
    "/guide-feedback.js": ("guide-feedback.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/archive.html": ("archive.html", "text/html; charset=utf-8"),
    "/archive.js": ("archive.js", "text/javascript; charset=utf-8"),
    "/archive.css": ("archive.css", "text/css; charset=utf-8"),
    "/library.html": ("library.html", "text/html; charset=utf-8"),
    "/library.js": ("library.js", "text/javascript; charset=utf-8"),
    "/museum-entry.js": ("museum-entry.js", "text/javascript; charset=utf-8"),
    "/museum-backdrop.js": ("museum-backdrop.js", "text/javascript; charset=utf-8"),
    "/library.css": ("library.css", "text/css; charset=utf-8"),
    "/img/museum/gallery-background.webp": ("img/museum/gallery-background.webp", "image/webp"),
    "/img/museum/gallery-background-mobile.webp": ("img/museum/gallery-background-mobile.webp", "image/webp"),
    "/source.html": ("source.html", "text/html; charset=utf-8"),
    "/source.js": ("source.js", "text/javascript; charset=utf-8"),
    "/source-visuals.js": ("source-visuals.js", "text/javascript; charset=utf-8"),
}
DOWNLOAD_FILES = {
    "/downloads/robe-review-practice.docx": (
        "downloads/robe-review-practice.docx", "【教学示例】绿棉袍审阅体验.docx",
    ),
}
MAX_REQUEST_BYTES = 8192
# 整篇审阅要传输完整正文，上限单独放宽。
# 一个中文字符约 3 字节，50000 字符的正文约 150KB。
MAX_REVIEW_BYTES = 400 * 1024
MAX_REVIEW_CHARS = 50000
MAX_DECISION_BYTES = 8 * 1024 * 1024
HISTORY_ROUTE = re.compile(r"^/api/reviews/([0-9a-f]{32})(?:/(decisions|report))?$")
REVIEW_SCHEMA_VERSION = 2
REVIEW_STATUSES = (
    "supported", "refute", "insufficient", "conflicting", "uncovered",
)

# 中文虚词与常见连接成分。它们出现在任何句子里，不能用来判断两句是否在谈同一件事。
STOP_TERMS = frozenset(
    "此件 这件 该件 一件 此 件 的 了 是 在 与 和 及 或 为 以 由 从 对 被 把 也 都 还 "
    "这个 那个 一个 各个 这些 那些 其中 以及 并且 而且 但是 不过 因此 所以 同时 "
    "可以 能够 具有 采用 使用 属于 位于 分为 呈现 形成 进行 较为 十分 非常 比较 "
    "新疆 维吾尔族 传统 民族 服饰 工艺".split()
)

# 内容词：连续两个及以上的汉字，或字母数字串。单字不作数——「衣」「色」这类
# 单字在服饰文本里到处都是，拿它判断相关性等于没判断。
CONTENT_TERM = re.compile(r"[0-9A-Za-z]+|[一-鿿]{2,}")

# 判定「句子和证据在谈同一件事」的两个门槛。
# MIN_RELEVANCE 太低会放进大量无关组合，太高会漏掉真矛盾。
# 这两个值需要结合实际数据调整，当前取值来自一份含已知错误的测试文稿。
MIN_RELEVANCE = 2
RELATIVE_THRESHOLD = 0.5

# 文稿自带的非正文内容。它们会被正常分句，但不对应任何服饰特征：
# 送进模型得不到有意义的结论，展示出来只会让读者以为系统在乱比对。
NOISE_HEADING = re.compile(r"^\s*[一二三四五六七八九十]+\s*[、.．]")
NOISE_TITLE_TERMS = ("文稿", "测试", "非正式出版", "内部资料", "草稿", "样本")
NOISE_META_KEYS = ("馆藏编号", "民族", "类别", "年代", "尺寸", "藏品号", "编号")


def is_noise_sentence(text):
    """判断这一句是不是文稿自带的标题、章节号或馆藏元数据。

    这类内容不对应任何服饰特征，送进模型得不到有意义的结论。
    规则刻意保守：只有在同时满足「短」和「形态明确」时才判为噪声，
    避免误伤真正的描述句。

    - 章节标题：「一、新疆喀什维吾尔族绿棉袍」，以序号开头且很短。
    - 文稿标题：「新疆传统服饰说明文稿」，很短且含「文稿 / 测试」等词。
    - 馆藏元数据：「馆藏编号:MFB002865 民族:维吾尔族 年代:当代 类别:衣」，
      在同一句里出现两个及以上「键: 值」形式的馆藏字段。
    """
    if not isinstance(text, str):
        return False
    stripped = text.strip()
    if not stripped:
        return True

    # 真正的描述句通常较长，且以句号收尾。带句末标点的长句一律放行。
    if len(stripped) > 40:
        return False

    # 章节标题：以「一、」「二.」这类序号开头。
    if NOISE_HEADING.match(stripped):
        return True

    # 馆藏元数据：至少两个「字段名: 值」。正文里的冒号极少这样成串出现。
    meta_hits = sum(1 for key in NOISE_META_KEYS if key in stripped)
    if meta_hits >= 2 and ":" in stripped:
        return True

    # 文稿标题 / 页眉：短，含「文稿」「测试」「非正式出版」这类词，
    # 且没有句末标点——真正的说明句会以句号收尾。
    if not any(mark in stripped for mark in "。！？"):
        if any(term in stripped for term in NOISE_TITLE_TERMS):
            return True

    return False


def content_terms(text):
    """提取用于判断「是否在谈同一件事」的实词集合。

    只保留长度 ≥ 2 的词，并去掉虚词与共享主题词。
    """
    terms = set()
    for run in CONTENT_TERM.findall(text):
        if len(run) <= 1:
            continue
        # 长串按二字滑窗拆开，提高与证据用词不一致时的召回：
        # 「绗缝线迹」与证据里的「绗缝」也能对上。
        if len(run) == 2:
            terms.add(run)
        else:
            for index in range(len(run) - 1):
                terms.add(run[index:index + 2])
    return {term for term in terms if term not in STOP_TERMS}


def relevance(sentence, evidence):
    """句子与证据的相关性：共用的内容词数量。

    用于在跑模型之前挡掉「说的根本不是一回事」的组合。
    这类组合模型容易误判为 refutes，其实语义上是 neutral。
    """
    return len(content_terms(sentence) & content_terms(evidence))


def review_document(document_text, source_id, verifier, connection,
                    on_progress=None, on_start=None):
    """返回每个正文句的模型判定、证据与未覆盖原因。

    不将没有反驳当作支持。支持和反驳同时出现时保留为判定分歧。
    coverage_ratio 是送入模型的句数比例，不是准确率或事实覆盖率。
    位置使用 normalized_text 的 Python 字符下标，含起点、不含终点。
    on_progress(index, total, sentence, status) 与 results 使用相同状态。
    """
    if not isinstance(document_text, str):
        raise ValueError("文档正文必须是文字。")
    if len(document_text) > MAX_REVIEW_CHARS:
        raise ValueError("文档正文超过 50000 字符，请拆分后分批审阅。")
    cleaned_text, _ = clean_text(document_text)
    raw_sentences = split_sentences(cleaned_text)
    # 保留现有标题过滤行为；过滤数量单列，不计入正文覆盖率。
    sentences = [item for item in raw_sentences if not is_noise_sentence(item[0])]
    noise_count = len(raw_sentences) - len(sentences)
    results = []
    total = len(sentences)

    if on_start is not None:
        try:
            on_start(total)
        except Exception:
            pass

    def record(item, status, reason, message):
        item.update(status=status, reason=reason, message=message)
        results.append(item)
        if on_progress is not None:
            try:
                on_progress(item["index"], total, item["sentence"], status)
            except Exception:
                pass

    for ordinal, (sentence_text, start, end) in enumerate(sentences):
        item = {
            "index": ordinal, "sentence": sentence_text,
            "sentence_start": start, "sentence_end": end, "evidence": [],
        }
        # 沿用当前对象检索和默认资料回退；段落指代另行改进。
        found = search_evidence(connection, sentence_text, None)
        if found["status"] != "found" and source_id is not None:
            found = search_evidence(connection, sentence_text, source_id)
        if found["status"] != "found" or not found["matches"]:
            record(item, "uncovered", "no_evidence",
                   "未检索到对应的已审核证据，本句未送入模型比对。")
            continue

        # 沿用字面相关性门槛；未入选不代表资料中确实没有这个事实。
        scored = [(relevance(sentence_text, match["evidence_text"]),
                   -match["id"], match) for match in found["matches"]]
        scored.sort(key=lambda row: (-row[0], row[1]))
        threshold = max(MIN_RELEVANCE, scored[0][0] * RELATIVE_THRESHOLD)
        candidates = [row[2] for row in scored if row[0] >= threshold]
        if not candidates:
            record(item, "uncovered", "low_relevance",
                   "已检索到候选，但文字相关性不足，本句未送入模型比对。")
            continue

        # 保存每条预测与出处，不再只挑出最大反驳分数的片段。
        for match in candidates:
            evidence_input = f"对象：{match['object_name']}。\n{match['evidence_text']}"
            prediction = verifier.predict(sentence_text, evidence_input)
            if prediction["label"] not in ("supports", "refutes", "insufficient"):
                raise RuntimeError("模型返回了未知的分类标签。")
            item["evidence"].append({
                "evidence_id": match["id"], "source_id": match["source_id"],
                "evidence": match["evidence_text"],
                "object_name": match["object_name"],
                "source_title": match["title"], "source_url": match["source_url"],
                "locator": match["locator"], "stance": prediction["label"],
                "scores": prediction["scores"],
                "relevance": relevance(sentence_text, match["evidence_text"]),
            })

        labels = {evidence["stance"] for evidence in item["evidence"]}
        if {"supports", "refutes"}.issubset(labels):
            record(item, "conflicting", "mixed_predictions",
                   "不同证据得到支持与反驳两种预测，请逐条核对原文与对象。")
        elif "refutes" in labels:
            record(item, "refute", "model_refutes",
                   "模型判为疑似矛盾，请核对依据；这不是已经确认的错误。")
        elif "supports" in labels:
            record(item, "supported", "model_supports",
                   "至少一条证据被模型判为支持，仍需核对对象、属性与适用范围。")
        else:
            record(item, "insufficient", "model_insufficient",
                   "模型对所比对证据均判为信息不足，尚不能支持或反驳本句。")

    counts = {status: sum(item["status"] == status for item in results)
              for status in REVIEW_STATUSES}
    checked_count = total - counts["uncovered"]
    # 兼容旧调用方的字段；v2界面使用完整results，不能只看problems。
    problems = []
    for item in results:
        if item["status"] == "refute":
            best = max((e for e in item["evidence"] if e["stance"] == "refutes"),
                       key=lambda e: e["scores"]["refutes"])
            problems.append({
                **best, "sentence": item["sentence"],
                "sentence_start": item["sentence_start"],
                "sentence_end": item["sentence_end"],
            })
    problems.sort(key=lambda item: -item["scores"]["refutes"])
    return {
        "schema_version": REVIEW_SCHEMA_VERSION,
        "normalized_text": cleaned_text,
        "offset_basis": "normalized_text_python_chars",
        "results": results,
        "problems": problems,
        "stats": {
            "total_sentences": total,
            "checked_sentences": checked_count,
            "problems_found": len(problems),
            "supported_sentences": counts["supported"],
            "refuted_sentences": counts["refute"],
            "insufficient_sentences": counts["insufficient"],
            "conflicting_sentences": counts["conflicting"],
            "uncovered_sentences": counts["uncovered"],
            "no_evidence_sentences": sum(item["reason"] == "no_evidence" for item in results),
            "low_relevance_sentences": sum(item["reason"] == "low_relevance" for item in results),
            "noise_sentences": noise_count,
            "coverage_ratio": checked_count / total if total else None,
        }
    }


def open_database(path=DB_PATH):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    if connection.execute("PRAGMA user_version").fetchone()[0] != 1:
        connection.close()
        raise ValueError("数据库版本不匹配，请先完成数据库初始化。")
    return connection


def normalized(text):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text).casefold())


def approved_evidence(connection):
    # 一条 SELECT 同时读取正文与来源；未审核/拒绝的草稿始终不参与检索。
    return [dict(row) for row in connection.execute(
        "SELECT e.id, e.source_id, e.object_name, e.aliases, e.attribute, e.keywords, "
        "e.evidence_text, e.locator, s.title, s.publisher, s.source_url "
        "FROM evidence_chunks e JOIN sources s ON s.id = e.source_id "
        "WHERE e.review_status = 'approved' ORDER BY e.id"
    )]


def available_sources(connection):
    rows = approved_evidence(connection)
    sources = {}
    for row in rows:
        sources.setdefault(row["source_id"], {
            "id": row["source_id"], "title": row["title"], "object_name": row["object_name"],
        })
    return {"sources": list(sources.values()), "approved_count": len(rows)}


def validate_query(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求内容必须是 JSON 对象。")
    claim = payload.get("claim")
    if not isinstance(claim, str) or not claim.strip():
        raise ValueError("请填写待核验说明。")
    claim = claim.strip()
    # 与浏览器 maxlength 的 UTF-16 计数保持一致，包括 emoji。
    if len(claim.encode("utf-16-le")) // 2 > 500:
        raise ValueError("说明不能超过 500 个字符。")
    if not normalized(claim):
        raise ValueError("说明中需要包含文字或数字。")
    source_id = payload.get("source_id")
    if source_id is not None and (type(source_id) is not int or not 0 < source_id <= 2**63 - 1):
        raise ValueError("限定资料编号必须是正整数。")
    return claim, source_id


def search_evidence(connection, claim, source_id=None):
    claim, source_id = validate_query({"claim": claim, "source_id": source_id})
    rows = approved_evidence(connection)
    result = {"status": "no_evidence", "claim": claim, "matches": [], "model_status": "not_connected"}
    if not rows:
        return {**result, "message": "资料库暂无已审核的证据，请先完成第一批资料审核。"}
    query = normalized(claim)
    catalog_ids = set(re.findall(r"mfb\d+", query))
    ranked = []
    for row in rows:
        if source_id is not None and row["source_id"] != source_id:
            continue
        names = list(dict.fromkeys([row["object_name"], row["title"], *row["aliases"].split()]))
        identity_hits = [term for term in names if len(normalized(term)) >= 2 and normalized(term) in query]
        known_ids = set(re.findall(r"mfb\d+", normalized(" ".join(names))))
        # 明确写了馆藏编号时不能退回到同名或泛称的另一件藏品。
        if catalog_ids and not catalog_ids.intersection(known_ids):
            continue
        if source_id is None and not identity_hits:
            continue
        keywords = list(dict.fromkeys((row["attribute"] + " " + row["keywords"]).split()))
        keyword_hits = [term for term in keywords if len(normalized(term)) >= 2 and normalized(term) in query]
        # 属性仅影响候选排序；颜色、材质或年代不一致不会排除反驳证据。
        body = normalized(row["evidence_text"])
        bigrams = {query[index:index + 2] for index in range(len(query) - 1)}
        overlap = min(12, sum(term in body for term in bigrams))
        identity_score = min(24, max((len(normalized(term)) for term in identity_hits), default=0))
        rank = (100 if catalog_ids else 0) + identity_score + 5 * len(keyword_hits) + overlap
        match = {key: value for key, value in row.items() if key not in ("aliases", "keywords")}
        match["matched_terms"] = list(dict.fromkeys(identity_hits + keyword_hits))
        ranked.append((rank, row["id"], match))
    if not ranked:
        if source_id is None and not catalog_ids:
            return {**result, "status": "needs_context", "message": "尚未识别到已收录的服饰对象。请补充服饰名称或馆藏编号，或在“限定资料”中选择对应资料。"}
        return {**result, "message": "当前资料范围内没有找到对应的已审核证据；这不代表说明错误。"}
    ranked.sort(key=lambda item: (-item[0], item[1]))
    result.update(
        status="found", matches=[item[2] for item in ranked[:5]],
        message="已找到候选证据，请核对是否为同一件服饰。检索结果尚未进行模型核验。",
    )
    return result


class WebsiteHandler(BaseHTTPRequestHandler):
    # 整篇审阅需要边处理边推送进度，因此用 HTTP/1.1 的 chunked 传输。
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    @property
    def auth_required(self):
        # Only isolated legacy test fixtures explicitly opt out. Missing auth
        # configuration must never turn a running website into a public API.
        return getattr(self.server, "auth_required", True)

    @property
    def owner_id(self):
        session = getattr(self, "current_session", None)
        return session["user"]["id"] if session else None

    def load_session(self):
        self.current_session = None
        if not self.auth_required:
            return True
        token = session_token(self.headers.get("Cookie"))
        if not token:
            return True
        try:
            self.current_session = self.server.auth_store.session(token)
            return True
        except (AttributeError, sqlite3.Error, OSError):
            self.respond(503, {"error": "账户服务暂时不可用，请稍后重试。"})
            self.close_connection = True
            return False

    def require_account(self, *, html=False):
        if not self.auth_required:
            return True
        if not self.load_session():
            return False
        if not self.current_session:
            if html:
                # Only local protected routes can arrive here; do not echo an
                # absolute request target into the post-login destination.
                parsed = urlsplit(self.path)
                destination = parsed.path + ("?" + parsed.query if parsed.query else "")
                self.respond(302, b"", headers={"Location": "/login.html?next=" + quote(destination, safe="")})
            else:
                self.respond(401, {"error": "请先登录后继续。"})
            self.close_connection = True
            return False
        account_id = self.headers.get("X-Account-ID")
        if account_id is not None and account_id != self.owner_id:
            self.respond(401, {"error": "登录账户已切换，请重新打开当前页面。"})
            self.close_connection = True
            return False
        return True

    def valid_origin(self):
        try:
            origins = self.headers.get_all("Origin", [])
            if len(origins) != 1 or self.headers.get("Sec-Fetch-Site") == "cross-site":
                return False
            origin = normalized_origin(origins[0])
            expected = getattr(self.server, "public_origin", None)
            if not expected:
                hosts = self.headers.get_all("Host", [])
                if len(hosts) != 1:
                    return False
                scheme = "https" if getattr(self.server, "secure_cookies", False) else "http"
                expected = normalized_origin(f"{scheme}://{hosts[0]}")
            return hmac.compare_digest(origin, expected)
        except (ValueError, TypeError):
            return False

    def require_mutation(self):
        if not self.auth_required:
            return True
        token = self.headers.get("X-CSRF-Token", "")
        if (not self.valid_origin() or not self.current_session
                or not hmac.compare_digest(token.encode("utf-8"), self.current_session["csrf_token"].encode("ascii"))):
            self.respond(403, {"error": "请求校验失败，请刷新页面后重试。"})
            self.close_connection = True
            return False
        return True

    def auth_post(self, route):
        if route not in ("/api/auth/register", "/api/auth/login", "/api/auth/logout"):
            self.respond(404, {"error": "账户接口不存在。"})
            self.close_connection = True
            return
        if route == "/api/auth/logout":
            if not self.require_account() or not self.require_mutation():
                return
            try:
                self.server.auth_store.logout(session_token(self.headers.get("Cookie")))
                self.respond(200, {"ok": True}, headers={
                    "Set-Cookie": session_cookie(secure=getattr(self.server, "secure_cookies", False), clear=True),
                })
            except (AttributeError, sqlite3.Error, OSError):
                self.respond(503, {"error": "退出登录失败，请稍后重试。"})
            # Logout may carry an empty JSON body; never reuse unread bytes.
            self.close_connection = True
            return
        if not self.valid_origin():
            self.respond(403, {"error": "请在本站登录或注册。"})
            self.close_connection = True
            return
        if self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
            self.respond(400, {"error": "请求类型必须是 application/json。"})
            self.close_connection = True
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            length = int(lengths[0]) if len(lengths) == 1 else 0
            if not 0 < length <= MAX_REQUEST_BYTES:
                raise ValueError("账户请求为空或过长。")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("请求内容不完整。")
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict) or set(payload) != {"username", "password"}:
                raise ValueError("请提供用户名和密码。")
            if not self.server.auth_limiter.allow(self.client_address[0], payload["username"]):
                self.respond(429, {"error": "尝试次数过多，请 5 分钟后重试。"}, headers={"Retry-After": "300"})
                return
            action = self.server.auth_store.register if route.endswith("register") else self.server.auth_store.login
            session, token = action(payload["username"], payload["password"], session_token(self.headers.get("Cookie")))
            self.respond(201 if route.endswith("register") else 200, session, headers={
                "Set-Cookie": session_cookie(token, secure=getattr(self.server, "secure_cookies", False)),
            })
        except UsernameTaken as error:
            self.respond(409, {"error": str(error)})
        except InvalidCredentials as error:
            self.respond(401, {"error": str(error)})
        except (ValueError, UnicodeError, RecursionError) as error:
            self.respond(400, {"error": str(error) if not isinstance(error, json.JSONDecodeError) else "账户请求格式不正确。"})
            self.close_connection = True
        except TimeoutError:
            self.respond(408, {"error": "接收请求超时，请重试。"})
            self.close_connection = True
        except (AttributeError, sqlite3.Error, OSError):
            self.respond(503, {"error": "账户服务暂时不可用，请稍后重试。"})
            self.close_connection = True

    def respond(self, status, content, content_type="application/json; charset=utf-8", headers=None):
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器编辑输入后可能取消旧请求。

    def begin_stream(self, content_type="application/x-ndjson; charset=utf-8"):
        """开始一段 chunked 响应。之后每次 emit() 推送一行。"""
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

    def emit(self, payload):
        """向已开始的流推送一行 JSON（NDJSON）。

        返回 False 表示客户端已断开——调用方应尽快停止后续处理。
        """
        try:
            line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
            self.wfile.write(b"%x\r\n" % len(line))
            self.wfile.write(line)
            self.wfile.write(b"\r\n")
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            return False

    def end_stream(self):
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass

    @property
    def history_path(self):
        # 历史单独存储；证据库继续只读，原始资料与审核记录不变。
        return getattr(self.server, "history_path", self.server.db_path.with_name("review_history.db"))

    def history_get(self, route):
        match = HISTORY_ROUTE.fullmatch(route)
        try:
            if route == "/api/reviews":
                values = parse_qs(urlsplit(self.path).query).get("limit", ["50"])
                if len(values) != 1 or not values[0].isdigit() or not 1 <= int(values[0]) <= 100:
                    raise ValueError("历史条数须为1至100之间的整数。")
                self.respond(200, list_reviews(self.history_path, limit=int(values[0]), owner_id=self.owner_id))
            elif match and match[2] in (None, "report"):
                record = get_review(self.history_path, match[1], owner_id=self.owner_id)
                if match[2] == "report":
                    revisions = parse_qs(urlsplit(self.path).query, keep_blank_values=True).get("revision")
                    if revisions is not None:
                        if len(revisions) != 1 or not revisions[0].isascii() or not revisions[0].isdigit():
                            raise ValueError("报告修订号须为非负整数。")
                        if int(revisions[0]) != record["decisions_revision"]:
                            self.respond(409, {"error": "人工意见已在其他页面更新，请重新打开本条历史记录并核对后再导出。"})
                            return
                    self.respond(200, render_report(record).encode("utf-8"),
                                 "text/html; charset=utf-8", headers={
                                     "Content-Disposition": f'attachment; filename="review-{match[1]}.html"',
                                     "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
                                 })
                else:
                    self.respond(200, record)
            else:
                self.respond(404, {"error": "审阅记录地址不存在。"})
        except NotFoundError:
            self.respond(404, {"error": "未找到这份审阅记录。"})
        except ValueError as error:
            self.respond(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self.respond(503, {"error": "暂时无法读取审阅历史，请稍后重试。"})

    def do_GET(self):
        self.current_session = None
        route = urlsplit(self.path).path
        if route == "/api/auth/session":
            if self.require_account():
                if self.current_session:
                    self.respond(200, self.current_session)
                else:
                    self.respond(401, {"error": "请先登录后继续。"})
            return
        private_html = route in ("/", "/index.html", "/archive.html")
        private_api = route.startswith("/api/") and route not in ("/api/sources", "/api/library") and not route.startswith("/api/library/")
        if (private_html or private_api) and not self.require_account(html=private_html):
            return
        if route == "/api/reviews" or route.startswith("/api/reviews/"):
            self.history_get(route)
        elif route == "/api/library" or route.startswith("/api/library/"):
            match = re.fullmatch(r"/api/library/([1-9][0-9]{0,18})", route)
            if route != "/api/library" and (match is None or int(match[1]) > 2**63 - 1):
                self.respond(404, {"error": "资料地址无效，请从资料馆重新选择。"})
                return
            try:
                with closing(open_database(self.server.db_path)) as connection:
                    result = list_library(connection) if route == "/api/library" else get_library_source(connection, int(match[1]))
                if result is None:
                    self.respond(404, {"error": "该资料不存在或暂无可用证据，请从资料馆重新选择。"})
                else:
                    self.respond(200, result)
            except (sqlite3.Error, ValueError):
                self.respond(503, {"error": "暂时无法读取资料馆，请检查资料库后重试。"})
        elif route == "/api/sources":
            try:
                with closing(open_database(self.server.db_path)) as connection:
                    result = available_sources(connection)
                self.respond(200, result)
            except (sqlite3.Error, ValueError):
                self.respond(503, {"error": "暂时无法读取资料库，请检查数据库是否已就绪。"})
        elif route.startswith("/img/library/"):
            image = read_library_image(route[len("/img/library/"):])
            if image is None:
                self.respond(404, {"error": "图片不存在。"})
            else:
                content, mime = image
                self.respond(200, content, mime)
        elif route in DOWNLOAD_FILES:
            name, download_name = DOWNLOAD_FILES[route]
            try:
                content = (FRONTEND / name).read_bytes()
                self.respond(200, content,
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                             headers={
                                 "Content-Disposition": (
                                     f'attachment; filename="{Path(name).name}"; '
                                     f"filename*=UTF-8''{quote(download_name, safe='')}"
                                 ),
                             })
            except OSError:
                self.respond(404, {"error": "体验文件不存在。"})
        elif route in STATIC_FILES:
            name, mime = STATIC_FILES[route]
            if mime.startswith("text/html") and not private_html and not self.load_session():
                return
            try:
                content = (FRONTEND / name).read_bytes()
                if mime.startswith("text/html") and self.current_session:
                    user = self.current_session["user"]
                    attributes = f' data-account-id="{escape(user["id"], quote=True)}" data-account-name="{escape(user["username"], quote=True)}"'
                    content = re.sub(r"<html\b", lambda _: "<html" + attributes,
                                     content.decode("utf-8"), count=1).encode("utf-8")
                self.respond(200, content, mime)
            except OSError:
                self.respond(404, {"error": "网页文件不存在。"})
        else:
            # 不把项目根目录、数据库或模型文件当静态资源暴露。
            self.respond(404, {"error": "地址不存在。"})

    def do_POST(self):
        self.current_session = None
        route = urlsplit(self.path).path
        if route.startswith("/api/auth/"):
            self.auth_post(route)
            return
        if not self.require_account() or not self.require_mutation():
            return
        history_match = HISTORY_ROUTE.fullmatch(route)
        is_decisions = bool(history_match and history_match[2] == "decisions")

        #文件上传使用独立入口，在现有JSON检查之前处理.
        if route == "/api/extract":
            from backend.document_upload import handle_upload
            handle_upload(self)
            return

        if route not in ("/api/search", "/api/verify", "/api/review") and not is_decisions:
            self.respond(404, {"error": "接口不存在。"})
            return
        if self.headers.get("Transfer-Encoding"):
            self.respond(400, {"error": "请使用普通 JSON 请求。"})
            return
        if self.headers.get_content_type() != "application/json":
            self.respond(400, {"error": "请求类型必须是 application/json。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        # 整篇审阅要传输完整正文，用单独放宽的上限。
        limit = MAX_DECISION_BYTES if is_decisions else MAX_REVIEW_BYTES if route == "/api/review" else MAX_REQUEST_BYTES
        if length > limit:
            self.close_connection = True
            if is_decisions:
                self.respond(413, {"error": "人工备注总量过大，请缩短备注后再保存。"})
            elif route == "/api/review":
                self.respond(413, {"error": "文档过长，请拆分后分批审阅。"})
            else:
                self.respond(413, {"error": "请求内容过长，请缩短说明。"})
            return
        if length <= 0:
            self.respond(400, {"error": "请求内容为空或长度无效。"})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("请求内容不完整。")
        except TimeoutError:
            self.respond(408, {"error": "接收请求超时，请重试。"})
            return
        except ValueError as error:
            self.respond(400, {"error": str(error)})
            return

        if is_decisions:
            try:
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, dict) or set(payload) != {"expected_revision", "decisions"}:
                    raise ValueError("请提供人工处理列表及其版本号。")
                updated = update_decisions(self.history_path, history_match[1],
                                           payload["expected_revision"], payload["decisions"], owner_id=self.owner_id)
                self.respond(200, updated)
            except NotFoundError:
                self.respond(404, {"error": "未找到这份审阅记录。"})
            except ConflictError:
                self.respond(409, {"error": "这份记录已在其他页面更新，请保留当前备注并重新打开历史记录后核对。"})
            except (ValueError, UnicodeError, RecursionError) as error:
                self.respond(400, {"error": str(error) or "人工处理格式不正确。"})
            except (sqlite3.Error, OSError):
                self.respond(503, {"error": "人工处理未保存，请稍后重试。"})
            return

        # 整篇审阅接口：单独处理，不经过 validate_query
        if route == "/api/review":
            try:
                request_data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError, RecursionError):
                self.respond(400, {"error": "请求格式不正确。"})
                return

            if not isinstance(request_data, dict):
                self.respond(400, {"error": "请求必须是包含正文和资料编号的 JSON 对象。"})
                return
            document_text = request_data.get("text")
            review_source_id = request_data.get("source_id")

            if not isinstance(document_text, str) or not document_text.strip():
                self.respond(400, {"error": "请提供非空的文档正文（text 字段）。"})
                return
            if len(document_text) > MAX_REVIEW_CHARS:
                self.respond(413, {"error": "文档正文超过 50000 字符，请拆分后分批审阅。"})
                return
            if type(review_source_id) is not int or not 0 < review_source_id <= 2**63 - 1:
                self.respond(400, {"error": "请选择有效的资料编号（source_id 字段）。"})
                return

            title = request_data.get("title", "未命名文稿")
            parent_id = request_data.get("parent_id")
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
                self.respond(400, {"error": "文稿名称须为1至120个字符。"})
                return
            if parent_id is not None and (not isinstance(parent_id, str) or not re.fullmatch(r"[0-9a-f]{32}", parent_id)):
                self.respond(400, {"error": "原审阅版本编号格式不正确。"})
                return
            if parent_id is not None:
                try:
                    get_review(self.history_path, parent_id, owner_id=self.owner_id)
                except NotFoundError:
                    self.respond(404, {"error": "原审阅版本不存在，无法生成关联复核。"})
                    return
                except (sqlite3.Error, OSError, ValueError):
                    self.respond(503, {"error": "暂时无法读取原审阅版本，请稍后重试。"})
                    return

            def persist_review(result):
                return save_review(self.history_path, result, title=title.strip(),
                                   source_id=review_source_id, parent_id=parent_id,
                                   model_version=getattr(self.server, "model_version", "unversioned"),
                                   owner_id=self.owner_id)

            try:
                with closing(open_database(self.server.db_path)) as connection:
                    if connection.execute("SELECT 1 FROM sources WHERE id = ?", (review_source_id,)).fetchone() is None:
                        self.respond(404, {"error": "所选资料不存在，请刷新资料列表后重试。"})
                        return
                    if not self.server.model_lock.acquire(blocking=False):
                        self.respond(429, {"error": "模型正在处理其他请求，请稍后重试。"})
                        return

                    # 浏览器接受 NDJSON 时走流式：每比对完一句就推一行，
                    # 前端可以据此显示真实进度。否则退回一次性 JSON，
                    # 行为与从前完全一致。
                    streaming = "application/x-ndjson" in (self.headers.get("Accept") or "")
                    if streaming:
                        closed = False

                        def on_start(total):
                            nonlocal closed
                            if closed:
                                return
                            closed = not self.emit({
                                "type": "start", "total": total,
                                "schema_version": REVIEW_SCHEMA_VERSION,
                            })

                        def on_progress(index, total, sentence_text, status):
                            nonlocal closed
                            if closed:
                                return
                            closed = not self.emit({
                                "type": "sentence",
                                "index": index,
                                "total": total,
                                "status": status,
                                "sentence": sentence_text,
                            })

                        try:
                            # 响应头也可能因客户端断线而失败，必须处于释放锁的保护范围。
                            self.begin_stream()
                            result = review_document(
                                document_text,
                                review_source_id,
                                self.server.verifier,
                                connection,
                                on_progress=on_progress,
                                on_start=on_start,
                            )
                            result = persist_review(result)
                            if not closed:
                                self.emit({
                                    "type": "done",
                                    **result,
                                })
                        except (BrokenPipeError, ConnectionResetError, TimeoutError):
                            self.close_connection = True
                        except ValueError as error:
                            self.emit({"type": "error", "error": str(error)})
                        except (sqlite3.Error, OSError):
                            self.emit({"type": "error", "error": "审阅结果未能保存，请稍后重试；本次没有形成可导出的记录。"})
                        except Exception as error:
                            self.log_error("Review failed: %s", error)
                            self.emit({"type": "error", "error": "审阅失败，请查看后端终端。"})
                        finally:
                            self.server.model_lock.release()
                            self.end_stream()
                        return

                    try:
                        result = review_document(
                            document_text,
                            review_source_id,
                            self.server.verifier,
                            connection
                        )
                        result = persist_review(result)
                        self.respond(200, {
                            "status": "completed",
                            **result,
                        })
                    except ValueError as error:
                        self.respond(422, {"error": str(error)})
                    except (sqlite3.Error, OSError):
                        self.respond(503, {"error": "审阅结果未能保存，请稍后重试；本次没有形成可导出的记录。"})
                    except Exception as error:
                        self.log_error("Review failed: %s", error)
                        self.respond(500, {"error": "审阅失败，请查看后端终端。"})
                    finally:
                        self.server.model_lock.release()
            except (sqlite3.Error, ValueError):
                self.respond(503, {"error": "暂时无法读取资料库。"})
            return

        # 其他接口（search / verify）：需要校验 claim 长度
        try:
            claim, source_id = validate_query(json.loads(raw.decode("utf-8")))
        except (ValueError, UnicodeError, RecursionError):
            self.respond(400, {"error": "请求格式不正确：请填写不超过 500 字符的说明，并选择有效的资料编号。"})
            return
        except TimeoutError:
            self.respond(408, {"error": "接收请求超时，请重试。"})
            return
        try:
            with closing(open_database(self.server.db_path)) as connection:
                result = search_evidence(connection, claim, source_id)
        except (sqlite3.Error, ValueError):
            self.respond(503, {"error": "暂时无法读取资料库。"})
            return

        # 检索接口只返回证据。
        if route == "/api/search":
            self.respond(200, result)
            return

        result["model_status"] = "not_run"

        # 核验前先确认对应的馆藏资料。
        if source_id is None:
            result.update(
                status="needs_context",
                matches=[],
                message="请先选择限定资料，确认核验对象。",
            )
            self.respond(200, result)
            return

        # 没找到证据时，不调用模型。
        if result["status"] != "found":
            self.respond(200, result)
            return

        # 同一时刻只运行一组预测。
        if not self.server.model_lock.acquire(blocking=False):
            self.respond(429, {"error": "模型正在处理其他请求，请稍后重试。"})
            return

        try:
            for match in result["matches"]:
                # 补充对象名，让模型知道这段原文描述的是谁。
                evidence_input = (
                    f"对象：{match['object_name']}。\n"
                    f"{match['evidence_text']}"
                )

                prediction = self.server.verifier.predict(
                    claim, evidence_input
                )

                # 在原来的证据结果中加入 label 和 scores。
                match.update(prediction)
                match["claim_input"] = claim
                match["evidence_input"] = evidence_input

        except ValueError as error:
            self.respond(422, {"error": str(error)})
            return
        except Exception as error:
            self.log_error("Model inference failed: %s", error)
            self.respond(500, {"error": "模型预测失败，请查看后端终端。"})
            return
        finally:
            self.server.model_lock.release()

        result.update(
            status="completed",
            model_status="completed",
            message="已逐条完成模型预测，请结合对应原文查看。",
        )
        self.respond(200, result)

def create_server(host="127.0.0.1", port=5173, db_path=DB_PATH, *, history_path=None,
                  accounts_path=None, secure_cookies=None, public_origin=None):
    db_path = Path(db_path)
    if secure_cookies is None:
        secure_cookies = os.environ.get("COSTUME_SECURE_COOKIES", "").lower() in ("1", "true", "yes")
    public_origin = public_origin or os.environ.get("COSTUME_PUBLIC_ORIGIN")
    if public_origin:
        public_origin = normalized_origin(public_origin)
        if public_origin.startswith("https://"):
            secure_cookies = True
    with closing(open_database(db_path)) as connection:
        available_sources(connection)

    server = ThreadingHTTPServer((host, port), WebsiteHandler)
    server.auth_required = True
    server.db_path = db_path
    server.history_path = history_path if history_path is not None else db_path.with_name("review_history.db")
    server.model_version = "ocnli_50k_20261007_01/best.pt"

    try:
        server.auth_store = AuthStore(accounts_path or os.environ.get("COSTUME_ACCOUNTS_PATH") or db_path.with_name("accounts.db"))
        server.auth_limiter = AuthRateLimiter()
        server.secure_cookies = bool(secure_cookies)
        server.public_origin = public_origin
        initialize_history(server.history_path)
        from backend.inference import Verifier
        print("正在加载模型……", flush=True)
        server.verifier = Verifier()
        server.model_lock = Lock()
        print(
            f"模型已加载，运行设备：{server.verifier.device}",
            flush=True,
        )
    except Exception:
        server.server_close()
        raise

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173, help="本地端口，默认 5173")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机 127.0.0.1")
    parser.add_argument("--accounts-db", type=Path, default=None, help="独立账户数据库路径，默认 data/accounts.db")
    parser.add_argument("--secure-cookies", action="store_true", default=None, help="仅通过 HTTPS 发送登录 Cookie")
    parser.add_argument("--public-origin", default=None, help="反向代理使用的公网来源，如 https://example.com")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    with create_server(host=args.host, port=args.port, accounts_path=args.accounts_db,
                       secure_cookies=args.secure_cookies, public_origin=args.public_origin) as server:
        print(f"网站已启动：http://localhost:{args.port}/", flush=True)
        print("检索与模型核验接口已就绪。按 Ctrl+C 停止。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(f"网站启动失败：{error}") from error
