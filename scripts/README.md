# scripts

数据准备、加载、检查和训练入口。从项目根目录以 `python -m scripts.<脚本名>` 运行，脚本名省略 `.py`。

- [prepare_ocnli.py](prepare_ocnli.py)：转换 OCNLI 标签、隔离同源样本；当前读取 `train.50k.json` 和 `dev.json`，写入 `data/processed/ocnli_50k/` 及预处理报告。
- [download_bert.py](download_bert.py)：准备固定版本 BERT 配置与权重，校验哈希，生成 `reports/bert_assets.json`；`--local-files-only` 仅检查本地资源。
- [model_data.py](model_data.py)：从 `data/processed/ocnli_50k/` 构建双路 DataLoader；直接运行时打印首批形状、批次数及样本数。
- [check_bert_encoder.py](check_bert_encoder.py)：按 `configs/bert_encoder.json` 检查冻结 BERT，写入诊断报告；支持 `--config` 和 `--device`。
- [check_stance_pipeline.py](check_stance_pipeline.py)：用真实 GPU batch 检查完整模型输出、真实标签交叉熵、可训练模块梯度及 BERT 冻结状态，仅打印结果。
- [train.py](train.py)：完整训练与验证入口；记录 TensorBoard 指标、每轮权重、最佳权重及优化器/随机状态，支持提前停止和时间上限。

已完成 3k 与 50k 两次训练，实际训练样本为 2,993 和 37,072 条，验证集均为 2,950 条。结果见[训练摘要](../reports/training_results_2026-10-07.json)。续训和独立推理入口待补。

诊断脚本不更新参数。训练默认 batch 16、最多 10 轮、AdamW 学习率 1e-4、40 分钟上限、连续 3 轮无改善停止；输出目录必须不存在。以下命令为新实验示例：

```bash
python -m scripts.train --output runs/ocnli_50k_20261008_01 --max-minutes 60
```
