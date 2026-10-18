# 本地训练结果

每次实验使用独立子目录，保存实际配置、指标、权重和 TensorBoard 日志。

| 实验目录 | 训练样本 | 完成轮次 | 最佳轮次 | 验证 Macro-F1 |
|---|---:|---:|---:|---:|
| `ocnli_3k_20261007_01/` | 2,993 | 6 | 3 | 0.5296 |
| `ocnli_50k_20261007_01/` | 37,072 | 9 | 6 | 0.6495 |

两次均使用 2,950 条验证样本，因连续 3 轮无改善停止，最佳权重重载检查通过。这些分数是 OCNLI 验证结果，不代表服饰领域测试成绩。

- `run.json`、`metrics.jsonl`、`summary.json`：配置、逐轮指标和最终结果。
- `best.pt`：验证 Macro-F1 最佳权重；同分时比较验证损失。
- `epoch_*.pt`、`last.pt`：完整轮次权重及最近完整阶段的恢复状态。
- `interrupted.pt`：超时或异常时的未完成状态（如有）。
- `console.log`、`tensorboard/`：控制台与可视化日志。

检查点只保存可训练部分，加载时须配合 [bert_assets.json](../reports/bert_assets.json) 对应的冻结 BERT。可运行 `python -m backend.inference` 查看独立推理示例；续训 CLI 尚未实现。

本目录仅 README 纳入 Git，权重及日志留在本地。可分享的实验摘要见 [training_results_2026-10-07.json](../reports/training_results_2026-10-07.json)。

在项目根目录查看全部实验：

```bash
tensorboard --logdir runs
```

轮次 0 为训练前基线；平滑设为 0 可查看原始曲线。TensorBoard 服务是否开启不影响训练日志写入。
