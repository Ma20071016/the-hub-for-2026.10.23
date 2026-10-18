# 数据、训练与辅助脚本

从项目根目录以 `python -m scripts.<脚本名>` 运行，省略 `.py`。环境安装见[项目说明](../README.md)，网站启动与数据库管理见 [backend](../backend/README.md)。

- [prepare_ocnli.py](prepare_ocnli.py)：清洗 OCNLI 50k，隔离同源样本，输出训练/验证 JSONL 与处理报告。
- [download_bert.py](download_bert.py)：下载并校验固定版本 BERT 配置和权重；分词器须[单独准备](../data/processed/bert-base-chinese-tokenizer/README.md)。
- [model_data.py](model_data.py)：加载 `data/processed/ocnli_50k/`，打印批次形状与样本数。
- [check_bert_encoder.py](check_bert_encoder.py)：按 [configs/bert_encoder.json](../configs/bert_encoder.json) 检查编码器；支持 `--config`、`--device`。
- [check_stance_pipeline.py](check_stance_pipeline.py)：用真实 GPU batch 检查前向、梯度与 BERT 冻结状态。
- [train.py](train.py)：训练、验证、保存权重及 TensorBoard 日志；支持提前停止和时间上限。
- [evaluate_costume.py](evaluate_costume.py)：本地服饰样本诊断；运行前检查脚本内的样本路径和报告路径。
- [build_review_practice.py](build_review_practice.py)：生成入门练习 `frontend/downloads/robe-review-practice.docx`，依赖 `python-docx`。

常用命令：

```bash
python -m scripts.download_bert --local-files-only
python -m scripts.model_data
python -m scripts.check_stance_pipeline
python -m scripts.train --output runs/ocnli_50k_new --max-minutes 60
python -m backend.inference
python -m scripts.build_review_practice
```

训练输出目录必须尚不存在；默认 batch 16、最多 10 轮、学习率 `1e-4`，连续 3 轮无改善停止。完整参数运行 `python -m scripts.train --help` 查看。权重和训练日志仅保存在本地，续训 CLI 尚未实现。

`evaluate_costume.py` 当前读取 WSL 下的 20 条原句复制样本，并覆盖 `reports/costume_eval_atomic_001_010.json`。新实验应先修改输入、输出路径；此诊断不代表正式领域测试，背景见[实验日志](../docs/experiment_log_2026-10-10.md)。
