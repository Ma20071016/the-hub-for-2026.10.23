"""Check the BERT, projection, and stance pipeline on a real GPU batch."""

import json
from pathlib import Path

import torch
from torch import nn

from models.bert_encoder import FrozenBertDualEncoder
from models.text_projection import DualTextProjection
from models.stance_transformer import SharedPrototypeStance
from scripts.model_data import build_loaders


PROJECT_DIR = Path(__file__).resolve().parents[1]


def main() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; this check requires a GPU")

    torch.manual_seed(20261006)
    device = torch.device("cuda")

    # Locate the previously downloaded BERT snapshot.
    assets = json.loads(
        (PROJECT_DIR / "reports/bert_assets.json").read_text(
            encoding="utf-8"
        )
    )
    bert_path = PROJECT_DIR / assets["snapshot_directory"]

    torch.cuda.reset_peak_memory_stats(device)

    # All modules belong to one parent; BERT must remain in eval mode.
    model = nn.ModuleDict({
        "encoder": FrozenBertDualEncoder.from_pretrained(bert_path),
        "projection": DualTextProjection(),
        "stance": SharedPrototypeStance(),
    }).to(device)
    model.train()

    # Read one real batch and transfer only the encoder inputs.
    train_loader, _ = build_loaders(
        batch_size=4,
        max_length=64,
        seed=20261006,
    )
    batch = next(iter(train_loader))

    claim_inputs = {
        key: value.to(device)
        for key, value in batch["claim_inputs"].items()
    }
    evidence_inputs = {
        key: value.to(device)
        for key, value in batch["evidence_inputs"].items()
    }

    # Forward through the three stages.
    encoded = model["encoder"](claim_inputs, evidence_inputs)
    projected = model["projection"](encoded)
    output = model["stance"](projected)

    batch_size = claim_inputs["input_ids"].shape[0]

    for name in ["claim", "evidence"]:
        features = getattr(output, name)
        assert features.shape == (batch_size, 40, 384)
        assert features.device == claim_inputs["input_ids"].device
        assert features.requires_grad
        assert torch.isfinite(features).all().item()
        print(f"{name} 输出：{tuple(features.shape)}，设备：{features.device}")

    # Diagnostic loss only: no optimizer step or classification training.
    loss = output.claim.square().mean() + output.evidence.square().mean()
    loss.backward()

    for module_name in ["projection", "stance"]:
        gradient_sum = 0.0

        for name, parameter in model[module_name].named_parameters():
            assert parameter.grad is not None, (
                f"{module_name}.{name} 没有梯度"
            )
            assert torch.isfinite(parameter.grad).all().item(), (
                f"{module_name}.{name} 梯度异常"
            )
            gradient_sum += parameter.grad.abs().sum().item()

        assert gradient_sum > 0
        print(f"{module_name}：参数梯度检查通过")

    assert model["stance"].prototypes.grad.abs().sum().item() > 0
    assert all(
        not parameter.requires_grad and parameter.grad is None
        for parameter in model["encoder"].parameters()
    )
    assert not model["encoder"].bert.training

    print("共享原型：获得非零梯度")
    print("BERT：保持冻结且处于 eval 模式")
    print(
        "PyTorch 峰值已分配显存："
        f"{torch.cuda.max_memory_allocated(device) / 2**20:.2f} MiB"
    )
    print("\n通过：真实 GPU 上的编码、投影和立场模块已接通。")


if __name__ == "__main__":
    main()