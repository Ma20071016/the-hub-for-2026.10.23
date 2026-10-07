# 开发记录

更新：2026-10-07（Asia/Shanghai）。

## 当前状态

基于 ESCNet 共享原型立场模块的文本三分类改编，保留文本分支，移除图像和知识图谱分支。

| 阶段 | 状态 |
| --- | --- |
| OCNLI 预处理与加载器 | 完成 |
| BERT、双路投影、共享原型立场模块 | 实现完成，阶段 CPU/GPU 检查通过 |
| 池化、特征融合、三分类头 | 代码完成，完整真实标签交叉熵与反向传播待验证 |
| 训练、checkpoint 保存恢复、独立推理 | 未实现 |

## 模型与运行设置

| 模块 | 实现 |
| --- | --- |
| 编码器 | 两路共用冻结中文 BERT，保持 eval；输出 `[B,L,768]` 和有效位置 mask |
| 双路投影 | 两套独立 Linear，`768 → 384`，投影后清零 padding |
| 立场模块 | 40 个共享原型，384 维，6 头，单层交叉注意力；前馈 `384 → 768 → 384`，ReLU，dropout 0.3，两段 Pre-Norm 残差 |
| 融合层 | 每路平均池化，共用无偏置 `384 → 40` 投影，拼接为 `[B,80]` |
| 分类器 | `80 → 180 → 3`，LeakyReLU(0.01)，输出原始 logits |

环境：WSL Ubuntu / Conda `escnet`；Python 3.10.21、PyTorch 2.7.0+cu128、Transformers 4.37.2；RTX 5060 Laptop 8GB。

加载：batch 4、max_length 64、seed 20261006；两路独立动态 padding，训练打乱，验证顺序读取，保留尾批，num_workers=0。加载器 seed 只控制各自的 Generator，完整训练确定性尚未配置。

标签：`supports=0 / refutes=1 / insufficient=2`，类型为 `torch.long`。`insufficient` 表示给定证据不足。数据划分与出处见[数据处理说明](data_preparation.md)。

## 阶段记录

| 日期 | 完成内容 | 检查结果 |
| --- | --- | --- |
| 2026-10-06 | 数据预处理与加载器 | 训练 2,993 条、749 批、尾批 1；验证 2,950 条、738 批、尾批 2。含特殊 token 的最大长度为 57，max_length=64 无截断 |
| 2026-10-06 | 共享冻结 BERT | 9 项 unittest 通过；GPU 输出 `[4,16,768]` / `[4,32,768]`，冻结、重复输出、padding 不变性及下游梯度检查通过 |
| 2026-10-07 | 双路投影 | CPU/GPU 检查通过；输出 `[4,16,384]` / `[4,32,384]`，两路 weight/bias 梯度有限且非零，padding 为零 |
| 2026-10-07 | 共享原型立场模块 | CPU/GPU 检查通过；两路 `[4,40,384]`，梯度、padding 不变性及分支交换检查通过，BERT 保持冻结与 eval |
| 2026-10-07 | 融合与分类头、代码精简 | 完整模型代码完成；删除立场模块重复校验并整理简单运算。结构与参数名不变，5 个模型文件静态语法检查通过；整理后未重跑模型 |
| 2026-10-07 | 文档与快照整理 | 合并重复记录，更新当前状态；历史实测数据与当前代码审阅分开记录 |

阶段诊断没有优化器更新。BERT 峰值 allocated 为 454.29 MiB，立场管线为 431.49 MiB；均为单批诊断统计，不代表完整训练显存或分类效果。

## 记录索引

- [模型快照](../reports/model_snapshot_2026-10-07.json)：当前结构、代码哈希与验证范围。
- [加载器历史快照](../reports/data_loader_snapshot_2026-10-06.json)：2026-10-06 的环境、数据、tokenizer、长度统计与加载设置。
- [预处理报告](../reports/ocnli_preprocessing.json)：来源提交、排除明细、划分统计及哈希。
- [BERT 资源](../reports/bert_assets.json)与[检查报告](../reports/bert_encoder_check.json)：固定权重、2026-10-06 实测结果。
- 投影和立场检查依据为终端记录；立场检查入口为 `scripts/check_stance_pipeline.py`，仅打印结果。

加载器和模型快照仅用于记录。加载参数由 `scripts/model_data.py` 控制，模型结构由 `models/text_verifier.py` 组合，`configs/bert_encoder.json` 仅用于 BERT 诊断。

后续：完整分类链路检查 → 训练与验证 → checkpoint 保存恢复 → 独立推理。实验记录应保存实际配置、数据/代码版本、指标和权重路径。
