# 传统服饰说明核验

2026 年全国大学生数字媒体科技作品及创意竞赛项目。方向：基于限定资料库的传统服饰说明核验。

当前实现：基于 ESCNet 共享原型立场模块的文本三分类改编。模型代码完成，GPU 联调已覆盖 BERT、双路投影和立场模块；完整分类链路待验证，尚未训练或评测服饰领域效果。

## 文档与记录

- [开发记录](docs/development_log.md)：当前状态、设置和阶段结果。
- [数据处理](docs/data_preparation.md)：来源、划分和字段约定。
- [BERT 编码](docs/bert_encoder.md)：接口、冻结策略和检查命令。
- [模型快照（2026-10-07）](reports/model_snapshot_2026-10-07.json)：模型结构、验证范围和代码哈希。
- [加载器历史快照（2026-10-06）](reports/data_loader_snapshot_2026-10-06.json)：数据与加载设置。

## 运行入口

在 WSL Ubuntu 中执行：

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier

python -m scripts.model_data              # 遍历数据加载器
python -m scripts.check_bert_encoder      # BERT 诊断，写入检查报告
python -m scripts.check_stance_pipeline   # 截至立场模块的诊断，仅输出终端
```

BERT 诊断读取 `configs/bert_encoder.json`；加载器默认参数位于 `scripts/model_data.py`。加载器和模型快照仅用于记录。
