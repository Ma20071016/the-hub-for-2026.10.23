# 文本核验模型

文本三分类模型的核心模块，按“编码 → 投影 → 立场 → 融合 → 分类”连接。

- [bert_encoder.py](bert_encoder.py)：冻结的共享 BERT，分别编码陈述和证据。
- [text_projection.py](text_projection.py)：将两路特征从 768 维投影到 384 维。
- [stance_transformer.py](stance_transformer.py)：共享原型注意力与特征融合。
- [text_verifier.py](text_verifier.py)：组合完整模型，输出三类 logits；顺序为 `supports / refutes / insufficient`。

模型改编自 ESCNet 的共享原型立场模块，仅处理文本；原型不对应具体实体，模型内部不做图片识别、知识图谱推理或证据检索。网站检索由 [backend](../backend/README.md) 负责。

训练与检查命令见 [scripts](../scripts/README.md)。本地资源齐全时，可运行 `python -m backend.inference` 查看推理示例。BERT 权重在 `data/processed/`，训练权重在 `runs/`，均不纳入 Git。

OCNLI 3k、50k 实验的最佳验证 Macro-F1 分别为 0.5296、0.6495。详见[训练摘要](../reports/training_results_2026-10-07.json)，这些结果不代表服饰领域或官方测试成绩。
