# models

文本三分类模型的核心模块，按“编码 → 投影 → 立场 → 融合 → 分类”连接。

- [bert_encoder.py](bert_encoder.py)：共享冻结 BERT，分别编码陈述和证据；输出 token 特征与有效位置 mask。
- [text_projection.py](text_projection.py)：两路独立线性投影，将 768 维降至 384 维，并清零 padding。
- [stance_transformer.py](stance_transformer.py)：共享原型交叉注意力、残差前馈层，以及池化、共享投影和拼接；融合输出 `[B, 80]`。
- [text_verifier.py](text_verifier.py)：组合完整模型，输出 `[B, 3]` 原始 logits，类别顺序为 `supports / refutes / insufficient`。
- [__init__.py](__init__.py)：导出 BERT 编码器及编码结果类型。

范围：基于 ESCNet 共享原型立场模块的文本三分类改编，不含图像和知识图谱分支。
完整模型的真实标签交叉熵前向、反向检查尚待完成。
