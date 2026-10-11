"""加载现有模型，对 claim 和 evidence 进行三分类。"""

import json

import torch
from transformers import AutoTokenizer

from backend.init_db import PROJECT_DIR
from models.text_verifier import TextVerifier


# 必须与训练时的类别顺序一致。
LABELS = ("supports", "refutes", "insufficient")


class Verifier:
    def __init__(self):
        # 沿用当前评测长度；claim 和 evidence 分别计算。
        self.max_length = 160
        self.device = torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )

        # 1. 加载本地分词器。
        tokenizer_path = (
            PROJECT_DIR / "data/processed/bert-base-chinese-tokenizer"
        )
        self.tokenizer = AutoTokenizer.from_pretrained(
            str(tokenizer_path),
            local_files_only=True,
        )

        # 2. 找到并加载冻结的 BERT。
        bert_info = json.loads(
            (PROJECT_DIR / "reports/bert_assets.json").read_text(
                encoding="utf-8"
            )
        )
        bert_path = PROJECT_DIR / bert_info["snapshot_directory"]
        self.model = TextVerifier(bert_path)

        # 3. 恢复训练好的分类模型参数。
        checkpoint_path = (
            PROJECT_DIR / "runs/ocnli_50k_20261007_01/best.pt"
        )
        checkpoint = torch.load(
            checkpoint_path,
            map_location="cpu",
            weights_only=True,
        )

        result = self.model.load_state_dict(
            checkpoint["model_state"],
            strict=False,
        )

        # best.pt 没有保存冻结的 BERT。
        # 只允许缺少 encoder 参数，其他参数必须匹配。
        expected_missing = {
            name
            for name in self.model.state_dict()
            if name.startswith("encoder.")
        }
        if (
            set(result.missing_keys) != expected_missing
            or result.unexpected_keys
        ):
            raise RuntimeError("训练权重与当前模型结构不匹配")

        self.model.to(self.device)
        self.model.eval()

    def encode(self, text, name):
        """把一段文字转换成模型输入。"""
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"{name}不能为空")

        inputs = self.tokenizer(
            text.strip(),
            return_tensors="pt",
            truncation=False,
        )

        token_count = inputs["input_ids"].shape[1]
        if token_count > self.max_length:
            raise ValueError(
                f"{name}有 {token_count} 个 token，"
                f"超过当前上限 {self.max_length}，请缩短文本"
            )

        return inputs.to(self.device)

    @torch.inference_mode()
    def predict(self, claim, evidence):
        """返回预测类别和三个类别的分数。"""
        claim_inputs = self.encode(claim, "说明")
        evidence_inputs = self.encode(evidence, "证据")

        logits = self.model(claim_inputs, evidence_inputs)
        probabilities = torch.softmax(logits, dim=-1)[0]

        if not torch.isfinite(probabilities).all().item():
            raise RuntimeError("模型输出包含无效分数")

        scores = probabilities.cpu().tolist()
        predicted_id = probabilities.argmax().item()

        return {
            "label": LABELS[predicted_id],
            "scores": dict(zip(LABELS, scores)),
        }


if __name__ == "__main__":
    print("正在加载模型……")
    verifier = Verifier()
    print(f"模型已加载，运行设备：{verifier.device}")

    result = verifier.predict(
        claim="这件棉袍采用对襟设计。",
        evidence=(
            "衣身宽大、造型简洁，对襟，两侧缝开短衩，"
            "衣身可见明显绗缝线迹，门襟处由于线迹紧密而出轻微褶皱。"
            "袖口、门襟、底摆均装饰有黄、白、黑色毛线编结的窄线条装饰。"
        ),
    )

    print(json.dumps(result, ensure_ascii=False, indent=2))