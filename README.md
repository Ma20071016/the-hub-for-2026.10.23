# 传统服饰说明核验

2026 年全国大学生数字媒体科技作品及创意竞赛项目。方向：基于限定资料库的传统服饰说明核验。

当前实现：基于 ESCNet 共享原型立场模块的文本三分类改编，已完成 OCNLI 3k 和 50k 两次训练。50k 清洗后使用 37,072 条训练数据，最佳验证 Macro-F1 为 0.6495、准确率为 64.64%。这是通用文本推理验证结果，暂无服饰领域评测。

输入为已配对的主张与证据。外部知识库检索、实体识别与链接、实体知识比较及图像分支尚未实现，不构成完整 ESCNet 或完整事实核验系统。

## 目录说明

| 目录 | 用途 |
| --- | --- |
| [models/](models/README.md) | 模型核心模块与完整三分类模型 |
| [scripts/](scripts/README.md) | 数据准备、资源下载、训练和诊断入口 |
| [configs/](configs/README.md) | 检查脚本的运行参数 |
| [data/](data/README.md) | 原始数据、处理数据与本地 BERT 资源 |
| [tests/](tests/README.md) | 自动化行为测试 |
| [docs/](docs/README.md) | 开发记录与技术说明 |
| [reports/](reports/README.md) | 来源、哈希、诊断结果和设置快照 |
| [runs/](runs/README.md) | 本地训练权重、优化器状态与 TensorBoard 日志 |
| [.idea/](.idea/README.md) | PyCharm 项目配置 |

根目录 `README.md` 为项目入口；`.gitignore` 定义数据、权重及临时文件的忽略规则。各目录的 README 列出具体文件分工。

## 文档与记录

- [开发记录](docs/development_log.md)：当前状态、设置和阶段结果。
- [数据处理](docs/data_preparation.md)：来源、划分和字段约定。
- [BERT 编码](docs/bert_encoder.md)：接口、冻结策略和检查命令。
- [训练结果（2026-10-07）](reports/training_results_2026-10-07.json)：两次实验配置、指标与本地结果索引。
- [模型快照（2026-10-08）](reports/model_snapshot_2026-10-08.json)：当前结构、训练状态和代码哈希。
- [训练前快照（2026-10-07）](reports/model_snapshot_2026-10-07.json)：单批诊断和训练入口检查历史。
- [加载器历史快照（2026-10-06）](reports/data_loader_snapshot_2026-10-06.json)：数据与加载设置。

## 运行入口

在 WSL Ubuntu 中执行：

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier

python -m scripts.model_data              # 遍历数据加载器
python -m scripts.check_bert_encoder      # BERT 诊断，写入检查报告
python -m scripts.check_stance_pipeline   # 完整模型单批前向与反向检查，仅输出终端
```

BERT 诊断读取 `configs/bert_encoder.json`；加载器默认参数位于 `scripts/model_data.py`。加载器和模型快照仅用于记录。

当前加载器读取 `data/processed/ocnli_50k/`，含 37,072 条训练、2,950 条验证。新实验示例：

```bash
python -m scripts.train --output runs/ocnli_50k_20261008_01 --max-minutes 60
```

默认 batch 16、最多 10 轮，按验证 Macro-F1 选最佳权重，连续 3 轮无提升提前停止；时间上限默认 40 分钟，上例改为 60 分钟。输出目录必须是新目录。历史 3k 数据保存在 `data/processed/ocnli/`；切换数据需修改 `scripts/model_data.py` 的 `DATA_DIR`，仅修改输出目录名不会切换数据。

TensorBoard 安装在 WSL 的 `escnet` 环境：

```bash
python -m tensorboard.main --logdir runs --host 127.0.0.1 --port 6006 --load_fast=false
```

浏览器访问 [localhost:6006](http://localhost:6006/)，同一页面可选择多个实验。日志由训练脚本写入，TensorBoard 无需提前启动。权重与事件日志保留在本地，文件分工见 [runs 说明](runs/README.md)。
