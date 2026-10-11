# 报告与快照

保存资源校验、数据处理、模型快照和训练摘要，保留原始实测日期。

- [bert_assets.json](bert_assets.json)：BERT 固定版本、本地路径与哈希；诊断脚本读取此文件定位权重。
- [bert_encoder_check.json](bert_encoder_check.json)：2026-10-06 的 BERT GPU 诊断结果，包括形状、冻结、梯度和显存检查。
- [data_loader_snapshot_2026-10-06.json](data_loader_snapshot_2026-10-06.json)：加载器完成时的历史环境、数据与参数快照，不控制运行。
- [model_snapshot_2026-10-07.json](model_snapshot_2026-10-07.json)：训练前的历史模型快照，记录当时结构、哈希与检查范围。
- [model_snapshot_2026-10-08.json](model_snapshot_2026-10-08.json)：当前模型、数据路径、源码哈希与已完成训练的状态快照，不控制运行。
- [ocnli_preprocessing.json](ocnli_preprocessing.json)：3k 数据来源、排除明细、划分统计与文件哈希；最终训练 2,993 条、验证 2,950 条。
- [ocnli_50k_preprocessing.json](ocnli_50k_preprocessing.json)：50k 预处理记录；训练 37,072 条、验证 2,950 条。`scope` 的旧 3k 名称已纠正并注明，原统计、数据哈希及生成时脚本哈希保留。
- [training_results_2026-10-07.json](training_results_2026-10-07.json)：两次训练的配置、逐轮指标、最佳结果和权重重载检查，整理自本地实验记录。
- [costume_eval_001_010.json](costume_eval_001_010.json)：249条服饰原句样本的初步评估，标签尚待人工复核。
- [costume_eval_atomic_001_010.json](costume_eval_atomic_001_010.json)：当前实际保存20条原句复制诊断结果；原1,398条单事实报告已被覆盖，文件名不代表当前样本构成，详见[实验日志](../docs/experiment_log_2026-10-10.md)。

完整权重与 TensorBoard 事件保留在本地 `runs/`，GitHub 保存训练摘要和轻量评估报告。OCNLI 指标仅适用于当前划分；服饰诊断不代表经过人工标签复核的正式领域测试。
