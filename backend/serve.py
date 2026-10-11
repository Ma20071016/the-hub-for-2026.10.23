"""本地网站,提供证据检索和模型核验。"""

import argparse
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import sqlite3
import unicodedata
from urllib.parse import urlsplit

from backend.init_db import DB_PATH, PROJECT_DIR

from threading import Lock
from backend.inference import Verifier


FRONTEND = PROJECT_DIR / "frontend"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
MAX_REQUEST_BYTES = 8192


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
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def respond(self, status, content, content_type="application/json; charset=utf-8"):
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器编辑输入后可能取消旧请求。

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/api/sources":
            try:
                with closing(open_database(self.server.db_path)) as connection:
                    result = available_sources(connection)
                self.respond(200, result)
            except (sqlite3.Error, ValueError):
                self.respond(503, {"error": "暂时无法读取资料库，请检查数据库是否已就绪。"})
        elif route in STATIC_FILES:
            name, mime = STATIC_FILES[route]
            try:
                self.respond(200, (FRONTEND / name).read_bytes(), mime)
            except OSError:
                self.respond(404, {"error": "网页文件不存在。"})
        else:
            # 不把项目根目录、数据库或模型文件当静态资源暴露。
            self.respond(404, {"error": "地址不存在。"})

    def do_POST(self):
        route = urlsplit(self.path).path
        if route not in ("/api/search", "/api/verify"):
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
        if length > MAX_REQUEST_BYTES:
            self.respond(413, {"error": "请求内容过长，请缩短说明。"})
            return
        if length <= 0:
            self.respond(400, {"error": "请求内容为空或长度无效。"})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("请求内容不完整。")
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

def create_server(host="127.0.0.1", port=5173, db_path=DB_PATH):
    with closing(open_database(db_path)) as connection:
        available_sources(connection)

    server = ThreadingHTTPServer((host, port), WebsiteHandler)
    server.db_path = db_path

    try:
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
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1 到 65535 之间。")
    with create_server(port=args.port) as server:
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
