# OCNLI 数据预处理

更新：2026-10-08。已保留 3k、50k 两套清洗结果；当前加载器使用 50k。数据用于通用中文三分类开发，不代表传统服饰领域验证或官方测试成绩。

## 来源与划分

- [OCNLI 官方仓库](https://github.com/CLUEbenchmark/OCNLI)，固定提交 `b53efdee17257a5c33993cf6fcf8ffff0497ea0e`；[论文](https://arxiv.org/abs/2010.05444)。
- 许可：[CC BY-NC 2.0](https://creativecommons.org/licenses/by-nc/2.0/)，保留官方 README 的署名与来源说明。
- 原始目录：`data/raw/ocnli/data/ocnli/`。训练分别取 `train.3k.json`、`train.50k.json`，验证取 `dev.json`；不使用 `test.json`，不拼接重叠训练子集。
- 排除无共识标签 `-` 和空文本；同 `prem_id` 或同规范化证据按连通分量分组。规范化为 NFKC 后去空白，仅用于查重，输出保留原文。
- 保留官方验证集，从训练候选中排除与验证集连通的整个组。未知标签、非法编号等格式错误直接报错。

| 集合 | supports | refutes | insufficient | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 3k 训练 | 974 | 966 | 1,053 | 2,993 |
| 50k 训练 | 12,337 | 12,096 | 12,639 | 37,072 |
| 验证 | 947 | 900 | 1,103 | 2,950 |

3k 原始 3,000 条，排除 6 条无共识样本和 1 条同源样本。50k 原始 50,486 条，排除 49 条无共识样本和 13,365 条与验证集同组的样本，因此实际训练规模为 37,072。验证原始 3,000 条，排除 50 条无共识样本。两套划分均无跨集合分组或规范化证据重合。

两份验证集的模型输入、标签、ID 与顺序一致；因与不同训练候选联合分组，4 条记录的 `group_id` 不同，文件哈希也不同。

## 字段与标签

输出为 UTF-8 JSONL，每行包含七个字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 带原文件命名空间的唯一编号，如 `ocnli:train.50k:12845` |
| `claim` | 原 `sentence2`，待核验陈述 |
| `evidence` | 原 `sentence1`，给定证据 |
| `label` | 英文三分类标签 |
| `source_id` | 原 `prem_id`，缺失时以规范化证据哈希回退 |
| `source_locator` | 固定提交和原文件行号的 GitHub 地址，定位数据集记录，不是原始历史文献出处 |
| `group_id` | 同前提编号或同规范化证据连通合并后的组编号 |

标签映射：`entailment → supports → 0`，`contradiction → refutes → 1`，`neutral → insufficient → 2`。文件保留英文，加载时转换为 `torch.long`；`insufficient` 表示给定证据不足。数据没有实体 ID、实体链接或知识图谱特征。

## 加载与复现

`scripts/model_data.py` 的 `DATA_DIR` 当前为 `data/processed/ocnli_50k`。`build_loaders(batch_size=4, max_length=64, seed=20261006)` 返回训练、验证加载器；训练入口传入 batch 16。两路独立分词并动态 padding，仅训练集打乱，`drop_last=False`、`num_workers=0`。

batch 包含 `claim_inputs`、`evidence_inputs`、`labels`、`ids`。每路输入含 `input_ids`、`attention_mask`、`token_type_ids`，形状为 `[B,L]`。50k 正式训练每轮 2,317 个训练 batch、185 个验证 batch。max_length=64 是截断上限；历史 3k 的最大 token 长度 57 仅适用于当时检查，详见[历史快照](../reports/data_loader_snapshot_2026-10-06.json)。

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier
python -m scripts.prepare_ocnli
python -m scripts.model_data
```

当前预处理脚本仅依赖标准库；重跑会覆盖 `data/processed/ocnli_50k/train.jsonl`、`validation.jsonl` 和 `reports/ocnli_50k_preprocessing.json`，不改原始数据及已有 3k 输出。准备其他规模时，在 `scripts/prepare_ocnli.py` 同步设置 `TRAIN_FILE`、`OUTPUT_DIR`、`REPORT_PATH`；加载时再将 `scripts/model_data.py` 的 `DATA_DIR` 指向对应输出。仅切换已有处理数据时只需修改 `DATA_DIR`，实验输出名不会控制数据来源。

| 数据版本 | 本地输出 | 预处理报告 |
| --- | --- | --- |
| 3k 历史 | `data/processed/ocnli/` | [ocnli_preprocessing.json](../reports/ocnli_preprocessing.json) |
| 50k 当前 | `data/processed/ocnli_50k/` | [ocnli_50k_preprocessing.json](../reports/ocnli_50k_preprocessing.json) |

报告保留来源提交、哈希、排除明细、分布及隔离检查。原始数据和处理数据保留本地。
