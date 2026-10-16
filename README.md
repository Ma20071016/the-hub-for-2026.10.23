# 传统服饰说明核验

2026 年全国大学生数字媒体科技作品及创意竞赛项目。方向：基于限定资料库的传统服饰说明核验。

当前实现：基于 ESCNet 共享原型立场模块的文本三分类改编，已完成 OCNLI 3k 和 50k 两次训练。50k 清洗后使用 37,072 条训练数据，最佳验证 Macro-F1 为 0.6495、准确率为 64.64%。这是通用文本推理验证结果；另已完成服饰样本初步诊断，标签待人工复核，不能作为正式领域测试成绩，详见[实验日志](docs/experiment_log_2026-10-10.md)。

模型输入为已配对的主张与证据。网站已提供本地 SQLite 已审核证据的对象别名与关键词检索，并接入逐证据模型核验；前端调用和分数展示代码已完成，最终浏览器联调待确认。当前模型仍有明显误判。语义检索、自动实体识别与链接、实体知识比较及图像分支尚未实现，不构成完整 ESCNet 或完整事实核验系统。

## 目录说明

| 目录 | 用途 |
| --- | --- |
| [frontend/](frontend/index.html) | 简易网页：说明输入、限定资料、逐证据预测与分数、独立示例预览 |
| [backend/](backend/README.md) | 网站后端：本地服务、数据库、资料导入审核、检索及模型推理 |
| [models/](models/README.md) | 模型核心模块与完整三分类模型 |
| [scripts/](scripts/README.md) | 数据准备、资源下载、训练和诊断入口 |
| [configs/](configs/README.md) | 检查脚本的运行参数 |
| [data/](data/README.md) | 原始数据、处理数据与本地 BERT 资源 |
| [tests/](tests/README.md) | 自动化行为测试 |
| [docs/](docs/README.md) | 开发记录与技术说明 |
| [reports/](reports/README.md) | 来源、哈希、诊断结果和设置快照 |
| [runs/](runs/README.md) | 本地训练权重、优化器状态与 TensorBoard 日志 |
| [.idea/](.idea/README.md) | PyCharm 项目配置 |

根目录 `README.md` 为项目入口；`.gitignore` 定义数据、权重及临时文件的忽略规则。各目录的 README 列出具体文件分工。

## 文档与记录

- [开发记录](docs/development_log.md)：当前状态、设置和阶段结果。
- [数据处理](docs/data_preparation.md)：来源、划分和字段约定。
- [BERT 编码](docs/bert_encoder.md)：接口、冻结策略和检查命令。
- [训练结果（2026-10-07）](reports/training_results_2026-10-07.json)：两次实验配置、指标与本地结果索引。
- [模型快照（2026-10-08）](reports/model_snapshot_2026-10-08.json)：当前结构、训练状态和代码哈希。
- [训练前快照（2026-10-07）](reports/model_snapshot_2026-10-07.json)：单批诊断和训练入口检查历史。
- [加载器历史快照（2026-10-06）](reports/data_loader_snapshot_2026-10-06.json)：数据与加载设置。

## 网站前后端

2026-10-14 已在原数据库完成564条待审片段的首轮内容审查：8条原段直接通过、414条不整段启用、142条待复核，另精切新增83条可用证据。现有655条片段，其中99条 approved 来自43份资料；原有8条人工审核保留。待核与拒绝片段不进入检索，逐条依据和本机明细见[审核记录](reports/evidence_review_2026-10-14.md)。审核的是来源范围内的证据可用性，模型准确率未因此得到验证。

前端仅包含 `frontend/index.html`、`frontend/style.css`、`frontend/app.js`，不需要 npm。本地后端为 `backend/serve.py`，HTTP 服务使用 Python 标准库，模型推理沿用 `escnet` 中的 PyTorch、Transformers 和本地资源。在 WSL 中，从项目根目录运行：

```bash
cd /mnt/d/cmit-2026-costume-verifier
conda activate escnet
python -m backend.serve
```

