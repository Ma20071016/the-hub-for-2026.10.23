"""检查完整文本三分类模型的单批 GPU 前向与反向传播。"""

import json
from pathlib import Path

import torch
from torch import nn

from models.text_verifier import TextVerifier
from scripts.model_data import LABEL_TO_ID, build_loaders


PROJECT_DIR = Path(__file__).resolve().parents[1]


def main() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用，请在 WSL 的 escnet 环境运行")

    torch.manual_seed(20261006)
    device = torch.device("cuda:0")

    # 1. 加载完整模型，BERT 仍保持冻结和 eval。
    assets = json.loads(
        (PROJECT_DIR / "reports/bert_assets.json").read_text(
            encoding="utf-8"
        )
    )
    bert_path = PROJECT_DIR / assets["snapshot_directory"]

    model = TextVerifier(bert_path).to(device)
    model.train()
    torch.cuda.reset_peak_memory_stats(device)

    # 2. 读取真实 batch，核对标签后搬到 GPU。
    train_loader, _ = build_loaders(
        batch_size=4,
        max_length=64,
        seed=20261006,
    )
    batch = next(iter(train_loader))
    batch_size = batch["claim_inputs"]["input_ids"].shape[0]

    assert LABEL_TO_ID == {
        "supports": 0,
        "refutes": 1,
        "insufficient": 2,
    }
    assert batch["labels"].dtype == torch.long
    assert batch["labels"].shape == (batch_size,)
    assert ((batch["labels"] >= 0) & (batch["labels"] < 3)).all().item()

    claim_inputs = {
        key: value.to(device)
        for key, value in batch["claim_inputs"].items()
    }
    evidence_inputs = {
        key: value.to(device)
        for key, value in batch["evidence_inputs"].items()
    }
    labels = batch["labels"].to(device)

    print("GPU：", torch.cuda.get_device_name(device))
    print("样本 ID：", batch["ids"])
    print("标签：", batch["labels"].tolist())

    # 3. 临时检查融合输出，再通过完整模型得到 logits。
    def check_fusion(_module, _inputs, output):
        assert output.shape == (batch_size, 80)
        assert output.device == device
        assert output.requires_grad
        assert torch.isfinite(output).all().item()
        print("融合输出：", tuple(output.shape))

    handle = model.fusion.register_forward_hook(check_fusion)
    try:
        logits = model(claim_inputs, evidence_inputs)
    finally:
        handle.remove()

    assert logits.shape == (batch_size, 3)
    assert logits.device == device
    assert logits.requires_grad
    assert torch.isfinite(logits).all().item()
    print("logits：", tuple(logits.shape))

    # 4. 真实标签交叉熵：直接输入 logits，不加 Softmax。
    loss = nn.CrossEntropyLoss()(logits, labels)
    assert torch.isfinite(loss).item()
    loss.backward()
    print(f"交叉熵：{loss.item():.6f}")

    # 5. 检查四个可训练模块的梯度。
    for module_name in ["projection", "stance", "fusion", "classifier"]:
        module = getattr(model, module_name)
        gradient_sum = 0.0

        for name, parameter in module.named_parameters():
            full_name = f"{module_name}.{name}"
            assert parameter.requires_grad, f"{full_name} 被意外冻结"

            grad = parameter.grad
            assert grad is not None, f"{full_name} 没有梯度"
            assert torch.isfinite(grad).all().item(), (
                f"{full_name} 梯度出现 NaN 或 Inf"
            )
            gradient_sum += grad.abs().sum().item()

        assert gradient_sum > 0, f"{module_name} 总梯度为零"
        print(f"{module_name}：梯度检查通过")

    assert model.stance.prototypes.grad.abs().sum().item() > 0
    assert all(
        not parameter.requires_grad and parameter.grad is None
        for parameter in model.encoder.parameters()
    )
    assert not model.encoder.bert.training

    print("共享原型：获得非零梯度")
    print("BERT：保持冻结、无梯度、处于 eval 模式")
    print(
        "PyTorch 峰值已分配显存："
        f"{torch.cuda.max_memory_allocated(device) / 2**20:.2f} MiB"
    )
    print("通过：完整模型单批前向与反向检查完成。")


if __name__ == "__main__":
    main()