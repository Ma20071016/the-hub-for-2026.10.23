#!/usr/bin/env python3
"""Build a self-contained Ubuntu release using only Python 3.10+ stdlib.

Run from WSL so Linux-created Hugging Face cache symlinks can be resolved:
    /usr/bin/python3 deploy/build_release.py

Only the explicit runtime allowlist below is packaged. The evidence database
is copied with SQLite's backup API; historical verification records are erased
and vacuumed from that temporary copy. The original databases are never edited.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = "cmit-2026-costume-verifier"
BERT_CACHE = PurePosixPath(
    "data/processed/.hf-cache/models--google-bert--bert-base-chinese"
)
TOKENIZER = PurePosixPath("data/processed/bert-base-chinese-tokenizer")
TOKENIZER_FILES = (
    "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt",
)
FIXED_FILES = (
    "data/library_visuals.json",
    "reports/bert_assets.json",
    "runs/ocnli_50k_20261007_01/best.pt",
)
REQUIRED_ENTRYPOINTS = (
    "backend/serve.py", "backend/inference.py", "backend/init_db.py",
    "models/text_verifier.py", "models/bert_encoder.py",
    "frontend/index.html", "deploy/build_release.py",
    "deploy/install-ubuntu.sh", "deploy/costume-verifier.service",
    "deploy/nginx-http.conf.template", "deploy/nginx-proxy.inc",
    "deploy/requirements.txt", "deploy/README.md", "deploy/backup.py",
    "deploy/preflight.py", "deploy/restore.py",
)
EXCLUDED_PARTS = {
    ".git", ".ssh", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", "logs", "credentials", "secrets",
}
EXCLUDED_SUFFIXES = {
    ".pyc", ".pyo", ".log", ".pem", ".key", ".p12", ".pfx",
    ".db", ".sqlite", ".sqlite3", ".bak", ".tmp",
}


class ReleaseError(Exception):
    """An input or generated release failed validation."""


def safe_relative(value: str) -> PurePosixPath:
    """Require portable relative names, including for untrusted manifest paths."""
    if not isinstance(value, str) or not value or chr(92) in value:
        raise ReleaseError(f"Invalid relative path: {value!r}")
    parts = value.split("/")
    if (any(part in ("", ".", "..") for part in parts)
            or any(":" in part for part in parts)
            or any(ord(char) < 32 for char in value)):
        raise ReleaseError(f"Unsafe relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute():
        raise ReleaseError(f"Absolute path is forbidden: {value!r}")
    return path


def source_file(relative: PurePosixPath, *, bert_asset: bool = False) -> Path:
    path = ROOT.joinpath(*relative.parts)
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ReleaseError(
            f"Missing or unreadable required asset: {relative}. "
            "For Linux cache symlinks, run this script in WSL."
        ) from exc
    if not resolved.is_file() or not resolved.is_relative_to(ROOT):
        raise ReleaseError(f"Asset must be a regular file inside the project: {relative}")
    # No links anywhere in ordinary runtime files. Only the two verified BERT
    # leaves may resolve into their own Hugging Face blob store.
    if bert_asset:
        if path.parent.resolve(strict=True) != path.parent:
            raise ReleaseError(f"Symlinked BERT parent directory is forbidden: {relative}")
        blob_directory = ROOT.joinpath(*BERT_CACHE.parts, "blobs")
        if resolved != path and (
            not resolved.is_relative_to(blob_directory)
            or resolved.parent != blob_directory
        ):
            raise ReleaseError(f"BERT link must point to its own cache blob: {relative}")
    elif resolved != path:
        raise ReleaseError(f"Unexpected symlink in runtime files: {relative}")
    if resolved.stat().st_size == 0:
        raise ReleaseError(f"Empty required asset: {relative}")
    return resolved


def excluded(path: PurePosixPath) -> bool:
    lower_parts = [part.lower() for part in path.parts]
    return (any(part in EXCLUDED_PARTS or part.startswith(".env") for part in lower_parts)
            or path.suffix.lower() in EXCLUDED_SUFFIXES
            or path.name.lower() in {"id_rsa", "id_ed25519", "authorized_keys"}
            or path.name.lower().startswith(("credentials.", "secrets.")))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def collect_files() -> tuple[dict[PurePosixPath, Path], dict]:
    files: dict[PurePosixPath, Path] = {}

    def add(name: str, *, bert_asset: bool = False) -> None:
        relative = safe_relative(name)
        if excluded(relative):
            raise ReleaseError(f"Disallowed release file: {relative}")
        files[relative] = source_file(relative, bert_asset=bert_asset)

    for directory in ("backend", "models"):
        for path in sorted((ROOT / directory).glob("*.py")):
            add(path.relative_to(ROOT).as_posix())
    for directory in ("frontend", "deploy"):
        base = ROOT / directory
        if not base.is_dir() or base.resolve() != base:
            raise ReleaseError(f"Missing or symlinked runtime directory: {directory}")
        for current, directories, names in os.walk(base, followlinks=False):
            # Do not traverse caches, credentials, or symlinked directories.
            for name in list(directories):
                path = Path(current) / name
                relative = safe_relative(path.relative_to(ROOT).as_posix())
                if excluded(relative):
                    directories.remove(name)
                elif path.is_symlink():
                    raise ReleaseError(f"Symlinked runtime directory: {relative}")
            for name in sorted(names):
                path = Path(current) / name
                relative = safe_relative(path.relative_to(ROOT).as_posix())
                if not excluded(relative):
                    add(relative.as_posix())
    for name in FIXED_FILES:
        add(name)
    for name in ("README.md", "docs/accounts.md"):
        if (ROOT / name).exists():
            add(name)
    for name in TOKENIZER_FILES:
        add((TOKENIZER / name).as_posix())
    for name in REQUIRED_ENTRYPOINTS:
        if safe_relative(name) not in files:
            raise ReleaseError(f"Missing required runtime file: {name}")

    manifest = json.loads(files[PurePosixPath("reports/bert_assets.json")].read_text(encoding="utf-8"))
    snapshot = safe_relative(manifest["snapshot_directory"])
    revision = manifest.get("revision", "")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ReleaseError("BERT manifest must pin a 40-character revision")
    if snapshot != BERT_CACHE / "snapshots" / revision:
        raise ReleaseError("BERT snapshot must be inside the known project model cache")
    for name in ("config.json", "model.safetensors"):
        metadata = manifest["files"][name]
        relative = safe_relative(metadata["path"])
        if relative != snapshot / name:
            raise ReleaseError(f"BERT asset path does not match its snapshot: {name}")
        if (type(metadata.get("size_bytes")) is not int or metadata["size_bytes"] <= 0
                or not isinstance(metadata.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", metadata["sha256"])):
            raise ReleaseError(f"Invalid BERT hash or size in manifest: {name}")
        add(relative.as_posix(), bert_asset=True)
    return files, manifest


def backup_evidence_database(destination: Path) -> dict[str, int]:
    original = source_file(PurePosixPath("data/costume.db"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(original.as_uri() + "?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(destination)
    try:
        source.execute("PRAGMA query_only = ON")
        source.backup(target)
    finally:
        source.close()
        target.close()
    connection = sqlite3.connect(destination)
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )}
        if tables != {"sources", "evidence_chunks", "verifications", "verification_items"}:
            raise ReleaseError(f"Unexpected evidence database tables; refusing to package: {sorted(tables)}")
        counts = {
            "sources": connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0],
            "evidence_chunks": connection.execute("SELECT COUNT(*) FROM evidence_chunks").fetchone()[0],
            "approved_evidence": connection.execute(
                "SELECT COUNT(*) FROM evidence_chunks WHERE review_status='approved'"
            ).fetchone()[0],
        }
        if not counts["sources"] or not counts["approved_evidence"]:
            raise ReleaseError("Evidence database must contain sources and approved evidence")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA secure_delete = ON")
        with connection:
            connection.execute("DELETE FROM verification_items")
            connection.execute("DELETE FROM verifications")
        # Rebuild the copy so deleted user documents cannot remain in free pages.
        connection.execute("VACUUM")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ReleaseError("Packaged evidence database failed integrity_check")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ReleaseError("Packaged evidence database has broken foreign keys")
        for table in ("sources", "evidence_chunks"):
            if connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] != counts[table]:
                raise ReleaseError(f"Evidence rows changed unexpectedly: {table}")
        for table in ("verifications", "verification_items"):
            if connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]:
                raise ReleaseError(f"Historical user records remain in {table}")
        return counts
    finally:
        connection.close()


def write_archive(staging: Path, destination: Path, names: list[PurePosixPath]) -> None:
    with destination.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                root_info = tarfile.TarInfo(PACKAGE_ROOT)
                root_info.type = tarfile.DIRTYPE
                root_info.mode = 0o755
                archive.addfile(root_info)
                for relative in sorted(names, key=str):
                    source = staging.joinpath(*relative.parts)
                    info = tarfile.TarInfo(f"{PACKAGE_ROOT}/{relative.as_posix()}")
                    info.size = source.stat().st_size
                    info.mode = 0o755 if relative.suffix == ".sh" else 0o644
                    # TarInfo defaults zero time, uid/gid and empty owner names.
                    with source.open("rb") as stream:
                        archive.addfile(info, stream)
    expected = {f"{PACKAGE_ROOT}/{name.as_posix()}" for name in names} | {PACKAGE_ROOT}
    with tarfile.open(destination, "r:gz") as archive:
        seen: set[str] = set()
        for member in archive:
            name = safe_relative(member.name)
            if (name.parts[0] != PACKAGE_ROOT or member.name in seen
                    or not (member.isfile() or member.isdir())
                    or member.name not in expected):
                raise ReleaseError(f"Unsafe or unexpected archive member: {member.name}")
            seen.add(member.name)
        if seen != expected:
            raise ReleaseError("Archive contents do not match the runtime allowlist")


def build(output: Path) -> None:
    output = output.expanduser().resolve()
    if not output.name.endswith(".tar.gz"):
        raise ReleaseError("--output must name a .tar.gz archive")
    safe_relative(output.name)
    if output.is_relative_to(ROOT) and not output.is_relative_to(ROOT / "dist"):
        raise ReleaseError("Output inside the project must be under dist/ to protect source files")
    files, manifest = collect_files()
    with tempfile.TemporaryDirectory(prefix="costume-release-") as temporary:
        staging = Path(temporary)
        for relative, source in sorted(files.items(), key=lambda item: str(item[0])):
            destination = staging.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        for name in ("config.json", "model.safetensors"):
            metadata = manifest["files"][name]
            path = staging.joinpath(*safe_relative(metadata["path"]).parts)
            if path.stat().st_size != metadata["size_bytes"] or sha256_file(path) != metadata["sha256"]:
                raise ReleaseError(f"BERT asset size or SHA-256 mismatch: {name}")
        database_name = PurePosixPath("data/costume.db")
        counts = backup_evidence_database(staging.joinpath(*database_name.parts))
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor, archive_name = tempfile.mkstemp(prefix=".costume-release-", dir=output.parent)
        os.close(descriptor)
        temporary_archive = Path(archive_name)
        checksum_temporary: Path | None = None
        try:
            write_archive(staging, temporary_archive, [*files, database_name])
            digest = sha256_file(temporary_archive)
            checksum = output.with_name(output.name + ".sha256")
            descriptor, checksum_name = tempfile.mkstemp(prefix=".costume-sha256-", dir=output.parent)
            checksum_temporary = Path(checksum_name)
            with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as stream:
                stream.write(f"{digest}  {output.name}\n")
            os.replace(temporary_archive, output)
            os.replace(checksum_temporary, checksum)
        finally:
            temporary_archive.unlink(missing_ok=True)
            if checksum_temporary is not None:
                checksum_temporary.unlink(missing_ok=True)
    print(f"Release: {output}")
    print(f"SHA-256: {digest}")
    print(f"Checksum: {checksum}")
    print(f"Archive size: {output.stat().st_size:,} bytes; {len(files) + 1} runtime files")
    print(f"Evidence: {counts['sources']} sources, {counts['evidence_chunks']} chunks, "
          f"{counts['approved_evidence']} approved")
    print("Excluded: accounts, review history, historical verifications, training data, credentials and logs.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "costume-verifier-ubuntu.tar.gz",
                        help="Output archive path (default: dist/costume-verifier-ubuntu.tar.gz)")
    args = parser.parse_args()
    try:
        build(args.output)
    except (ReleaseError, OSError, sqlite3.Error, ValueError, KeyError, TypeError, tarfile.TarError) as exc:
        print(f"Release build failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
