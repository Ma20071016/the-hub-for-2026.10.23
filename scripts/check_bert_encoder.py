"""Exercise the real pretrained encoder with one existing DataLoader batch.

Run from the project root: python -m scripts.check_bert_encoder
This is a forward/gradient diagnostic, not a classifier training experiment.
"""

import argparse
import json
import os
import platform
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import torch
import transformers
from torch import nn
from torch.nn import functional as F

from models.bert_encoder import FrozenBertDualEncoder
from scripts.download_bert import sha256_file
from scripts.model_data import build_loaders


PROJECT_DIR = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def move_inputs(inputs: dict, device: torch.device) -> dict:
    return {key: tensor.to(device) for key, tensor in inputs.items()}


def add_right_padding(inputs: dict, pad_id: int, count: int = 3) -> dict:
    return {
        key: F.pad(tensor, (0, count), value=pad_id if key == "input_ids" else 0)
        for key, tensor in inputs.items()
    }


def run_check(config: dict) -> dict:
    device = torch.device(config["device"])
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable; no implicit CPU fallback")
    torch.set_num_threads(config["cpu_threads"])
    torch.manual_seed(config["seed"])
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False

    asset_report_path = PROJECT_DIR / config["asset_report"]
    assets = json.loads(asset_report_path.read_text(encoding="utf-8"))
    for info in assets["files"].values():
        path = PROJECT_DIR / info["path"]
        require(sha256_file(path) == info["sha256"], f"BERT asset hash mismatch: {path}")

    train_loader, _ = build_loaders(
        batch_size=config["batch_size"], max_length=config["max_length"], seed=config["seed"]
    )
    batch = next(iter(train_loader))
    tokenizer = train_loader.collate_fn.tokenizer
    snapshot = PROJECT_DIR / assets["snapshot_directory"]
    # Compare the complete vocabulary, not merely its size.
    source_tokenizer = transformers.AutoTokenizer.from_pretrained(str(snapshot), local_files_only=True)
    require(tokenizer.get_vocab() == source_tokenizer.get_vocab(), "Tokenizer vocabulary differs from BERT")

    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    encoder = FrozenBertDualEncoder.from_pretrained(snapshot).to(device)
    encoder.train()  # The future parent classifier will call train() too.
    claim = move_inputs(batch["claim_inputs"], device)
    evidence = move_inputs(batch["evidence_inputs"], device)

    if device.type == "cuda":
        torch.cuda.synchronize(device)
    started = time.perf_counter()
    output = encoder(claim, evidence)
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    forward_seconds = time.perf_counter() - started
    repeated = encoder(claim, evidence)
    padded = encoder(
        add_right_padding(claim, tokenizer.pad_token_id),
        add_right_padding(evidence, tokenizer.pad_token_id),
    )

    branches = {}
    for name, inputs in (("claim", claim), ("evidence", evidence)):
        encoded = getattr(output, name)
        features, valid = encoded.hidden_states, encoded.attention_mask
        require(tuple(features.shape) == (*inputs["input_ids"].shape, encoder.hidden_size), "Bad output shape")
        require(torch.isfinite(features).all().item(), "Non-finite BERT features")
        require(not features.requires_grad, "Frozen BERT outputs should have no gradient graph")
        require(torch.count_nonzero(features[~valid]).item() == 0, "Padding features must be zero")
        torch.testing.assert_close(features, getattr(repeated, name).hidden_states, rtol=0, atol=0)
        extended_features = getattr(padded, name).hidden_states[:, :features.shape[1]]
        torch.testing.assert_close(features[valid], extended_features[valid], rtol=1e-4, atol=1e-5)
        branches[name] = {
            "input_shape": list(inputs["input_ids"].shape),
            "feature_shape": list(features.shape),
            "mask_shape": list(valid.shape),
            "valid_lengths": valid.sum(dim=1).tolist(),
            "dtype": str(features.dtype),
            "requires_grad": features.requires_grad,
        }

    # A temporary probe proves trainable downstream layers can consume the
    # frozen features. No optimizer step is performed and the probe is not saved.
    probe = nn.Linear(encoder.hidden_size, 3).to(device)
    probe_features = (output.claim.hidden_states[:, 0] + output.evidence.hidden_states[:, 0]) / 2
    F.cross_entropy(probe(probe_features), batch["labels"].to(device)).backward()
    require(probe.weight.grad is not None, "Downstream gradient was lost")
    require(torch.isfinite(probe.weight.grad).all().item(), "Non-finite downstream gradient")
    require(probe.weight.grad.abs().sum().item() > 0, "Downstream gradient is zero")
    require(all(p.grad is None and not p.requires_grad for p in encoder.parameters()), "BERT is not frozen")
    require(all(not module.training for module in encoder.bert.modules()), "BERT dropout was enabled")

    code_paths = ["models/bert_encoder.py", "scripts/model_data.py", "scripts/check_bert_encoder.py"]
    return {
        "recorded_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "timezone": "Asia/Shanghai",
        "status": "passed",
        "scope": "Shared frozen BERT dual encoding diagnostic only; no optimizer update or stance classifier training",
        "config": config,
        "assets": {"model_id": assets["model_id"], "revision": assets["revision"],
                   "report": config["asset_report"], "report_sha256": sha256_file(asset_report_path)},
        "environment": {
            "python": platform.python_version(), "torch": torch.__version__,
            "transformers": transformers.__version__, "torch_cuda_runtime": torch.version.cuda,
            "device": str(device), "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "cublas_workspace_config": os.environ["CUBLAS_WORKSPACE_CONFIG"],
            "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        },
        "sample_ids": batch["ids"],
        "branches": branches,
        "frozen_parameters": sum(p.numel() for p in encoder.parameters()),
        "trainable_encoder_parameters": sum(p.numel() for p in encoder.parameters() if p.requires_grad),
        "checks": {
            "asset_hashes": True, "tokenizer_vocabulary_match": True,
            "parent_train_keeps_bert_eval": True, "repeat_outputs_identical": True,
            "right_padding_preserves_valid_features": True, "padding_features_zero": True,
            "downstream_backward_succeeds": True, "bert_gradients_absent": True,
        },
        "performance": {
            "first_forward_seconds": forward_seconds,
            "peak_allocated_mib": torch.cuda.max_memory_allocated(device) / 2**20 if device.type == "cuda" else None,
            "peak_reserved_mib": torch.cuda.max_memory_reserved(device) / 2**20 if device.type == "cuda" else None,
            "note": "Single diagnostic batch, including repeated/padded forwards and probe; excludes desktop VRAM and is not a full training benchmark",
        },
        "file_sha256": {name: sha256_file(PROJECT_DIR / name) for name in code_paths},
        "training_data_sha256": sha256_file(PROJECT_DIR / "data/processed/ocnli/train.jsonl"),
        "saved_tokenizer_sha256": {
            p.name: sha256_file(p)
            for p in sorted((PROJECT_DIR / "data/processed/bert-base-chinese-tokenizer").iterdir()) if p.is_file()
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=PROJECT_DIR / "configs/bert_encoder.json")
    parser.add_argument("--device", choices=["cpu", "cuda"], help="Override the configured diagnostic device")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    if args.device:
        config["device"] = args.device
    report = run_check(config)
    path = PROJECT_DIR / config["report_path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    print(json.dumps({"status": report["status"], "branches": report["branches"],
                      "performance": report["performance"], "report": str(path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
