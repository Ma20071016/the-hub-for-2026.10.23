# BERT 双路编码模块

更新：2026-10-08。共享冻结 BERT 分别编码 claim/evidence，输出 token 特征。文本模型已完成 OCNLI 3k 和 50k 训练；训练中仅更新投影、立场、融合与分类模块。

## 文件与权重

| 文件 | 作用 |
| --- | --- |
| `models/bert_encoder.py` | 双路编码、冻结与输入校验 |
| `models/text_verifier.py` | 组合编码器、投影、立场模块、融合与三分类头 |
| `scripts/model_data.py` | 真实数据分批、分词和标签转换 |
| `scripts/train.py` | 训练、验证、检查点保存及 TensorBoard 记录 |
| `scripts/download_bert.py` | 固定版本下载及大小、SHA-256 校验 |
| `scripts/check_bert_encoder.py` | 真实 batch 的编码器诊断 |
| `scripts/check_stance_pipeline.py` | 完整模型的真实 GPU 单批前向与反向检查 |
| `configs/bert_encoder.json` | 编码器诊断参数，不控制完整模型或训练 |
| `tests/test_bert_encoder.py` | 小型随机 BERT 的行为测试 |
| `reports/bert_assets.json` | 权重来源、版本、路径与哈希 |
| `reports/bert_encoder_check.json` | 2026-10-06 编码器诊断结果及当时运行配置 |

本地权重与 tokenizer 均为 `google-bert/bert-base-chinese`，固定 revision `8f23c25b06e129b6c986331a13d8d025a92cf0ea`。权重目录由 `bert_assets.json` 的 `snapshot_directory` 记录；编码器仅加载本地 safetensors，不发起下载。

## 接口约定

`FrozenBertDualEncoder.from_pretrained(bert_path)` 创建编码器，`forward(claim_inputs, evidence_inputs)` 返回 `DualEncoderOutput`，其 `claim`、`evidence` 均为 `TokenEncoding`。

每路输入含 `input_ids`、`attention_mask` 和可选的 `token_type_ids`，形状均为 `[B, L]`。两路 batch 相同，长度可不同；张量须已在编码器所在设备，输入不含标签或来源字段。入口检查字段、形状、dtype、设备、mask、编号范围和位置长度。

```python
output.claim.hidden_states       # [B, L_claim, 768]
output.claim.attention_mask      # [B, L_claim]，bool，True = 有效
output.evidence.hidden_states    # [B, L_evidence, 768]
output.evidence.attention_mask   # [B, L_evidence]，bool，True = 有效
```

- 两路共用一套 BERT 参数，保留 `[CLS]`、`[SEP]`，不池化或拼接。
- BERT 全部冻结；父模块调用 `train()` 后仍保持 `eval()`。`torch.no_grad()` 允许下游层正常反传，不使用 `inference_mode()`。
- padding 特征置零，下游注意力仍须使用 mask。当前约定 `True = 有效`；如接入 PyTorch `key_padding_mask`，需取反。

## 检查命令

在现有 WSL Ubuntu 的 `escnet` 环境按需运行：

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier
python -m scripts.download_bert --local-files-only
python -m unittest discover -s tests -p 'test_bert_encoder.py' -v
python -m scripts.check_bert_encoder
```

编码器诊断默认使用 CUDA；不可用时直接报错。CPU 检查可加 `--device cpu`。诊断读取 `configs/bert_encoder.json`，成功后覆盖 `reports/bert_encoder_check.json`；编码器本身不读取该配置。数据路径与哈希跟随加载器的 `DATA_DIR`，当前指向 50k，重跑结果与历史报告的数据不同。CUDA 显存统计在编码器搬入 GPU 后重置。

## 已有结果

- 2026-10-06：9 项 unittest 通过，覆盖双路形状、冻结、训练模式、下游梯度、padding 不变性、非法输入、设备和本地权重加载。
- 同日 21:58（Asia/Shanghai）：RTX 5060 Laptop 真实 batch 通过，claim 为 `[4,16,768]`、evidence 为 `[4,32,768]`，dtype 为 float32。
- 重复前向一致，追加右侧 padding 后有效特征在浮点容差内一致；padding 输出为零。临时线性探针梯度有限且非零，BERT 无梯度，未执行参数更新。
- 该次编码器诊断峰值 allocated 为 454.29 MiB、reserved 为 494 MiB，仅反映该进程的 PyTorch 显存统计。
- 2026-10-07：完整模型单批 GPU 检查通过，融合输出 `[4,80]`、logits `[4,3]`，交叉熵 1.075862；下游梯度正常，BERT 保持冻结、无梯度和 eval。该次诊断峰值 allocated 为 431.07 MiB，未执行参数更新。
- 同日：3k、50k 正式训练完成，最佳权重回载后的固定 batch logits 与保存时完全一致。两次最佳验证 Macro-F1 分别为 0.5296、0.6495，详情见[训练结果](../reports/training_results_2026-10-07.json)。检查点不重复保存冻结 BERT，回载时仍需上述固定版本的本地权重。
- 2026-10-08：9 项 CPU 测试及当前 50k 真实 batch 编码器诊断通过，确认数据路径与哈希匹配；历史 GPU 报告保留，未重新训练。