等终端显示模型已加载、网站已启动后，打开 [localhost:5173](http://localhost:5173/)。后端同时提供页面、检索和核验接口，默认仅监听 `127.0.0.1`，按 Ctrl+C 停止；端口占用时先停止原服务，或用 `--port 5174` 更换端口。直接打开 HTML 只能预览页面。建库、资料导入、审核及模型资源要求见 [backend 说明](backend/README.md)；数据库仍保存在 `data/costume.db`。

已有 50 份资料和分段草稿后，可以先批量整理 5 份馆藏资料中的 8 条精选证据。原文与标签会先显示，确认后输入 `y` 才保存；其他输入取消。也可先加 `--check` 只读预览：

```bash
python -m backend.import_sources --starter
```

在网页先选择“新疆喀什维吾尔族绿棉袍”，再输入 `这件棉袍采用对襟设计。`，可对该件藏品的两条已审核证据逐条核验。当前核验必须选择资料，即使说明中已包含馆藏编号也一样。用户需确认选择的资料与说明属于同一对象；单件馆藏事实不能推广到整类服饰。没有匹配也不等于说明错误。

接口：

- `GET /api/sources` 返回有已审核证据的来源及片段数。
- `POST /api/search` 接收 `{"claim":"说明","source_id":null}`，`source_id` 可选，只返回候选证据。状态为 `found / no_evidence / needs_context`；保留旧字段 `model_status: "not_connected"`，仅表示此检索接口没有运行模型。
- `POST /api/verify` 接收 `{"claim":"说明","source_id":1}`，要求选定资料。成功返回 `status: "completed"`、`model_status: "completed"`，每条 match 增加 `label`、`scores`、`claim_input`、`evidence_input`。缺少资料或证据时分别返回 `needs_context / no_evidence`，`model_status: "not_run"`，无预测；模型忙返回429，输入超长返回422。

两种 POST 结果均含 `claim`、`matches` 和 `message`。证据包含原文、对象、属性、出处及定位，最多返回5条。检索只读取 `approved`，按对象名称/别名/馆藏编号发现候选，再用关键词和原文词组重合度排序；颜色、材质等不会作为必须相同的过滤条件。当前是小规模字面匹配，不具备语义理解。

页面支持输入校验、来源选择、120秒超时、取消旧请求和清空；核验结果按每条证据展示支持/反驳/信息不足及三类分数，不汇总整体结论。折叠区保留三个独立的自拟示例，预设结果明确标注。后端启动时加载一次模型，推理加锁，只读数据库，尚未保存核验历史。网页取消请求不会中止后端已开始的推理。分类分数不代表说明为真的概率，当前模型误判及验证范围见[开发记录](docs/development_log.md)。

网页说明长度上限为500个 UTF-16 代码单元，不等同于模型 token 上限。当前推理分别限制 claim 和 evidence 为160 token，包含特殊 token；证据先补充对象名称，再计算长度。超长直接报错，不静默截断。训练采用过64 token，评测采用过160 token；这些是运行设置，不是架构硬限制。

## 模型运行入口

在 WSL Ubuntu 中执行：

```bash
conda activate escnet
cd /mnt/d/cmit-2026-costume-verifier

python -m scripts.model_data              # 遍历数据加载器
python -m scripts.check_bert_encoder      # BERT 诊断，写入检查报告
python -m scripts.check_stance_pipeline   # 完整模型单批前向与反向检查，仅输出终端
```

BERT 诊断读取 `configs/bert_encoder.json`；加载器默认参数位于 `scripts/model_data.py`。加载器和模型快照仅用于记录。

当前加载器读取 `data/processed/ocnli_50k/`，含 37,072 条训练、2,950 条验证。新实验示例：

```bash
python -m scripts.train --output runs/ocnli_50k_20261008_01 --max-minutes 60
```

默认 batch 16、最多 10 轮，按验证 Macro-F1 选最佳权重，连续 3 轮无提升提前停止；时间上限默认 40 分钟，上例改为 60 分钟。输出目录必须是新目录。历史 3k 数据保存在 `data/processed/ocnli/`；切换数据需修改 `scripts/model_data.py` 的 `DATA_DIR`，仅修改输出目录名不会切换数据。

TensorBoard 安装在 WSL 的 `escnet` 环境：

```bash
python -m tensorboard.main --logdir runs --host 127.0.0.1 --port 6006 --load_fast=false
```

浏览器访问 [localhost:6006](http://localhost:6006/)，同一页面可选择多个实验。日志由训练脚本写入，TensorBoard 无需提前启动。权重与事件日志保留在本地，文件分工见 [runs 说明](runs/README.md)。
