import json
from pathlib import Path

import torch
from torch.utils.data import DataLoader
from transformers import AutoTokenizer

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_DIR / "data/processed/ocnli_50k"
TOKENIZER_DIR = PROJECT_DIR / "data/processed/bert-base-chinese-tokenizer"

LABEL_TO_ID = {"supports": 0, "refutes": 1, "insufficient": 2}


class PairCollator:
    """把若干条样本转换成一个双路输入 batch。"""

    def __init__(self, tokenizer, max_length=64):
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __call__(self, samples):
        options = {
            "padding": True,
            "truncation": True,
            "max_length": self.max_length,
            "return_tensors": "pt",
        }

        return {
            "claim_inputs": self.tokenizer(
                [s["claim"] for s in samples], **options
            ),
            "evidence_inputs": self.tokenizer(
                [s["evidence"] for s in samples], **options
            ),
            "labels": torch.tensor(
                [LABEL_TO_ID[s["label"]] for s in samples],
                dtype=torch.long,
            ),
            "ids": [s["id"] for s in samples],
        }


def build_loaders(batch_size=4, max_length=64, seed=20261006):
    tokenizer = AutoTokenizer.from_pretrained(
        str(TOKENIZER_DIR),
        local_files_only=True,
    )
    collator = PairCollator(tokenizer, max_length)
    loaders = {}

    for split in ["train", "validation"]:
        with (DATA_DIR / f"{split}.jsonl").open(encoding="utf-8") as f:
            samples = [json.loads(line) for line in f if line.strip()]

        loaders[split] = DataLoader(
            samples,
            batch_size=batch_size,
            shuffle=(split == "train"),
            drop_last=False,
            num_workers=0,
            collate_fn=collator,
            generator=torch.Generator().manual_seed(seed),
        )

    return loaders["train"], loaders["validation"]


if __name__ == "__main__":
    train_loader, validation_loader = build_loaders()

    for name, loader in [
        ("train", train_loader),
        ("validation", validation_loader),
    ]:
        total = 0
        last_batch_size = 0

        for index, batch in enumerate(loader):
            last_batch_size = batch["labels"].shape[0]
            total += last_batch_size

            if index == 0:
                print(f"\n=== {name} 第一批 ===")
                print("claim：", tuple(batch["claim_inputs"]["input_ids"].shape))
                print("evidence：", tuple(batch["evidence_inputs"]["input_ids"].shape))
                print("labels：", batch["labels"])

        print("批次数：", len(loader))
        print("实际读取样本数：", total)
        print("最后一批大小：", last_batch_size)
