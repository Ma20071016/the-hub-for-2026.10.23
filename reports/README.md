# 报告与快照

保存有日期的实验、审核和界面验证记录。报告反映记录当天的状态，旧报告中的待办与缺陷不等于当前产品现状。

## 模型与数据

- [bert_assets.json](bert_assets.json)：固定 BERT 版本、路径和哈希，也是运行时定位权重的资源清单。
- [bert_encoder_check.json](bert_encoder_check.json)、`data_loader_snapshot_*`、`model_snapshot_*`：编码器检查及历史实现快照。
- [ocnli_preprocessing.json](ocnli_preprocessing.json)、[ocnli_50k_preprocessing.json](ocnli_50k_preprocessing.json)：3k / 50k 数据清洗、隔离与哈希记录。
- [training_results_2026-10-07.json](training_results_2026-10-07.json)：两次训练的配置、逐轮指标和最佳权重重载检查。
- [costume_eval_001_010.json](costume_eval_001_010.json)：249 条服饰原句的初步评估，标签尚待复核。
- [costume_eval_atomic_001_010.json](costume_eval_atomic_001_010.json)：现存 20 条原句复制诊断；原 1,398 条报告已被覆盖，详见[实验日志](../docs/experiment_log_2026-10-10.md)。

## 资料与产品验证

- [evidence_review_2026-10-14.md](evidence_review_2026-10-14.md)：证据片段审核、入库统计和待核问题。
- [library_visual_audit_2026-10-17.json](library_visual_audit_2026-10-17.json)、[library_visual_assets_2026-10-17.json](library_visual_assets_2026-10-17.json)：配图来源、对象绑定、转存方式和哈希。
- `*_live_2026-10-17.json`、`*_verification_2026-10-17.json`：审阅、修改、资料馆和入门流程的实测记录。
- `*.jpg`、`*.png`、`*.gif`：桌面及移动布局截图、交互预览；文件名保留测试日期。
- [project_audit_2026-10-17.md](project_audit_2026-10-17.md)、[competition_gap_analysis_2026-10-17.md](competition_gap_analysis_2026-10-17.md)：当时的实现审计和参赛差距分析；调研出处见 [competition_research_2026-10-17.md](competition_research_2026-10-17.md)。

完整权重和 TensorBoard 事件只保存在本地 `runs/`。OCNLI 验证成绩及服饰诊断均不能视为正式服饰领域测试结果。
