"""Prepare the pinned official Chinese BERT assets without loading a model.

Run from the project root in the existing WSL ``escnet`` environment::

    python -m scripts.download_bert
    python -m scripts.download_bert --local-files-only

Only JSON configuration and safetensors weights are requested. The second
command verifies an existing download without making network requests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from huggingface_hub import hf_hub_download, hf_hub_url


PROJECT_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = PROJECT_DIR / "data/processed/.hf-cache"
REPORT_PATH = PROJECT_DIR / "reports/bert_assets.json"

MODEL_ID = "google-bert/bert-base-chinese"
REVISION = "8f23c25b06e129b6c986331a13d8d025a92cf0ea"
WEIGHTS_SIZE = 411_553_788
WEIGHTS_SHA256 = "3404a1ffd8da507042e8161013ba2a4fc49858b4e3f8fbf5ce5724f94883aec3"


def sha256_file(path: Path) -> str:
    """Hash in bounded chunks so verification does not duplicate model RAM."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_assets(*, local_files_only: bool = False) -> dict:
    """Download or locate the fixed revision, verify it, and record provenance."""
    paths = {}
    for filename in ("config.json", "model.safetensors"):
        print(f"Preparing {MODEL_ID}/{filename} @ {REVISION}", flush=True)
        paths[filename] = Path(
            hf_hub_download(
                repo_id=MODEL_ID,
                filename=filename,
                revision=REVISION,
                cache_dir=str(CACHE_DIR),
                local_files_only=local_files_only,
            )
        )

    files = {}
    for filename, path in paths.items():
        files[filename] = {
            "path": path.relative_to(PROJECT_DIR).as_posix(),
            "size_bytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "source_url": hf_hub_url(MODEL_ID, filename, revision=REVISION),
        }

    weights = files["model.safetensors"]
    if weights["size_bytes"] != WEIGHTS_SIZE or weights["sha256"] != WEIGHTS_SHA256:
        raise ValueError(
            "BERT weight integrity check failed: the file does not match the "
            "official fixed revision. No successful asset report was written."
        )

    config = json.loads(paths["config.json"].read_text(encoding="utf-8"))
    expected_config = {"model_type": "bert", "hidden_size": 768, "vocab_size": 21128}
    for key, expected in expected_config.items():
        if config.get(key) != expected:
            raise ValueError(f"Unexpected BERT configuration: {key}={config.get(key)!r}")

    report = {
        "recorded_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "timezone": "Asia/Shanghai",
        "status": "verified",
        "model_id": MODEL_ID,
        "revision": REVISION,
        "snapshot_directory": paths["config.json"].parent.relative_to(PROJECT_DIR).as_posix(),
        "files": files,
        "verification": {
            "weight_size_and_sha256_match_official_lfs_metadata": True,
            "expected_weight_size_bytes": WEIGHTS_SIZE,
            "expected_weight_sha256": WEIGHTS_SHA256,
            "configuration": expected_config,
        },
        "scope": "Configuration and weights only; no model training or environment changes.",
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = REPORT_PATH.with_suffix(".json.tmp")
    temporary_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary_path.replace(REPORT_PATH)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--local-files-only", action="store_true", help="Verify cached assets without network access."
    )
    args = parser.parse_args()
    report = prepare_assets(local_files_only=args.local_files_only)
    print(f"Verified snapshot: {report['snapshot_directory']}")
    print(f"Asset report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
