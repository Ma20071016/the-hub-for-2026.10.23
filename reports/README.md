# 报告与快照

保存资源校验、数据处理和模型检查记录，保留原始实测日期。

- [bert_assets.json](bert_assets.json)：BERT 固定版本、本地路径与哈希；诊断脚本读取此文件定位权重。
- [bert_encoder_check.json](bert_encoder_check.json)：2026-10-06 的 BERT GPU 诊断结果，包括形状、冻结、梯度和显存检查。
- [data_loader_snapshot_2026-10-06.json](data_loader_snapshot_2026-10-06.json)：加载器完成时的历史环境、数据与参数快照，不控制运行。
- [model_snapshot_2026-10-07.json](model_snapshot_2026-10-07.json)：模型代码结构、哈希与验证范围，仅作记录；完整分类链路尚未验证。
- [ocnli_preprocessing.json](ocnli_preprocessing.json)：数据来源、排除明细、划分统计、隔离检查与文件哈希。
