# scripts

数据准备、加载和阶段检查入口。从项目根目录以 `python -m scripts.<脚本名>` 运行，脚本名省略 `.py`。

- [prepare_ocnli.py](prepare_ocnli.py)：转换 OCNLI 标签、隔离同源样本；写入训练集、验证集及预处理报告。
- [download_bert.py](download_bert.py)：准备固定版本 BERT 配置与权重，校验哈希，生成 `reports/bert_assets.json`；`--local-files-only` 仅检查本地资源。
- [model_data.py](model_data.py)：构建双路 DataLoader；直接运行时打印首批形状、批次数及样本数。
- [check_bert_encoder.py](check_bert_encoder.py)：按 `configs/bert_encoder.json` 检查冻结 BERT，写入诊断报告；支持 `--config` 和 `--device`。
- [check_stance_pipeline.py](check_stance_pipeline.py)：用真实 GPU batch 检查 BERT、投影和立场模块的前向与梯度，仅打印结果。

阶段检查不执行参数更新；当前没有完整分类训练或独立推理入口。
