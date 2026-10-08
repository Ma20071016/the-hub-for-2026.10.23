# models

文本三分类模型的核心模块，按“编码 → 投影 → 立场 → 融合 → 分类”连接。

- [bert_encoder.py](bert_encoder.py)：共享冻结 BERT，分别编码陈述和证据；输出 token 特征与有效位置 mask。
- [text_projection.py](text_projection.py)：两路独立线性投影，将 768 维降至 384 维，并清零 padding。
- [stance_transformer.py](stance_transformer.py)：共享原型交叉注意力、残差前馈层，以及池化、共享投影和拼接；融合输出 `[B, 80]`。
- [text_verifier.py](text_verifier.py)：组合完整模型，输出 `[B, 3]` 原始 logits，类别顺序为 `supports / refutes / insufficient`。
- [__init__.py](__init__.py)：导出 BERT 编码器及编码结果类型。

范围：基于 ESCNet 共享原型立场模块的文本三分类改编。原型是可训练向量，没有对应到具体实体；尚无图像、实体提取与链接、知识图谱实体比较或证据检索分支。

已通过 GPU 单批前向/反向检查，并完成 OCNLI 3k、50k 训练；最佳验证 Macro-F1 分别为 0.5296、0.6495，最佳权重重载后的固定验证批次 logits 完全一致。结果见[训练摘要](../reports/training_results_2026-10-07.json)，不代表服饰领域验证或官方测试成绩。
