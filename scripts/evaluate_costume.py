import json
from pathlib import Path
from torch.utils.data import DataLoader
from transformers import AutoTokenizer
from scripts.model_data import PairCollator, TOKENIZER_DIR
import torch
from models.text_verifier import TextVerifier

from scripts.model_data import LABEL_TO_ID
from scripts.train import (
    batch_to_device,
    new_totals,
    accumulate,
    finish_metrics,
)

# WSL 中，D 盘对应 /mnt/d
TEST_DIR = Path(
    "/mnt/d/Uyghur_Costume_Raw_Archive/文字实验集_001-010_原句复制20条"
)

# 找到目录中的样本文件
files = sorted(TEST_DIR.glob("costume_*.json"))

if not files:
    raise FileNotFoundError(f"没有找到样本，请检查目录：{TEST_DIR}")

# 将文件内容读入列表
samples = []

for file in files:
    with file.open(encoding="utf-8") as f:
        samples.append(json.load(f))

# 加载本地中文 BERT 分词器
tokenizer = AutoTokenizer.from_pretrained(
    str(TOKENIZER_DIR),
    local_files_only=True,
)

# 复用已有功能：分词、补齐长度、转换标签
collator = PairCollator(tokenizer, max_length=160)

# 每次向模型提供 4 条样本
test_loader = DataLoader(
    samples,
    batch_size=4,
    shuffle=False,
    drop_last=False,
    collate_fn=collator,
)

# 先查看第一批输入
batch = next(iter(test_loader))

# 定位项目根目录
PROJECT_DIR = Path(__file__).resolve().parents[1]

# 找到训练时使用的本地 BERT
bert_info = json.loads(
    (PROJECT_DIR / "reports/bert_assets.json").read_text(
        encoding="utf-8"
    )
)
bert_path = PROJECT_DIR / bert_info["snapshot_directory"]

# 创建模型，并加载 BERT
model = TextVerifier(bert_path)

# 读取训练中保存的最佳权重
checkpoint_path = (
    PROJECT_DIR / "runs/ocnli_50k_20261007_01/best.pt"
)
checkpoint = torch.load(
    checkpoint_path,
    map_location="cpu",
    weights_only=True,
)

# 恢复训练得到的参数
result = model.load_state_dict(
    checkpoint["model_state"],
    strict=False,
)

# best.pt 不包含冻结的 BERT，检查缺失的是否只有这部分
expected_missing = {
    name for name in model.state_dict()
    if name.startswith("encoder.")
}

if (
    set(result.missing_keys) != expected_missing
    or result.unexpected_keys
):
    raise RuntimeError("权重与模型结构不匹配")

# 有 GPU 就用 GPU，否则使用 CPU
device = torch.device(
    "cuda" if torch.cuda.is_available() else "cpu"
)
model = model.to(device)
model.eval()

ID_TO_LABEL = {
    number: label for label, number in LABEL_TO_ID.items()
}

totals = new_totals()
predictions = []
samples_by_id = {sample["id"]: sample for sample in samples}

print("\n开始测试全部样本……")

with torch.inference_mode():
    for batch in test_loader:
        # 准备这一批输入
        claim_inputs, evidence_inputs, labels = batch_to_device(
            batch, device
        )

        # 模型只接收陈述和证据
        logits = model(claim_inputs, evidence_inputs)

        # 对照参考标签，累计统计指标
        loss = torch.nn.functional.cross_entropy(logits, labels)
        accumulate(totals, loss, logits, labels)

        predicted_ids = logits.argmax(dim=1).cpu().tolist()
        reference_ids = labels.cpu().tolist()

        # 记录每条样本的预测结果
        for sample_id, predicted, reference in zip(
            batch["ids"], predicted_ids, reference_ids
        ):
            sample = samples_by_id[sample_id]
            predictions.append({
                "id": sample_id,
                "claim": sample["claim"],
                "evidence": sample["evidence"],
                "reference_label": ID_TO_LABEL[reference],
                "predicted_label": ID_TO_LABEL[predicted],
                "correct": predicted == reference,
            })

        print(
            f"\r已测试：{totals['count']}/{len(samples)}",
            end="",
            flush=True,
        )

# 汇总全部样本的指标
metrics = finish_metrics(totals)

print("\n\n测试完成")
print("样本总数：", metrics["count"])
print(f"准确率：{metrics['accuracy']:.2%}")
print(f"宏平均 F1：{metrics['macro_f1']:.4f}")

for label, values in metrics["per_class"].items():
    print(
        f"{label}："
        f"精确率={values['precision']:.4f}，"
        f"召回率={values['recall']:.4f}，"
        f"F1={values['f1']:.4f}"
    )

# 将统计指标和每条预测保存到一个文件
output_path = PROJECT_DIR / "reports/costume_eval_atomic_001_010.json"
output_path.parent.mkdir(parents=True, exist_ok=True)

report = {
    "checkpoint": str(checkpoint_path),
    "max_length": collator.max_length,
    "label_order": [ID_TO_LABEL[i] for i in range(3)],
    "reference_label_status": "AI初拟，尚待人工复核",
    "metrics": metrics,
    "predictions": predictions,
}

output_path.write_text(
    json.dumps(report, ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print("结果已保存到：", output_path)
