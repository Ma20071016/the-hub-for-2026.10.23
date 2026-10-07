# OCNLI 数据预处理

更新：2026-10-07。采用 `train.3k.json` 和官方 `dev.json`，完成清洗、分组隔离和双路 DataLoader。数据用于中文三分类开发，不代表传统服饰领域验证或官方测试成绩。

## 来源与划分

- [OCNLI 官方仓库](https://github.com/CLUEbenchmark/OCNLI)，固定提交 `b53efdee17257a5c33993cf6fcf8ffff0497ea0e`；[论文](https://arxiv.org/abs/2010.05444)。
- 许可：[CC BY-NC 2.0](https://creativecommons.org/licenses/by-nc/2.0/)，保留官方 README 的署名与来源说明。
- 原始目录：`data/raw/ocnli/data/ocnli/`。不使用 `test.json`，不拼接相互重叠的不同规模训练子集。
- 排除无共识标签 `-` 和空文本；同 `prem_id` 或同规范化证据按连通分量分组。规范化为 NFKC 后去空白，仅用于查重，输出保留原文。
- 保留官方验证集，从训练候选中排除与验证集连通的整个组。未知标签、非法编号等格式错误直接报错。

| 集合 | supports | refutes | insufficient | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 训练 | 974 | 966 | 1,053 | 2,993 |
| 验证 | 947 | 900 | 1,103 | 2,950 |

训练原始 3,000 条，排除 6 条无共识样本和 1 条同源样本（ID `39129`，前提 `tv_257`）；验证原始 3,000 条，排除 50 条无共识样本。跨集合分组与规范化证据均无重合。

## 字段与标签

输出为 UTF-8 JSONL，每行包含七个字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 带原文件命名空间的唯一编号，如 `ocnli:train.3k:12845` |
| `claim` | 原 `sentence2`，待核验陈述 |
| `evidence` | 原 `sentence1`，证据 |
| `label` | 英文三分类标签 |
| `source_id` | 原 `prem_id`，缺失时以规范化证据哈希回退 |
| `source_locator` | 固定提交和原文件行号的 GitHub 地址，定位数据集记录，不是原始历史文献出处 |
| `group_id` | 同前提编号或同规范化证据连通合并后的组编号 |

标签映射：`entailment → supports → 0`，`contradiction → refutes → 1`，`neutral → insufficient → 2`。文件保留英文，加载时转换为 `torch.long`；`insufficient` 表示给定证据不足。

## 加载与复现

`scripts/model_data.py` 的 `build_loaders(batch_size=4, max_length=64, seed=20261006)` 返回训练、验证加载器。两路独立编码并动态 padding；仅训练集打乱，`drop_last=False`、`num_workers=0`。seed 控制加载器，不等于完整训练确定性。

batch 包含 `claim_inputs`、`evidence_inputs`、`labels`、`ids`。每路输入含 `input_ids`、`attention_mask`、`token_type_ids`，形状为 `[B, L]`；标签用于损失，编号用于追溯。

全量遍历通过：训练 749 批、尾批 1 条；验证 738 批、尾批 2 条。含特殊 token 的最大长度为训练两路 52、验证 claim 57 / evidence 52，当前长度 64 无截断；更换数据后需重新统计。

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier
python scripts/prepare_ocnli.py
python -m scripts.model_data
```

预处理仅依赖标准库，重跑覆盖 `data/processed/ocnli/train.jsonl`、`validation.jsonl` 和 `reports/ocnli_preprocessing.json`，不改原始数据。报告保留来源、哈希、排除明细及隔离检查；重复处理结果一致，5,943 条输出已逐条核对。
