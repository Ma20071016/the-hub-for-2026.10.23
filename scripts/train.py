"""Train the frozen-BERT verifier; save metrics, TensorBoard events and checkpoints."""

import argparse
import hashlib
import json
import os
import platform
import random
import subprocess
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import tensorboard
import torch
from torch import nn
from torch.utils.tensorboard import SummaryWriter
import transformers

from models.text_verifier import TextVerifier
from scripts.model_data import DATA_DIR, LABEL_TO_ID, TOKENIZER_DIR, build_loaders


PROJECT_DIR = Path(__file__).resolve().parents[1]
LABELS = list(LABEL_TO_ID)


class TimeLimitReached(Exception):
    """Stop at a batch boundary without treating a partial epoch as complete."""


def atomic_save(path, payload, *, checkpoint=False):
    temporary = path.with_suffix(path.suffix + ".tmp")
    if checkpoint:
        torch.save(payload, temporary)
    else:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    os.replace(temporary, path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_output(*arguments):
    try:
        return subprocess.check_output(
            ["git", *arguments], cwd=PROJECT_DIR, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def batch_to_device(batch, device):
    claim = {key: value.to(device) for key, value in batch["claim_inputs"].items()}
    evidence = {key: value.to(device) for key, value in batch["evidence_inputs"].items()}
    return claim, evidence, batch["labels"].to(device)


def new_totals():
    return {"loss_sum": 0.0, "count": 0, "confusion": torch.zeros(3, 3, dtype=torch.long)}


def accumulate(totals, loss, logits, labels):
    count = labels.numel()
    totals["loss_sum"] += loss.item() * count
    totals["count"] += count
    pairs = labels.detach().cpu() * 3 + logits.detach().argmax(dim=1).cpu()
    totals["confusion"] += torch.bincount(pairs, minlength=9).reshape(3, 3)


def finish_metrics(totals):
    matrix = totals["confusion"]
    per_class = {}
    for index, label in enumerate(LABELS):
        true_positive = matrix[index, index].item()
        support = matrix[index].sum().item()
        predicted = matrix[:, index].sum().item()
        precision = true_positive / predicted if predicted else 0.0
        recall = true_positive / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_class[label] = dict(precision=precision, recall=recall, f1=f1, support=support)
    return {
        "count": totals["count"],
        "loss": totals["loss_sum"] / totals["count"],
        "accuracy": matrix.diag().sum().item() / totals["count"],
        "macro_f1": sum(values["f1"] for values in per_class.values()) / 3,
        "per_class": per_class,
        "confusion_matrix": matrix.tolist(),  # Rows: true labels; columns: predictions.
    }


def head_state(model):
    # Frozen BERT remains in the pinned local snapshot instead of every checkpoint.
    return {
        name: value.detach().cpu().clone()
        for name, value in model.state_dict().items()
        if not name.startswith("encoder.")
    }


def rng_state():
    numpy_state = np.random.get_state()
    return {
        "python": random.getstate(),
        "numpy": {
            "algorithm": numpy_state[0], "keys": numpy_state[1].tolist(),
            "position": numpy_state[2], "has_gaussian": numpy_state[3],
            "cached_gaussian": numpy_state[4],
        },
        "torch_cpu": torch.get_rng_state(),
        "torch_cuda": torch.cuda.get_rng_state_all(),
    }


def log_epoch(writer, split, metrics, epoch):
    for name in ("loss", "accuracy", "macro_f1"):
        writer.add_scalar(f"{split}/{name}", metrics[name], epoch)
    for label, values in metrics["per_class"].items():
        writer.add_scalar(f"{split}/f1_{label}", values["f1"], epoch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New, nonexistent run directory")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--max-length", type=int, default=64)
    parser.add_argument("--max-minutes", type=float, default=40)
    parser.add_argument("--patience", type=int, default=3)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--seed", type=int, default=20261006)
    args = parser.parse_args()
    if min(args.epochs, args.batch_size, args.max_length, args.patience, args.max_minutes, args.lr) <= 0:
        parser.error("Epochs, batch size, length, patience, time limit and learning rate must be positive")
    if args.weight_decay < 0:
        parser.error("Weight decay must be nonnegative")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    writer = model = optimizer = train_loader = None
    epoch = global_step = completed_epochs = stale_epochs = batches_completed = 0
    best_epoch = best_metrics = baseline = epoch_start_generator = None
    phase, status, stop_reason = "initialization", "running", None
    restore_check, failure = {"passed": False, "reason": "No best checkpoint yet"}, None
    metadata = {}

    def log(message):
        print(message, flush=True)
        with (output / "console.log").open("a", encoding="utf-8") as stream:
            stream.write(message + "\n")

    def check_time():
        if time.monotonic() - started >= args.max_minutes * 60:
            raise TimeLimitReached

    def checkpoint(include_optimizer=False):
        state = {
            "format_version": 1, "model_state": head_state(model), "metadata": metadata,
            "epoch": epoch, "global_step": global_step, "phase": phase,
            "completed_epochs": completed_epochs, "batches_completed_in_phase": batches_completed,
            "best_epoch": best_epoch, "best_metrics": best_metrics, "stale_epochs": stale_epochs,
        }
        if include_optimizer:
            state.update(
                optimizer_state=optimizer.state_dict(), rng_state=rng_state(),
                train_loader_generator=train_loader.generator.get_state(),
                validation_loader_generator=validation_loader.generator.get_state(),
                epoch_start_generator=epoch_start_generator,
                resume_note="State retained; exact partial-epoch resume CLI is not implemented.",
            )
        return state

    def validate():
        nonlocal batches_completed
        model.eval()
        totals, first_logits = new_totals(), None
        batches_completed = 0
        with torch.no_grad():
            for batch in validation_loader:
                check_time()
                claim, evidence, labels = batch_to_device(batch, device)
                logits = model(claim, evidence)
                loss = criterion(logits, labels)
                if not torch.isfinite(loss).item():
                    raise FloatingPointError("Nonfinite validation loss")
                accumulate(totals, loss, logits, labels)
                if first_logits is None:
                    first_logits = logits.cpu().clone()
                batches_completed += 1
        return finish_metrics(totals), first_logits

    try:
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.set_num_threads(4)
        random.seed(args.seed)
        np.random.seed(args.seed)
        torch.manual_seed(args.seed)
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; run in the WSL escnet environment")
        device = torch.device("cuda:0")
        assets = json.loads((PROJECT_DIR / "reports/bert_assets.json").read_text(encoding="utf-8"))
        for asset in assets["files"].values():
            if sha256(PROJECT_DIR / asset["path"]) != asset["sha256"]:
                raise RuntimeError(f"BERT asset hash mismatch: {asset['path']}")
        model = TextVerifier(PROJECT_DIR / assets["snapshot_directory"]).to(device)
        torch.cuda.reset_peak_memory_stats(device)
        parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
        optimizer = torch.optim.AdamW(parameters, lr=args.lr, weight_decay=args.weight_decay)
        criterion = nn.CrossEntropyLoss()
        train_loader, validation_loader = build_loaders(args.batch_size, args.max_length, args.seed)
        fixed_batch = next(iter(validation_loader))
        settings = {**vars(args), "output": str(output), "gradient_clip": 1.0,
                    "cpu_threads": torch.get_num_threads(), "deterministic_algorithms": True,
                    "cublas_workspace_config": os.environ["CUBLAS_WORKSPACE_CONFIG"]}
        code_files = sorted((PROJECT_DIR / "models").glob("*.py")) + [Path(__file__), PROJECT_DIR / "scripts/model_data.py"]
        code_hashes = {str(path.relative_to(PROJECT_DIR)): sha256(path) for path in code_files}
        metadata = {"settings": settings, "label_to_id": LABEL_TO_ID, "bert_revision": assets["revision"], "code_sha256": code_hashes}
        git_status = git_output("status", "--porcelain")
        run = {
            **metadata, "started_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "environment": {"python": platform.python_version(), "torch": str(torch.__version__),
                            "transformers": transformers.__version__, "numpy": np.__version__,
                            "tensorboard": tensorboard.__version__,
                            "cuda_runtime": torch.version.cuda, "gpu": torch.cuda.get_device_name(device)},
            "git": {"head": git_output("rev-parse", "HEAD"), "dirty": bool(git_status) if git_status is not None else None, "status": git_status},
            "data_sha256": {f"{split}.jsonl": sha256(DATA_DIR / f"{split}.jsonl") for split in ("train", "validation")},
            "tokenizer_sha256": {name: sha256(TOKENIZER_DIR / name) for name in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt")},
            "bert_snapshot": assets["snapshot_directory"], "bert_files": assets["files"],
            "train_samples": len(train_loader.dataset), "validation_samples": len(validation_loader.dataset),
            "trainable_parameters": sum(parameter.numel() for parameter in parameters),
            "fixed_validation_ids": fixed_batch["ids"],
            "resume_support": "Checkpoint states retained; exact partial-epoch resume CLI is not implemented.",
        }
        atomic_save(output / "run.json", run)
        writer = SummaryWriter(str(output / "tensorboard"), flush_secs=15)
        phase = "baseline_validation"
        baseline, baseline_logits = validate()
        phase = "baseline_complete"
        best_epoch, best_metrics = 0, baseline
        best = checkpoint()
        best.update(validation=baseline, fixed_validation_logits=baseline_logits)
        atomic_save(output / "best.pt", best, checkpoint=True)
        atomic_save(output / "last.pt", checkpoint(True), checkpoint=True)
        log_epoch(writer, "validation", baseline, 0)
        with (output / "metrics.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"epoch": 0, "validation": baseline, "elapsed_seconds": time.monotonic() - started}) + "\n")
        writer.flush()
        log(f"Baseline: loss={baseline['loss']:.4f} acc={baseline['accuracy']:.4f} macro_f1={baseline['macro_f1']:.4f}")

        for epoch in range(1, args.epochs + 1):
            phase, batches_completed = "training", 0
            epoch_start_generator = train_loader.generator.get_state().clone()
            check_time()
            model.train()
            if model.encoder.bert.training or any(p.requires_grad for p in model.encoder.parameters()):
                raise RuntimeError("BERT must remain frozen and in eval mode")
            totals = new_totals()
            for batch in train_loader:
                check_time()
                claim, evidence, labels = batch_to_device(batch, device)
                optimizer.zero_grad(set_to_none=True)
                logits = model(claim, evidence)
                loss = criterion(logits, labels)
                if not torch.isfinite(loss).item():
                    raise FloatingPointError("Nonfinite training loss")
                loss.backward()
                grad_norm = nn.utils.clip_grad_norm_(parameters, 1.0, error_if_nonfinite=True)
                optimizer.step()
                global_step += 1
                batches_completed += 1
                accumulate(totals, loss, logits, labels)
                if global_step == 1 or global_step % 20 == 0:
                    writer.add_scalar("training/step_loss", loss.item(), global_step)
                    writer.add_scalar("training/grad_norm", grad_norm.item(), global_step)
                    writer.add_scalar("training/learning_rate", optimizer.param_groups[0]["lr"], global_step)
            training = finish_metrics(totals)
            phase = "validation"
            validation, reference_logits = validate()
            completed_epochs, phase = epoch, "epoch_complete"
            improved = (validation["macro_f1"], -validation["loss"]) > (best_metrics["macro_f1"], -best_metrics["loss"])
            stale_epochs = 0 if improved else stale_epochs + 1
            if improved:
                best_epoch, best_metrics = epoch, validation
            state = checkpoint()
            state.update(training=training, validation=validation)
            atomic_save(output / f"epoch_{epoch:03d}.pt", state, checkpoint=True)
            if improved:
                state["fixed_validation_logits"] = reference_logits
                atomic_save(output / "best.pt", state, checkpoint=True)
            atomic_save(output / "last.pt", checkpoint(True), checkpoint=True)
            record = {"epoch": epoch, "global_step": global_step, "training": training, "validation": validation, "best_epoch": best_epoch, "elapsed_seconds": time.monotonic() - started}
            with (output / "metrics.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record) + "\n")
            log_epoch(writer, "training", training, epoch)
            log_epoch(writer, "validation", validation, epoch)
            for name in ("projection", "stance", "fusion", "classifier"):
                norm = sum(p.detach().square().sum() for p in getattr(model, name).parameters()).sqrt()
                writer.add_scalar(f"weights/{name}_l2", norm.item(), epoch)
            writer.add_histogram("weights/prototypes", model.stance.prototypes.detach().cpu(), epoch)
            writer.flush()
            log(f"Epoch {epoch}: train_loss={training['loss']:.4f} val_loss={validation['loss']:.4f} val_acc={validation['accuracy']:.4f} val_macro_f1={validation['macro_f1']:.4f} best={best_epoch} elapsed={(time.monotonic()-started)/60:.1f}min")
            if stale_epochs >= args.patience:
                stop_reason = "early_stopping"
                break
        status, stop_reason = "completed", stop_reason or "epochs_finished"
    except TimeLimitReached:
        status, stop_reason = "stopped", "time_limit"
    except (Exception, KeyboardInterrupt) as error:
        status, stop_reason, failure = "failed", f"{type(error).__name__}: {error}", error
    finally:
        try:
            if model is not None and optimizer is not None and train_loader is not None:
                checkpoint_name = "last.pt" if phase in ("baseline_complete", "epoch_complete") else "interrupted.pt"
                atomic_save(output / checkpoint_name, checkpoint(True), checkpoint=True)
            if (output / "best.pt").is_file() and failure is None:
                best = torch.load(output / "best.pt", map_location="cpu", weights_only=True)
                incompatible = model.load_state_dict(best["model_state"], strict=False)
                expected_missing = {name for name in model.state_dict() if name.startswith("encoder.")}
                if set(incompatible.missing_keys) != expected_missing or incompatible.unexpected_keys:
                    raise RuntimeError("Checkpoint keys do not match the trainable model head")
                model.eval()
                with torch.no_grad():
                    claim, evidence, _ = batch_to_device(fixed_batch, device)
                    restored = model(claim, evidence).cpu()
                exact = torch.equal(restored, best["fixed_validation_logits"])
                restore_check = {"passed": exact, "exact_logits_match": exact, "best_epoch": best_epoch}
                if not exact:
                    raise RuntimeError("Restored best checkpoint did not reproduce fixed-batch logits")
        except (Exception, KeyboardInterrupt) as error:
            status, stop_reason, failure = "failed", f"Finalization {type(error).__name__}: {error}", failure or error
        finally:
            if writer is not None:
                writer.close()
            summary = {
                "status": status, "stop_reason": stop_reason, "phase": phase,
                "completed_epochs": completed_epochs, "current_epoch": epoch, "global_steps": global_step,
                "best_epoch": best_epoch, "best_metrics": best_metrics, "baseline": baseline,
                "elapsed_seconds": time.monotonic() - started, "restore_check": restore_check,
                "peak_allocated_mib": torch.cuda.max_memory_allocated() / 2**20 if model is not None else None,
                "partial_epoch": phase in ("training", "validation"),
                "interrupted_checkpoint": "interrupted.pt" if (output / "interrupted.pt").is_file() else None,
                "resume_note": "State retained; exact partial-epoch resume CLI is not implemented.",
            }
            atomic_save(output / "summary.json", summary)
            log(json.dumps(summary, ensure_ascii=False))
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
