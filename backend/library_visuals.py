"""Curated source photographs, bound to current approved library evidence.

The manifest is supplementary presentation data. Missing or malformed entries
never make the text library unavailable, and neither paths nor saved evidence
IDs from that file are trusted as public links.
"""

from collections import Counter
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit

from backend.init_db import PROJECT_DIR


MANIFEST_PATH = PROJECT_DIR / "data" / "library_visuals.json"
IMAGE_DIR = PROJECT_DIR / "frontend" / "img" / "library"
_FILE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.(?:jpg|png|webp)\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
_MIME = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_VISUALS = 50
_MAX_HOTSPOTS = 25
_MAX_DIMENSION = 20000
_JS_MAX_SAFE_INTEGER = 2**53 - 1


def _text(value, limit=1000):
    return isinstance(value, str) and 0 < len(value) <= limit and bool(value.strip())


def _web_url(value):
    if not _text(value, 4096) or any(character.isspace() or ord(character) < 32 for character in value):
        return False
    if "\\" in value:
        return False
    try:
        parsed = urlsplit(value)
        return (parsed.scheme in ("https", "http") and bool(parsed.hostname)
                and parsed.username is None and parsed.password is None
                and (parsed.port is None or 1 <= parsed.port <= 65535))
    except ValueError:
        return False


def _image_path(filename, image_dir=None):
    """Resolve only an existing basename directly inside the fixed image folder."""
    if not isinstance(filename, str) or _FILE.fullmatch(filename) is None:
        return None
    try:
        directory = Path(image_dir if image_dir is not None else IMAGE_DIR).resolve(strict=True)
        local_path = directory / filename
        if local_path.is_symlink():
            return None
        candidate = local_path.resolve(strict=True)
        if candidate.parent == directory and candidate.is_file():
            return candidate
    except (OSError, ValueError, RuntimeError):
        pass
    return None


def _coordinate(value):
    return type(value) in (int, float) and 0 <= value <= 100 and math.isfinite(value)


def _hotspots(value):
    if not isinstance(value, list):
        return []
    candidates = []
    for item in value[:_MAX_HOTSPOTS]:
        if not isinstance(item, dict):
            continue
        identifier = item.get("id")
        if (not isinstance(identifier, str) or _ID.fullmatch(identifier) is None
                or not _text(item.get("label"), 120)
                or not _text(item.get("evidence_quote"), 50000)
                or not _coordinate(item.get("x")) or not _coordinate(item.get("y"))):
            continue
        candidates.append({key: item[key] for key in ("id", "label", "x", "y", "evidence_quote")})
    counts = Counter(item["id"] for item in candidates)
    return [item for item in candidates if counts[item["id"]] == 1]


def load_visual_manifest(manifest_path=None, image_dir=None):
    """Return validated entries; a missing/invalid manifest is equivalent to no images."""
    path = Path(manifest_path if manifest_path is not None else MANIFEST_PATH)
    try:
        # Keep a broken or accidentally huge local data file out of request memory.
        with path.open("rb") as stream:
            raw = stream.read(_MAX_MANIFEST_BYTES + 1)
        if len(raw) > _MAX_MANIFEST_BYTES:
            return []
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError, RecursionError):
        return []
    if (not isinstance(data, dict) or type(data.get("schema_version")) is not int
            or data["schema_version"] != 1 or not isinstance(data.get("sources"), list)):
        return []

    entries = []
    for entry in data["sources"][:1000]:
        if not isinstance(entry, dict):
            continue
        if (any(not _text(entry.get(key)) for key in ("case_id", "title", "object_name"))
                or not _web_url(entry.get("source_url"))
                or not isinstance(entry.get("images"), list)):
            continue
        images = []
        for item in entry["images"][:_MAX_VISUALS]:
            if not isinstance(item, dict):
                continue
            identifier = item.get("id")
            if (not isinstance(identifier, str) or _ID.fullmatch(identifier) is None
                    or _image_path(item.get("file"), image_dir) is None
                    or not _web_url(item.get("original_url"))
                    or not _text(item.get("caption"), 2000)
                    or any(not _text(item.get(key), 1000) for key in ("alt", "credit"))
                    or any(type(item.get(key)) is not int or not 1 <= item[key] <= _MAX_DIMENSION
                           for key in ("width", "height"))):
                continue
            images.append({
                **{key: item[key] for key in (
                    "id", "file", "original_url", "caption", "alt", "width", "height", "credit")},
                "hotspots": _hotspots(item.get("hotspots", [])),
            })
        entries.append({
            **{key: entry[key] for key in ("case_id", "source_url", "title", "object_name")},
            "images": images,
        })

    # Reject ambiguous duplicate bindings/IDs rather than guess which annotation wins.
    bindings = Counter((item["case_id"], item["source_url"], item["title"], item["object_name"])
                       for item in entries)
    image_ids = Counter((entry["case_id"], image["id"])
                        for entry in entries for image in entry["images"])
    result = []
    for entry in entries:
        binding = (entry["case_id"], entry["source_url"], entry["title"], entry["object_name"])
        if bindings[binding] != 1:
            continue
        entry["images"] = [item for item in entry["images"]
                           if image_ids[(entry["case_id"], item["id"])] == 1]
        result.append(entry)
    return result


def source_visuals(source, approved, manifest=None):
    """Bind photos by source identity and hotspots by exact current approved text."""
    entries = load_visual_manifest() if manifest is None else manifest
    visuals = []
    for entry in entries:
        if any(entry[key] != source[key] for key in ("case_id", "source_url", "title")):
            continue
        evidence = [item for item in approved if item["object_name"] == entry["object_name"]]
        if not evidence:
            continue
        by_quote = {}
        for item in evidence:
            by_quote.setdefault(item["evidence_text"], []).append(item["id"])
        for item in entry["images"]:
            hotspots = []
            for hotspot in item["hotspots"]:
                ids = by_quote.get(hotspot["evidence_quote"], [])
                if len(ids) == 1 and type(ids[0]) is int and 0 < ids[0] <= _JS_MAX_SAFE_INTEGER:
                    hotspots.append({
                        **{key: hotspot[key] for key in ("id", "label", "x", "y")},
                        "evidence_id": ids[0],
                    })
            visuals.append({
                **{key: item[key] for key in (
                    "id", "original_url", "caption", "alt", "width", "height", "credit")},
                "url": "/img/library/" + item["file"], "hotspots": hotspots,
            })
            if len(visuals) >= _MAX_VISUALS:
                return visuals
    return visuals


def read_library_image(filename):
    """Return bytes and MIME only for a valid manifest-listed local image."""
    if not isinstance(filename, str) or _FILE.fullmatch(filename) is None:
        return None
    manifest = load_visual_manifest()
    if not any(item["file"] == filename for entry in manifest for item in entry["images"]):
        return None
    path = _image_path(filename)
    if path is None:
        return None
    try:
        return path.read_bytes(), _MIME[Path(filename).suffix.lower()]
    except OSError:
        return None
