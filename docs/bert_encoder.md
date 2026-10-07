# BERT 双路编码模块

更新：2026-10-07。共享冻结 BERT 分别编码 claim/evidence，输出 token 特征。投影、共享原型、立场融合和分类头已编写；完整模型的交叉熵与反向传播尚未验证，训练循环尚未实现。

## 文件与权重

| 文件 | 作用 |
| --- | --- |
| `models/bert_encoder.py` | 双路编码、冻结与输入校验 |
| `models/text_verifier.py` | 组合编码器、投影、立场模块、融合与三分类头 |
| `scripts/model_data.py` | 真实数据分批、分词和标签转换 |
| `scripts/download_bert.py` | 固定版本下载及大小、SHA-256 校验 |
| `scripts/check_bert_encoder.py` | 真实 batch 的编码器诊断 |
| `configs/bert_encoder.json` | 编码器诊断参数，不控制完整模型或训练 |
| `tests/test_bert_encoder.py` | 小型随机 BERT 的行为测试 |
| `reports/bert_assets.json` | 权重来源、版本、路径与哈希 |
| `reports/bert_encoder_check.json` | 最近一次编码器诊断结果及运行配置 |

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

编码器诊断默认使用 CUDA；不可用时直接报错。CPU 检查可加 `--device cpu`。诊断读取 `configs/bert_encoder.json`，成功后更新 `reports/bert_encoder_check.json`；编码器本身不读取该配置。

## 已有结果

- 2026-10-06：9 项 unittest 通过，覆盖双路形状、冻结、训练模式、下游梯度、padding 不变性、非法输入、设备和本地权重加载。
- 同日 21:58（Asia/Shanghai）：RTX 5060 Laptop 真实 batch 通过，claim 为 `[4,16,768]`、evidence 为 `[4,32,768]`，dtype 为 float32。
- 重复前向一致，追加右侧 padding 后有效特征在浮点容差内一致；padding 输出为零。临时线性探针梯度有限且非零，BERT 无梯度，未执行参数更新。
- 该次编码器诊断峰值 allocated 为 454.29 MiB、reserved 为 494 MiB，仅反映该进程的 PyTorch 显存统计。
- 后续 BERT → 投影 → 共享原型立场模块的真实 GPU 前向与反向已通过，两路输出 `[4,40,384]`。融合与分类头的完整链路仍待验证，暂无分类效果或训练结果。
