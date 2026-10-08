# runs：训练结果

每次实验使用独立子目录，保存实际配置、指标、权重和 TensorBoard 日志。

| 实验目录 | 训练样本 | 完成轮次 | 最佳轮次 | 验证 Macro-F1 |
|---|---:|---:|---:|---:|
| `ocnli_3k_20261007_01/` | 2,993 | 6 | 3 | 0.5296 |
| `ocnli_50k_20261007_01/` | 37,072 | 9 | 6 | 0.6495 |

两次均使用 2,950 条验证样本，因连续 3 轮无改善停止；最佳权重重载检查通过。各实验目录内文件如下：

- `run.json`：超参数、环境、数据及代码哈希。
- `metrics.jsonl`：初始验证与每轮训练/验证指标。
- `best.pt`：验证集 Macro-F1 最佳的可训练参数；同分时比较验证损失。
- `epoch_*.pt`：各完整轮次的可训练参数，保留历史版本。
- `last.pt`：最近一个完整验证阶段的参数、优化器与随机状态；续训入口尚未提供。
- `interrupted.pt`：超时或异常时的未完成状态，不覆盖完整轮次检查点。
- `summary.json`：结束原因、最佳轮次及指标、恢复检查结果。
- `console.log`：运行输出；`tensorboard/`：可视化事件文件。

冻结 BERT 不重复写入每个权重文件，恢复时须配合 `reports/bert_assets.json` 对应的固定本地权重。续训与独立推理 CLI 尚未提供。

本目录仅 README 纳入 Git；权重、完整日志和事件文件留在本地，逐轮指标等摘要另存于 [training_results_2026-10-07.json](../reports/training_results_2026-10-07.json)。根目录的 `tensorboard-server.log`、`tensorboard.pid` 如存在，分别是后台服务日志和启动时进程号，不属于训练结果。

训练脚本自动写入 TensorBoard 日志，查看服务是否开启不影响记录。TensorBoard 读取整个 `runs/` 即可对比多次实验，无需分别开端口。

`training/`、`validation/` 的平均损失、accuracy、Macro-F1 和每类 F1 按轮记录；验证轮次 0 为训练前基线。`training/step_loss`、`grad_norm`、`learning_rate` 按更新步数记录，其中 `grad_norm` 为裁剪前数值。`weights/` 记录权重范数和原型分布。平滑设为 0 可查看原始值；平滑不影响日志或最佳权重选择。
